const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
// Placeholder until real auth: the API trusts this header (see WorkspaceGuard).
const WORKSPACE = process.env.NEXT_PUBLIC_WORKSPACE_ID ?? "ws_demo";

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(messageFrom(body, status));
  }
}

function messageFrom(body: unknown, status: number) {
  if (body && typeof body === "object" && "message" in body) {
    const m = (body as { message: unknown }).message;
    if (typeof m === "string") return m;
  }
  return `Request failed (${status})`;
}

/** Policy/validation details the API attaches to 4xx responses. */
export function errorDetails(e: unknown): string[] {
  if (!(e instanceof ApiError) || !e.body || typeof e.body !== "object") return [];
  const b = e.body as { violations?: unknown; issues?: unknown };
  const list = (b.violations ?? b.issues) as unknown;
  if (!Array.isArray(list)) return [];
  return list.map((v) => (typeof v === "string" ? v : v && typeof v === "object" && "detail" in v
    ? `${(v as { where?: string }).where ?? ""} ${(v as { detail: string }).detail}`.trim()
    : v && typeof v === "object" && "message" in v ? String((v as { message: unknown }).message) : JSON.stringify(v)));
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers: { "x-workspace-id": WORKSPACE, ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...init.headers },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError(0, { message: `Cannot reach the API at ${BASE}. Is it running?` });
  }
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}
