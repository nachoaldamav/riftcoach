import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import chalk from 'chalk';
import consola from 'consola';
import { bedrockClient } from '../clients/bedrock.js';
import type { CohortPercentilesDoc } from './champion-role-algo.js';
import type { ChampionRoleStats } from './champion-role-score.js';

export type ChampionRoleInsightResult = {
  summary: string;
  strengths: string[];
  weaknesses: string[];
};

function buildPrompt(
  stats: ChampionRoleStats,
  cohort: CohortPercentilesDoc | null,
): string {
  const percentiles = cohort?.percentiles ?? null;
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
    },
    bannedPhrases: [
      'key presses per minute',
      'percentile',
      'p75',
      'p90',
      'cohort',
    ],
    negativeMetrics: ['deathsPerMin', 'dtpm'],
  } as const;

  const getNumber = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;

  const averages = {
    winRate: getNumber(stats.winRate),
    kda: getNumber(stats.kda),
    goldEarned: getNumber(stats.avgGoldEarned),
    cspm: getNumber(stats.avgCspm),
    dpm: getNumber(stats.avgDpm),
    dtpm: getNumber(stats.avgDtpm),
    kpm: getNumber(stats.avgKpm),
    apm: getNumber(stats.avgApm),
    deathsPerMin: getNumber(stats.avgDeathsPerMin),
    goldAt10: getNumber(stats.avgGoldAt10),
    csAt10: getNumber(stats.avgCsAt10),
    goldAt15: getNumber(stats.avgGoldAt15),
    csAt15: getNumber(stats.avgCsAt15),
    damageShare: getNumber(stats.avgDamageShare),
    damageTakenShare: getNumber(stats.avgDamageTakenShare),
    objectiveParticipationPct: getNumber(stats.avgObjectiveParticipationPct),
    earlyGankDeathRate: getNumber(stats.earlyGankDeathRateSmart),
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
    }
  > = {};

  const getNum = (x: unknown) =>
    typeof x === 'number' && Number.isFinite(x) ? x : null;
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
    comparisons[m as string] = {
      value: averages[m],
      cohort: { p50, p75, p90, p95 },
      band,
      deltaPctFromP50: deltaPct,
      directionRelativeToP50: direction,
      isHigherBetter: !lexicon.negativeMetrics.includes(
        m as 'dtpm' | 'deathsPerMin',
      ),
    };
  }

  const payload = {
    championName: stats.championName,
    role: stats.role,
    totalMatches: stats.totalMatches,
    wins: stats.wins,
    losses: stats.losses,
    averages: {
      winRate: stats.winRate,
      kda: stats.kda,
      goldEarned: stats.avgGoldEarned,
      cspm: stats.avgCspm,
      dpm: stats.avgDpm,
      dtpm: stats.avgDtpm,
      kpm: stats.avgKpm,
      apm: stats.avgApm,
      deathsPerMin: stats.avgDeathsPerMin,
      goldAt10: stats.avgGoldAt10,
      csAt10: stats.avgCsAt10,
      goldAt15: stats.avgGoldAt15,
      csAt15: stats.avgCsAt15,
      damageShare: stats.avgDamageShare,
      damageTakenShare: stats.avgDamageTakenShare,
      objectiveParticipationPct: stats.avgObjectiveParticipationPct,
      earlyGankDeathRate: stats.earlyGankDeathRateSmart,
    },
    cohortPercentiles: percentiles,
    comparisons,
    derived: { minutesPerDeath },
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
  - Treat near_p50 (abs delta < 3%) as "about average".
  - For negative metrics (deathsPerMin, dtpm): higher = worse, lower = better.
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
): Promise<ChampionRoleInsightResult> {
  try {
    const prompt = buildPrompt(stats, cohort);
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
