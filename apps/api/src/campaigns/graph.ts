import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { CampaignBrief, CampaignPlan } from "@marketing/shared";
import { checkAsset, checkDraft, checkText, formatViolations, isSoftViolation, maxLength, type BrandRules, type Violation } from "./content-policy";
import type { ContentDraft } from "./content.schema";
import type { BrandContext, CampaignWriter } from "./writer";

export const MAX_ATTEMPTS = 3;
/** Rounds of targeted shortening for over-length lines. */
export const MAX_REPAIRS = 2;

export type CampaignDeps = {
  brief: CampaignBrief;
  loadContext: () => Promise<BrandContext>;
  writer: CampaignWriter;
  /** Rewriting only the copy: start from this plan instead of planning again. */
  plan?: CampaignPlan;
  /** What the reviewer asked to change, and the wording to move away from. Only used with `plan`. */
  guidance?: string;
  previous?: string[];
};

const State = Annotation.Root({
  context: Annotation<BrandContext>(),
  plan: Annotation<CampaignPlan | undefined>(),
  planErrors: Annotation<string[]>(),
  planAttempts: Annotation<number>(),
  content: Annotation<ContentDraft | undefined>(),
  contentErrors: Annotation<string[]>(),
  contentViolations: Annotation<Violation[]>(),
  contentAttempts: Annotation<number>(),
  repairAttempts: Annotation<number>(),
  /** Lines that were over their limit and were rewritten automatically. */
  shortened: Annotation<{ where: string; from: number; to: number }[]>(),
});
export type CampaignState = typeof State.State;

export const brandRules = (brand: BrandContext["brand"]): BrandRules => ({
  approvedClaims: brand?.approvedClaims ?? [],
  prohibited: brand?.prohibited ?? [],
  allowedDomains: brand?.allowedDomains ?? [],
});

function checkPlan(plan: CampaignPlan, brief: CampaignBrief, brand: BrandRules): string[] {
  const errors = formatViolations([
    ...checkText("plan.positioning", plan.positioning, brand),
    ...checkText("plan.keyMessage", plan.keyMessage, brand),
  ]);
  for (const ch of plan.channels)
    if (!brief.channels.includes(ch.name as never)) errors.push(`plan.channels: "${ch.name}" was not requested (requested: ${brief.channels.join(", ")})`);
  if (!plan.experiments.length) errors.push("plan.experiments: include at least one experiment");
  return errors;
}

export function buildCampaignGraph(deps: CampaignDeps) {
  return new StateGraph(State)
    .addNode("load_context", async () => ({ context: await deps.loadContext(), plan: deps.plan, planAttempts: 0, contentAttempts: 0, repairAttempts: 0, planErrors: [], contentErrors: [], contentViolations: [], shortened: [] }))
    .addNode("write_plan", async (s) => ({
      plan: await deps.writer.plan({ brief: deps.brief, context: s.context, feedback: s.planErrors.length ? s.planErrors : undefined }),
      planAttempts: s.planAttempts + 1,
    }))
    .addNode("check_plan", (s) => ({ planErrors: checkPlan(s.plan!, deps.brief, brandRules(s.context.brand)) }))
    .addNode("write_content", async (s) => ({
      content: await deps.writer.content({ brief: deps.brief, plan: s.plan!, context: s.context, feedback: s.contentErrors.length ? s.contentErrors : undefined, guidance: deps.guidance, previous: deps.previous }),
      contentAttempts: s.contentAttempts + 1,
    }))
    .addNode("check_content", (s) => {
      const violations = checkDraft(s.content!.assets, deps.brief.channels, brandRules(s.context.brand));
      return { contentViolations: violations, contentErrors: formatViolations(violations) };
    })
    .addNode("fix_lengths", async (s) => {
      const brand = brandRules(s.context.brand);
      const assets = s.content!.assets.map((a) => ({ ...a }));
      const log = [...s.shortened];
      await Promise.all(assets.map(async (a, i) => {
        if (!checkAsset(a, brand).some((v) => v.rule === "too_long")) return;
        const limit = maxLength(a.channel, a.kind)!;
        const siblings = assets.filter((x, j) => j !== i && x.channel === a.channel && x.kind === a.kind).map((x) => x.content);
        let candidates: string[] = [];
        try {
          candidates = await deps.writer.shorten({ asset: a, limit, brief: deps.brief, context: s.context, siblings });
        } catch {
          // A failed rewrite is not fatal: the line stays flagged for a person to fix.
        }
        // The model proposes; we measure. A candidate must fit, keep every other brand rule, and differ from its siblings.
        const pick = candidates.map((c) => c.trim()).find((c) => c.length > 0 && c.length <= limit && !siblings.includes(c) && checkAsset({ ...a, content: c }, brand).length === 0);
        if (pick) {
          log.push({ where: `${a.channel}/${a.kind}/${a.variant}`, from: a.content.length, to: pick.length });
          assets[i] = { ...a, content: pick };
        }
      }));
      return { content: { assets }, shortened: log, repairAttempts: s.repairAttempts + 1 };
    })
    .addEdge(START, "load_context")
    .addConditionalEdges("load_context", () => (deps.plan ? "write_content" : "write_plan"))
    .addEdge("write_plan", "check_plan")
    .addConditionalEdges("check_plan", (s) => (!s.planErrors.length ? "write_content" : s.planAttempts < MAX_ATTEMPTS ? "write_plan" : END))
    .addEdge("write_content", "check_content")
    .addConditionalEdges("check_content", (s) => {
      if (!s.contentErrors.length) return END;
      // Rule breaks (banned words, bad links, missing channels) need the whole draft rewritten...
      if (s.contentViolations.some((v) => !isSoftViolation(v))) return s.contentAttempts < MAX_ATTEMPTS ? "write_content" : END;
      // ...but if only lengths are off, fix just those lines and leave the rest of the draft alone.
      return s.repairAttempts < MAX_REPAIRS ? "fix_lengths" : END;
    })
    .addEdge("fix_lengths", "check_content")
    .compile();
}
