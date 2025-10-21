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
  drills: z.array(z.string()).min(3).max(DRILLS_MAX),
  confidence: z.number().min(0).max(1),
});

export type MatchInsights = z.infer<typeof MatchInsightsSchema>;

// BuildNoteV2 contract type
export type BuildNoteV2 = {
  when: 'early' | 'mid' | 'late' | `@t=${number}` | string;
  goal:
    | 'anti-heal'
    | 'burst'
    | 'sustain'
    | 'survivability'
    | 'siege'
    | 'waveclear'
    | 'armor-pen'
    | 'magic-pen'
    | 'on-hit'
    | 'cdr'
    | 'utility';
  suggestion: {
    add: number[];
    replace?: number[];
    timingHint?: string;
  };
  reason: string;
  confidence: 0.0 | 0.25 | 0.5 | 0.75 | 1.0 | number;
};
type UnknownRecord = Record<string, unknown>;

function aggressiveJsonCleanup(text: string): string | null {
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');

    if (start === -1 || end === -1 || start >= end) {
      return null;
    }

    let cleaned = text.slice(start, end + 1);

    cleaned = cleaned.replace(/\n\s*\w+[^{}\[\]"':,]*(?=[,}\]])/g, '');
    cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');
    cleaned = cleaned.replace(
      /([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g,
      '$1"$2":',
    );
    // Avoid global single-quote replacement; apostrophes inside valid strings should remain intact
    cleaned = cleaned.replace(/"[^\"]*$/g, '""');

    const lines = cleaned.split('\n');
    const validLines: string[] = [];
    let braceCount = 0;
    let bracketCount = 0;
    let inString = false;
    let escaped = false;

    for (const line of lines) {
      let validLine = '';
      for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (escaped) {
          escaped = false;
          validLine += char;
          continue;
        }

        if (char === '\\' && inString) {
          escaped = true;
          validLine += char;
          continue;
        }

        if (char === '"') {
          inString = !inString;
          validLine += char;
          continue;
        }

        if (!inString) {
          if (char === '{') braceCount++;
          else if (char === '}') braceCount--;
          else if (char === '[') bracketCount++;
          else if (char === ']') bracketCount--;
        }

        validLine += char;

        if (braceCount < 0 || bracketCount < 0) {
          break;
        }
      }

      validLines.push(validLine);

      if (braceCount < 0 || bracketCount < 0) {
        break;
      }
    }

    cleaned = validLines.join('\n');
    cleaned = cleaned.replace(/,\s*$/, '');
    cleaned = cleaned.replace(/{\s*"[^"]*"\s*:\s*"[^"]*$/, '');
    cleaned = cleaned.replace(/{\s*"[^"]*"\s*:\s*$/, '');

    const openBraces = (cleaned.match(/\{/g) || []).length;
    const closeBraces = (cleaned.match(/\}/g) || []).length;
    const openBrackets = (cleaned.match(/\[/g) || []).length;
    const closeBrackets = (cleaned.match(/\]/g) || []).length;

    if (openBraces > closeBraces) {
      cleaned += '}'.repeat(openBraces - closeBraces);
    }
    if (openBrackets > closeBrackets) {
      cleaned += ']'.repeat(openBrackets - closeBrackets);
    }

    return cleaned;
  } catch {
    return null;
  }
}

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
  if (hasHeal) parts.push('Has healing/sustain.');
  if (hasShield) parts.push('Has shields.');
  if (!hasHeal && !hasShield) parts.push('No heal/shield in kit.');
  parts.push(
    mentionsGW
      ? 'Validate anti-heal claims in context; prefer items.'
      : 'No ability applies Grievous Wounds; anti-heal via items only.',
  );
  return parts.join(' ');
}

type MechanicsSpec = {
  antiHealItemIds?: number[];
  championAbilities?: Record<string, string>;
  rules?: string[];
};

function buildPrompt(
  ctx: UnknownRecord,
  locale = 'en',
  mechanics?: MechanicsSpec,
): { systemPrompt: string; userPrompt: string } {
  const baseSystemLines = [
    'You are RiftCoach, a League of Legends coaching assistant.',
    'Provide concise, actionable, role-specific guidance strictly grounded in the supplied context.',
    'Respond with ONLY valid JSON that matches the required schema. No markdown, no preamble, no code fences.',
    'Leverage the provided tools when item, champion, stat, or coordinate lookups are needed.',
    'Set confidence as a float between 0 and 1 (example: 0.82).',
  ];

  const schemaHint = [
    'Required JSON schema:',
    '{',
    `  "summary": string (max ${SUMMARY_MAX_CHARS} chars),`,
    '  "roleFocus": string,',
    `  "keyMoments": [{ "ts": number, "title": string, "insight": string, "suggestion": string, "coordinates"?: [{"x": number, "y": number}], "zone"?: string, "enemyHalf"?: boolean }] (max ${KEY_MOMENTS_MAX}),`,
    '  "buildNotesV2": [{ "when": "early"|"mid"|"late"|"@t=123", "goal": string, "suggestion": { "add": number[], "replace"?: number[], "timingHint"?: string }, "reason": string, "confidence": number }],',
    `  "macro": { "objectives": string[] (max ${MACRO_LIST_MAX}), "rotations": string[] (max ${MACRO_LIST_MAX}), "vision": string[] (max ${MACRO_LIST_MAX}) },`,
    `  "drills": string[] (exactly ${DRILLS_MAX}),`,
    '  "confidence": number (0..1)',
    '}',
  ].join('\n');

  const goals = [
    'Guidance goals:',
    '- Early lane plan; mid-game rotations/objectives; late-game teamfight positioning.',
    `- Include exactly ${DRILLS_MAX} drills.`,
    `- Keep summary concise (<= ${SUMMARY_MAX_CHARS} chars).`,
    `- Objectives/rotations/vision: max ${MACRO_LIST_MAX} each.`,
    `- Limit key moments to ${KEY_MOMENTS_MAX}.`,
    '- BUILD CONTRACT: buildNotesV2 must be forward-looking with item IDs from ddragon items; do not include already finished items unless recommending replace/delay with rationale.',
    '- ANTI-HEAL CONTRACT: Only recommend anti-heal when enemy sustain/shields are present; never claim the player built anti-heal unless present in playerItems.',
    '- AOI CONTRACT: Use AOI counts to describe skirmish numbers; do not assume 1v1 unless ally==1 && enemy==1.',
    '- Reference map coordinates (x,y) for key moments when available. Use coordinate mapping tool if unsure.',
    '- Mention concrete item names/effects; call out anti-heal timing when warranted.',
    '- Compare against opponent role using available stats; be specific.',
  ].join('\n');

  const mechanicsRules = mechanics?.rules?.length
    ? mechanics.rules.join('\n')
    : [
        'Mechanics sanity rules:',
        '- Do NOT invent champion ability effects or stats. Avoid claims like "Ekko Q heals" unless explicitly present in context.',
        '- If uncertain, use generic phrasing instead of claiming ability specifics.',
        '- Only mention item effects in general categories: movement speed, armor, magic resist, health, ability haste, grievous wounds, vision control.',
        '- Anti-heal is provided via items only unless explicitly listed.',
        '- Phrase build timing as prioritization, not impossible ordering: use "prioritize X over Y when gold allows" instead of "build X before Y".',
        '- BUILD CONTRACT: Each buildNotesV2 entry must include add[] item IDs validated via ddragon items tool; one clear goal; crisp reason tied to match facts.',
        '- ANTI-HEAL CONTRACT: When recommending anti-heal, cite enemy sustain sources and timing; include exact item IDs; specify who should buy.',
        '- AOI CONTRACT: Use aoi.nearbyAllies/enemies and assistCount to determine 1v2/3v2 contexts; mention numbers succinctly.',
      ].join('\n');

  // Derive explicit team context for the AI
  const subjectObj = (ctx as { subject?: unknown }).subject as
    | { championName?: unknown; teamId?: unknown }
    | undefined;
  const opponentObj = (ctx as { opponent?: unknown }).opponent as
    | { championName?: unknown; teamId?: unknown }
    | undefined;
  const synergyObj = (ctx as { synergy?: unknown }).synergy as
    | { partnerChampion?: unknown }
    | undefined;
  const participantsArr = Array.isArray(
    (ctx as { participantsBasic?: unknown }).participantsBasic,
  )
    ? (((ctx as { participantsBasic?: unknown })
        .participantsBasic as unknown[]) as Array<Record<string, unknown>>)
    : [];
  const subjectTeamId =
    typeof subjectObj?.teamId === 'number' ? (subjectObj?.teamId as number) : undefined;
  const subjectName =
    typeof subjectObj?.championName === 'string'
      ? (subjectObj?.championName as string)
      : undefined;
  const opponentName =
    typeof opponentObj?.championName === 'string'
      ? (opponentObj?.championName as string)
      : undefined;
  const partnerName =
    typeof synergyObj?.partnerChampion === 'string'
      ? (synergyObj?.partnerChampion as string)
      : undefined;

  const allyNames = participantsArr
    .filter((p) => typeof p?.teamId === 'number' && (p.teamId as number) === subjectTeamId)
    .map((p) => String(p?.championName || ''));
  const enemyNames = participantsArr
    .filter((p) => typeof p?.teamId === 'number' && (p.teamId as number) !== subjectTeamId)
    .map((p) => String(p?.championName || ''));

  const teamContract = [
    'TEAM CONTRACT:',
    '- Treat subject champion as ALLY; lane opponent as ENEMY.',
    '- Ally champions: use explicit list from Team Sheet. Enemy champions: use explicit list from Team Sheet.',
    '- Never mislabel an ally as enemy or vice versa.',
    '- Use full champion names from Team Sheet in reasons; avoid abbreviations (e.g., prefer "Cho\'Gath" over "Cho").',
    '- When referencing champion names in reasons, clarify ownership on first mention if ambiguous (e.g., "Cho\'Gath (ally)", "Udyr (enemy)").',
  ].join('\n');

  const systemPrompt = [
    ...baseSystemLines,
    mechanicsRules,
    teamContract,
    goals,
    schemaHint,
  ].join('\n');

  const userPrompt = [
    `Locale: ${locale}`,
    'Mechanics constraints (JSON):',
    JSON.stringify(
      mechanics ?? {
        antiHealItemIds: Array.from(ITEM_GROUPS.GRIEVOUS_WOUNDS),
      },
    ),
    'Team Sheet (JSON):',
    JSON.stringify(
      {
        subjectChampion: subjectName,
        laneOpponent: opponentName,
        synergyPartner: partnerName,
        allyChampionNames: allyNames,
        enemyChampionNames: enemyNames,
      },
      null,
      2,
    ),
    'Context (JSON):',
    JSON.stringify(ctx),
    'Return STRICT JSON ONLY.',
  ].join('\n');

  return { systemPrompt, userPrompt };
}

type LooseInsights = {
  confidence?: unknown;
  keyMoments?: unknown;
  buildNotesV2?: unknown;
  buildNotes?: unknown;
  drills?: unknown;
  macro?: unknown;
};

type KeyMoment = MatchInsights['keyMoments'][number];

type TimelineEventWithPosition = {
  timestamp?: number;
  zone?: string;
  enemyHalf?: boolean;
  position?: { x: number; y: number } | null;
};

function normalizeRawInsights(raw: UnknownRecord): UnknownRecord {
  const out: UnknownRecord = {};
  const loose = raw as LooseInsights;

  let conf = Number((loose as { confidence?: unknown }).confidence ?? 0.5);
  if (Number.isNaN(conf)) conf = 0.5;
  if (conf > 1) {
    if (conf <= 5) conf = conf / 5;
    else if (conf <= 100) conf = conf / 100;
    else conf = 1;
  } else if (conf < 0) {
    conf = 0;
  }
  conf = Math.max(0, Math.min(1, conf));
  out.confidence = conf;

  const summaryUnknown = (loose as { summary?: unknown }).summary;
  out.summary = typeof summaryUnknown === 'string' ? summaryUnknown : '';

  const roleUnknown = (loose as { roleFocus?: unknown }).roleFocus;
  out.roleFocus = typeof roleUnknown === 'string' ? roleUnknown : '';
  const kmUnknown = loose.keyMoments;
  if (Array.isArray(kmUnknown)) {
    out.keyMoments = (kmUnknown as UnknownRecord[]).slice(0, 12).map((km) => {
      const coordinatesRaw = Array.isArray(km.coordinates)
        ? km.coordinates
        : undefined;
      const safeCoordinates = coordinatesRaw
        ? coordinatesRaw
            .filter(
              (c): c is { x: number; y: number } =>
                !!c &&
                typeof (c as { x?: unknown }).x === 'number' &&
                typeof (c as { y?: unknown }).y === 'number',
            )
            .map((c) => ({
              x: Number(c.x),
              y: Number(c.y),
            }))
        : undefined;
      const zone = typeof km.zone === 'string' ? km.zone : undefined;
      const enemyHalf =
        typeof km.enemyHalf === 'boolean' ? km.enemyHalf : undefined;
      return {
        ts: typeof km.ts === 'number' ? km.ts : 0,
        title: typeof km.title === 'string' ? km.title : '',
        insight: typeof km.insight === 'string' ? km.insight : '',
        suggestion: typeof km.suggestion === 'string' ? km.suggestion : '',
        coordinates: safeCoordinates,
        zone,
        enemyHalf,
      } satisfies KeyMoment;
    });
  }

  const bnV2Unknown = loose.buildNotesV2;
  if (Array.isArray(bnV2Unknown)) {
    out.buildNotesV2 = (bnV2Unknown as UnknownRecord[])
      .slice(0, 8)
      .map((bn) => {
        const sRaw = (bn as { suggestion?: unknown }).suggestion as unknown;
        const addRaw = (sRaw as { add?: unknown })?.add;
        const replaceRaw = (sRaw as { replace?: unknown })?.replace;
        const timingHintRaw = (sRaw as { timingHint?: unknown })?.timingHint;
        return {
          when:
            typeof (bn as { when?: unknown }).when === 'string'
              ? ((bn as { when?: string }).when as string)
              : 'mid',
          goal:
            (() => {
              const rawGoal = (bn as { goal?: unknown }).goal;
              const s = typeof rawGoal === 'string' ? rawGoal.toLowerCase() : '';
              if (/\b(anti[-\s]?heal|grievous)\b/.test(s)) return 'anti-heal';
              if (/\bburst\b/.test(s)) return 'burst';
              if (/\b(sustain|lifesteal|regen|shield)\b/.test(s)) return 'sustain';
              if (/\bsurviv/.test(s)) return 'survivability';
              if (/\bsiege\b/.test(s)) return 'siege';
              if (/\bwave/.test(s)) return 'waveclear';
              if (/\barmor\b/.test(s) && /\bpen/.test(s)) return 'armor-pen';
              if (/\bmagic\b/.test(s) && /\bpen/.test(s)) return 'magic-pen';
              if (/\bon[-\s]?hit\b/.test(s)) return 'on-hit';
              if (/\b(cdr|haste|cooldown)\b/.test(s)) return 'cdr';
              return 'utility';
            })(),
          suggestion: {
            add: Array.isArray(addRaw)
              ? (addRaw as unknown[])
                  .filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
                  .map((n) => Math.trunc(n))
              : [],
            replace: Array.isArray(replaceRaw)
              ? (replaceRaw as unknown[])
                  .filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
                  .map((n) => Math.trunc(n))
              : undefined,
            timingHint:
              typeof timingHintRaw === 'string' ? (timingHintRaw as string) : undefined,
          },
          reason:
            typeof (bn as { reason?: unknown }).reason === 'string'
              ? ((bn as { reason?: string }).reason as string)
              : String((bn as { reason?: unknown }).reason ?? ''),
          confidence:
            typeof (bn as { confidence?: unknown }).confidence === 'number' &&
            Number.isFinite((bn as { confidence?: number }).confidence as number)
              ? Math.max(0, Math.min(1, (bn as { confidence?: number }).confidence as number))
              : 0.5,
        };
      });
  } else {
    // Legacy mapping from buildNotes -> buildNotesV2
    const bnLegacy = loose.buildNotes;
    if (Array.isArray(bnLegacy)) {
      out.buildNotesV2 = (bnLegacy as UnknownRecord[]).slice(0, 8).map((bn) => ({
        when: 'mid',
        goal: 'utility',
        suggestion: {
          add: Array.isArray((bn as { buildPath?: unknown }).buildPath)
            ? ((bn as { buildPath?: unknown }).buildPath as unknown[])
                .filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
                .map((n) => Math.trunc(n))
            : [],
        },
        reason:
          typeof (bn as { note?: unknown }).note === 'string'
            ? ((bn as { note?: string }).note as string)
            : String((bn as { note?: unknown }).note ?? ''),
        confidence: 0.5,
      }));
    } else {
      out.buildNotesV2 = [];
    }
  }

  const drillsUnknown = loose.drills;
  if (Array.isArray(drillsUnknown)) {
    out.drills = (drillsUnknown as unknown[])
      .slice(0, DRILLS_MAX)
      .map((v) => String(v ?? ''));
  }

  const macroUnknown = loose.macro;
  if (
    macroUnknown &&
    typeof macroUnknown === 'object' &&
    !Array.isArray(macroUnknown)
  ) {
    const m = macroUnknown as {
      objectives?: unknown;
      rotations?: unknown;
      vision?: unknown;
    };
    const objectives = Array.isArray(m.objectives)
      ? (m.objectives as unknown[])
          .slice(0, MACRO_LIST_MAX)
          .map((v) => String(v ?? ''))
      : [];
    const rotations = Array.isArray(m.rotations)
      ? (m.rotations as unknown[])
          .slice(0, MACRO_LIST_MAX)
          .map((v) => String(v ?? ''))
      : [];
    const vision = Array.isArray(m.vision)
      ? (m.vision as unknown[])
          .slice(0, MACRO_LIST_MAX)
          .map((v) => String(v ?? ''))
      : [];
    out.macro = { objectives, rotations, vision };
  }

  return out;
}

function sanitizeText(input: string): string {
  let s = String(input ?? '');
  s = s
    .replace(/\bmythic\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  s = s.replace(
    /\b([A-Z][a-z]+)[^.\n]*\bQ\b[^.\n]*\bheal(?:s|ing)?\b/gi,
    'Apply anti-heal if enemy sustain is observed',
  );
  s = s.replace(
    /critical[-\s]*damage\s+champions?\s+like\s+[^.,;]+/gi,
    'critical-strike heavy champions',
  );
  s = s.replace(
    /\banti[-\s]*heal\b[^.\n]*(Ekko|Brand|Smolder|Senna|Caitlyn)[^.,;]*/gi,
    'anti-heal to reduce enemy sustain',
  );
  s = s.replace(
    /\b(Grievous Wounds|anti[-\s]*heal)\b[^.\n]*\([A-Z][a-z]+'s\s+[QRWE]\)/gi,
    'Apply anti-heal via items when needed',
  );
  s = s.replace(
    /\b(Grievous Wounds|anti[-\s]*heal)\b[^.\n]*\b[A-Z][a-z]+'s\s+[QRWE]\b/gi,
    'Apply anti-heal via items when needed',
  );
  s = s.replace(
    /\bApply\s+(Grievous Wounds|anti[-\s]*heal)\b[^.\n]*\b(Q|W|E|R)\b/gi,
    'Apply anti-heal via items when needed',
  );
  // Remove overly aggressive anti-heal item suggestions but don't replace with delay message
  s = s.replace(
    /\b(?:consider|rush|add|build)\s+(?:Bramble\s+Vest|Executioner'?s\s+Calling|Mortal\s+Reminder|Oblivion\s+Orb|Morellonomicon|Chemtech\s+Putrifier|Chempunk\s+Chainsword)[^.\n]*\./gi,
    '',
  );
  // Replace problematic build timing phrasing with prioritization language
  s = s.replace(
    /\b(build|rush|get)\s+([^.,;]+?)\s+before\s+([^.,;]+?)([.!?])/gi,
    'prioritize $2 over $3 when gold allows$4',
  );
  s = s.replace(
    /\bbuild\s+([^.,;]+?)\s+earlier\b/gi,
    'prioritize $1 earlier when affordable',
  );
  s = s.replace(
    /\bbuy\s+([^.,;]+?)\s+asap\b/gi,
    'prioritize $1 when affordable',
  );
  s = s.replace(/Brand['’]s\s*heal(s)?/gi, "Brand's damage");
  s = s.replace(/\bRanduin'?s Omen\b[^.\n]*/gi, (m) => {
    const t = m
      .replace(/slows[^.\n]*/i, '')
      .replace(/counters[^.\n]*/i, '')
      .trim();
    return t || 'Randuin’s Omen';
  });
  s = s.replace(/\bDead ?Man'?s Plate\b/gi, 'Dead Man’s Plate');
  s = s.replace(/–\s*–/g, '– ');
  return s;
}

function sanitizeInsights(ins: MatchInsights): MatchInsights {
  return {
    ...ins,
    summary: sanitizeText(ins.summary).slice(0, SUMMARY_MAX_CHARS),
    roleFocus: sanitizeText(ins.roleFocus),
    keyMoments: ins.keyMoments.slice(0, KEY_MOMENTS_MAX).map((km) => ({
      ...km,
      insight: sanitizeText(km.insight),
      suggestion: sanitizeText(km.suggestion),
    })),
    buildNotesV2: (ins.buildNotesV2 || []).map((bn) => ({
      when: typeof bn.when === 'string' ? bn.when : 'mid',
      goal: bn.goal,
      suggestion: {
        add: Array.isArray(bn.suggestion.add)
          ? bn.suggestion.add
              .filter((n) => typeof n === 'number' && Number.isFinite(n))
              .map((n) => Math.trunc(n))
          : [],
        replace: Array.isArray(bn.suggestion.replace)
          ? bn.suggestion.replace
              .filter((n) => typeof n === 'number' && Number.isFinite(n))
              .map((n) => Math.trunc(n))
          : undefined,
        timingHint: bn.suggestion.timingHint
          ? sanitizeText(bn.suggestion.timingHint)
          : undefined,
      },
      reason: sanitizeText(bn.reason),
      confidence: Math.max(0, Math.min(1, Number(bn.confidence ?? 0.5))),
    })),
    macro: {
      objectives: ins.macro.objectives
        .slice(0, MACRO_LIST_MAX)
        .map(sanitizeText),
      rotations: ins.macro.rotations.slice(0, MACRO_LIST_MAX).map(sanitizeText),
      vision: ins.macro.vision.slice(0, MACRO_LIST_MAX).map(sanitizeText),
    },
    drills: ins.drills.slice(0, DRILLS_MAX).map(sanitizeText),
  };
}

// Anti-heal gating helpers
type SustainSignals = {
  enemyHasSustain: boolean;
  enemyGWObserved: boolean;
  subjectGWObserved: boolean;
};

function detectEnemySustain(
  ctx: UnknownRecord,
  champHints?: Record<string, string>,
): SustainSignals {
  const itemsObj = (ctx as { items?: unknown }).items as
    | {
        opponentFinalItemMeta?: Record<
          number,
          { name?: string; plaintext?: string; tags?: string[] }
        >;
      }
    | undefined;

  const eventsRaw = Array.isArray((ctx as { events?: unknown }).events)
    ? ((ctx as { events?: unknown }).events as UnknownRecord[])
    : [];

  const opMeta = itemsObj?.opponentFinalItemMeta ?? {};
  let hasSustain = false;
  for (const m of Object.values(opMeta)) {
    const text = `${m?.name || ''} ${m?.plaintext || ''}`.toLowerCase();
    const tags = (m?.tags || []).map((t) => String(t).toLowerCase());
    if (
      /omnivamp|life ?steal|spell ?vamp|hp ?regen|regenerat|healing/i.test(text)
    ) {
      hasSustain = true;
      break;
    }
    if (
      tags.some((t) =>
        /(lifesteal|omnivamp|spellvamp|hpregen|regeneration|regen)/i.test(t),
      )
    ) {
      hasSustain = true;
      break;
    }
  }

  const opponentName = (
    (ctx as { opponent?: unknown }).opponent as
      | { championName?: unknown }
      | undefined
  )?.championName;
  const hintText =
    typeof opponentName === 'string' && champHints
      ? champHints[opponentName]
      : undefined;
  if (!hasSustain && typeof hintText === 'string') {
    if (/has healing\/sustain/i.test(hintText)) hasSustain = true;
  }

  const enemyGWObserved = eventsRaw.some(
    (e) =>
      (e as { enemyHasGrievousWounds?: unknown }).enemyHasGrievousWounds ===
      true,
  );
  const subjectGWObserved = eventsRaw.some(
    (e) =>
      (e as { subjectHasGrievousWounds?: unknown }).subjectHasGrievousWounds ===
      true,
  );

  return { enemyHasSustain: hasSustain, enemyGWObserved, subjectGWObserved };
}

function gateAntiHealText(input: string, sig: SustainSignals): string {
  let s = String(input ?? '');
  const mentions = /\b(anti[-\s]*heal|grievous\s*wounds)\b/i.test(s);
  if (!mentions) return s;

  // Remove the delay message replacement - let anti-heal mentions pass through
  // if (!sig.enemyHasSustain) {
  //   s = s.replace(
  //     /[^.\n]*\b(anti[-\s]*heal|grievous\s*wounds)[^.\n]*\./gi,
  //     'Delay anti-heal unless enemy sustain emerges.',
  //   );
  //   return s;
  // }

  if (sig.enemyGWObserved && !/\b(position|trade|timing)\b/i.test(s)) {
    s = `${s} Time trades around enemy Grievous Wounds cooldowns; shorten extended fights.`;
  }

  if (!sig.subjectGWObserved) {
    s = s.replace(
      /apply\s+anti[-\s]*heal\s+via\s+items\s+when\s+needed/gi,
      'time anti-heal via items during sustained trades',
    );
  }

  return s;
}

function applyAntiHealGating(
  ins: MatchInsights,
  ctx: UnknownRecord,
  champHints?: Record<string, string>,
): MatchInsights {
  const sig = detectEnemySustain(ctx, champHints);
  const gate = (t: string) => gateAntiHealText(t, sig);
  return {
    ...ins,
    summary: gate(ins.summary).slice(0, SUMMARY_MAX_CHARS),
    roleFocus: gate(ins.roleFocus),
    keyMoments: ins.keyMoments.slice(0, KEY_MOMENTS_MAX).map((km) => ({
      ...km,
      insight: gate(km.insight),
      suggestion: gate(km.suggestion),
    })),
    buildNotesV2: (ins.buildNotesV2 || []).map((bn) => ({
      ...bn,
      reason: gate(bn.reason),
    })),
    macro: {
      objectives: ins.macro.objectives.slice(0, MACRO_LIST_MAX).map(gate),
      rotations: ins.macro.rotations.slice(0, MACRO_LIST_MAX).map(gate),
      vision: ins.macro.vision.slice(0, MACRO_LIST_MAX).map(gate),
    },
    drills: ins.drills.slice(0, DRILLS_MAX).map(gate),
  };
}

function ensureBuildNotes(
  ins: MatchInsights,
  ctx: UnknownRecord,
  champHints?: Record<string, string>,
): MatchInsights {
  const existing = (ins.buildNotesV2 || []).filter((bn) => {
    const addLen = Array.isArray(bn.suggestion?.add)
      ? bn.suggestion.add.length
      : 0;
    return addLen > 0 || String(bn.reason || '').trim().length > 0;
  });
  if (existing.length > 0) return ins;

  const itemsObj = (ctx as { items?: unknown }).items as
    | {
        subjectFinalItemNames?: string[];
        opponentFinalItemNames?: string[];
      }
    | undefined;

  const selfNames = Array.isArray(itemsObj?.subjectFinalItemNames)
    ? (itemsObj?.subjectFinalItemNames as string[])
    : [];
  const enemyNames = Array.isArray(itemsObj?.opponentFinalItemNames)
    ? (itemsObj?.opponentFinalItemNames as string[])
    : [];

  const subjectRaw = (ctx as { subject?: unknown }).subject as
    | { finalItems?: unknown }
    | undefined;
  const currentBuild = Array.isArray(subjectRaw?.finalItems)
    ? (subjectRaw?.finalItems as unknown[])
        .filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
        .map((n) => Math.trunc(n))
    : [];

  const sig = detectEnemySustain(ctx, champHints);
  const defaultNotes: BuildNoteV2[] = [];
  if (sig.enemyHasSustain) {
    defaultNotes.push({
      when: 'early',
      goal: 'anti-heal',
      suggestion: { add: [] },
      reason:
        'Enemy sustain/shields present; add anti-heal timing if gold allows.',
      confidence: 0.5,
    });
  }
  defaultNotes.push({
    when: 'mid',
    goal: 'utility',
    suggestion: { add: [] },
    reason: `${selfNames.length > 0 ? `Final build: ${selfNames.join(', ')}. ` : ''}${enemyNames.length > 0 ? `Enemy final items: ${enemyNames.join(', ')}. ` : ''}Track item spikes; fight with timing advantage; buy control wards for setups.`,
    confidence: 0.5,
  });

  return { ...ins, buildNotesV2: defaultNotes };
}
function normCoordinate(v: number): number {
  const MAP_MIN = 0;
  const MAP_MAX = 15000;
  return Math.max(0, Math.min(1, (v - MAP_MIN) / (MAP_MAX - MAP_MIN)));
}

type TeamSide = 'BLUE' | 'RED';

function detectTeamSide(teamId?: number | null): TeamSide {
  return teamId === 100 ? 'BLUE' : 'RED';
}

function zoneLabel(pos?: { x: number; y: number } | null): string {
  if (!pos) return 'unknown';
  const x = normCoordinate(pos.x);
  const y = normCoordinate(pos.y);
  const distToDiag = Math.abs(x - (1 - y));
  const nearRiver = distToDiag < 0.06;
  const lane = y > 0.66 ? 'TOP' : y < 0.33 ? 'BOTTOM' : 'MIDDLE';
  const nearLane =
    (lane === 'TOP' && x < 0.6) ||
    (lane === 'BOTTOM' && x > 0.4) ||
    lane === 'MIDDLE';
  if (nearRiver) return `${lane}_RIVER`;
  return nearLane ? `${lane}_LANE` : `${lane}_JUNGLE`;
}

function isEnemyHalf(
  pos: { x: number; y: number } | null,
  side: TeamSide,
): boolean {
  if (!pos) return false;
  const x = normCoordinate(pos.x);
  const y = normCoordinate(pos.y);
  const s = x + y;
  return side === 'BLUE' ? s > 1.02 : s < 0.98;
}

function derivePatchFromContext(ctx: UnknownRecord): string | undefined {
  const ctxItems = ctx.items as { patch?: string } | undefined;
  const infoObj = ctx.info as { gameVersion?: string } | undefined;
  return ctxItems?.patch ?? inferPatchFromGameVersion(infoObj?.gameVersion);
}

function deriveChampionAbilityHints(
  ctx: UnknownRecord,
  names: string[],
  patch?: string,
): Promise<Record<string, string>> {
  return (async () => {
    try {
      const resolvedPatch = patch ?? derivePatchFromContext(ctx) ?? '15.18.1';
      const champMap = await getChampionMap(resolvedPatch);
      const hints: Record<string, string> = {};
      for (const n of names) {
        const ch = findChampionByName(n, champMap);
        if (ch) {
          hints[n] = buildAbilityHintFromDDragon(ch);
        }
      }
      return hints;
    } catch (error) {
      consola.warn('[match-insights] ability hint load failed', error);
      return {};
    }
  })();
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
    const input = (toolUse.input ?? {}) as Record<string, unknown>;
    let inputPreview = '';
    try {
      inputPreview = JSON.stringify(input).substring(0, 300);
    } catch {
      inputPreview = '[unserializable input]';
    }
    consola.info('[match-insights] tool executing', {
      toolUseId: toolUse.toolUseId,
      name: toolUse.name,
      inputPreview,
    });
    const payload = await spec.execute(input, ctx);
    let resultPreview = '';
    try {
      resultPreview = JSON.stringify(payload).substring(0, 300);
    } catch {
      resultPreview = '[unserializable result]';
    }
    consola.info('[match-insights] tool result', {
      toolUseId: toolUse.toolUseId,
      name: toolUse.name,
      status: 'success',
      resultPreview,
    });
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

function ensureKeyMomentCoordinates(
  insights: MatchInsights,
  ctx: UnknownRecord,
): MatchInsights {
  const eventsRaw = Array.isArray((ctx as { events?: unknown }).events)
    ? ((ctx as { events?: unknown }).events as TimelineEventWithPosition[])
    : [];

  const eventsByTs = eventsRaw
    .filter((e) => typeof e?.timestamp === 'number')
    .map((e) => ({
      ts: e.timestamp ?? 0,
      zone: typeof e.zone === 'string' ? e.zone : undefined,
      enemyHalf: typeof e.enemyHalf === 'boolean' ? e.enemyHalf : undefined,
      position:
        e.position && typeof e.position === 'object'
          ? (e.position as { x: number; y: number })
          : null,
    }));

  const enrichedKeyMoments = insights.keyMoments.map((km) => {
    if (km.coordinates && km.coordinates.length > 0 && km.zone) {
      return km;
    }

    const candidates = eventsByTs
      .filter((e) => Math.abs((e.ts ?? 0) - km.ts) <= 2_000)
      .sort((a, b) => Math.abs(a.ts - km.ts) - Math.abs(b.ts - km.ts));

    const fallback = candidates[0];
    if (!fallback) {
      if (km.coordinates && km.coordinates.length > 0 && !km.zone) {
        const derived = km.coordinates[0];
        return {
          ...km,
          zone: zoneLabel(derived),
          enemyHalf: isEnemyHalf(derived, detectTeamSide()),
        };
      }
      return km;
    }

    const coords = fallback.position ? [fallback.position] : km.coordinates;
    const zone =
      fallback.zone ??
      (coords && coords.length > 0 ? zoneLabel(coords[0]) : km.zone);
    const enemyHalf =
      fallback.enemyHalf ??
      (coords && coords.length > 0
        ? isEnemyHalf(coords[0], detectTeamSide())
        : km.enemyHalf);

    return {
      ...km,
      coordinates: coords ?? km.coordinates,
      zone,
      enemyHalf,
    };
  });

  return {
    ...insights,
    keyMoments: enrichedKeyMoments,
  };
}

function extractTextFromMessage(message: Message | undefined): string {
  if (!message?.content) return '';
  const textBlocks = message.content
    .map((block) => ('text' in block && block.text ? block.text : null))
    .filter((v): v is string => typeof v === 'string');
  return textBlocks.join('\n').trim();
}

export async function generateMatchInsights(
  ctx: UnknownRecord,
  opts?: {
    modelId?: string;
    locale?: string;
    temperature?: number;
    maxTokens?: number;
    mechanics?: MechanicsSpec;
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

  const mechanicsSpec = opts?.mechanics ?? {
    antiHealItemIds: Array.from(ITEM_GROUPS.GRIEVOUS_WOUNDS),
    ...(Object.keys(championAbilitiesHints).length
      ? { championAbilities: championAbilitiesHints }
      : {}),
  };

  const { systemPrompt, userPrompt } = buildPrompt(ctx, locale, mechanicsSpec);

  const messages: Message[] = [
    {
      role: 'user',
      content: [{ text: userPrompt }],
    },
  ];

  const toolConfig = buildToolConfig();
  const runtimeCtx: ToolRuntimeContext = { ctx };

  let finalMessage: Message | undefined;
  let lastResponseMetrics: { latencyMs?: number; totalTokens?: number } = {};

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

    const started = Date.now();
    const response = await bedrockClient.send(command);
    const latencyMs = response.metrics?.latencyMs ?? Date.now() - started;
    const totalTokens = response.usage?.totalTokens;
    lastResponseMetrics = { latencyMs, totalTokens };

    const output = response.output;
    const assistantMessage =
      output && 'message' in output ? (output.message as Message) : undefined;
    if (!assistantMessage) {
      throw new Error('No assistant message received from Claude');
    }

    messages.push(assistantMessage);

    const toolUses = assistantMessage.content
      ?.map((block) => ('toolUse' in block ? block.toolUse : undefined))
      .filter((block): block is NonNullable<typeof block> => !!block)
      .filter(
        (block): block is typeof block & { toolUseId: string; name: string } =>
          !!block.toolUseId && !!block.name,
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
        count: toolUses.length,
        tools: toolUses.map((t) => ({ name: t.name, toolUseId: t.toolUseId })),
      });
      const toolResults: ContentBlock[] = [];
      for (const toolUse of toolUses) {
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
      }

      consola.debug('[match-insights] returning tool results to AI', {
        iteration,
        count: toolResults.length,
      });
      messages.push({
        role: 'user',
        content: toolResults,
      });

      // Continue processing tool uses
    } else {
      finalMessage = assistantMessage;
      break;
    }
  }

  if (!finalMessage) {
    finalMessage = messages[messages.length - 1];
  }

  const aiText = extractTextFromMessage(finalMessage) || '{}';
  let cleanedText = String(aiText).trim();
  cleanedText = cleanedText.replace(/^```json\s*/i, '').replace(/\s*```$/, '');
  cleanedText = cleanedText.replace(/^```\s*/, '').replace(/\s*```$/, '');
  // Previously: cleanedText = fixMalformedJson(cleanedText);

  consola.debug(
    '[match-insights] AI response',
    {
      modelId,
      latencyMs: lastResponseMetrics.latencyMs,
      totalTokens: lastResponseMetrics.totalTokens,
    },
    cleanedText,
  );

  try {
    const parsed = JSON.parse(cleanedText);
    const normalized = normalizeRawInsights(parsed as UnknownRecord);
    const validated = MatchInsightsSchema.safeParse(normalized);
    if (!validated.success) {
      consola.error(
        '[match-insights] Schema validation failed',
        validated.error.issues,
      );
      throw new Error('Invalid AI JSON schema');
    }
    let sanitized = sanitizeInsights(validated.data);
    sanitized = ensureKeyMomentCoordinates(sanitized, ctx);
    // Apply contextual gating and buildNotesV2 fallback
    sanitized = applyAntiHealGating(
      sanitized,
      ctx,
      mechanicsSpec.championAbilities,
    );
    sanitized = ensureBuildNotes(
      sanitized,
      ctx,
      mechanicsSpec.championAbilities,
    );

    // Post-processing validators for buildNotesV2
    try {
      const { getItemMap } = await import('../utils/ddragon-items.js');
      const ctxItems = ctx.items as { patch?: string } | undefined;
      const infoObj = ctx.info as { gameVersion?: string } | undefined;
      const patch = ctxItems?.patch ?? inferPatchFromGameVersion(infoObj?.gameVersion);
      const itemMap = await getItemMap(patch);
      const ddSet = new Set<number>(Object.keys(itemMap).map((s) => Number(s)).filter((n) => Number.isFinite(n)));

      const subjectRaw = (ctx as { subject?: unknown }).subject as { finalItems?: unknown; teamId?: unknown } | undefined;
      const currentBuild = Array.isArray(subjectRaw?.finalItems)
        ? (subjectRaw?.finalItems as unknown[])
            .filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
            .map((n) => Math.trunc(n))
        : [];

      function filterUnknownItems(ddItems: Set<number>, notes: BuildNoteV2[]): BuildNoteV2[] {
        const out: BuildNoteV2[] = [];
        for (const n of notes) {
          const add = (n.suggestion.add || []).filter((id) => ddItems.has(id));
          const replace = n.suggestion.replace
            ? n.suggestion.replace.filter((id) => ddItems.has(id))
            : undefined;
          const m: BuildNoteV2 = {
            ...n,
            suggestion: { ...n.suggestion, add, replace },
          };
          if ((m.suggestion.add?.length ?? 0) > 0 || (m.suggestion.replace?.length ?? 0) > 0 || String(m.reason || '').trim().length > 0) {
            out.push(m);
          }
        }
        return out;
      }

      function dropAlreadyBuilt(current: number[], notes: BuildNoteV2[]): BuildNoteV2[] {
        const built = new Set(current);
        return notes
          .map((n) => ({
            ...n,
            suggestion: {
              ...n.suggestion,
              add: (n.suggestion.add || []).filter((id) => !built.has(id)),
            },
          }))
          .filter((n) => (n.suggestion.add?.length ?? 0) > 0 || (n.suggestion.replace?.length ?? 0) > 0 || String(n.reason || '').trim().length > 0);
      }

      function isFinalItem(id: number): boolean {
        const it = itemMap[id];
        if (!it) return false;
        const name = String(it.name || '').toLowerCase();
        const tags = (it.tags || []).map((t) => String(t).toLowerCase());
        const total = typeof it.gold?.total === 'number' ? Number(it.gold?.total) : 0;
        const isConsumable = tags.includes('consumable') || /elixir|potion|ward|refillable|cookie/i.test(name);
        const isTrinket = tags.includes('trinket');
        if (isConsumable || isTrinket) return false;
        const isBoots = tags.includes('boots') || /greaves|treads|boots|sandals/i.test(name);
        const intoLen = Array.isArray(it.into) ? it.into.length : 0;
        const fromLen = Array.isArray(it.from) ? it.from.length : 0;
        const depth = typeof it.depth === 'number' ? (it.depth as number) : undefined;
        if (isBoots) return true;
        if (depth != null && depth >= 2 && intoLen === 0) return true;
        if (fromLen > 0 && intoLen === 0 && total >= 1200) return true;
        const isLegendaryOrMythic = tags.includes('legendary') || tags.includes('mythic');
        if (isLegendaryOrMythic && fromLen > 0 && total >= 2600) return true;
        return false;
      }

      function onlyFinalItems(notes: BuildNoteV2[]): BuildNoteV2[] {
        return notes
          .map((n) => ({
            ...n,
            suggestion: {
              ...n.suggestion,
              add: (n.suggestion.add || []).filter((id) => isFinalItem(id)),
              replace: n.suggestion.replace
                ? n.suggestion.replace.filter((id) => isFinalItem(id))
                : undefined,
            },
          }))
          .filter((n) => (n.suggestion.add?.length ?? 0) > 0 || (n.suggestion.replace?.length ?? 0) > 0 || String(n.reason || '').trim().length > 0);
      }

      function validateAntiHealNotes(notes: BuildNoteV2[], sig: SustainSignals): BuildNoteV2[] {
        const antiIds = ITEM_GROUPS.GRIEVOUS_WOUNDS;
        const scrub = (reason: string): string => {
          let r = String(reason || '');
          r = r.replace(/[^.\n]*\b(built|buys|purchased)\b[^.\n]*(Mortal Reminder|Executioner'?s|Oblivion Orb|Morellonomicon|Chemtech Putrifier|Chempunk Chainsword|anti[-\s]*heal|Grievous Wounds)[^.\n]*[.\n]/gi, '');
          r = r.replace(/\bYou never answered\b\.?/i, '');
          r = r.replace(/\s{2,}/g, ' ').trim();
          if (r.length === 0) {
            r = 'Enemy sustain observed; apply anti-heal during extended trades.';
          }
          return r;
        };
        const out: BuildNoteV2[] = [];
        for (const n of notes) {
          const isAnti = n.goal === 'anti-heal' || (n.suggestion.add || []).some((id) => antiIds.has(id));
          if (isAnti && !sig.enemyHasSustain) {
            continue;
          }
          const m: BuildNoteV2 = { ...n, reason: isAnti ? scrub(n.reason) : n.reason };
          out.push(m);
        }
        return out;
      }

      const sig = detectEnemySustain(ctx, mechanicsSpec.championAbilities);
      let processed = validateAntiHealNotes(
        onlyFinalItems(
          dropAlreadyBuilt(currentBuild, filterUnknownItems(ddSet, sanitized.buildNotesV2 || [])),
        ),
        sig,
      );

      // Annotate champion mentions with ally/enemy tags on first mention
      try {
        const participantsList = Array.isArray((ctx as { participantsBasic?: unknown }).participantsBasic)
          ? (((ctx as { participantsBasic?: unknown }).participantsBasic as unknown[]) as Array<Record<string, unknown>>)
          : [];
        const subjTeamId = typeof subjectRaw?.teamId === 'number' ? (subjectRaw?.teamId as number) : undefined;
        const nameSideMap: Record<string, 'ally' | 'enemy'> = {};
        for (const p of participantsList) {
          const n = String(p?.championName || '').trim();
          const t = typeof p?.teamId === 'number' ? (p.teamId as number) : undefined;
          if (!n || t == null || subjTeamId == null) continue;
          nameSideMap[n] = t === subjTeamId ? 'ally' : 'enemy';
        }
        // Add common aliases to improve matching (e.g., "Cho", "Cass")
        const aliasMap: Record<string, string[]> = {
          "Cho'Gath": ['Cho', 'Chogath'],
          Cassiopeia: ['Cass'],
        };
        for (const [name, side] of Object.entries(nameSideMap)) {
          const aliases = aliasMap[name] || [];
          for (const a of aliases) {
            if (!nameSideMap[a]) nameSideMap[a] = side;
          }
          if (name.includes("'")) {
            const before = name.split("'")[0];
            const alias = before.trim();
            if (alias && !nameSideMap[alias]) nameSideMap[alias] = side;
          }
        }
        const annotateOne = (text: string): string => {
          let out = String(text || '');
          for (const [n, side] of Object.entries(nameSideMap)) {
            const re = new RegExp(`\\b(${n.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')})\\b(?!\\s*\\()`, 'g');
            out = out.replace(re, `${n} (${side})`);
          }
          return out;
        };
        processed = processed.map((bn) => ({ ...bn, reason: annotateOne(bn.reason) }));
      } catch {}

      sanitized = { ...sanitized, buildNotesV2: processed };
    } catch (validatorErr) {
      consola.warn('[match-insights] post-processing validators failed', validatorErr);
    }

    if (JSON.stringify(validated.data) !== JSON.stringify(sanitized)) {
      consola.warn('[match-insights] mechanics sanitized');
    }
    return sanitized;
  } catch (error) {
    consola.error('[match-insights] parse error', error);
    consola.error('[match-insights] problematic response', {
      originalText: aiText.substring(0, 500),
      cleanedText: cleanedText.substring(0, 500),
      textLength: aiText.length,
      cleanedLength: cleanedText.length,
    });

    // Simple fallback: try aggressive cleanup once, then minimal
    try {
      const aggressivelyCleaned = aggressiveJsonCleanup(aiText);
      if (aggressivelyCleaned) {
        const parsed = JSON.parse(aggressivelyCleaned);
        const normalized = normalizeRawInsights(parsed as UnknownRecord);
        const validated = MatchInsightsSchema.safeParse(normalized);
        if (validated.success) {
          consola.warn('[match-insights] recovered with aggressive cleanup');
          let sanitized = sanitizeInsights(validated.data);
          sanitized = ensureKeyMomentCoordinates(sanitized, ctx);
          sanitized = applyAntiHealGating(
            sanitized,
            ctx,
            mechanicsSpec.championAbilities,
          );
          sanitized = ensureBuildNotes(
            sanitized,
            ctx,
            mechanicsSpec.championAbilities,
          );
          if (JSON.stringify(validated.data) !== JSON.stringify(sanitized)) {
            consola.warn('[match-insights] mechanics sanitized');
          }
          return sanitized;
        }
      }
    } catch (recoveryError) {
      consola.error('[match-insights] recovery attempt failed', recoveryError);
    }

    const minimal: MatchInsights = {
      summary: 'Unable to generate full insights at this time.',
      roleFocus: 'UNKNOWN',
      keyMoments: [],
      buildNotesV2: [],
      macro: { objectives: [], rotations: [], vision: [] },
      drills: [],
      confidence: 0,
    };
    let sanitized = sanitizeInsights(minimal);
    sanitized = ensureKeyMomentCoordinates(sanitized, ctx);
    sanitized = applyAntiHealGating(
      sanitized,
      ctx,
      mechanicsSpec.championAbilities,
    );
    sanitized = ensureBuildNotes(
      sanitized,
      ctx,
      mechanicsSpec.championAbilities,
    );
    if (JSON.stringify(minimal) !== JSON.stringify(sanitized)) {
      consola.warn('[match-insights] mechanics sanitized');
    }
    return sanitized;
  }
}
