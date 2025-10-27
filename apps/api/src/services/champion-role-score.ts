import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { collections } from '@riftcoach/clients.mongodb';
import consola from 'consola';
import { playerChampRolePercentilesAggregation } from '../aggregations/playerChampionRolePercentiles.js';
import { bedrockClient } from '../clients/bedrock.js';

export type ChampionRoleStats = {
  championName: string;
  role: string;
  totalMatches: number;
  wins: number;
  losses: number;
  winRate: number; // 0..1
  kda: number;
  avgKills: number;
  avgDeaths: number;
  avgAssists: number;
  avgGoldEarned: number;
  avgCS: number;
  avgGoldAt10: number;
  avgCsAt10: number;
  avgGoldAt15: number;
  avgCsAt15: number;
  avgDpm: number;
  avgDtpm: number;
  avgKpm: number;
  avgDeathsPerMin: number;
  avgApm: number;
  avgDamageShare?: number;
  avgDamageTakenShare?: number;
  avgObjectiveParticipationPct?: number;
  earlyGankDeathRateSmart?: number;
};

type PercentilesDoc = ChampionRoleStats & {
  percentiles: {
    p50: Record<string, number>;
    p75: Record<string, number>;
    p90: Record<string, number>;
    p95: Record<string, number>;
  };
};

export type ChampionRoleAIScore = {
  championName: string;
  role: string;
  aiScore: number; // 0..100
  reasoning?: string;
};

function buildPrompt(
  puuid: string,
  items: Array<{ stats: ChampionRoleStats; dist: PercentilesDoc | null }>,
): string {
  const header =
    'You are an analyst assigning a numeric mastery score (0-100) per champion-role for a League of Legends player. Consider performance vs distribution percentiles (p50/p75/p90/p95), volume (games), and stability. Output STRICT JSON only.';
  const guidelines =
    'Scoring guidelines:\n- Baseline around 50 near p50 on key metrics with sufficient games (>=5).\n- Increase score when winRate, KDA, DPM, KP, laning (gold/cs at 10/15) exceed p75/p90, reduce when below p50.\n- Penalize high deaths/min or early gank death rate if notably above p75.\n- Include a one-sentence reasoning.\n- Return an array of objects { championName, role, aiScore, reasoning }.\n- aiScore must be a number between 0 and 100.';

  const payloadItems = items.map(({ stats, dist }) => ({
    championName: stats.championName,
    role: stats.role,
    games: stats.totalMatches,
    winRate: stats.winRate,
    kda: stats.kda,
    avgKills: stats.avgKills,
    avgDeaths: stats.avgDeaths,
    avgAssists: stats.avgAssists,
    avgCS: stats.avgCS,
    avgGoldEarned: stats.avgGoldEarned,
    dpm: stats.avgDpm,
    dtpm: stats.avgDtpm,
    kpm: stats.avgKpm,
    apm: stats.avgApm,
    deathsPerMin: stats.avgDeathsPerMin,
    lane: {
      goldAt10: stats.avgGoldAt10,
      csAt10: stats.avgCsAt10,
      goldAt15: stats.avgGoldAt15,
      csAt15: stats.avgCsAt15,
    },
    extras: {
      damageShare: stats.avgDamageShare ?? null,
      damageTakenShare: stats.avgDamageTakenShare ?? null,
      objectivePartPct: stats.avgObjectiveParticipationPct ?? null,
      earlyGankDeathRate: stats.earlyGankDeathRateSmart ?? null,
    },
    percentiles: dist?.percentiles ?? null,
  }));

  const body = {
    puuid,
    items: payloadItems,
  };

  const bodyJson = JSON.stringify(body, null, 2);
  return `${header}\n\n${guidelines}\n\nDATA:\n${bodyJson}\n\nReturn JSON array only.`;
}

async function invokeAIScoring(prompt: string): Promise<ChampionRoleAIScore[]> {
  const instruction = `<s>[INST] ${prompt} [/INST]`;
  const command = new InvokeModelCommand({
    modelId: 'mistral.mixtral-8x7b-instruct-v0:1',
    contentType: 'application/json',
    body: JSON.stringify({
      prompt: instruction,
      max_tokens: 1200,
      temperature: 0.2,
      top_p: 0.9,
      top_k: 50,
    }),
    accept: 'application/json',
  });

  const response = await bedrockClient.send(command);
  if (!response.body) throw new Error('No response body from Bedrock');
  const raw = JSON.parse(new TextDecoder().decode(response.body as Uint8Array));
  const text: string = raw.outputs?.[0]?.text ?? '[]';

  // Extract JSON array defensively
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  const json = start !== -1 && end !== -1 ? text.slice(start, end + 1) : text;
  const parsedUnknown: unknown = JSON.parse(json);

  if (!Array.isArray(parsedUnknown)) return [];

  function toAIScore(x: unknown): ChampionRoleAIScore | null {
    if (!x || typeof x !== 'object') return null;
    const obj = x as Record<string, unknown>;
    const champName =
      typeof obj.championName === 'string'
        ? obj.championName
        : typeof obj.champion === 'string'
          ? obj.champion
          : '';
    const role = typeof obj.role === 'string' ? obj.role : '';

    let score = 50;
    if (typeof obj.aiScore === 'number') score = obj.aiScore;
    else if (typeof obj.score === 'number') score = obj.score;
    else if (
      typeof obj.aiScore === 'string' &&
      !Number.isNaN(Number(obj.aiScore))
    )
      score = Number(obj.aiScore);
    else if (typeof obj.score === 'string' && !Number.isNaN(Number(obj.score)))
      score = Number(obj.score);

    const reasoning =
      typeof obj.reasoning === 'string' ? obj.reasoning : undefined;
    if (!champName || !role || !Number.isFinite(score)) return null;
    return { championName: champName, role, aiScore: score, reasoning };
  }

  const coerced = (parsedUnknown as unknown[])
    .map((x) => toAIScore(x))
    .filter((x): x is ChampionRoleAIScore => x !== null);
  return coerced;
}

export async function generateChampionRoleAIScores(
  puuid: string,
  rows: ChampionRoleStats[],
): Promise<ChampionRoleAIScore[]> {
  try {
    // Fetch percentiles per champion-role (for current page only)
    const docs: Array<PercentilesDoc | null> = [];
    for (const r of rows) {
      try {
        const aggs = await collections.matches
          .aggregate<PercentilesDoc>(
            playerChampRolePercentilesAggregation(
              puuid,
              r.championName,
              r.role,
            ),
            { allowDiskUse: true },
          )
          .toArray();
        docs.push(aggs[0] ?? null);
      } catch (e) {
        consola.warn('[champion-role-score] percentiles aggregation failed', e);
        docs.push(null);
      }
    }

    const prompt = buildPrompt(
      puuid,
      rows.map((stats, i) => ({ stats, dist: docs[i] ?? null })),
    );
    const scores = await invokeAIScoring(prompt);
    return scores;
  } catch (error) {
    consola.error('[champion-role-score] AI scoring failed', error);
    return [];
  }
}
