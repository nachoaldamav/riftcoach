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
- Cite at most one key metric per bullet.
- Prefer clean numbers: round decimals; convert rates to intuitive units (e.g., say "about one death every 7 minutes" instead of "0.148 deaths/min").
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
