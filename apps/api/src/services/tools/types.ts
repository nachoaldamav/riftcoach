import type { ToolInputSchema } from '@aws-sdk/client-bedrock-runtime';

export type UnknownRecord = Record<string, unknown>;

export type ToolRuntimeContext = {
  ctx: UnknownRecord;
};

export type ToolSpec = {
  name: string;
  description: string;
  schema: ToolInputSchema.JsonMember['json'];
  execute: (
    input: Record<string, unknown>,
    runtimeCtx: ToolRuntimeContext,
  ) => Promise<Record<string, unknown>>;
};