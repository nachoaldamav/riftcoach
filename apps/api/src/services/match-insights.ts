import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { ITEM_GROUPS } from '@riftcoach/shared.constants';
import consola from 'consola';
import z from 'zod';
import { bedrockClient } from '../clients/bedrock.js';
import {
  type DDragonChampion,
  findChampionByName,
  getChampionMap,
} from '../utils/ddragon-champions.js';
import { inferPatchFromGameVersion } from '../utils/ddragon-items.js';

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
      }),
    )
    .max(12),
  buildNotes: z.array(z.object({ note: z.string() })).max(8),
  macro: z.object({
    objectives: z.array(z.string()).max(6),
    rotations: z.array(z.string()).max(6),
    vision: z.array(z.string()).max(6),
  }),
  drills: z.array(z.string()).min(3).max(5),
  confidence: z.number().min(0).max(1),
});

export type MatchInsights = z.infer<typeof MatchInsightsSchema>;

function aggressiveJsonCleanup(text: string): string | null {
  try {
    // Remove everything before the first { and after the last }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');

    if (start === -1 || end === -1 || start >= end) {
      return null;
    }

    let cleaned = text.slice(start, end + 1);

    // Remove any non-JSON content that might be mixed in
    cleaned = cleaned.replace(/\n\s*\w+[^{}\[\]"':,]*(?=[,}\]])/g, '');

    // Fix common issues
    cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1'); // trailing commas
    cleaned = cleaned.replace(
      /([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g,
      '$1"$2":',
    ); // unquoted keys
    cleaned = cleaned.replace(/'/g, '"'); // single to double quotes

    // Handle truncated strings - find incomplete string values and close them
    cleaned = cleaned.replace(/"[^"]*$/g, '""'); // incomplete strings at end

    // Handle truncated objects/arrays more intelligently
    // Find the last complete object or array element
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

        // If we've gone negative, we have unmatched closing brackets
        if (braceCount < 0 || bracketCount < 0) {
          break;
        }
      }

      validLines.push(validLine);

      // Stop if we have unmatched brackets
      if (braceCount < 0 || bracketCount < 0) {
        break;
      }
    }

    cleaned = validLines.join('\n');

    // Remove trailing incomplete elements
    cleaned = cleaned.replace(/,\s*$/, ''); // trailing comma
    cleaned = cleaned.replace(/{\s*"[^"]*"\s*:\s*"[^"]*$/, ''); // incomplete object
    cleaned = cleaned.replace(/{\s*"[^"]*"\s*:\s*$/, ''); // incomplete key-value

    // Balance remaining brackets and braces
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

function extractPartialInsights(text: string): Partial<MatchInsights> | null {
  try {
    const result: Partial<MatchInsights> = {};

    // Try to extract summary using regex
    const summaryMatch = text.match(/"summary"\s*:\s*"([^"]+)"/);
    if (summaryMatch) {
      result.summary = summaryMatch[1];
    }

    // Try to extract roleFocus
    const roleFocusMatch = text.match(/"roleFocus"\s*:\s*"([^"]+)"/);
    if (roleFocusMatch) {
      result.roleFocus = roleFocusMatch[1];
    }

    // Try to extract keyMoments array - look for complete objects
    const keyMomentsMatch = text.match(/"keyMoments"\s*:\s*\[(.*?)\]/s);
    if (keyMomentsMatch) {
      try {
        const keyMomentsStr = `[${keyMomentsMatch[1]}]`;
        const keyMoments = JSON.parse(keyMomentsStr);
        if (Array.isArray(keyMoments)) {
          result.keyMoments = keyMoments.filter(
            (km) =>
              km &&
              typeof km === 'object' &&
              typeof km.ts === 'number' &&
              typeof km.title === 'string' &&
              typeof km.insight === 'string' &&
              typeof km.suggestion === 'string',
          );
        }
      } catch {
        // If keyMoments array is malformed, try to extract individual complete objects
        const keyMomentObjects = text.match(/{\s*"ts"\s*:\s*\d+[^}]*}/g);
        if (keyMomentObjects) {
          const validKeyMoments = [];
          for (const obj of keyMomentObjects) {
            try {
              const parsed = JSON.parse(obj);
              if (
                parsed.ts &&
                parsed.title &&
                parsed.insight &&
                parsed.suggestion
              ) {
                validKeyMoments.push(parsed);
              }
            } catch {
              // Skip invalid objects
            }
          }
          if (validKeyMoments.length > 0) {
            result.keyMoments = validKeyMoments;
          }
        }
      }
    }

    // Try to extract confidence
    const confidenceMatch = text.match(/"confidence"\s*:\s*([\d.]+)/);
    if (confidenceMatch) {
      const conf = Number.parseFloat(confidenceMatch[1]);
      if (!Number.isNaN(conf) && conf >= 0 && conf <= 1) {
        result.confidence = conf;
      }
    }

    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

function fixMalformedJson(jsonStr: string): string {
  try {
    // First, try to parse as-is
    JSON.parse(jsonStr);
    return jsonStr;
  } catch {
    // Common fixes for malformed JSON
    let fixed = jsonStr;

    // Fix trailing commas in arrays and objects
    fixed = fixed.replace(/,(\s*[}\]])/g, '$1');

    // Fix missing quotes around property names
    fixed = fixed.replace(
      /([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g,
      '$1"$2":',
    );

    // Fix single quotes to double quotes
    fixed = fixed.replace(/'/g, '"');

    // Fix incomplete arrays - if we find an unclosed array, close it
    const openBrackets = (fixed.match(/\[/g) || []).length;
    const closeBrackets = (fixed.match(/\]/g) || []).length;
    if (openBrackets > closeBrackets) {
      // Find the last incomplete array and try to close it properly
      const lastCommaIndex = fixed.lastIndexOf(',');
      const lastBracketIndex = fixed.lastIndexOf('[');
      if (
        lastCommaIndex > lastBracketIndex &&
        lastCommaIndex > fixed.lastIndexOf(']')
      ) {
        // Remove trailing comma and close the array
        fixed = `${fixed.substring(0, lastCommaIndex)}]${fixed.substring(lastCommaIndex + 1)}`;
      } else {
        // Just add missing closing brackets
        fixed += ']'.repeat(openBrackets - closeBrackets);
      }
    }

    // Fix incomplete objects
    const openBraces = (fixed.match(/\{/g) || []).length;
    const closeBraces = (fixed.match(/\}/g) || []).length;
    if (openBraces > closeBraces) {
      fixed += '}'.repeat(openBraces - closeBraces);
    }

    return fixed;
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

function buildPrompt(
  ctx: Record<string, unknown>,
  locale = 'en',
  mechanics?: {
    antiHealItemIds?: number[];
    championAbilities?: Record<string, string>;
    rules?: string[];
  },
) {
  const header = [
    'You are RiftCoach, a League of Legends coaching assistant. Provide concise, actionable, role-specific guidance strictly grounded in the supplied context. If an element is missing, state it explicitly and proceed.',
    '',
    'CRITICAL:',
    '- Respond with ONLY valid JSON that matches the required schema.',
    '- No markdown, no prose outside JSON, no code fences.',
    '- Keep the response under ~1200 tokens.',
    "- Use the user's locale when phrasing suggestions.",
    '- Set confidence as a float between 0 and 1 (e.g., 0.8).',
    '- Include explicit numeric metrics (gold/CS/KDA/DPM, leads and deltas).',
    '- Reference map coords as "x,y" in key moments when available.',
    '- Mention concrete item names/effects; call out anti-heal timing when warranted.',
    '- Compare against opponent role using available stats; be specific.',
    '',
  ].join('\n');

  const mechanicsRules = [
    'Mechanics sanity rules:',
    '- Do NOT invent champion ability effects or stats. Avoid claims like "Ekko Q heals" or "Randuin counters Ekko crit" unless explicitly present in context.',
    '- If uncertain, use generic phrasing (e.g., "anti-heal to reduce enemy sustain", "engage tools"), not champion-specific mechanics.',
    '- Do NOT label items as mythic or attribute patch-specific properties unless provided in context.',
    '- Only mention item effects in general categories: movement speed, armor, magic resist, health, ability haste, grievous wounds, vision control.',
    '- Anti-heal is provided via items only unless explicitly listed. Do NOT attribute anti-heal/Grievous Wounds to champion abilities.',
  ].join('\n');

  const schemaHint = [
    'Required JSON schema:',
    '{',
    '  "summary": string,',
    '  "roleFocus": string,',
    '  "keyMoments": [{ "ts": number, "title": string, "insight": string, "suggestion": string }],',
    '  "buildNotes": [{ "note": string }],',
    '  "macro": { "objectives": string[], "rotations": string[], "vision": string[] },',
    '  "drills": string[],',
    '  "confidence": number (0..1)',
    '}',
  ].join('\n');

  const goals = [
    'Guidance goals:',
    '- Early lane plan; mid-game rotations/objectives; late-game teamfight positioning.',
    '- Include 3–5 drills.',
    '- Call out build/macro misalignments.',
    '- Leverage item categories (anti-heal, defenses, movement speed, damage profile).',
    '- Use duo/jungle synergy context to tailor macro/rotation suggestions.',
    '- Keep it practical.',
  ].join('\n');

  const mechJson = mechanics
    ? JSON.stringify(mechanics)
    : JSON.stringify({
        antiHealItemIds: Array.from(ITEM_GROUPS.GRIEVOUS_WOUNDS),
        rules: [
          'Anti-heal ONLY via items listed; do NOT claim champion abilities apply Grievous Wounds.',
        ],
      });

  return [
    `Locale: ${locale}`,
    header,
    mechanicsRules,
    goals,
    schemaHint,
    'Mechanics constraints (JSON):',
    mechJson,
    'Context (JSON):',
    JSON.stringify(ctx),
    'Return STRICT JSON ONLY.',
  ].join('\n');
}

type LooseInsights = {
  confidence?: unknown;
  keyMoments?: unknown;
  buildNotes?: unknown;
  drills?: unknown;
  macro?: unknown;
};

export function normalizeRawInsights(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  const loose = raw as LooseInsights;

  // Normalize confidence to [0,1]
  const cUnknown = loose.confidence;
  let conf: number | null = null;
  if (typeof cUnknown === 'string') {
    const n = Number.parseFloat(cUnknown);
    conf = Number.isFinite(n) ? n : null;
  } else if (typeof cUnknown === 'number') {
    conf = cUnknown;
  }
  if (conf === null || Number.isNaN(conf)) {
    conf = 0.5;
  } else if (conf > 1) {
    if (conf <= 5)
      conf = conf / 5; // 1-5 scale
    else if (conf <= 100)
      conf = conf / 100; // 0-100 scale
    else conf = 1; // clamp extreme values
  } else if (conf < 0) {
    conf = 0;
  }
  // clamp to [0,1]
  conf = Math.max(0, Math.min(1, conf));
  out.confidence = conf;

  // Trim arrays to schema limits
  const kmUnknown = loose.keyMoments;
  if (Array.isArray(kmUnknown)) {
    out.keyMoments = (kmUnknown as unknown[]).slice(0, 12);
  }

  const bnUnknown = loose.buildNotes;
  if (Array.isArray(bnUnknown)) {
    out.buildNotes = (bnUnknown as unknown[]).slice(0, 8);
  }

  const drillsUnknown = loose.drills;
  if (Array.isArray(drillsUnknown)) {
    out.drills = (drillsUnknown as unknown[]).slice(0, 5);
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
      ? (m.objectives as unknown[]).slice(0, 6)
      : [];
    const rotations = Array.isArray(m.rotations)
      ? (m.rotations as unknown[]).slice(0, 6)
      : [];
    const vision = Array.isArray(m.vision)
      ? (m.vision as unknown[]).slice(0, 6)
      : [];
    out.macro = { objectives, rotations, vision };
  }

  return out;
}

export async function generateMatchInsights(
  ctx: Record<string, unknown>,
  opts?: {
    modelId?: string;
    locale?: string;
    temperature?: number;
    maxTokens?: number;
    mechanics?: {
      antiHealItemIds?: number[];
      championAbilities?: Record<string, string>;
      rules?: string[];
    };
  },
): Promise<MatchInsights> {
  const modelId = opts?.modelId ?? 'openai.gpt-oss-120b-1:0';
  const locale = opts?.locale ?? 'en';
  const temperature = opts?.temperature ?? 0.2;
  const maxTokens = opts?.maxTokens ?? 3000;

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

  // Infer patch for DDragon champions
  const ctxItems = (ctx as { items?: { patch?: string } }).items;
  const patch =
    ctxItems?.patch ??
    inferPatchFromGameVersion(
      (ctx as { info?: { gameVersion?: string } }).info?.gameVersion,
    );
  let championAbilitiesHints: Record<string, string> = {};
  try {
    const champMap = await getChampionMap(patch);
    for (const n of names) {
      const ch = findChampionByName(n, champMap);
      if (ch) {
        championAbilitiesHints[n] = buildAbilityHintFromDDragon(ch);
      }
    }
  } catch (err) {
    consola.warn(
      '[match-insights] Failed to load DDragon champions; continuing without ability hints',
      err,
    );
    championAbilitiesHints = {};
  }

  const mechanicsSpec = opts?.mechanics ?? {
    antiHealItemIds: Array.from(ITEM_GROUPS.GRIEVOUS_WOUNDS),
    rules: [
      'Anti-heal ONLY via items listed; do NOT claim champion abilities apply Grievous Wounds.',
    ],
    ...(Object.keys(championAbilitiesHints).length
      ? { championAbilities: championAbilitiesHints }
      : {}),
  };

  const prompt = buildPrompt(ctx, locale, mechanicsSpec);
  const sanitizedPrompt =
    prompt.includes('```') || prompt.includes('"""')
      ? `${prompt}

IMPORTANT: Respond with ONLY raw JSON (no explanations, no markdown, no code fences, no preambles).`
      : prompt;

  const payload = {
    model: modelId,
    messages: [
      {
        role: 'system',
        content:
          'You are RiftCoach’s match insights generator. Respond ONLY with a valid JSON object that matches the required schema. No preamble, no markdown, no code fences, no extra keys.',
      },
      {
        role: 'user',
        content: sanitizedPrompt,
      },
    ],
    max_completion_tokens: maxTokens,
    temperature,
    top_p: 0.9,
    stream: false,
  };

  const command = new InvokeModelCommand({
    modelId,
    contentType: 'application/json',
    body: JSON.stringify(payload),
  });

  const started = Date.now();
  const response = await bedrockClient.send(command);
  const latencyMs = Date.now() - started;

  if (!response.body) {
    consola.error('[match-insights] No response body from Bedrock');
    throw new Error('No response body from Bedrock');
  }

  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  const aiText =
    responseBody?.choices?.[0]?.message?.content ??
    responseBody?.outputs?.[0]?.text ??
    '{}';

  // Clean and fix malformed JSON responses
  let cleanedText = String(aiText).trim();

  // Remove any markdown code fences or extra text
  cleanedText = cleanedText.replace(/^```json\s*/i, '').replace(/\s*```$/, '');
  cleanedText = cleanedText.replace(/^```\s*/, '').replace(/\s*```$/, '');

  // Remove reasoning chain - look for </reasoning> tag and take everything after it
  const reasoningEndMatch = cleanedText.match(/<\/reasoning>\s*(.*)$/s);
  if (reasoningEndMatch) {
    cleanedText = reasoningEndMatch[1].trim();
  }

  // Also handle other common reasoning patterns
  cleanedText = cleanedText.replace(/^.*?<reasoning>.*?<\/reasoning>\s*/s, '');
  cleanedText = cleanedText.replace(/^.*?reasoning.*?\n\s*/i, '');

  // Find JSON boundaries
  const firstBrace = cleanedText.indexOf('{');
  const lastBrace = cleanedText.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleanedText = cleanedText.slice(firstBrace, lastBrace + 1);
  }

  // Attempt to fix common JSON issues
  cleanedText = fixMalformedJson(cleanedText);

  consola.debug('AI response', cleanedText);

  function sanitizeText(input: string): string {
    let s = String(input);
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
    // Normalize common false claims like "Brand's heal"
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
      summary: sanitizeText(ins.summary),
      roleFocus: sanitizeText(ins.roleFocus),
      keyMoments: ins.keyMoments.map((km) => ({
        ...km,
        insight: sanitizeText(km.insight),
        suggestion: sanitizeText(km.suggestion),
      })),
      buildNotes: ins.buildNotes.map((bn) => ({ note: sanitizeText(bn.note) })),
      macro: {
        objectives: ins.macro.objectives.map(sanitizeText),
        rotations: ins.macro.rotations.map(sanitizeText),
        vision: ins.macro.vision.map(sanitizeText),
      },
      drills: ins.drills.map(sanitizeText),
      confidence: ins.confidence,
    };
  }

  try {
    const parsed = JSON.parse(cleanedText);
    const normalized = normalizeRawInsights(parsed as Record<string, unknown>);
    consola.debug('[match-insights] parsed AI response', {
      modelId,
      latencyMs,
      parsed: JSON.stringify(normalized, null, 2),
    });
    const validated = MatchInsightsSchema.safeParse(normalized);
    if (!validated.success) {
      consola.error(
        '[match-insights] Schema validation failed',
        validated.error.message,
      );
      throw new Error('Invalid AI JSON schema');
    }
    consola.debug('[match-insights] success', { modelId, latencyMs });
    const sanitized = sanitizeInsights(validated.data);
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

    // Try one more time with aggressive cleaning
    try {
      const aggressivelyCleaned = aggressiveJsonCleanup(aiText);
      if (aggressivelyCleaned) {
        const parsed = JSON.parse(aggressivelyCleaned);
        const normalized = normalizeRawInsights(
          parsed as Record<string, unknown>,
        );
        const validated = MatchInsightsSchema.safeParse(normalized);
        if (validated.success) {
          consola.warn('[match-insights] recovered with aggressive cleanup');
          const sanitized = sanitizeInsights(validated.data);
          if (JSON.stringify(validated.data) !== JSON.stringify(sanitized)) {
            consola.warn('[match-insights] mechanics sanitized');
          }
          return sanitized;
        }
      }
    } catch (recoveryError) {
      consola.error('[match-insights] recovery attempt failed', recoveryError);
    }

    // Try to extract partial valid data before falling back completely
    try {
      const partialData = extractPartialInsights(aiText);
      if (partialData && Object.keys(partialData).length > 1) {
        consola.warn('[match-insights] using partial extraction fallback');
        const partial: MatchInsights = {
          summary:
            partialData.summary ||
            'Partial insights generated from available data.',
          roleFocus: partialData.roleFocus || 'UNKNOWN',
          keyMoments: partialData.keyMoments || [],
          buildNotes: partialData.buildNotes || [],
          macro: partialData.macro || {
            objectives: [],
            rotations: [],
            vision: [],
          },
          drills: partialData.drills || [
            'Focus on positioning',
            'Practice last-hitting',
            'Improve map awareness',
          ],
          confidence: (partialData.confidence as number) || 0.3,
        };
        const sanitized = sanitizeInsights(partial);
        if (JSON.stringify(partial) !== JSON.stringify(sanitized)) {
          consola.warn('[match-insights] mechanics sanitized');
        }
        return sanitized;
      }
    } catch (partialError) {
      consola.error('[match-insights] partial extraction failed', partialError);
    }

    // Minimal fallback
    const minimal: MatchInsights = {
      summary: 'Unable to generate full insights at this time.',
      roleFocus: 'UNKNOWN',
      keyMoments: [],
      buildNotes: [],
      macro: { objectives: [], rotations: [], vision: [] },
      drills: [],
      confidence: 0,
    };
    const sanitized = sanitizeInsights(minimal);
    if (JSON.stringify(minimal) !== JSON.stringify(sanitized)) {
      consola.warn('[match-insights] mechanics sanitized');
    }
    return sanitized;
  }
}
