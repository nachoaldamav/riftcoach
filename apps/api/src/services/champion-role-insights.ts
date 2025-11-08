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
    'Your job is to turn the provided JSON data into a short, practical performance review for the player on this champion and role.',
    'Use ONLY the provided data. If something is missing or unclear, simply avoid talking about it; do not invent numbers, facts, or situations.',
    'Always talk directly to the player using "you".',

    // --- How to interpret the data ---
    'The JSON already contains comparisons against similar players in "comparisons[metric]".',
    'Treat "average" as the typical midpoint level (this is comparisons[metric].cohort.p50). Never mention "percentiles", "p75", "p90", "median", or "cohort" by name.',
    'For positive metrics (winRate, kda, cspm, dpm, kpm, apm, objectiveParticipationPct, goldAt10/15, csAt10/15 etc.): higher is better.',
    'For negative metrics (deathsPerMin, dtpm, earlyGankDeathRate, firstItemCompletionTime): lower is better.',
    'comparisons[metric].performanceScore already accounts for whether higher or lower is better.',
    'Use these thresholds:',
    '  • Strong strength candidate: performanceScore >= 4.',
    '  • Soft strength candidate: performanceScore = 3.',
    '  • Neutral: performanceScore = 2 (do NOT list in strengths or weaknesses).',
    '  • Clear weakness candidate: performanceScore <= 1.',
    'Never override these thresholds.',

    // --- What to choose as strengths / weaknesses ---
    'Strengths:',
    '  • Choose at most three metrics with the highest performanceScore (prioritise >= 4, then 3).',
    '  • Do NOT mark any metric as a strength if performanceScore <= 2.',
    'Weaknesses:',
    '  • Choose at most three metrics with the lowest performanceScore (prioritise <= 1).',
    '  • Do NOT mark any metric as a weakness if performanceScore >= 3.',
    'Metrics with performanceScore between 1 and 3 are neutral and should not appear in the strengths or weaknesses lists.',
    'Never label a metric as a weakness when comparisons[metric].bandScore >= 3 or comparisons[metric].performanceScore >= 3; that means the player is already ahead of most similar players.',
    'If you mention a metric in a weakness bullet that still has bandScore >= 3 or performanceScore >= 3 (for context), you MUST clearly say that the player is already above average on it.',
    'If there are no clear weakness candidates (no metric with performanceScore <= 1), return weaknesses as an empty array.',

    // --- Special handling for objective participation and timings ---
    'objectiveParticipationPct is always a positive metric: higher is better.',
    'Never tell the player to "engage more" or similar if objectiveParticipationPct has performanceScore >= 3; instead, treat it as a strength.',
    'For timing metrics like firstItemCompletionTime: shorter is better.',
    'Do not judge item builds or say "suboptimal builds"; only talk about timing and its impact (earlier or later spikes).',

    // --- Lexicon and banned phrases ---
    'Metric labels must come from lexicon.metricLabels (for example: apm = "Assists per minute", never "key presses per minute").',
    'Use comparisons[metric].tier together with lexicon.adjectives to determine the qualitative tier (bestInClass, elite, strong, solid, average, needsImprovement).',
    'Never use these exact phrases in your output: "key presses per minute", "percentile", "p75", "p90", "cohort", "median", "suboptimal builds".',

    // --- How to handle above-average but improvable stats ---
    'If a metric is a strength but not at the very top (performanceScore = 3), you may gently mention that there is still room to refine it.',
    'In those cases, explicitly acknowledge that the player is already above average, then optionally add a realistic suggestion, e.g. "You are already ahead of most players here, and you could try to…".',
    'Do NOT turn such metrics into weaknesses; they stay as strengths with an optional refinement comment.',

    // --- Bullet structure and style ---
    'You must output strengths and weaknesses as arrays of text bullets.',
    'Each bullet MUST have exactly two sentences.',
    'First sentence: give a short evaluation using the metric label and its tier, in natural English.',
    '  • Examples (non-exhaustive): "CS per minute is elite.", "Objective participation is strong.", "Damage taken per minute is average."',
    '  • For the "needsImprovement" tier, NEVER write "is needs improvement". Instead use natural phrasing such as "is a clear area for improvement", "is currently a weak point", or "is a consistent pain point".',
    '  • Vary the first sentence so not every bullet begins the same way; switch between verbs like "is", "remains", "sits", "continues to be", or "stands out as".',
    'Second sentence: explain the concrete in-game impact of this metric.',
    '  • Focus on specific situations: laning, wave control, skirmishes, teamfights, side-laning, objective setups, catching waves, surviving ganks, etc.',
    '  • For strengths, describe how this helps the player (e.g., earlier item spikes, safer map control, better fight setups).',
    '  • For weaknesses, describe what this usually looks like in games (e.g., risky positioning, late recalls, poor ward coverage) and offer a light, realistic adjustment.',
    '  • Use soft, interpretive language such as "can indicate", "often means", "may come from", "can make it easier to", rather than hard commands.',
    'Do not repeat the exact same wording across bullets; keep them varied and human-sounding.',
    'Mention at most one main metric per bullet; keep sentences short and easy to read.',

    // --- Summary line ---
    'summary should be one or two short sentences that describe the overall pattern of the player on this champion and role.',
    'It should briefly reference whether the profile is more strength-skewed, weakness-skewed, or mixed, without re-listing every metric.',
    'Do not include numbers or technical terms (p50, bands, tiers) in the summary; keep it high-level and readable.',

    // --- Output format ---
    'Return STRICT JSON only. No markdown, no extra explanations, no commentary outside the JSON object.',
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
        temperature: 1,
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
