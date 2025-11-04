import {
  type ContentBlock,
  ConverseCommand,
  type Message,
} from '@aws-sdk/client-bedrock-runtime';
import chalk from 'chalk';
import consola from 'consola';
import { bedrockClient } from '../clients/bedrock.js';
import type { CohortPercentilesDoc } from './champion-role-algo.js';
import type { ChampionRoleStats } from './champion-role-score.js';

export type PlayerPercentilesDoc = {
  championName: string;
  role: string;
  percentiles: {
    p50: Record<string, number>;
    p75: Record<string, number>;
    p90: Record<string, number>;
    p95: Record<string, number>;
  };
};

export type ChampionRoleInsightResult = {
  summary: string;
  strengths: string[];
  weaknesses: string[];
};

// In-memory cache and inflight de-duplication to avoid redundant Bedrock calls
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const insightCache = new Map<
  string,
  { ts: number; result: ChampionRoleInsightResult }
>();
const inflightRequests = new Map<string, Promise<ChampionRoleInsightResult>>();

function buildCacheKey(
  stats: ChampionRoleStats,
  cohort: CohortPercentilesDoc | null,
  player: PlayerPercentilesDoc | null,
): string {
  return JSON.stringify({ stats, cohort, player });
}

// Extract plain text from Bedrock converse message
function extractTextFromMessage(message: Message | undefined): string {
  consola.debug('Extracting text from message:', message);
  if (!message?.content) return '';
  const textBlocks = message.content
    .map((block) => ('text' in block && block.text ? block.text : null))
    .filter((v): v is string => typeof v === 'string');
  const raw = textBlocks
    .join('\n')
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, '');
  return raw.replace('```json', '').replace('```', '').trim();
}

// Find the last assistant message that actually contains text we can parse
function getLastAssistantWithText(messages: Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const txt = extractTextFromMessage(m);
    if (txt && txt.trim().length > 0) return m;
  }
  return undefined;
}

function describeContentBlocks(
  blocks: ContentBlock[],
): Array<{ type: string; length?: number }> {
  return blocks.map((b) => {
    if ('text' in b) return { type: 'text', length: (b.text ?? '').length };
    if ('toolUse' in b) return { type: 'toolUse' };
    if ('toolResult' in b) return { type: 'toolResult' };
    if ('reasoningContent' in b) return { type: 'reasoning' };
    return { type: 'unknown' };
  });
}

function buildPrompts(
  stats: ChampionRoleStats,
  cohort: CohortPercentilesDoc | null,
  player: PlayerPercentilesDoc | null,
): { systemPrompt: string; userPrompt: string } {
  const percentiles = cohort?.percentiles ?? null;
  const playerPercentiles = player?.percentiles ?? null;
  // Controlled lexicon and numeric guardrails
  const lexicon = {
    adjectives: {
      bestInClass: ['best-in-class', 'among the very top'],
      elite: ['elite'],
      strong: ['strong', 'better than most players'],
      solid: ['solid', 'slightly above average'],
      average: ['about average'],
      needsImprovement: ['needs improvement', 'below most players'],
    },
    metricLabels: {
      cspm: 'CS per minute',
      dpm: 'Damage per minute',
      dtpm: 'Damage taken per minute',
      kpm: 'Kills per minute',
      apm: 'Assists per minute',
      deathsPerMin: 'Deaths per minute',
      goldAt10: 'Gold at 10',
      csAt10: 'CS at 10',
      goldAt15: 'Gold at 15',
      csAt15: 'CS at 15',
      kda: 'KDA',
      winRate: 'Win Rate',
      firstItemCompletionTime: 'First item completion time',
      objectiveParticipationPct: 'Objective participation rate',
      earlyGankDeathRate: 'Early gank death rate',
    },
    bannedPhrases: [
      'key presses per minute',
      'percentile',
      'p75',
      'p90',
      'cohort',
      'median',
      'suboptimal builds',
    ],
    negativeMetrics: [
      'deathsPerMin',
      'dtpm',
      'firstItemCompletionTime',
      'earlyGankDeathRate',
    ],
  } as const;

  const getNumber = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;

  // Prefer player's p50 (midpoint) where available to mitigate outliers
  const pickPlayerMid = (
    key: string,
    fallback: number | null,
  ): number | null => {
    const val = getNumber(playerPercentiles?.p50?.[key]);
    return val ?? fallback;
  };

  const averages = {
    winRate: getNumber(stats.winRate),
    kda: getNumber(stats.kda),
    goldEarned: pickPlayerMid('goldEarned', getNumber(stats.avgGoldEarned)),
    cspm: getNumber(stats.avgCspm), // player percentiles may not include cspm
    dpm: pickPlayerMid('dpm', getNumber(stats.avgDpm)),
    dtpm: pickPlayerMid('dtpm', getNumber(stats.avgDtpm)),
    kpm: pickPlayerMid('kpm', getNumber(stats.avgKpm)),
    apm: pickPlayerMid('apm', getNumber(stats.avgApm)),
    deathsPerMin: pickPlayerMid(
      'deathsPerMin',
      getNumber(stats.avgDeathsPerMin),
    ),
    goldAt10: pickPlayerMid('goldAt10', getNumber(stats.avgGoldAt10)),
    csAt10: pickPlayerMid('csAt10', getNumber(stats.avgCsAt10)),
    goldAt15: pickPlayerMid('goldAt15', getNumber(stats.avgGoldAt15)),
    csAt15: pickPlayerMid('csAt15', getNumber(stats.avgCsAt15)),
    damageShare: getNumber(stats.avgDamageShare),
    damageTakenShare: getNumber(stats.avgDamageTakenShare),
    objectiveParticipationPct: getNumber(stats.avgObjectiveParticipationPct),
    earlyGankDeathRate: getNumber(stats.earlyGankDeathRateSmart),
    firstItemCompletionTime: getNumber(stats.avgFirstItemCompletionTime),
  };

  const minutesPerDeath =
    averages.deathsPerMin && averages.deathsPerMin > 0
      ? 60 / (averages.deathsPerMin as number)
      : null;

  type Band =
    | 'unknown'
    | 'below_p50'
    | 'near_p50'
    | 'p50_to_p75'
    | 'p75_to_p90'
    | 'p90_to_p95'
    | 'above_p95';

  const toBand = (
    val: number | null,
    p50: number | null,
    p75: number | null,
    p90: number | null,
    p95: number | null,
  ): {
    band: Band;
    deltaPct: number | null;
    direction: 'higher' | 'lower' | 'equal' | 'unknown';
  } => {
    if (val == null || p50 == null)
      return { band: 'unknown', deltaPct: null, direction: 'unknown' };
    const deltaPct =
      p50 === 0 ? (val === 0 ? 0 : 100) : ((val - p50) / p50) * 100;
    const abs = Math.abs(deltaPct);
    if (abs < 3) return { band: 'near_p50', deltaPct, direction: 'equal' };
    if (p95 != null && val >= p95)
      return { band: 'above_p95', deltaPct, direction: 'higher' };
    if (p90 != null && val >= p90)
      return { band: 'p90_to_p95', deltaPct, direction: 'higher' };
    if (p75 != null && val >= p75)
      return { band: 'p75_to_p90', deltaPct, direction: 'higher' };
    if (val >= p50)
      return { band: 'p50_to_p75', deltaPct, direction: 'higher' };
    return { band: 'below_p50', deltaPct, direction: 'lower' };
  };

  const metrics: Array<keyof typeof averages> = [
    'cspm',
    'dpm',
    'dtpm',
    'kpm',
    'apm',
    'objectiveParticipationPct',
    'deathsPerMin',
    'goldAt10',
    'csAt10',
    'goldAt15',
    'csAt15',
    'kda',
    'earlyGankDeathRate',
    'firstItemCompletionTime',
  ];

  const comparisons: Record<
    string,
    {
      value: number | null;
      cohort: {
        p50: number | null;
        p75: number | null;
        p90: number | null;
        p95: number | null;
      };
      band: Band;
      deltaPctFromP50: number | null;
      directionRelativeToP50: 'higher' | 'lower' | 'equal' | 'unknown';
      isHigherBetter: boolean;
      bandScore: number | null;
      performanceScore: number | null;
      tier:
        | 'bestInClass'
        | 'elite'
        | 'strong'
        | 'solid'
        | 'average'
        | 'needsImprovement'
        | 'unknown';
      summaryText: string;
    }
  > = {};

  const getNum = (x: unknown) =>
    typeof x === 'number' && Number.isFinite(x) ? x : null;

  const bandToScore = (band: Band): number | null => {
    switch (band) {
      case 'below_p50':
        return 0;
      case 'near_p50':
        return 1;
      case 'p50_to_p75':
        return 2;
      case 'p75_to_p90':
        return 3;
      case 'p90_to_p95':
        return 4;
      case 'above_p95':
        return 5;
      default:
        return null;
    }
  };

  const scoreToTier = (
    score: number | null,
  ):
    | 'bestInClass'
    | 'elite'
    | 'strong'
    | 'solid'
    | 'average'
    | 'needsImprovement'
    | 'unknown' => {
    if (score == null) return 'unknown';
    if (score >= 5) return 'bestInClass';
    if (score >= 4) return 'elite';
    if (score >= 3) return 'strong';
    if (score >= 2) return 'solid';
    if (score >= 1) return 'average';
    return 'needsImprovement';
  };

  const describeBand = (band: Band, isHigherBetter: boolean): string => {
    if (band === 'unknown')
      return 'Not enough reliable data to judge this metric yet.';

    const describe = (
      higherText: string,
      lowerText: string,
      neutralText: string,
    ): string => (isHigherBetter ? higherText : lowerText) ?? neutralText;

    switch (band) {
      case 'above_p95':
        return describe(
          'You outperform almost every comparable player here.',
          'This number is higher (worse) than almost every comparable player.',
          'Performance is far from the midpoint.',
        );
      case 'p90_to_p95':
        return describe(
          'You are among the elite in this area.',
          'This is higher (worse) than roughly 90% of players.',
          'Performance is significantly different from the midpoint.',
        );
      case 'p75_to_p90':
        return describe(
          'You beat about three quarters of players on this front.',
          'This is higher (worse) than about three quarters of players.',
          'Performance differs notably from the midpoint.',
        );
      case 'p50_to_p75':
        return describe(
          'You are a bit ahead of the typical player.',
          'Slightly higher (worse) than the typical player.',
          'Close to the midpoint.',
        );
      case 'near_p50':
        return 'Roughly on par with the typical player for this role.';
      case 'below_p50':
        return describe(
          'A bit behind most players on this metric.',
          'You keep this metric lower (better) than most players.',
          'A bit below the midpoint.',
        );
      default:
        return 'Not enough reliable data to judge this metric yet.';
    }
  };

  for (const m of metrics) {
    const p50 = getNum(percentiles?.p50?.[m as string]);
    const p75 = getNum(percentiles?.p75?.[m as string]);
    const p90 = getNum(percentiles?.p90?.[m as string]);
    const p95 = getNum(percentiles?.p95?.[m as string]);
    const { band, deltaPct, direction } = toBand(
      averages[m],
      p50,
      p75,
      p90,
      p95,
    );
    const baseScore = bandToScore(band);
    const isHigherBetter = !lexicon.negativeMetrics.includes(
      m as 'dtpm' | 'deathsPerMin' | 'firstItemCompletionTime',
    );
    const performanceScore =
      baseScore == null ? null : isHigherBetter ? baseScore : 5 - baseScore;
    comparisons[m as string] = {
      value: averages[m],
      cohort: { p50, p75, p90, p95 },
      band,
      deltaPctFromP50: deltaPct,
      directionRelativeToP50: direction,
      isHigherBetter,
      bandScore: baseScore,
      performanceScore,
      tier: scoreToTier(performanceScore),
      summaryText: describeBand(band, isHigherBetter),
    };
  }

  const getPerformanceScore = (metric: keyof typeof averages): number | null =>
    typeof comparisons[metric]?.performanceScore === 'number'
      ? (comparisons[metric]?.performanceScore as number)
      : null;

  const getBandScore = (metric: keyof typeof averages): number | null =>
    typeof comparisons[metric]?.bandScore === 'number'
      ? (comparisons[metric]?.bandScore as number)
      : null;

  const dtpmBandScore = getBandScore('dtpm');
  const deathsScore = getPerformanceScore('deathsPerMin');
  const killsScore = getPerformanceScore('kpm');

  const takesHeavyDamage = dtpmBandScore != null && dtpmBandScore >= 3;
  const deathsWellManaged = deathsScore != null && deathsScore >= 4;
  const deathsProblematic = deathsScore != null && deathsScore <= 2;
  const killsVeryHigh = killsScore != null && killsScore >= 3;

  const riskProfile = takesHeavyDamage
    ? deathsWellManaged
      ? 'absorbsPressureWell'
      : deathsProblematic
        ? 'overextending'
        : 'tradesEvenly'
    : 'unknown';

  const killHunting =
    takesHeavyDamage && killsVeryHigh && deathsProblematic
      ? 'killSeeker'
      : null;

  const payload = {
    championName: stats.championName,
    role: stats.role,
    totalMatches: stats.totalMatches,
    wins: stats.wins,
    losses: stats.losses,
    averages: {
      // Reflect the actual values used (player midpoints where available)
      winRate: averages.winRate,
      kda: averages.kda,
      goldEarned: averages.goldEarned,
      cspm: averages.cspm,
      dpm: averages.dpm,
      dtpm: averages.dtpm,
      kpm: averages.kpm,
      apm: averages.apm,
      deathsPerMin: averages.deathsPerMin,
      goldAt10: averages.goldAt10,
      csAt10: averages.csAt10,
      goldAt15: averages.goldAt15,
      csAt15: averages.csAt15,
      damageShare: averages.damageShare,
      damageTakenShare: averages.damageTakenShare,
      objectiveParticipationPct: averages.objectiveParticipationPct,
      earlyGankDeathRate: averages.earlyGankDeathRate,
      firstItemCompletionTime: averages.firstItemCompletionTime,
    },
    cohortPercentiles: percentiles,
    comparisons,
    derived: {
      minutesPerDeath,
      riskProfile,
      killHunting,
    },
    lexicon,
  };

  const schemaHint = [
    'Return STRICT JSON matching:',
    '{',
    '  "summary": string',
    '  "strengths": string[] (max 3)',
    '  "weaknesses": string[] (max 3)',
    '}',
  ].join('\n');

  const systemPrompt = [
    'You are RiftCoach, a League of Legends coaching assistant.',
    'Use ONLY the provided player data. If data is missing, say so and avoid fabrications.',
    'Speak directly to the player using "you".',
    'Treat "average" as the typical midpoint level (internally use p50). Do not mention percentiles or cohort terms.',
    'For negative metrics (deathsPerMin, dtpm, firstItemCompletionTime): higher = worse; lower = better.',
    'For positive metrics (including objectiveParticipationPct): higher = better; lower = worse.',
    'Classification rules using provided comparisons: if isHigherBetter=true and directionRelativeToP50="higher" → strength; if isHigherBetter=true and directionRelativeToP50="lower" → weakness; if isHigherBetter=false and directionRelativeToP50="higher" → weakness; if isHigherBetter=false and directionRelativeToP50="lower" → strength.',
    'Specifically for objectiveParticipationPct: it is a positive metric. Never suggest to "engage more" (or equivalents) when it is above average; only suggest increasing participation when it is below average.',
    'Avoid contradictory bullets; do not call an above-average metric a weakness or advise increasing it.',
    'For timing metrics: shorter is better; never infer build quality solely from timing; avoid "suboptimal builds".',
    'Use lexicon.metricLabels for names; apm = "Assists per minute" (never "key presses per minute").',
    'Cite at most one key metric per bullet; keep bullets to 1–2 short sentences.',
    'Limit strengths/weaknesses to max 3 each.',
    'Return STRICT JSON only. No markdown, no explanations.',
    schemaHint,
  ].join('\n');

  const userPrompt = ['Player data (JSON):', JSON.stringify(payload)].join(
    '\n',
  );

  return { systemPrompt, userPrompt };
}

export async function generateChampionRoleInsights(
  stats: ChampionRoleStats,
  cohort: CohortPercentilesDoc | null,
  player: PlayerPercentilesDoc | null,
): Promise<ChampionRoleInsightResult> {
  const cacheKey = buildCacheKey(stats, cohort, player);
  const cached = insightCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.result;
  }

  if (inflightRequests.has(cacheKey)) {
    const inflight = inflightRequests.get(cacheKey);
    if (inflight) {
      return await inflight;
    }
  }

  const work = (async (): Promise<ChampionRoleInsightResult> => {
    try {
      const { systemPrompt, userPrompt } = buildPrompts(stats, cohort, player);
      const messages: Message[] = [
        { role: 'user', content: [{ text: userPrompt }] },
      ];
      let finalMessage: Message | undefined;

      // Mirror match-insights: multi-turn loop until we get a text block
      const MAX_ITERATIONS = 3;
      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        const command = new ConverseCommand({
          modelId: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
          system: [{ text: systemPrompt }],
          messages,
          inferenceConfig: { maxTokens: 3000 },
          additionalModelRequestFields: {
            reasoning_config: { type: 'enabled', budget_tokens: 1024 },
          },
        });

        // Simple retry for Bedrock rate limits (single retry)
        const maxAttempts = 2;
        let assistantMessage: Message | undefined;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          try {
            const response = await bedrockClient.send(command);
            assistantMessage =
              response.output && 'message' in response.output
                ? (response.output.message as Message)
                : undefined;
            break;
          } catch (err) {
            const msg = (err as Error)?.message || '';
            if (
              msg.toLowerCase().includes('too many requests') &&
              attempt < maxAttempts - 1
            ) {
              const delayMs = 500;
              consola.warn('[champion-role-insights] rate limited, retrying', {
                attempt: attempt + 1,
                delayMs,
              });
              await new Promise((res) => setTimeout(res, delayMs));
              continue;
            }
            throw err;
          }
        }
        if (!assistantMessage) throw new Error('No assistant message received');
        const contentBlocks: ContentBlock[] = assistantMessage.content ?? [];
        const hasText = contentBlocks.some((block) => {
          return (
            'text' in block &&
            typeof block.text === 'string' &&
            block.text.trim().length > 0
          );
        });
        const endsWithThinking =
          contentBlocks.length > 0 &&
          'reasoningContent' in contentBlocks[contentBlocks.length - 1];

        // If the assistant produced text, capture and exit
        if (hasText) {
          messages.push(assistantMessage);
          finalMessage = assistantMessage;
          break;
        }

        // If the assistant responded only with reasoning, DO NOT add it to messages.
        // Nudge with a brief user reminder to return strict JSON.
        if (!hasText && endsWithThinking) {
          messages.push({
            role: 'user',
            content: [
              {
                text: 'Return STRICT JSON matching the requested schema. No markdown, no explanations.',
              },
            ],
          });
          continue;
        }

        // Fallback: if no usable text and not thinking-only, gently remind again
        messages.push({
          role: 'user',
          content: [{ text: 'Please provide the JSON output now.' }],
        });
      }

      // Only parse assistant text; avoid accidentally parsing a user reminder
      if (!finalMessage) finalMessage = getLastAssistantWithText(messages);

      const aiText =
        finalMessage && finalMessage.role === 'assistant'
          ? extractTextFromMessage(finalMessage)
          : '';
      consola.debug(
        '[champion-role-insights] AI response (truncated)',
        aiText.slice(0, 400),
      );

      // If no JSON-looking content, return a graceful fallback without throwing
      const start = aiText.indexOf('{');
      const end = aiText.lastIndexOf('}');
      if (aiText.length === 0 || start === -1 || end === -1 || end <= start) {
        const blocks = finalMessage?.content ?? [];
        consola.warn(
          '[champion-role-insights] No valid assistant JSON found. Returning fallback insights.',
          {
            blockTypes: describeContentBlocks(blocks),
            extractedPreview: aiText.slice(0, 400),
          },
        );
        return {
          summary: `Performance review for ${stats.championName} (${stats.role}).`,
          strengths: [],
          weaknesses: [],
        };
      }

      const json = aiText.slice(start, end + 1);
      let parsed: Partial<ChampionRoleInsightResult> = {};
      try {
        parsed = JSON.parse(json) as Partial<ChampionRoleInsightResult>;
      } catch (parseErr) {
        // Parsing failed even though braces exist; fall back quietly
        const blocks = finalMessage?.content ?? [];
        consola.warn(
          '[champion-role-insights] Failed to parse assistant JSON. Returning fallback insights.',
          {
            blockTypes: describeContentBlocks(blocks),
            extractedPreview: aiText.slice(0, 400),
            errorMessage:
              parseErr instanceof Error ? parseErr.message : String(parseErr),
          },
        );
        return {
          summary: `Performance review for ${stats.championName} (${stats.role}).`,
          strengths: [],
          weaknesses: [],
        };
      }

      const summary =
        typeof parsed.summary === 'string'
          ? parsed.summary
          : `Performance review for ${stats.championName} (${stats.role}).`;

      const strengths = Array.isArray(parsed.strengths)
        ? parsed.strengths.slice(0, 3).map((s) => String(s))
        : [];

      const weaknesses = Array.isArray(parsed.weaknesses)
        ? parsed.weaknesses.slice(0, 3).map((s) => String(s))
        : [];

      return { summary, strengths, weaknesses };
    } catch (error) {
      const err = error as Error;
      consola.error(
        chalk.red('[champion-role-insights] Failed to generate AI insights'),
        err.message,
      );

      return {
        summary: `With ${stats.totalMatches} games and ${(stats.winRate * 100).toFixed(1)}% win rate on ${stats.championName} (${stats.role}), additional insights are unavailable.`,
        strengths: [],
        weaknesses: [],
      };
    }
  })();

  inflightRequests.set(cacheKey, work);
  const result = await work;
  inflightRequests.delete(cacheKey);
  insightCache.set(cacheKey, { ts: Date.now(), result });
  return result;
}
