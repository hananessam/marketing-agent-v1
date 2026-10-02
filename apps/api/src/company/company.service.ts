import { Inject, Injectable, UnprocessableEntityException } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { schema, type Db } from "../db";
import { DB } from "../db/database.module";

const Item = z.object({
  id: z.string().trim().max(100).optional(),
  name: z.string().trim().min(1, "Give each one a name").max(100),
  description: z.string().trim().min(1, "Add a short description").max(500),
});
const lines = (max: number, each: number) => z.array(z.string().trim().min(1).max(each)).max(max).default([]);

export const CompanyBody = z.object({
  name: z.string().trim().min(1, "Enter your company name").max(100),
  voice: z.string().trim().min(1, "Describe how your brand sounds").max(1000),
  approvedClaims: lines(50, 200),
  prohibited: lines(50, 100),
  allowedDomains: lines(20, 253),
  products: z.array(Item).min(1, "Add at least one product or service").max(20),
  audiences: z.array(Item).min(1, "Add at least one audience").max(20),
});
export type CompanyBody = z.infer<typeof CompanyBody>;

const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** "https://www.Acme.com/pricing?x=1" -> "acme.com". The bare domain also covers www and other subdomains. */
export function normalizeDomain(input: string): string | null {
  let h = input.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  h = h.split(/[/?#]/)[0].replace(/:\d+$/, "").replace(/^www\./, "").replace(/\.$/, "");
  return HOST.test(h) ? h : null;
}

const dedupe = (list: string[]) => {
  const seen = new Set<string>();
  return list.filter((x) => { const k = x.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
};

@Injectable()
export class CompanyService {
  constructor(@Inject(DB) private readonly db: Db) {}

  get(workspaceId: string) {
    const ws = this.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get()!;
    const brand = this.db.select().from(schema.brandProfiles).where(eq(schema.brandProfiles.workspaceId, workspaceId)).get();
    const list = (t: typeof schema.products | typeof schema.audiences) =>
      this.db.select({ id: t.id, name: t.name, description: t.description }).from(t).where(eq(t.workspaceId, workspaceId)).orderBy(asc(t.name)).all();
    const sample = !!this.db.select({ id: schema.campaigns.id }).from(schema.campaigns)
      .where(and(eq(schema.campaigns.workspaceId, workspaceId), eq(schema.campaigns.source, "seed"))).get();
    return {
      name: ws.name,
      onboarded: ws.onboardedAt !== null,
      /** True while the demo seed is present, so the form can warn that the pre-filled details are not the user's. */
      sample,
      voice: brand?.voice ?? "",
      approvedClaims: brand?.approvedClaims ?? [],
      prohibited: brand?.prohibited ?? [],
      allowedDomains: brand?.allowedDomains ?? [],
      products: list(schema.products),
      audiences: list(schema.audiences),
    };
  }

  /** Saves exactly what the form shows: items missing from it are removed, items with a known id are updated, the rest are added. */
  save(workspaceId: string, input: CompanyBody) {
    const domains: string[] = [];
    const badDomains: string[] = [];
    for (const d of input.allowedDomains) {
      const n = normalizeDomain(d);
      if (n) domains.push(n); else badDomains.push(d);
    }
    if (badDomains.length) throw new UnprocessableEntityException({ message: "Some website addresses are not valid", violations: badDomains.map((d) => `"${d}" is not a website address. Use something like acme.com`) });
    for (const [what, items] of [["product", input.products], ["audience", input.audiences]] as const) {
      const names = items.map((i) => i.name.toLowerCase());
      const dup = names.find((n, i) => names.indexOf(n) !== i);
      if (dup) throw new UnprocessableEntityException(`Two ${what}s are called "${items[names.indexOf(dup)].name}". Give each a different name.`);
    }

    this.db.transaction((tx) => {
      const ws = tx.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get()!;
      tx.update(schema.workspaces).set({ name: input.name, onboardedAt: ws.onboardedAt ?? new Date().toISOString() }).where(eq(schema.workspaces.id, workspaceId)).run();

      const brand = { voice: input.voice, approvedClaims: dedupe(input.approvedClaims), prohibited: dedupe(input.prohibited), allowedDomains: dedupe(domains) };
      const existing = tx.select({ id: schema.brandProfiles.id }).from(schema.brandProfiles).where(eq(schema.brandProfiles.workspaceId, workspaceId)).get();
      if (existing) tx.update(schema.brandProfiles).set(brand).where(eq(schema.brandProfiles.id, existing.id)).run();
      else tx.insert(schema.brandProfiles).values({ id: randomUUID(), workspaceId, ...brand }).run();

      const sync = (t: typeof schema.products | typeof schema.audiences, items: z.infer<typeof Item>[]) => {
        const have = new Set(tx.select({ id: t.id }).from(t).where(eq(t.workspaceId, workspaceId)).all().map((r) => r.id));
        const keep = new Set<string>();
        for (const it of items) {
          // A client-supplied id is only honoured if it already belongs to this workspace.
          if (it.id && have.has(it.id)) {
            keep.add(it.id);
            tx.update(t).set({ name: it.name, description: it.description }).where(and(eq(t.id, it.id), eq(t.workspaceId, workspaceId))).run();
          } else {
            const id = randomUUID();
            keep.add(id);
            tx.insert(t).values({ id, workspaceId, name: it.name, description: it.description }).run();
          }
        }
        for (const id of have) if (!keep.has(id)) tx.delete(t).where(and(eq(t.id, id), eq(t.workspaceId, workspaceId))).run();
      };
      sync(schema.products, input.products);
      sync(schema.audiences, input.audiences);
    });
    return this.get(workspaceId);
  }
}
