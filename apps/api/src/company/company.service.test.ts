import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { checkText } from "../campaigns/content-policy";
import type { Db } from "../db";
import { RunsService } from "../runs/runs.service";
import { createTestDb, schema } from "../test/helpers";
import { ToolRunnerService } from "../tools/tool-runner.service";
import { CompanyBody, CompanyService, normalizeDomain } from "./company.service";

let db: Db;
let svc: CompanyService;

const valid = (over: Partial<CompanyBody> = {}): CompanyBody => ({
  name: "Acme Inc", voice: "Friendly and plain-spoken", approvedClaims: ["Free 30-day trial"], prohibited: ["guaranteed results"], allowedDomains: ["acme.com"],
  products: [{ name: "Acme Planner", description: "Project planning for small teams" }],
  audiences: [{ name: "Founders", description: "Teams of 2-10 shipping a first product" }], ...over,
});
const parse = (b: unknown) => CompanyBody.parse(b);

beforeEach(async () => {
  db = await createTestDb();
  svc = new CompanyService(db);
  db.insert(schema.workspaces).values([{ id: "w", name: "Default Workspace" }, { id: "other", name: "Other Co" }]).run();
});

describe("domains", () => {
  it("normalizes whatever people paste into a bare domain", () => {
    expect(normalizeDomain("https://www.Acme.com/pricing?x=1")).toBe("acme.com");
    expect(normalizeDomain("acme.com")).toBe("acme.com");
    expect(normalizeDomain("shop.acme.co.uk:8080/path")).toBe("shop.acme.co.uk");
    expect(normalizeDomain("  WWW.ACME.COM.  ")).toBe("acme.com");
  });
  it("rejects things that are not website addresses", () => {
    for (const bad of ["acme", "not a domain", "http://", "-bad-.com", "acme..com", "javascript:alert(1)", ""]) expect(normalizeDomain(bad)).toBeNull();
  });
});

describe("input validation", () => {
  it("requires the essentials, with friendly messages", () => {
    const r = CompanyBody.safeParse({ name: "", voice: "", products: [], audiences: [] });
    expect(r.success).toBe(false);
    const msgs = r.error!.issues.map((i) => i.message);
    expect(msgs).toEqual(expect.arrayContaining(["Enter your company name", "Describe how your brand sounds", "Add at least one product or service", "Add at least one audience"]));
  });
  it("bounds list sizes and lengths", () => {
    expect(CompanyBody.safeParse(valid({ approvedClaims: Array(51).fill("x") })).success).toBe(false);
    expect(CompanyBody.safeParse(valid({ voice: "x".repeat(1001) })).success).toBe(false);
    expect(CompanyBody.safeParse(valid({ prohibited: ["x".repeat(101)] })).success).toBe(false);
  });
});

describe("saving", () => {
  it("starts not onboarded, and the first save marks it done and stores everything", () => {
    expect(svc.get("w")).toMatchObject({ onboarded: false, name: "Default Workspace", voice: "", products: [], audiences: [] });
    const out = svc.save("w", parse(valid()));
    expect(out).toMatchObject({ onboarded: true, name: "Acme Inc", voice: "Friendly and plain-spoken", approvedClaims: ["Free 30-day trial"], prohibited: ["guaranteed results"], allowedDomains: ["acme.com"] });
    expect(out.products.map((p) => p.name)).toEqual(["Acme Planner"]);
    expect(out.audiences.map((a) => a.name)).toEqual(["Founders"]);
  });

  it("keeps the original onboarding time on later edits", () => {
    svc.save("w", parse(valid()));
    const first = db.select().from(schema.workspaces).where(eq(schema.workspaces.id, "w")).get()!.onboardedAt;
    svc.save("w", parse(valid({ name: "Acme Corp" })));
    expect(db.select().from(schema.workspaces).where(eq(schema.workspaces.id, "w")).get()!.onboardedAt).toBe(first);
    expect(svc.get("w").name).toBe("Acme Corp");
  });

  it("saves exactly what the form shows: updates by id, adds new items, removes missing ones", () => {
    const a = svc.save("w", parse(valid({ products: [{ name: "Planner", description: "d1" }, { name: "Reports", description: "d2" }] })));
    const planner = a.products.find((p) => p.name === "Planner")!;
    const b = svc.save("w", parse(valid({ products: [{ id: planner.id, name: "Planner Pro", description: "better" }, { name: "Brand New", description: "d3" }] })));
    expect(b.products.map((p) => p.name).sort()).toEqual(["Brand New", "Planner Pro"]);
    expect(b.products.find((p) => p.name === "Planner Pro")!.id).toBe(planner.id); // same record, renamed
    expect(db.select().from(schema.products).where(eq(schema.products.workspaceId, "w")).all()).toHaveLength(2); // "Reports" is gone
  });

  it("cleans lists: trims, drops case-insensitive duplicates, normalizes domains", () => {
    const out = svc.save("w", parse(valid({
      approvedClaims: ["Free trial", "free trial", " Set up fast "], prohibited: ["Guarantee", "guarantee"], allowedDomains: ["https://www.Acme.com/x", "acme.com", "shop.acme.com"],
    })));
    expect(out.approvedClaims).toEqual(["Free trial", "Set up fast"]);
    expect(out.prohibited).toEqual(["Guarantee"]);
    expect(out.allowedDomains).toEqual(["acme.com", "shop.acme.com"]);
  });

  it("refuses bad websites and duplicate names with readable errors, and saves nothing", () => {
    expect(() => svc.save("w", parse(valid({ allowedDomains: ["acme.com", "not a site"] })))).toThrow(/not valid/);
    expect(() => svc.save("w", parse(valid({ products: [{ name: "Planner", description: "a" }, { name: "planner", description: "b" }] })))).toThrow(/Two products are called "Planner"/);
    expect(() => svc.save("w", parse(valid({ audiences: [{ name: "Founders", description: "a" }, { name: "founders", description: "b" }] })))).toThrow(/Two audiences/);
    expect(svc.get("w").onboarded).toBe(false);
    expect(svc.get("w").products).toEqual([]);
  });

  it("is workspace-scoped: another workspace's data is invisible, and its ids cannot be hijacked", () => {
    svc.save("other", parse(valid({ name: "Other Co", products: [{ name: "Theirs", description: "secret" }] })));
    const theirs = svc.get("other").products[0];
    expect(svc.get("w").products).toEqual([]);
    // sending someone else's product id from workspace w must create a new product, never modify theirs
    svc.save("w", parse(valid({ products: [{ id: theirs.id, name: "Hijack", description: "x" }] })));
    expect(svc.get("other").products).toEqual([{ id: theirs.id, name: "Theirs", description: "secret" }]);
    expect(svc.get("w").products.map((p) => p.name)).toEqual(["Hijack"]);
    expect(svc.get("w").products[0].id).not.toBe(theirs.id);
  });

  it("flags sample data so the form can warn", () => {
    db.insert(schema.campaigns).values({ id: "s", workspaceId: "w", name: "Demo", channel: "email", status: "active", source: "seed" }).run();
    expect(svc.get("w").sample).toBe(true);
    expect(svc.get("other").sample).toBe(false);
  });
});

describe("what you save is what the agent uses", () => {
  it("the brand tools return the new details, and the content policy enforces the new rules", async () => {
    svc.save("w", parse(valid({ approvedClaims: ["Set up in minutes"], prohibited: ["world-class"], allowedDomains: ["acme.com"] })));
    const tools = new ToolRunnerService(db);
    const run = new RunsService(db).start("w", "t");
    const brand = (await tools.run("w", run, "get_brand_guidelines", {})) as { result: { voice: string; approvedClaims: string[]; prohibited: string[]; allowedDomains: string[] } };
    expect(brand.result).toMatchObject({ voice: "Friendly and plain-spoken", approvedClaims: ["Set up in minutes"], prohibited: ["world-class"], allowedDomains: ["acme.com"] });
    const products = (await tools.run("w", run, "get_product_information", {})) as { result: { name: string }[] };
    expect(products.result.map((p) => p.name)).toEqual(["Acme Planner"]);

    const rules = { approvedClaims: brand.result.approvedClaims, prohibited: brand.result.prohibited, allowedDomains: brand.result.allowedDomains };
    expect(checkText("x", "A world-class planner", rules).map((v) => v.rule)).toContain("prohibited_phrase");
    expect(checkText("x", "Visit https://acme.com/go?utm_source=a&utm_medium=b&utm_campaign=c", rules)).toEqual([]);
    expect(checkText("x", "Visit https://evil.example/go?utm_source=a&utm_medium=b&utm_campaign=c", rules).map((v) => v.rule)).toContain("unapproved_domain");
  });
});
