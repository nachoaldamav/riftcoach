import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
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

// Simple helper to extract a JSON object from a text blob
function extractJsonFromText(text: string): string | null {
  // Normalize and strip common wrappers
  const cleaned = text
    .split('</reasoning>')[1]
    .replace(/```json/g, '')
    .replace(/```/g, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/g, '')
    .replace(/^\uFEFF/, '') // strip BOM if present
    .trim();

  if (!cleaned) return null;

  // Find first balanced JSON object, ignoring braces inside quoted strings
  const start = cleaned.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let isEscaped = false;
  let end = -1;

  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (isEscaped) {
      isEscaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      isEscaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
  }

  if (end === -1 || end <= start) return null;
  const candidate = cleaned.slice(start, end + 1).trim();
  return candidate.length ? candidate : null;
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
    'Never label a metric as a weakness when comparisons[metric].isHigherBetter=true and comparisons[metric].bandScore >= 3; that means the player is already beating at least three quarters of their cohort on that metric.',
    'Likewise, if comparisons[metric].performanceScore >= 3 (indicating above-average results after accounting for whether lower or higher is better), do not treat it as a weakness.',
    'If you ever reference a metric with bandScore >= 3 or performanceScore >= 3 inside a weakness bullet for context, explicitly acknowledge that it remains better than the typical player.',
    'For timing metrics: shorter is better; never infer build quality solely from timing; avoid "suboptimal builds".',
    'Use lexicon.metricLabels for names; apm = "Assists per minute" (never "key presses per minute").',
    'Use comparisons[metric].tier to pick a single adjective from lexicon.adjectives (e.g., elite, strong, solid).',

    // <<< NEW PART: structure + anti-generic rules >>>
    'Each strength or weakness bullet MUST have exactly two sentences.',
    'First sentence: a short evaluation using the metric label and the adjective from lexicon.adjectives, written in natural, grammatically correct English.',
    'Examples: "CS per minute is elite.", "Objective participation is strong.", "Deaths per minute needs improvement." (for the "needs improvement" tier, do NOT write "is needs improvement").',
    'You may vary the structure as long as the metric label and adjective appear together (e.g., "Damage taken per minute sits in the needs improvement tier." or "CS per minute remains strong.").',
    'Do not start three consecutive bullets with the exact same phrase; rotate verbs like "is", "remains", "continues", "sits", or "lands" so the openings feel human.',
    'Second sentence: explain the concrete in-game impact. For weaknesses, you may add a light, realistic adjustment if it fits naturally.',
    'The second sentence MUST be specific to the metric and situation (laning, skirmishes, objectives, side-laning, vision, etc.).',
    'When helpful, fold in derived context such as derived.riskProfile or derived.killHunting, but only if it matches the metrics you cite.',
    'DO NOT use generic explanations like "above the typical player for this role" or "lower than most players" as the whole second sentence.',
    'Vary the openings of the second sentences as well; avoid repeating the same stem like "This indicates" three times in a row.',
    'Instead, describe what this means in practice, e.g., "this lets you hit item spikes earlier and pressure your lane" or "this often leaves you low before fights start."',

    'For strengths, second sentence: describe what this reflects about the player’s playstyle or how it benefits their performance. Highlight concrete advantages such as lane control, faster item spikes, stronger map presence, or better fight setup.',
    'Avoid generic comparisons like "above the typical player for this role". Instead, express the *impact* or *benefit* (e.g., "helps you pressure lane and deny CS" or "keeps you relevant in gold even after early setbacks").',
    'You may vary tone between descriptive ("shows strong farming discipline") and interpretive ("you manage waves efficiently to secure leads").',
    'Do not exaggerate; never imply perfect play or guaranteed success. Each bullet should sound like a calm, professional observation rather than praise.',
    'For weaknesses, second sentence: describe what this might reveal about the player’s habits or tendencies (e.g., risky positioning, delayed recalls, poor ward coverage). Offer a light recommendation only if it’s natural; never give hard targets (minutes, gold, item timings).',
    'Prefer interpretive phrasing like "suggests", "can indicate", "often results in", or "may come from" instead of rigid commands.',
    'Never make up numeric thresholds or specific timing goals (like "finish by 6 minutes").',
    'Vary your sentence style; some bullets can end with an insight instead of advice to keep tone natural and human.',
    'Cite at most one key metric per bullet; keep bullets to 2 short sentences total.',
    'Limit strengths/weaknesses to max 3 each.',
    'Return STRICT JSON only. No markdown, no explanations.',
    schemaHint,
  ].join('\\n');

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

      const payload = {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_completion_tokens: 3000,
        temperature: 0.3,
        top_p: 0.9,
        stream: false,
      };

      const modelId = process.env.INSIGHTS_MODEL || 'openai.gpt-oss-20b-1:0';
      const maxAttempts = 3;
      let contentText = '';
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const command = new InvokeModelCommand({
            modelId,
            contentType: 'application/json',
            accept: 'application/json',
            body: JSON.stringify(payload),
          });
          const response = await bedrockClient.send(command);
          const bodyText = new TextDecoder().decode(
            response.body ?? new Uint8Array(),
          );
          const parsed = JSON.parse(bodyText);
          contentText = String(
            parsed?.choices?.[0]?.message?.content ?? '',
          ).trim();
          break;
        } catch (err) {
          const msg = (err as Error)?.message || '';
          if (
            msg.toLowerCase().includes('too many requests') &&
            attempt < maxAttempts - 1
          ) {
            const base = 600;
            const delayMs = base * (attempt + 1);
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

      consola.debug('[champion-role-insights] AI response', contentText);

      const jsonText = extractJsonFromText(contentText);
      if (!jsonText) {
        consola.warn(
          '[champion-role-insights] No valid assistant JSON found. Returning fallback insights.',
          { extractedPreview: contentText.slice(0, 400) },
        );
        return {
          summary: `Performance review for ${stats.championName} (${stats.role}).`,
          strengths: [],
          weaknesses: [],
        };
      }

      let parsed: Partial<ChampionRoleInsightResult> = {};
      try {
        parsed = JSON.parse(jsonText) as Partial<ChampionRoleInsightResult>;
      } catch (parseErr) {
        consola.warn(
          '[champion-role-insights] Failed to parse assistant JSON. Returning fallback insights.',
          {
            extractedPreview: contentText.slice(0, 400),
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
