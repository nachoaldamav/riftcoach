import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { collections } from '@riftcoach/clients.mongodb';
import consola from 'consola';
import { playerChampRolePercentilesAggregation } from '@riftcoach/packages.shared.aggregations';
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
  avgCspm: number;
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
  avgFirstItemCompletionTime?: number | null;
};

export type DistDoc = {
  championName: string;
  role: string;
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
  items: Array<{ stats: ChampionRoleStats; dist: DistDoc | null }>,
): string {
  const header =
    'You are a supportive, fair analyst assigning a positive, encouraging mastery score (0-100) per champion-role for a League of Legends player. Consider performance vs distribution percentiles (p50/p75/p90/p95), volume (games), and stability. Keep language kind and constructive. Output STRICT JSON only.';
  const guidelines =
    'Scoring guidelines (be kind):\n- Baseline around 50 near p50 on key metrics with sufficient games (>=5).\n- Nudge the score upward when winRate, KDA, DPM, KP, and laning (gold/CS at 10/15) exceed p75/p90.\n- When most tracked metrics are >=p50 and trending toward p75, aim for confident 70s (avoid capping mid-60s).\n- When most tracked metrics are >=p75 with none meaningfully below p50, reward strongly (mid/high 80s); reserve 90+ for sustained excellence (multiple metrics >=p90 with solid volume).\n- Prefer CS per minute (CSPM) over total CS per game due to match length variance.\n- If below p50 on some metrics, frame as growth opportunities; adjust scores moderately (avoid extreme lows unless many metrics are well below p50).\n- Consider stability and sample size: for low games (<5) or missing percentiles, keep scores cautious in a mid range (e.g., 45–60) based on player averages.\n- If a metric is missing or unavailable, do not speculate; omit it from reasoning.\n- Avoid harsh wording; include a gentle, actionable coaching tip in one-sentence reasoning and cite specific numbers (e.g., "KDA 3.1 vs p75 2.8").\n- Return an array of objects { championName, role, aiScore, reasoning }.\n- aiScore must be a number between 0 and 100.';

  const payloadItems = items.map(({ stats, dist }) => ({
    championName: stats.championName,
    role: stats.role,
    games: stats.totalMatches,
    winRate: stats.winRate,
    kda: stats.kda,
    avgKills: stats.avgKills,
    avgDeaths: stats.avgDeaths,
    avgAssists: stats.avgAssists,
    cspm: stats.avgCspm,
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
      firstItemCompletionTime: stats.avgFirstItemCompletionTime ?? null,
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
  options?: { completedItemIds?: number[]; percentilesDocs?: Array<DistDoc | null> },
): Promise<ChampionRoleAIScore[]> {
  try {
    // Fetch percentiles per champion-role (for current page only)
    const docs: Array<DistDoc | null> = Array.isArray(options?.percentilesDocs)
      ? options?.percentilesDocs ?? []
      : [];

    if (docs.length === 0) {
      for (const r of rows) {
        try {
          const aggs = await collections.matches
            .aggregate<DistDoc>(
              playerChampRolePercentilesAggregation(
                puuid,
                r.championName,
                r.role,
                { completedItemIds: options?.completedItemIds },
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
