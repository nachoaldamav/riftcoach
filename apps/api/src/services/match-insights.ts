import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import consola from 'consola';
import z from 'zod';
import { bedrockClient } from '../clients/bedrock.js';

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

function buildPrompt(ctx: Record<string, unknown>, locale = 'en') {
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
    '- Mention concrete item names/effects; call out anti-heal and mythic timings.',
    '- Compare against opponent role using available stats; be specific.',
    '',
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
    '- Leverage item metadata and names (anti-heal, mythic, damage profile).',
    '- Use duo/jungle synergy context to tailor macro/rotation suggestions.',
    '- Keep it practical.',
  ].join('\n');

  return [
    `Locale: ${locale}`,
    header,
    goals,
    schemaHint,
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
  },
): Promise<MatchInsights> {
  const modelId = opts?.modelId ?? 'openai.gpt-oss-120b-1:0';
  const locale = opts?.locale ?? 'en';
  const temperature = opts?.temperature ?? 0.2;
  const maxTokens = opts?.maxTokens ?? 1200;

  const prompt = buildPrompt(ctx, locale);
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

  // Attempt strict parse first; otherwise trim to first/last brace
  let cleanedText = String(aiText);
  const firstBrace = cleanedText.indexOf('{');
  const lastBrace = cleanedText.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleanedText = cleanedText.slice(firstBrace, lastBrace + 1);
  }

  consola.debug('AI response', cleanedText);

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
    return validated.data;
  } catch (error) {
    consola.error('[match-insights] parse error', error);
    // Minimal fallback
    return {
      summary: 'Unable to generate full insights at this time.',
      roleFocus: 'UNKNOWN',
      keyMoments: [],
      buildNotes: [],
      macro: { objectives: [], rotations: [], vision: [] },
      drills: [],
      confidence: 0,
    };
  }
}
