import { inspect } from 'node:util';
import {
  type ContentBlock,
  ConverseCommand,
  type Message,
  type ToolResultContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import { ITEM_GROUPS } from '@riftcoach/shared.constants';
import consola from 'consola';
import type { Document } from 'mongodb';
import z from 'zod';
import { bedrockClient } from '../clients/bedrock.js';
import {
  type DDragonChampion,
  findChampionByName,
  getChampionMap,
} from '../utils/ddragon-champions.js';
import { inferPatchFromGameVersion } from '../utils/ddragon-items.js';
import { buildToolConfig, toolDefinitions } from './tools/index.js';
import type { ToolRuntimeContext } from './tools/types.js';

const CLAUDE_SMART_MODEL = 'anthropic.claude-3-5-sonnet-20240620-v1:0';
const MAX_TOOL_ITERATIONS = 6;
const SUMMARY_MAX_CHARS = 360;
const KEY_MOMENTS_MAX = 6;
const MACRO_LIST_MAX = 3;
const DRILLS_MAX = 3;

const CoordinateSchema = z.object({
  x: z.number(),
  y: z.number(),
});

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
  buildNotesV2: z
    .array(
      z.object({
        when: z.string(),
        goal: z.enum([
          'anti-heal',
          'burst',
          'sustain',
          'survivability',
          'siege',
          'waveclear',
          'armor-pen',
          'magic-pen',
          'on-hit',
          'cdr',
          'utility',
        ]),
        suggestion: z.object({
          add: z.array(z.number()).default([]),
          replace: z.array(z.number()).optional(),
          timingHint: z.string().optional(),
        }),
        reason: z.string(),
        confidence: z.number().min(0).max(1).default(0.5),
      }),
    )
    .max(8)
    .default([]),
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

type UnknownRecord = Record<string, unknown>;

type MechanicsSpec = {
  antiHealItemIds?: number[];
  championAbilities?: Record<string, string>;
};

function buildAbilityHintFromDDragon(ch: DDragonChampion): string {
  const texts: string[] = [];
  if (ch.passive?.sanitizedDescription)
    texts.push(ch.passive.sanitizedDescription);
  if (ch.passive?.description) texts.push(ch.passive.description);
  for (const s of ch.spells ?? []) {
    if (s?.sanitizedDescription) texts.push(s.sanitizedDescription as string);
    else if (s?.description) texts.push(s.description as string);
    else if (s?.tooltip) texts.push(s.tooltip as string);
  }
  const blob = texts.join(' ').toLowerCase();
  const hasHeal = /(\bheal\b|\bheals\b|healing|restore|regenerat)/i.test(blob);
  const hasShield = /\bshield/i.test(blob);
  const mentionsGW = /(grievous|anti-?heal)/i.test(blob);
  const parts: string[] = [];
  if (hasHeal) parts.push('Has healing or sustain tools.');
  if (hasShield) parts.push('Can provide shields.');
  if (!hasHeal && !hasShield) parts.push('No native heal or shield.');
  parts.push(
    mentionsGW
      ? 'Can apply anti-heal directly—track cooldown timing.'
      : 'Needs items to apply anti-heal.',
  );
  return parts.join(' ');
}

async function deriveChampionAbilityHints(
  ctx: UnknownRecord,
  names: string[],
  patch?: string,
): Promise<Record<string, string>> {
  try {
    const resolvedPatch =
      patch ??
      inferPatchFromGameVersion(
        (ctx.info as { gameVersion?: string } | undefined)?.gameVersion,
      );
    if (!resolvedPatch) return {};
    const champMap = await getChampionMap(resolvedPatch);
    const hints: Record<string, string> = {};
    for (const name of names) {
      const ch = findChampionByName(name, champMap);
      if (ch) hints[name] = buildAbilityHintFromDDragon(ch);
    }
    return hints;
  } catch (error) {
    consola.warn('[match-insights] ability hint load failed', error);
    return {};
  }
}

function buildPrompt(
  ctx: UnknownRecord,
  locale: string,
  mechanics: MechanicsSpec,
): { systemPrompt: string; userPrompt: string } {
  const schemaHint = [
    'Required JSON schema:',
    '{',
    `  "summary": string (max ${SUMMARY_MAX_CHARS} chars)`,
    '  "roleFocus": string',
    `  "keyMoments": [{ "ts": number, "title": string, "insight": string, "suggestion": string, "coordinates"?: [{"x": number, "y": number}], "zone"?: string, "enemyHalf"?: boolean }] (max ${KEY_MOMENTS_MAX})`,
    '  "buildNotesV2": [{ "when": string, "goal": "anti-heal"|"burst"|"sustain"|"survivability"|"siege"|"waveclear"|"armor-pen"|"magic-pen"|"on-hit"|"cdr"|"utility", "suggestion": { "add": number[], "replace"?: number[], "timingHint"?: string }, "reason": string, "confidence": number }]',
    `  "macro": { "objectives": string[] (max ${MACRO_LIST_MAX}), "rotations": string[] (max ${MACRO_LIST_MAX}), "vision": string[] (max ${MACRO_LIST_MAX}) }`,
    `  "drills": string[] (exactly ${DRILLS_MAX})`,
    '  "confidence": number (0..1)',
    '}',
  ].join('\n');

  const systemPrompt = [
    'You are RiftCoach, a League of Legends coaching assistant.',
    'Respond with actionable, role-specific advice grounded only in provided context.',
    'Return STRICT JSON that matches the required schema. No markdown or prose outside JSON.',
    'Use tools when you need additional data (items, builds, stats, coordinates).',
    'Treat inventory.completedItemIds as already filtered to completed items—avoid recommending unfinished components.',
    "When suggesting build changes (buildNotesV2), base them ONLY on other players' common builds via tools: use query_common_champion_builds for the subject's champion and role; do not invent items beyond tool outputs.",
    '`ts` should be the timestamp provided in the specific event that the moment occurs.',
    schemaHint,
  ].join('\n');

  const userPrompt = [
    `Locale: ${locale}`,
    'Mechanics (JSON):',
    JSON.stringify(mechanics),
    'Context (JSON):',
    JSON.stringify(ctx),
    'Return JSON only.',
  ].join('\n');

  return { systemPrompt, userPrompt };
}

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

function extractTextFromMessage(message: Message | undefined): string {
  if (!message?.content) return '';
  const textBlocks = message.content
    .map((block) => ('text' in block && block.text ? block.text : null))
    .filter((v): v is string => typeof v === 'string');
  return textBlocks.join('\n').replace('```json', '').replace('```', '').trim();
}

function enforceOutputLimits(insights: MatchInsights): MatchInsights {
  return {
    summary: insights.summary.slice(0, SUMMARY_MAX_CHARS),
    roleFocus: insights.roleFocus,
    keyMoments: insights.keyMoments.slice(0, KEY_MOMENTS_MAX).map((km) => ({
      ...km,
      insight: km.insight,
      suggestion: km.suggestion,
      coordinates: km.coordinates?.slice(0, 3),
    })),
    buildNotesV2: (insights.buildNotesV2 || []).slice(0, 8).map((note) => ({
      ...note,
      suggestion: {
        add: (note.suggestion.add || []).map((id) => Math.trunc(id)),
        replace: note.suggestion.replace?.map((id) => Math.trunc(id)),
        timingHint: note.suggestion.timingHint,
      },
      confidence: Math.max(0, Math.min(1, note.confidence)),
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

// Normalize AI output before schema validation to coerce goal values and numbers
const GOAL_VALUES = [
  'anti-heal',
  'burst',
  'sustain',
  'survivability',
  'siege',
  'waveclear',
  'armor-pen',
  'magic-pen',
  'on-hit',
  'cdr',
  'utility',
] as const;

type GoalValue = (typeof GOAL_VALUES)[number];

function canonicalizeGoal(v: string): string {
  return v
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]/g, '');
}

const goalCanonicalToEnum: Record<string, GoalValue> = {
  antiheal: 'anti-heal',
  burst: 'burst',
  sustain: 'sustain',
  survivability: 'survivability',
  siege: 'siege',
  waveclear: 'waveclear',
  armorpen: 'armor-pen',
  magicpen: 'magic-pen',
  onhit: 'on-hit',
  cdr: 'cdr',
  utility: 'utility',
};

const goalSynonyms: Record<string, GoalValue> = {
  grievouswounds: 'anti-heal',
  grievous: 'anti-heal',
  healingreduction: 'anti-heal',
  antihealing: 'anti-heal',
  armorpenetration: 'armor-pen',
  lethality: 'armor-pen',
  antiarmor: 'armor-pen',
  magicpenetration: 'magic-pen',
  abilityhaste: 'cdr',
  cooldown: 'cdr',
  cooldowns: 'cdr',
  haste: 'cdr',
  onhiteffects: 'on-hit',
  oneshot: 'burst',
  execute: 'burst',
  combo: 'burst',
  poke: 'siege',
  waveclearance: 'waveclear',
  waveclearer: 'waveclear',
  push: 'waveclear',
  shove: 'waveclear',
  healing: 'sustain',
  lifesteal: 'sustain',
  vamp: 'sustain',
  omnivamp: 'sustain',
  defense: 'survivability',
  durability: 'survivability',
  tankiness: 'survivability',
  defensive: 'survivability',
  support: 'utility',
  cc: 'utility',
  crowdcontrol: 'utility',
  vision: 'utility',
};

function normalizeGoalValue(value: unknown): GoalValue | undefined {
  if (typeof value !== 'string') return undefined;
  const key = canonicalizeGoal(value);
  return goalCanonicalToEnum[key] ?? goalSynonyms[key];
}

function normalizeAIInsightsOutput(output: any): any {
  if (!output || typeof output !== 'object') return output;
  const copy: any = { ...output };
  if (Array.isArray(copy.buildNotesV2)) {
    copy.buildNotesV2 = copy.buildNotesV2.map((note: any) => {
      const n: any = { ...note };
      const normalizedGoal = normalizeGoalValue(n.goal);
      n.goal = normalizedGoal ?? 'utility';
      if (n.suggestion && typeof n.suggestion === 'object') {
        const s = { ...n.suggestion };
        s.add = Array.isArray(s.add)
          ? s.add
              .map((x: any) => Number(x))
              .filter((x: number) => Number.isFinite(x))
          : [];
        if (Array.isArray(s.replace)) {
          s.replace = s.replace
            .map((x: any) => Number(x))
            .filter((x: number) => Number.isFinite(x));
        } else {
          delete s.replace;
        }
        n.suggestion = s;
      }
      return n;
    });
  }
  return copy;
}

function derivePatchFromContext(ctx: UnknownRecord): string | undefined {
  const ctxItems = ctx.items as { patch?: string } | undefined;
  const infoObj = ctx.info as { gameVersion?: string } | undefined;
  return ctxItems?.patch ?? inferPatchFromGameVersion(infoObj?.gameVersion);
}

// Add a reducer to prune heavy fields from the match context before prompting
function reduceCtxForPrompt(
  ctx: UnknownRecord,
  opts?: { maxEvents?: number },
): UnknownRecord {
  const out: UnknownRecord = {};

  const maxEvents = Math.max(0, Math.trunc(opts?.maxEvents ?? 120));

  // Shallow base properties commonly used by the model
  const baseKeys = [
    'matchId',
    'gameCreation',
    'gameDuration',
    'gameMode',
    'gameVersion',
    'mapId',
    'queueId',
  ];
  for (const k of baseKeys) {
    const v = (ctx as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = v;
  }

  // Subject/opponent minimal shapes
  function pruneSB(raw: unknown): UnknownRecord | null {
    if (!raw || typeof raw !== 'object') return null;
    const s = raw as Record<string, unknown>;
    const obj: UnknownRecord = {};
    for (const k of [
      'participantId',
      'puuid',
      'summonerName',
      'teamId',
      'teamPosition',
      'championId',
      'championName',
      'summoner1Id',
      'summoner2Id',
      'finalItems',
      'completedFinalItems',
    ]) {
      if (s[k] !== undefined) obj[k] = s[k];
    }
    return obj;
  }

  const subjectPruned = pruneSB((ctx as { subject?: unknown }).subject);
  const opponentPruned = pruneSB((ctx as { opponent?: unknown }).opponent);
  if (subjectPruned) out.subject = subjectPruned;
  if (opponentPruned) out.opponent = opponentPruned;

  // Items block (already reduced at route level)
  const items = (ctx as { items?: unknown }).items;
  if (items && typeof items === 'object') out.items = items as UnknownRecord;

  // Synergy info is small
  const synergy = (ctx as { synergy?: unknown }).synergy;
  if (synergy && typeof synergy === 'object')
    out.synergy = synergy as UnknownRecord;

  // Events: keep only essential fields and cap the count
  const eventsRaw = (ctx as { events?: unknown }).events as unknown;
  if (Array.isArray(eventsRaw) && maxEvents > 0) {
    const prunedEvents = eventsRaw.slice(0, maxEvents).map((e) => {
      const ev = e as Record<string, unknown>;
      const pos = ev.position as { x?: number; y?: number } | null | undefined;
      const position =
        pos && typeof pos === 'object'
          ? { x: Number(pos.x ?? 0), y: Number(pos.y ?? 0) }
          : null;
      return {
        type: ev.type,
        timestamp: ev.timestamp,
        phase: ev.phase,
        zone: ev.zone,
        enemyHalf: ev.enemyHalf,
        position,
        killerId: ev.killerId ?? null,
        victimId: ev.victimId ?? null,
      } as UnknownRecord;
    });
    out.events = prunedEvents as unknown as UnknownRecord;
  }

  // Explicitly omit large collections like participants, teams, participantsBasic
  // by not copying them over.

  return out;
}

export async function generateMatchInsights(
  ctx: UnknownRecord,
  opts?: {
    modelId?: string;
    locale?: string;
    temperature?: number;
    maxTokens?: number;
  },
): Promise<MatchInsights> {
  const modelId = opts?.modelId ?? CLAUDE_SMART_MODEL;
  const locale = opts?.locale ?? 'en';
  const temperature = opts?.temperature ?? 0.2;
  const maxTokens = opts?.maxTokens ?? 9000;

  type CtxSubject = { championName?: unknown };
  type CtxOpponent = { championName?: unknown };
  type CtxSynergy = { partnerChampion?: unknown };

  const subjectObj = (ctx as { subject?: unknown }).subject;
  const opponentObj = (ctx as { opponent?: unknown }).opponent;
  const synergyObj = (ctx as { synergy?: unknown }).synergy;

  const subjectName =
    subjectObj && typeof (subjectObj as CtxSubject).championName === 'string'
      ? ((subjectObj as CtxSubject).championName as string)
      : undefined;
  const opponentName =
    opponentObj && typeof (opponentObj as CtxOpponent).championName === 'string'
      ? ((opponentObj as CtxOpponent).championName as string)
      : undefined;
  const partnerName =
    synergyObj && typeof (synergyObj as CtxSynergy).partnerChampion === 'string'
      ? ((synergyObj as CtxSynergy).partnerChampion as string)
      : undefined;

  const names = [subjectName, opponentName, partnerName].filter(
    Boolean,
  ) as string[];
  const patch = derivePatchFromContext(ctx);
  const championAbilitiesHints = await deriveChampionAbilityHints(
    ctx,
    names,
    patch,
  );

  const mechanicsSpec: MechanicsSpec = {
    antiHealItemIds: Array.from(ITEM_GROUPS.GRIEVOUS_WOUNDS),
    ...(Object.keys(championAbilitiesHints).length
      ? { championAbilities: championAbilitiesHints }
      : {}),
  };

  // Use reduced context for the prompt to keep input size safe
  let promptCtx = reduceCtxForPrompt(ctx, { maxEvents: 120 });
  let prompts = buildPrompt(promptCtx, locale, mechanicsSpec);
  const MAX_INPUT_CHARS = 100_000; // conservative bound
  let totalLen = prompts.systemPrompt.length + prompts.userPrompt.length;

  if (totalLen > MAX_INPUT_CHARS) {
    for (const cap of [80, 40, 20, 0]) {
      promptCtx = reduceCtxForPrompt(ctx, { maxEvents: cap });
      prompts = buildPrompt(promptCtx, locale, mechanicsSpec);
      totalLen = prompts.systemPrompt.length + prompts.userPrompt.length;
      if (totalLen <= MAX_INPUT_CHARS) break;
    }
  }

  const { systemPrompt, userPrompt } = prompts;

  const messages: Message[] = [
    {
      role: 'user',
      content: [{ text: userPrompt }],
    },
  ];

  const toolConfig = buildToolConfig();
  const runtimeCtx: ToolRuntimeContext = { ctx };

  let finalMessage: Message | undefined;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const command = new ConverseCommand({
      modelId,
      system: [{ text: systemPrompt }],
      messages,
      toolConfig: {
        tools: toolConfig.tools,
      },
      inferenceConfig: {
        maxTokens,
        temperature,
      },
    });

    const response = await bedrockClient.send(command);
    const assistantMessage =
      response.output && 'message' in response.output
        ? (response.output.message as Message)
        : undefined;
    if (!assistantMessage) {
      throw new Error('No assistant message received from Claude');
    }

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
      consola.info('[match-insights] AI requested tool calls', {
        iteration,
        tools: toolUses.map((t) => ({ name: t.name, toolUseId: t.toolUseId })),
      });
      const toolResults: ContentBlock[] = [];
      for (const toolUse of toolUses) {
        const start = Date.now();
        consola.debug('[match-insights] AI requested tool call', {
          toolUseId: toolUse.toolUseId,
          name: toolUse.name,
          input: toolUse.input,
        });
        const result = await executeToolUse(toolUse, runtimeCtx);
        const content: ToolResultContentBlock[] =
          result.status === 'success'
            ? [{ json: result.payload as Document }]
            : [{ text: String(result.payload) }];
        toolResults.push({
          toolResult: {
            toolUseId: toolUse.toolUseId,
            status: result.status,
            content,
          },
        });
        consola.debug('[match-insights] AI tool call duration', {
          toolUseId: toolUse.toolUseId,
          name: toolUse.name,
          duration: Date.now() - start,
          result: JSON.stringify(result),
        });
      }
      messages.push({
        role: 'user',
        content: toolResults,
      });
      continue;
    }

    finalMessage = assistantMessage;
    break;
  }

  if (!finalMessage) {
    finalMessage = messages[messages.length - 1];
  }

  const aiText = extractTextFromMessage(finalMessage);
  consola.info('[match-insights] AI response', aiText);
  try {
    const parsed = JSON.parse(aiText || '{}');
    const normalized = normalizeAIInsightsOutput(parsed);
    const validated = MatchInsightsSchema.parse(normalized);
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
      buildNotesV2: [],
      macro: { objectives: [], rotations: [], vision: [] },
      drills: DEFAULT_DRILLS,
      confidence: 0,
    };
    return enforceOutputLimits(fallback);
  }
}
