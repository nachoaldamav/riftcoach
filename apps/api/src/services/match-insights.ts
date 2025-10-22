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

/**
 * ————————————————————————————————————————————————————————————————
 * NEW: Single Build Path + Branches (for the UI like your screenshot)
 * ————————————————————————————————————————————————————————————————
 *
 * This file introduces `buildPath`, a deterministic build line with
 * (a) core sequence, (b) boots choice, and (c) situational branches per slot.
 * The AI is asked to ground all items via tools and to avoid parroting the
 * user’s exact build unless it is provably optimal. Reasons are concise.
 */

const CLAUDE_SMART_MODEL = 'anthropic.claude-3-5-sonnet-20240620-v1:0';
const MAX_TOOL_ITERATIONS = 6;
const SUMMARY_MAX_CHARS = 360;
const KEY_MOMENTS_MAX = 6;
const MACRO_LIST_MAX = 3;
const DRILLS_MAX = 3;

const CoordinateSchema = z.object({ x: z.number(), y: z.number() });

// ——— Build Path V1 ————————————————————————————————————————
// 0..3: On-curve order guarantee, then branches per slot.
const BuildBranchSchema = z.object({
  label: z.string(), // e.g., "vs heavy MR", "vs burst + pick"
  when: z.string().optional(),
  add: z.array(z.number()).min(1),
  replace: z.array(z.number()).optional(), // replacement target(s) by ID
  reason: z.string().min(1),
});

const BuildSlotSchema = z.object({
  slot: z.enum(['mythic', '1st', '2nd', '3rd', '4th', '5th', '6th']),
  primary: z.array(z.number()).min(1), // usually a single item; allow combos like RFC+Statikk if ever
  branches: z.array(BuildBranchSchema).default([]),
});

const BootsChoiceSchema = z.object({
  options: z
    .array(
      z.object({
        id: z.number(),
        reason: z.string(),
        priority: z.number().min(0).max(1),
      }),
    )
    .min(1),
  policyNote: z.string().optional(),
});

const BuildPathSchema = z.object({
  starting: z.array(z.number()).max(5).default([]),
  early: z
    .array(z.object({ id: z.number(), note: z.string().optional() }))
    .max(6)
    .default([]),
  boots: BootsChoiceSchema,
  core: z.array(BuildSlotSchema).min(3).max(6),
  sellOrder: z.array(z.number()).default([]),
  rationale: z.string(),
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

  // NEW: Deterministic build line used by the UI
  buildPath: BuildPathSchema,

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

// ——— Mechanics helper ————————————————————————————————————————

type UnknownRecord = Record<string, unknown>;

type MechanicsSpec = {
  antiHealItemIds?: number[];
  championAbilities?: Record<string, string>;
  alreadyBuilt?: number[]; // subject completed items
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

function deriveExistingItems(ctx: UnknownRecord): number[] {
  const subj = (ctx as any)?.subject ?? {};
  const final: number[] = Array.isArray(subj.completedFinalItems)
    ? subj.completedFinalItems
    : Array.isArray(subj.finalItems)
      ? subj.finalItems
      : [];
  return final
    .filter((x: any) => Number.isFinite(Number(x)))
    .map((x: any) => Number(x));
}

// ——— Prompt ————————————————————————————————————————————

function buildPrompt(
  ctx: UnknownRecord,
  locale: string,
  mechanics: MechanicsSpec,
): { systemPrompt: string; userPrompt: string } {
  const BOOTS_IDS = [3006, 3009, 3020, 3047, 3111, 3117, 3158]; // Tier-2 boots

  const schemaHint = [
    'Required JSON schema:',
    '{',
    `  "summary": string (max ${SUMMARY_MAX_CHARS} chars)`,
    '  "roleFocus": string',
    `  "keyMoments": [{ "ts": number, "title": string, "insight": string, "suggestion": string, "coordinates"?: [{"x": number, "y": number}], "zone"?: string, "enemyHalf"?: boolean }] (max ${KEY_MOMENTS_MAX}, min 4, SORTED BY ts ASC)`,
    '  "buildPath": {',
    '      "starting": number[],',
    '      "early": [{"id": number, "note"?: string}] ,',
    '      "boots": { "options": [{"id": number, "reason": string, "priority": number (0..1)}], "policyNote"?: string },',
    '      "core": [{ "slot": "mythic"|"1st"|"2nd"|"3rd"|"4th"|"5th"|"6th", "primary": number[] (min 1), "branches": [{"label": string, "when"?: string, "add": number[] (min 1), "replace"?: number[], "reason": string}] }] (MAX 6 entries total; if "mythic" present, only include "1st".."5th"),',
    '      "sellOrder": number[],',
    '      "rationale": string',
    '  }',
    `  "macro": { "objectives": string[] (max ${MACRO_LIST_MAX}), "rotations": string[] (max ${MACRO_LIST_MAX}), "vision": string[] (max ${MACRO_LIST_MAX}) }`,
    `  "drills": string[] (exactly ${DRILLS_MAX})`,
    '  "confidence": number (0..1)',
    '}',
  ].join('\n');

  const systemPrompt = [
    'You are RiftCoach, a League of Legends coaching assistant.',
    'Respond with actionable, role-specific advice grounded ONLY in the provided context and tool results.',
    'Return STRICT JSON that matches the required schema. No markdown or prose outside JSON.',
    '',
    'Outcome handling:',
    'Set "outcome" to "WIN" or "LOSS" in your internal reasoning; mention the outcome in "summary".',
    '',
    'Role handling:',
    'When reasoning about role/lane, prefer subject/opponent participants’ "inferredPosition" from context over Riot raw fields.',
    '',
    'Events:',
    'Only create moments from Context.events. Do not invent events. For kills: killerId=subject => kill; victimId=subject => death; otherwise -> assisted.',
    '',
    'Naming & phrasing:',
    'Use summonerName if available; else championName. Use human lane names (top/mid/bot/river). Format times as mm:ss.',
    '',
    // — Boots and Build Path policy
    `Boots policy: Tier-2 boots IDs ${JSON.stringify(BOOTS_IDS)}.`,
    'Never recommend SELLING boots for another item. Only choose boots type based on enemy damage/CC. Include 1–3 options ranked with reasons.',
    '',
    // NEW: anti-parroting & grounding
    'BuildPath rules:',
    '- Base recommendations on common builds via tools (e.g., query_common_champion_builds, items_by_ids).',
    '- Use the provided mechanics.alreadyBuilt list to AVOID parroting the same build order. If a user-built item is still optimal, keep it but justify ordering; otherwise present a superior alternative or swap.',
    '- Include up to 2 situational branches per relevant slot that adapt to enemy comp (e.g., vs heavy MR/armor/heal/burst/poke/splitpush/shields). Every branch MUST include at least one item in "add"; if advice-only, omit the branch.',
    '- Each slot must include at least one ID in "primary" (min 1).',
    '- Total "core" entries must be <= 6 (including "mythic" if used). If you include "mythic", only use "1st".."5th" afterwards; otherwise use "1st".."6th" with no "mythic".',
    '- Ensure the core sequence is a coherent path (mythic → 1st → 2nd …).',
    '',
    'Quality:',
    'Be concise but complete: 1–2 sentences per reason. Lower confidence if evidence is weak. Align zone/enemyHalf with coordinates.',
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

// ——— Tool execution glue ——————————————————————————————

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
    buildPath: {
      starting: (insights.buildPath?.starting || [])
        .slice(0, 5)
        .map((id) => Math.trunc(id)),
      early: (insights.buildPath?.early || [])
        .slice(0, 6)
        .map((e) => ({ id: Math.trunc(e.id), note: e.note })),
      boots: {
        options: (insights.buildPath?.boots?.options || [])
          .slice(0, 3)
          .map((o) => ({
            id: Math.trunc(o.id),
            reason: o.reason,
            priority: Math.max(0, Math.min(1, o.priority)),
          })),
        policyNote: insights.buildPath?.boots?.policyNote,
      },
      core: (insights.buildPath?.core || []).slice(0, 6).map((slot) => ({
        slot: slot.slot,
        primary: (slot.primary || []).map((id) => Math.trunc(id)),
        branches: (slot.branches || []).slice(0, 4).map((b) => ({
          label: b.label,
          when: b.when,
          add: (b.add || []).map((id) => Math.trunc(id)),
          replace: b.replace?.map((id) => Math.trunc(id)),
          reason: b.reason,
        })),
      })),
      sellOrder: (insights.buildPath?.sellOrder || [])
        .slice(0, 3)
        .map((id) => Math.trunc(id)),
      rationale: insights.buildPath?.rationale || '',
    },
    macro: {
      objectives: insights.macro.objectives.slice(0, MACRO_LIST_MAX),
      rotations: insights.macro.rotations.slice(0, MACRO_LIST_MAX),
      vision: insights.macro.vision.slice(0, MACRO_LIST_MAX),
    },
    drills: insights.drills.slice(0, DRILLS_MAX),
    confidence: Math.max(0, Math.min(1, insights.confidence)),
  };
}

// ——— Normalizers for legacy goals —————————————————————————
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
  // buildPath coercions
  if (copy.buildPath && typeof copy.buildPath === 'object') {
    const bp = copy.buildPath;
    bp.starting = Array.isArray(bp.starting)
      ? bp.starting.map(Number).filter(Number.isFinite)
      : [];
    bp.early = Array.isArray(bp.early)
      ? bp.early.map((e: any) => ({ id: Number(e.id), note: e.note }))
      : [];
    if (bp.boots && Array.isArray(bp.boots.options)) {
      bp.boots.options = bp.boots.options.map((o: any) => ({
        id: Number(o.id),
        reason: o.reason,
        priority: Math.max(0, Math.min(1, Number(o.priority))),
      }));
    }
    bp.core = Array.isArray(bp.core)
      ? bp.core
          .map((s: any) => ({
            slot: s.slot,
            primary: Array.isArray(s.primary)
              ? s.primary.map(Number).filter(Number.isFinite)
              : [],
            branches: Array.isArray(s.branches)
              ? s.branches
                  .map((b: any) => ({
                    label: b.label,
                    when: b.when,
                    add: Array.isArray(b.add)
                      ? b.add.map(Number).filter(Number.isFinite)
                      : [],
                    replace: Array.isArray(b.replace)
                      ? b.replace.map(Number).filter(Number.isFinite)
                      : undefined,
                    reason: b.reason,
                  }))
                  .filter((b: any) => Array.isArray(b.add) && b.add.length > 0)
              : [],
          }))
          .filter((s: any) => Array.isArray(s.primary) && s.primary.length > 0)
           .slice(0, 6)
      : [];
    bp.sellOrder = Array.isArray(bp.sellOrder)
      ? bp.sellOrder.map(Number).filter(Number.isFinite)
      : [];
    copy.buildPath = bp;
  }
  return copy;
}

function derivePatchFromContext(ctx: UnknownRecord): string | undefined {
  const ctxItems = ctx.items as { patch?: string } | undefined;
  const infoObj = ctx.info as { gameVersion?: string } | undefined;
  return ctxItems?.patch ?? inferPatchFromGameVersion(infoObj?.gameVersion);
}

function reduceCtxForPrompt(
  ctx: UnknownRecord,
  opts?: { maxEvents?: number },
): UnknownRecord {
  const out: UnknownRecord = {};
  const maxEvents = Math.max(0, Math.trunc(opts?.maxEvents ?? 120));
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
      'inferredPosition',
    ]) {
      if (s[k] !== undefined) obj[k] = s[k];
    }
    return obj;
  }
  const subjectPruned = pruneSB((ctx as { subject?: unknown }).subject);
  const opponentPruned = pruneSB((ctx as { opponent?: unknown }).opponent);
  if (subjectPruned) out.subject = subjectPruned;
  if (opponentPruned) out.opponent = opponentPruned;
  const items = (ctx as { items?: unknown }).items;
  if (items && typeof items === 'object') out.items = items as UnknownRecord;
  const synergy = (ctx as { synergy?: unknown }).synergy;
  if (synergy && typeof synergy === 'object')
    out.synergy = synergy as UnknownRecord;
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
  const alreadyBuilt = deriveExistingItems(ctx);

  const mechanicsSpec: MechanicsSpec = {
    antiHealItemIds: Array.from(ITEM_GROUPS.GRIEVOUS_WOUNDS),
    alreadyBuilt,
    ...(Object.keys(championAbilitiesHints).length
      ? { championAbilities: championAbilitiesHints }
      : {}),
  };

  // reduce context
  let promptCtx = reduceCtxForPrompt(ctx, { maxEvents: 120 });
  let prompts = buildPrompt(promptCtx, locale, mechanicsSpec);
  const MAX_INPUT_CHARS = 100_000;
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
      inferenceConfig: { maxTokens, temperature },
    });

    const response = await bedrockClient.send(command);
    const assistantMessage =
      response.output && 'message' in response.output
        ? (response.output.message as Message)
        : undefined;
    if (!assistantMessage)
      throw new Error('No assistant message received from Claude');

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
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    finalMessage = assistantMessage;
    break;
  }

  if (!finalMessage) finalMessage = messages[messages.length - 1];

  const aiText = extractTextFromMessage(finalMessage);
  consola.info('[match-insights] AI response', finalMessage);
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
      buildPath: {
        starting: [],
        early: [],
        boots: {
          options: [{ id: 3047, reason: 'Default fallback', priority: 0.5 }],
        },
        core: [],
        sellOrder: [],
        rationale: '',
      },
      macro: { objectives: [], rotations: [], vision: [] },
      drills: DEFAULT_DRILLS,
      confidence: 0,
    };
    return enforceOutputLimits(fallback);
  }
}
