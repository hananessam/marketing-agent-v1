import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { CampaignBrief, CampaignPlan } from "@marketing/shared";
import { checkDraft, checkText, formatViolations, type BrandRules } from "./content-policy";
import type { ContentDraft } from "./content.schema";
import type { BrandContext, CampaignWriter } from "./writer";

export const MAX_ATTEMPTS = 2;

export type CampaignDeps = {
  brief: CampaignBrief;
  loadContext: () => Promise<BrandContext>;
  writer: CampaignWriter;
};

const State = Annotation.Root({
  context: Annotation<BrandContext>(),
  plan: Annotation<CampaignPlan | undefined>(),
  planErrors: Annotation<string[]>(),
  planAttempts: Annotation<number>(),
  content: Annotation<ContentDraft | undefined>(),
  contentErrors: Annotation<string[]>(),
  contentAttempts: Annotation<number>(),
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
    .addNode("load_context", async () => ({ context: await deps.loadContext(), planAttempts: 0, contentAttempts: 0, planErrors: [], contentErrors: [] }))
    .addNode("write_plan", async (s) => ({
      plan: await deps.writer.plan({ brief: deps.brief, context: s.context, feedback: s.planErrors.length ? s.planErrors : undefined }),
      planAttempts: s.planAttempts + 1,
    }))
    .addNode("check_plan", (s) => ({ planErrors: checkPlan(s.plan!, deps.brief, brandRules(s.context.brand)) }))
    .addNode("write_content", async (s) => ({
      content: await deps.writer.content({ brief: deps.brief, plan: s.plan!, context: s.context, feedback: s.contentErrors.length ? s.contentErrors : undefined }),
      contentAttempts: s.contentAttempts + 1,
    }))
    .addNode("check_content", (s) => ({ contentErrors: formatViolations(checkDraft(s.content!.assets, deps.brief.channels, brandRules(s.context.brand))) }))
    .addEdge(START, "load_context")
    .addEdge("load_context", "write_plan")
    .addEdge("write_plan", "check_plan")
    .addConditionalEdges("check_plan", (s) => (!s.planErrors.length ? "write_content" : s.planAttempts < MAX_ATTEMPTS ? "write_plan" : END))
    .addEdge("write_content", "check_content")
    .addConditionalEdges("check_content", (s) => (s.contentErrors.length && s.contentAttempts < MAX_ATTEMPTS ? "write_content" : END))
    .compile();
}
