import {
  type ContentBlock,
  ConverseCommand,
  type Message,
  type ToolResultContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import consola from 'consola';
import z from 'zod';
import { bedrockClient } from '../clients/bedrock.js';
import { buildToolConfig, toolDefinitions } from './tools/index.js';
import type { ToolRuntimeContext } from './tools/types.js';

/**
 * ————————————————————————————————————————————————————————————————
 * Match Insights (Simplified)
 * ————————————————————————————————————————————————————————————————
 *
 * Minimal pipeline:
 * 1) Receive context (ctx)
 * 2) Build a compact prompt
 * 3) Let the model call tools (if it wants)
 * 4) Return validated JSON
 */

const CLAUDE_SMART_MODEL = 'anthropic.claude-3-5-sonnet-20240620-v1:0';
const MAX_TOOL_ITERATIONS = 6;
const SUMMARY_MAX_CHARS = 360;
const KEY_MOMENTS_MAX = 6;
const MACRO_LIST_MAX = 3;
const DRILLS_MAX = 3;

// ——— Schema ————————————————————————————————————————————————
const CoordinateSchema = z.object({ x: z.number(), y: z.number() });

export const MatchInsightsSchema = z.object({
  summary: z.string(),
  roleFocus: z.string(),
  keyMoments: z
    .array(
      z.object({
        ts: z.number(),
        title: z.string(),
        insight: z.string(),
        suggestion: z.string(),
        coordinates: z.array(CoordinateSchema).optional(),
        zone: z.string().optional(),
        enemyHalf: z.boolean().optional(),
      }),
    )
    .max(KEY_MOMENTS_MAX),
  macro: z.object({
    objectives: z.array(z.string()).max(MACRO_LIST_MAX),
    rotations: z.array(z.string()).max(MACRO_LIST_MAX),
    vision: z.array(z.string()).max(MACRO_LIST_MAX),
  }),
  drills: z.array(z.string()).min(DRILLS_MAX).max(DRILLS_MAX),
  confidence: z.number().min(0).max(1),
});

export type MatchInsights = z.infer<typeof MatchInsightsSchema>;

const DEFAULT_DRILLS = [
  'Review replay to understand lane trades.',
  'Practice last-hitting under pressure in training mode.',
  'Focus on minimap checks every wave for rotations.',
];

// ——— Prompt ————————————————————————————————————————————————
function buildPrompt(
  ctx: Record<string, unknown>,
  locale: string,
): { systemPrompt: string; userPrompt: string } {
  const schemaHint = [
    'Required JSON schema:',
    '{',
    `  "summary": string (max ${SUMMARY_MAX_CHARS} chars)`,
    '  "roleFocus": string',
    `  "keyMoments": [{ "ts": number, "title": string, "insight": string, "suggestion": string, "coordinates"?: [{"x": number, "y": number}], "zone"?: string, "enemyHalf"?: boolean }] (max ${KEY_MOMENTS_MAX}, min 4, SORTED BY ts ASC)`,
    `  "macro": { "objectives": string[] (max ${MACRO_LIST_MAX}), "rotations": string[] (max ${MACRO_LIST_MAX}), "vision": string[] (max ${MACRO_LIST_MAX}) }`,
    `  "drills": string[] (exactly ${DRILLS_MAX})`,
    '  "confidence": number (0..1)',
    '}',
  ].join('\n');

  const systemPrompt = [
    'You are RiftCoach, a League of Legends coaching assistant.',
    'Use ONLY the provided context. If data is missing, lower confidence and avoid fabrications.',
    'Return STRICT JSON matching the schema. No markdown, no extra text.',
    '',
    'Events policy:',
    'Only emit keyMoments that exist in Context.events. For kills: killerId=subject => kill; victimId=subject => death; else assisted.',
    'Context.events include `participantStates` with nearest-frame positions and `proximity.participants` listing nearby champions (team + inferredPosition). Use this to judge isolation or collapses.',
    '',
    'Naming:',
    'Prefer summonerName; otherwise championName. Times inside reasons/insights can be formatted as mm:ss. The property `ts` needs to be the actual events timestamp',
    '',
    'Quality:',
    'Be concise and actionable. Align zone/enemyHalf with coordinates when present.',
    schemaHint,
  ].join('\n');

  const userPrompt = [
    `Locale: ${locale}`,
    'Context (JSON):',
    JSON.stringify(ctx),
    'Return JSON only.',
  ].join('\n');

  return { systemPrompt, userPrompt };
}

// ——— Utilities ——————————————————————————————————————————————
function extractTextFromMessage(message: Message | undefined): string {
  if (!message?.content) return '';
  const textBlocks = message.content
    .map((block) => ('text' in block && block.text ? block.text : null))
    .filter((v): v is string => typeof v === 'string');
  const raw = textBlocks
    .join('\n')
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, '');
  return raw.replace('```json', '').replace('```', '').trim();
}

function enforceOutputLimits(insights: MatchInsights): MatchInsights {
  return {
    summary: insights.summary.slice(0, SUMMARY_MAX_CHARS),
    roleFocus: insights.roleFocus,
    keyMoments: insights.keyMoments.slice(0, KEY_MOMENTS_MAX).map((km) => ({
      ...km,
      coordinates: km.coordinates?.slice(0, 3),
    })),
    macro: {
      objectives: insights.macro.objectives.slice(0, MACRO_LIST_MAX),
      rotations: insights.macro.rotations.slice(0, MACRO_LIST_MAX),
      vision: insights.macro.vision.slice(0, MACRO_LIST_MAX),
    },
    drills: insights.drills.slice(0, DRILLS_MAX),
    confidence: Math.max(0, Math.min(1, insights.confidence)),
  };
}

// Keep a tiny reducer just to limit payload size (esp. events)
function reduceCtxForPrompt(
  ctx: Record<string, unknown>,
  maxEvents = 120,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...ctx };
  const events = (ctx as { events?: unknown }).events;
  if (Array.isArray(events)) {
    out.events = events.slice(0, Math.max(0, Math.trunc(maxEvents)));
  }
  return out;
}

// ——— Tool glue —————————————————————————————————————————————

type ToolUseBlock = {
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
};

type ToolRunResult = {
  status: 'success' | 'error';
  toolUseId: string;
  payload: Record<string, unknown> | string;
};

async function executeToolUse(
  toolUse: ToolUseBlock,
  ctx: ToolRuntimeContext,
): Promise<ToolRunResult> {
  const spec = toolDefinitions.find((t) => t.name === toolUse.name);
  if (!spec) {
    return {
      status: 'error',
      toolUseId: toolUse.toolUseId,
      payload: `Unknown tool ${toolUse.name}`,
    };
  }
  try {
    const payload = await spec.execute(toolUse.input ?? {}, ctx);
    return { status: 'success', toolUseId: toolUse.toolUseId, payload };
  } catch (error) {
    consola.error('[match-insights] tool execution failed', {
      toolUseId: toolUse.toolUseId,
      name: toolUse.name,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return {
      status: 'error',
      toolUseId: toolUse.toolUseId,
      payload: error instanceof Error ? error.message : 'Tool failure',
    };
  }
}

// ——— Main ————————————————————————————————————————————————
export async function generateMatchInsights(
  ctx: Record<string, unknown>,
  opts?: {
    modelId?: string;
    locale?: string;
    temperature?: number;
    maxTokens?: number;
  },
): Promise<MatchInsights> {
  const modelId = opts?.modelId ?? CLAUDE_SMART_MODEL;
  const locale = opts?.locale ?? 'en';

  // Build prompt with a lightly reduced context
  const promptCtx = reduceCtxForPrompt(ctx, 120);
  const { systemPrompt, userPrompt } = buildPrompt(promptCtx, locale);

  const messages: Message[] = [
    { role: 'user', content: [{ text: userPrompt }] },
  ];
  const toolConfig = buildToolConfig();
  const runtimeCtx: ToolRuntimeContext = { ctx };

  let finalMessage: Message | undefined;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const command = new ConverseCommand({
      modelId,
      system: [{ text: systemPrompt }],
      messages,
      toolConfig: { tools: toolConfig.tools },
      inferenceConfig: { maxTokens: 9000, temperature: 1 },
      additionalModelRequestFields: {
        reasoning_config: { type: 'enabled', budget_tokens: 1024 },
      },
    });

    const response = await bedrockClient.send(command);
    const assistantMessage =
      response.output && 'message' in response.output
        ? (response.output.message as Message)
        : undefined;

    if (!assistantMessage) throw new Error('No assistant message received');
    messages.push(assistantMessage);

    const toolUses = assistantMessage.content
      ?.map((block) => ('toolUse' in block ? block.toolUse : undefined))
      .filter(
        (block): block is typeof block & { toolUseId: string; name: string } =>
          !!block?.toolUseId && !!block?.name,
      )
      .map(
        (block): ToolUseBlock => ({
          toolUseId: block.toolUseId,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        }),
      );

    if (toolUses && toolUses.length > 0) {
      consola.info('[match-insights] tool calls', {
        iteration,
        tools: toolUses.map((t) => ({ name: t.name, toolUseId: t.toolUseId })),
      });

      const toolResults: ContentBlock[] = [];
      for (const toolUse of toolUses) {
        const start = Date.now();
        const result = await executeToolUse(toolUse, runtimeCtx);
        const content =
          result.status === 'success'
            ? [{ text: JSON.stringify(result.payload) }]
            : [{ text: String(result.payload) }];
        toolResults.push({
          toolResult: {
            toolUseId: toolUse.toolUseId,
            status: result.status,
            content,
          },
        });
        consola.debug('[match-insights] tool duration', {
          toolUseId: toolUse.toolUseId,
          name: toolUse.name,
          ms: Date.now() - start,
        });
      }

      messages.push({ role: 'user', content: toolResults });
      continue; // another turn for the model to read tool outputs
    }

    finalMessage = assistantMessage;
    break; // model produced a final answer
  }

  if (!finalMessage) finalMessage = messages[messages.length - 1];

  const aiText = extractTextFromMessage(finalMessage);
  consola.info(
    '[match-insights] AI response (truncated)',
    aiText.slice(0, 500),
  );

  try {
    const parsed = JSON.parse(aiText || '{}');
    const validated = MatchInsightsSchema.parse(parsed);
    return enforceOutputLimits(validated);
  } catch (error) {
    consola.error('[match-insights] failed to parse AI response', {
      error: error instanceof Error ? error.message : String(error),
      raw: aiText?.slice(0, 500) ?? '',
    });
    const fallback: MatchInsights = {
      summary: 'Unable to generate full insights at this time.',
      roleFocus: 'UNKNOWN',
      keyMoments: [],
      macro: { objectives: [], rotations: [], vision: [] },
      drills: DEFAULT_DRILLS,
      confidence: 0,
    };
    return enforceOutputLimits(fallback);
  }
}
