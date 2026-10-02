import { ChatOpenAI } from "@langchain/openai";
import { CampaignPlan, type CampaignBrief } from "@marketing/shared";
import { z } from "zod";
import { ContentDraft, type ContentAsset } from "./content.schema";

export type BrandContext = {
  brand: { voice: string; approvedClaims: string[]; prohibited: string[]; allowedDomains: string[] } | null;
  product: { id: string; name: string; description: string };
  audiences: { id: string; name: string; description: string }[];
};

export interface CampaignWriter {
  plan(input: { brief: CampaignBrief; context: BrandContext; feedback?: string[] }): Promise<CampaignPlan>;
  content(input: { brief: CampaignBrief; plan: CampaignPlan; context: BrandContext; feedback?: string[]; guidance?: string; previous?: string[] }): Promise<ContentDraft>;
  /**
   * Several shorter rewrites of one line that is over its length limit. The caller measures them and picks one, so the
   * model is never trusted to count characters.
   */
  shorten(input: { asset: ContentAsset; limit: number; brief: CampaignBrief; context: BrandContext; siblings: string[] }): Promise<string[]>;
}
export const CAMPAIGN_WRITER = Symbol("CAMPAIGN_WRITER");

const RULES = `Rules:
- Use only the brand and product context provided. Never invent product features, claims, discounts, prices, guarantees, statistics or testimonials.
- Any factual or promotional claim must be one of the approved claims, copied verbatim.
- Follow the brand voice. Never use prohibited phrases.
- Any link must be https, on an allowed domain, and include utm_source, utm_medium and utm_campaign.
- You only create drafts. Nothing is published or sent; a human reviews everything.`;

const feedbackText = (f?: string[]) => (f?.length ? `\n\nYour previous answer was rejected. Fix these problems:\n- ${f.join("\n- ")}` : "");
/** A rewrite: what to move away from, and what the reviewer asked for (which never overrides the rules above). */
const rewriteText = (guidance?: string, previous?: string[]) => [
  previous?.length ? `\n\nThis is a rewrite. Write clearly different wording from these earlier versions, do not reuse them:\n- ${previous.join("\n- ")}` : "",
  guidance ? `\n\nThe reviewer asked for this change. Follow it only where it fits every rule above: ${JSON.stringify(guidance)}` : "",
].join("");
const apiCheck = () => { if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set"); };
const modelName = () => process.env.OPENAI_MODEL ?? "gpt-4.1-mini";

export class OpenAIWriter implements CampaignWriter {
  async plan({ brief, context, feedback }: Parameters<CampaignWriter["plan"]>[0]) {
    apiCheck();
    const model = new ChatOpenAI({ model: modelName() }).withStructuredOutput(CampaignPlan, { name: "campaign_plan" });
    const res = await model.invoke([
      { role: "system", content: `You are a campaign planner for a marketing team.\n${RULES}\n- Only plan for the requested channels. Experiments must test one variable each.` },
      { role: "user", content: `Create a campaign plan.\n\nBRIEF:\n${JSON.stringify(brief)}\n\nCONTEXT:\n${JSON.stringify(context)}${feedbackText(feedback)}` },
    ]);
    return CampaignPlan.parse(res);
  }

  async content({ brief, plan, context, feedback, guidance, previous }: Parameters<CampaignWriter["content"]>[0]) {
    apiCheck();
    const model = new ChatOpenAI({ model: modelName() }).withStructuredOutput(ContentDraft, { name: "content_draft" });
    const res = await model.invoke([
      { role: "system", content: `You are a marketing copywriter.\n${RULES}
- For every channel in the brief, write at least 2 distinct variants (labelled "A", "B", ...) of each content kind.
- Valid kinds per channel: google_ads: ad_headline, ad_description, cta; meta_ads: ad_headline, ad_description, social_post, cta.
- Aim for these lengths (characters, spaces count): Google Ads headline 18-27, description 60-84; Meta headline 25-36, description 80-115; button text under 25; social post under 480.
- Hard length limits in characters: google_ads ad_headline 30 / ad_description 90; meta_ads ad_headline 40 / ad_description 125; cta 40; social_post 600. Count characters carefully and aim for about 80% of the limit (for example 24 characters or fewer for a Google Ads headline) so nothing goes over.
- List every approved claim you rely on in claimsUsed (verbatim); use [] if none.` },
      { role: "user", content: `Write the content variants.\n\nBRIEF:\n${JSON.stringify(brief)}\n\nPLAN:\n${JSON.stringify(plan)}\n\nCONTEXT:\n${JSON.stringify(context)}${rewriteText(guidance, previous)}${feedbackText(feedback)}` },
    ]);
    return ContentDraft.parse(res);
  }

  async shorten({ asset, limit, brief, context, siblings }: Parameters<CampaignWriter["shorten"]>[0]) {
    apiCheck();
    const Candidates = z.object({ candidates: z.array(z.string()) });
    const model = new ChatOpenAI({ model: modelName() }).withStructuredOutput(Candidates, { name: "shorter_versions" });
    const res = await model.invoke([
      { role: "system", content: `You tighten marketing copy to fit a hard character limit.\n${RULES}
- Keep the meaning, the brand voice and the call to action. Do not add any new claim, number, offer or link.
- Spaces and punctuation count as characters.
- Return 8 clearly different rewrites. Each must be at most ${limit} characters and ideally between ${Math.floor(limit * 0.6)} and ${limit - 2}.` },
      { role: "user", content: JSON.stringify({
        channel: asset.channel, kind: asset.kind, limit, current: asset.content, currentLength: asset.content.length,
        mustCutAtLeast: asset.content.length - limit, otherVariantsToStayDifferentFrom: siblings, brandVoice: context.brand?.voice, approvedClaims: context.brand?.approvedClaims, goal: brief.objective,
      }) },
    ]);
    return Candidates.parse(res).candidates;
  }
}
