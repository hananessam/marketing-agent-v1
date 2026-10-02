import { BadGatewayException, BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { and, eq, lt } from "drizzle-orm";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { encryptSecret, decryptSecret } from "../connectors/crypto";
import { ConnectorAuthError, ConnectorError } from "../connectors/http";
import { schema, type Db } from "../db";
import { DB } from "../db/database.module";
import { OAUTH_PROVIDERS, type Account, type OAuthProvider } from "./providers";

const STATE_TTL_MS = 10 * 60 * 1000;
const b64url = (b: Buffer) => b.toString("base64url");

/** Browser-facing outcomes. Fixed codes only: provider text is never reflected into the redirect. */
export type CallbackResult = { ok: true; provider: string; connectionId: string; pending: boolean } | { ok: false; code: "denied" | "invalid_state" | "exchange_failed" | "not_configured" };

@Injectable()
export class OAuthService {
  constructor(@Inject(DB) private readonly db: Db, @Inject(OAUTH_PROVIDERS) private readonly providers: OAuthProvider[]) {}

  private provider(slug: string): OAuthProvider {
    const p = this.providers.find((x) => x.slug === slug);
    if (!p) throw new NotFoundException("Unknown provider");
    return p;
  }

  status() {
    return Object.fromEntries(this.providers.map((p) => [p.slug, { configured: p.configured() }]));
  }

  /** Creates a single-use, expiring state (and PKCE verifier) and returns the consent URL. */
  start(workspaceId: string, slug: string, connectionId?: string, posting = false) {
    const p = this.provider(slug);
    if (!p.configured()) throw new ServiceUnavailableException(`${slug} OAuth is not configured on the server`);
    if (connectionId) {
      const own = this.db.select({ id: schema.connections.id }).from(schema.connections).where(and(
        eq(schema.connections.workspaceId, workspaceId), eq(schema.connections.id, connectionId), eq(schema.connections.provider, p.provider))).get();
      if (!own) throw new NotFoundException("Connection not found");
    }
    const now = Date.now();
    this.db.delete(schema.oauthStates).where(lt(schema.oauthStates.expiresAt, new Date(now).toISOString())).run(); // tidy up
    const state = b64url(randomBytes(32));
    const verifier = p.usesPkce ? b64url(randomBytes(32)) : null;
    this.db.insert(schema.oauthStates).values({
      state, workspaceId, provider: p.provider, connectionId: connectionId ?? null, codeVerifier: verifier,
      expiresAt: new Date(now + STATE_TTL_MS).toISOString(),
    }).run();
    const codeChallenge = verifier ? b64url(createHash("sha256").update(verifier).digest()) : undefined;
    return { authUrl: p.authUrl({ state, codeChallenge, posting }) };
  }

  /** Public endpoint (a browser redirect): the workspace comes only from the state we issued. */
  async callback(slug: string, q: { code?: string; state?: string; error?: string }): Promise<CallbackResult> {
    const p = this.providers.find((x) => x.slug === slug);
    if (!p || !p.configured()) return { ok: false, code: "not_configured" };
    if (!q.state) return { ok: false, code: "invalid_state" };

    // Consume first, so a replayed or forged state can never be used twice.
    const row = this.db.transaction((tx) => {
      const r = tx.select().from(schema.oauthStates).where(eq(schema.oauthStates.state, q.state!)).get();
      if (r) tx.delete(schema.oauthStates).where(eq(schema.oauthStates.state, q.state!)).run();
      return r;
    });
    if (!row || row.provider !== p.provider || Date.parse(row.expiresAt) < Date.now()) return { ok: false, code: "invalid_state" };
    if (q.error || !q.code) return { ok: false, code: "denied" };

    let grant;
    try {
      grant = await p.exchangeCode({ code: q.code, codeVerifier: row.codeVerifier ?? undefined });
    } catch {
      return { ok: false, code: "exchange_failed" };
    }
    const encryptedSecret = encryptSecret(grant.secret);

    if (row.connectionId) {
      // Re-authorizing: replace the tokens, keep the chosen account.
      const existing = this.db.select().from(schema.connections).where(and(eq(schema.connections.workspaceId, row.workspaceId), eq(schema.connections.id, row.connectionId))).get();
      if (!existing) return { ok: false, code: "invalid_state" };
      this.db.update(schema.connections).set({ encryptedSecret, config: { ...existing.config, ...grant.config }, status: "never_synced", lastError: null })
        .where(eq(schema.connections.id, existing.id)).run();
      return { ok: true, provider: p.provider, connectionId: existing.id, pending: false };
    }

    const id = randomUUID();
    this.db.insert(schema.connections).values({
      id, workspaceId: row.workspaceId, provider: p.provider, accountId: `pending_${id}`, encryptedSecret, config: grant.config, status: "pending_account",
    }).run();
    return { ok: true, provider: p.provider, connectionId: id, pending: true };
  }

  async accounts(workspaceId: string, connectionId: string): Promise<Account[]> {
    const conn = this.connection(workspaceId, connectionId);
    try {
      return await this.provider(conn.provider === "ga4" ? "google" : "meta").listAccounts(decryptSecret(conn.encryptedSecret));
    } catch (e) {
      // Provider errors are already sanitized (no tokens or URLs), so their message is safe to show.
      if (e instanceof ConnectorAuthError) throw new ConflictException(e.message);
      if (e instanceof ConnectorError) throw new BadGatewayException(e.message);
      throw e;
    }
  }

  /** Finalise a pending connection with an account the user actually has access to. */
  async selectAccount(workspaceId: string, connectionId: string, accountId: string, conversionAction?: string) {
    const conn = this.connection(workspaceId, connectionId);
    const chosen = (await this.accounts(workspaceId, connectionId)).find((a) => a.id === accountId);
    if (!chosen) throw new BadRequestException("That account is not available to this login");

    const config = { ...conn.config, accountName: chosen.name, ...(conn.provider === "meta_ads" ? { conversionAction: conversionAction === "lead" ? "lead" : "purchase" } : {}) };
    const dup = this.db.select().from(schema.connections).where(and(
      eq(schema.connections.workspaceId, workspaceId), eq(schema.connections.provider, conn.provider), eq(schema.connections.accountId, accountId))).get();

    if (dup && dup.id !== conn.id) {
      // Same account connected before: fold the fresh login into it.
      this.db.transaction((tx) => {
        tx.update(schema.connections).set({ encryptedSecret: conn.encryptedSecret, config: { ...dup.config, ...config }, status: "never_synced", lastError: null }).where(eq(schema.connections.id, dup.id)).run();
        tx.delete(schema.connections).where(eq(schema.connections.id, conn.id)).run();
      });
      return { connectionId: dup.id };
    }
    this.db.update(schema.connections).set({ accountId, config, status: "never_synced", lastError: null }).where(eq(schema.connections.id, conn.id)).run();
    return { connectionId: conn.id };
  }

  private connection(workspaceId: string, id: string) {
    const c = this.db.select().from(schema.connections).where(and(eq(schema.connections.workspaceId, workspaceId), eq(schema.connections.id, id))).get();
    if (!c) throw new NotFoundException("Connection not found");
    return c;
  }
}
