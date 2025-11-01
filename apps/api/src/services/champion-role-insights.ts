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

function buildPrompt(
  stats: ChampionRoleStats,
  cohort: CohortPercentilesDoc | null,
  player: PlayerPercentilesDoc | null,
): string {
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
    },
    bannedPhrases: [
      'key presses per minute',
      'percentile',
      'p75',
      'p90',
      'cohort',
      'median',
    ],
    negativeMetrics: ['deathsPerMin', 'dtpm', 'firstItemCompletionTime'],
  } as const;

  const getNumber = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;

  // Prefer player's p50 (midpoint) where available to mitigate outliers
  const pickPlayerMid = (key: string, fallback: number | null): number | null => {
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
    deathsPerMin: pickPlayerMid('deathsPerMin', getNumber(stats.avgDeathsPerMin)),
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
    'deathsPerMin',
    'goldAt10',
    'csAt10',
    'goldAt15',
    'csAt15',
    'kda',
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
      case 'unknown':
      default:
        return null;
    }
  };

  const scoreToTier = (score: number | null):
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

  const describeBand = (
    band: Band,
    isHigherBetter: boolean,
  ): string => {
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
      m as 'dtpm' | 'deathsPerMin',
    );
    const performanceScore =
      baseScore == null
        ? null
        : isHigherBetter
          ? baseScore
          : 5 - baseScore;
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
    takesHeavyDamage && killsVeryHigh && deathsProblematic ? 'killSeeker' : null;

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

  return `You are a supportive League of Legends coach. Give a concise, human, friendly analysis of the player's performance on ${stats.championName} (${stats.role}). Use the cohort percentiles only to calibrate comparisons internally — do not mention the words "percentile", "p75", "p90", or "cohort" in the output. Prefer plain-English phrases and helpful context.

Return ONLY valid JSON:
{
  "summary": "One-sentence overview in plain English",
  "strengths": ["Human-friendly insight with simple numbers"],
  "weaknesses": ["Human-friendly insight with simple numbers"]
}

Style and rules:
  - Speak directly to the player using "you".
  - Treat "average" as the typical midpoint level (not the mean). Internally use p50 as the cohort's midpoint reference, but do not say "median" or other statistical terms.
  - If a metric is just below the midpoint (slightly under p50), avoid saying "below average". Prefer gentler phrasing like "slightly below typical levels" or "a bit behind most players".
  - Translate percentile comparisons into everyday phrases:
    - ≥ p95: "best-in-class", "among the very top"
    - p90–p95: "elite"
    - p75–p90: "strong", "better than most players"
    - p50–p75: "solid", "slightly above average"
    - p25–p50: "about average"
    - < p25: "needs improvement", "below most players"
  - Do NOT use technical terms like "percentile", "p75/p90", or "cohort" in the output.
  - Use lexicon.metricLabels for metric names; apm = "Assists per minute" (never "key presses per minute").
  - Use comparisons[metric] for judgments: rely on directionRelativeToP50 and band.
  - comparisons[metric].summaryText already converts the percentile math into natural language—use it to keep statements precise.
  - Treat near_p50 (abs delta < 3%) as "about average".
  - For negative metrics (deathsPerMin, dtpm): higher = worse, lower = better.
  - derived.riskProfile tells you whether heavy damage intake is controlled ('absorbsPressureWell'), neutral ('tradesEvenly'), or reckless ('overextending'); highlight this when appropriate.
  - If derived.killHunting === 'killSeeker', point out that the player is tunnel-visioning on kills and should protect their life bar.
  - Cite at most one key metric per bullet.
  - Prefer clean numbers: round decimals; convert rates to intuitive units (e.g., say "about one death every 7–8 minutes" using derived.minutesPerDeath).
  - Keep each bullet to 1–2 short sentences. Limit to max 3 strengths and 3 weaknesses.
  - If data is insufficient for a metric, say so instead of guessing.
  - Avoid using total CS per game because match length varies; prefer CS at 10/15 minutes (provided) and per-minute metrics if present.
   - Avoid using total CS per game because match length varies; prefer CS per minute (CSPM, provided) and CS at 10/15 minutes.

Player data:
${JSON.stringify(payload, null, 2)}
`;
}

export async function generateChampionRoleInsights(
  stats: ChampionRoleStats,
  cohort: CohortPercentilesDoc | null,
  player: PlayerPercentilesDoc | null,
): Promise<ChampionRoleInsightResult> {
  try {
    const prompt = buildPrompt(stats, cohort, player);
    const command = new InvokeModelCommand({
      modelId: 'mistral.mixtral-8x7b-instruct-v0:1',
      contentType: 'application/json',
      body: JSON.stringify({
        prompt: `<s>[INST] ${prompt} [/INST]`,
        max_tokens: 800,
        temperature: 0.2,
        top_p: 0.9,
        top_k: 50,
      }),
    });

    const response = await bedrockClient.send(command);
    if (!response.body) throw new Error('No response body from Bedrock');

    const raw = JSON.parse(
      new TextDecoder().decode(response.body as Uint8Array),
    );
    const text: string = raw.outputs?.[0]?.text ?? '{}';
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    const json = start !== -1 && end !== -1 ? text.slice(start, end + 1) : text;
    const parsed = JSON.parse(json) as Partial<ChampionRoleInsightResult>;

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
}
