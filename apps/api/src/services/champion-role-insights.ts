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
      cs: stats.avgCS,
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

  return `You are an elite League of Legends analyst. Evaluate the player's performance on ${stats.championName} (${stats.role}). Use the provided cohort percentiles (p50, p75, p90, p95) to determine how this player compares to other players on the same champion-role. Identify the strongest advantages and the most critical weaknesses.\n\nReturn ONLY valid JSON in the following structure:\n{\n  "summary": "One sentence overview",\n  "strengths": ["Strength highlighting metric comparison"],\n  "weaknesses": ["Weakness highlighting metric comparison"]\n}\n\nRules:\n- Cite specific metrics and numbers when explaining strengths/weaknesses.\n- Limit to at most 3 strengths and 3 weaknesses.\n- If there is insufficient data for a metric, say so rather than guessing.\n- Focus on differences that are meaningfully above p75/p90 or below p50 percentiles.\n\nPlayer data:\n${JSON.stringify(payload, null, 2)}\n`;
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
