import type { ZodType } from "zod";
import type { Db } from "../db";

export type ToolContext = { db: Db; workspaceId: string };

/** workspaceId always comes from the context, never from model-supplied args. */
export type ToolDefinition<I = unknown, O = unknown> = {
  name: string;
  description: string;
  readOnly: boolean;
  parameters: ZodType<I>;
  execute: (ctx: ToolContext, args: I) => O | Promise<O>;
};

export function defineTool<I, O>(t: ToolDefinition<I, O>): ToolDefinition<I, O> {
  return t;
}
