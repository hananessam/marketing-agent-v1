import { ChatOpenAI } from "@langchain/openai";
import type { Anomaly, CampaignFacts, DataQualityIssue } from "./analysis";
import { ModelReport } from "./report.schema";

export type RecommenderInput = {
  periods: { current: { startDate: string; endDate: string }; previous: { startDate: string; endDate: string } };
  facts: CampaignFacts[];
  anomalies: Anomaly[];
  dataQualityIssues: DataQualityIssue[];
  /** Validation errors from the previous attempt, if any. */
  feedback?: string[];
};

export interface Recommender {
  recommend(input: RecommenderInput): Promise<ModelReport>;
}
export const RECOMMENDER = Symbol("RECOMMENDER");

export const SYSTEM_PROMPT = `You are a marketing operations analyst.

Rules:
- Use ONLY the facts provided. Never invent metrics, claims, discounts or testimonials.
- Every recommendation must cite evidence: metric values copied EXACTLY (same number) from the facts, for the stated campaign and period.
- Return at most 3 recommendations, most important first. Each must be a specific, controllable, measurable and reversible action, not vague advice like "improve engagement".
- Do not infer success or failure from a single metric. Consider CTR vs conversion rate together (high CTR + low conversion suggests a landing-page problem; low clicks + strong conversion suggests weak creative or targeting).
- If a campaign has lowConfidence data (missing days, stale data), say so in caveats and prefer "investigate_tracking" before changing spend.
- Order by impact: address the highest-severity, non-lowConfidence anomaly first. Anomalies in the facts are pre-computed and ranked; build on them rather than re-deriving.
- Use "investigate_tracking" only for data-quality problems, never for "keep monitoring". For an efficient_spend_increase anomaly, consider a small, reversible "reallocate_budget" test.
- You only propose actions. You cannot publish, send, pause, or change budgets; a human approves those.
- Percentages in the facts are ratios (0.03 = 3%). In prose, round and write rates as percentages (e.g. 2.0%), money with 2 decimals; evidence values stay exact.`;

export class OpenAIRecommender implements Recommender {
  constructor(private readonly modelName = process.env.OPENAI_MODEL ?? "gpt-4.1-mini") {}

  async recommend(input: RecommenderInput): Promise<ModelReport> {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
    const model = new ChatOpenAI({ model: this.modelName }).withStructuredOutput(ModelReport, { name: "analytics_report" });
    const { feedback, ...facts } = input;
    const user =
      `Analyze campaign performance and recommend the next actions.\n\nFACTS (JSON):\n${JSON.stringify(facts)}` +
      (feedback?.length ? `\n\nYour previous answer was rejected. Fix these problems:\n- ${feedback.join("\n- ")}` : "");
    return ModelReport.parse(await model.invoke([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: user },
    ]));
  }
}
