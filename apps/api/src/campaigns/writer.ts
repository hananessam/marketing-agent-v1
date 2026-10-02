import { ChatOpenAI } from "@langchain/openai";
import { CampaignPlan, type CampaignBrief } from "@marketing/shared";
import { ContentDraft } from "./content.schema";

export type BrandContext = {
  brand: { voice: string; approvedClaims: string[]; prohibited: string[]; allowedDomains: string[] } | null;
  product: { id: string; name: string; description: string };
  audiences: { id: string; name: string; description: string }[];
};

export interface CampaignWriter {
  plan(input: { brief: CampaignBrief; context: BrandContext; feedback?: string[] }): Promise<CampaignPlan>;
  content(input: { brief: CampaignBrief; plan: CampaignPlan; context: BrandContext; feedback?: string[] }): Promise<ContentDraft>;
}
export const CAMPAIGN_WRITER = Symbol("CAMPAIGN_WRITER");

const RULES = `Rules:
- Use only the brand and product context provided. Never invent product features, claims, discounts, prices, guarantees, statistics or testimonials.
- Any factual or promotional claim must be one of the approved claims, copied verbatim.
- Follow the brand voice. Never use prohibited phrases.
- Any link must be https, on an allowed domain, and include utm_source, utm_medium and utm_campaign.
- You only create drafts. Nothing is published or sent; a human reviews everything.`;

const feedbackText = (f?: string[]) => (f?.length ? `\n\nYour previous answer was rejected. Fix these problems:\n- ${f.join("\n- ")}` : "");
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

  async content({ brief, plan, context, feedback }: Parameters<CampaignWriter["content"]>[0]) {
    apiCheck();
    const model = new ChatOpenAI({ model: modelName() }).withStructuredOutput(ContentDraft, { name: "content_draft" });
    const res = await model.invoke([
      { role: "system", content: `You are a marketing copywriter.\n${RULES}
- For every channel in the brief, write at least 2 distinct variants (labelled "A", "B", ...) of each content kind.
- Valid kinds per channel: email: email_subject, email_body, cta; google_ads: ad_headline, ad_description, cta; meta_ads/linkedin: ad_headline, ad_description, social_post, cta; blog: landing_copy, cta.
- Hard length limits in characters: google_ads ad_headline 30 / ad_description 90; meta_ads ad_headline 40 / ad_description 125; linkedin ad_headline 70 / ad_description 150; email_subject 70; cta 40; social_post 600. Count characters carefully and aim for about 80% of the limit (for example 24 characters or fewer for a Google Ads headline) so nothing goes over.
- List every approved claim you rely on in claimsUsed (verbatim); use [] if none.` },
      { role: "user", content: `Write the content variants.\n\nBRIEF:\n${JSON.stringify(brief)}\n\nPLAN:\n${JSON.stringify(plan)}\n\nCONTEXT:\n${JSON.stringify(context)}${feedbackText(feedback)}` },
    ]);
    return ContentDraft.parse(res);
  }
}
