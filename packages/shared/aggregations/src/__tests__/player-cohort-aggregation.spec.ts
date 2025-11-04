import { collections } from '@riftcoach/clients.mongodb';
import { beforeAll, describe, expect, it } from 'vitest';
import { playerChampRolePercentilesAggregation } from '../aggregations/playerChampionRolePercentiles.js';
import { getCompletedItemIds } from '../utils/completed-items.js';

const PUUID =
  '_B0dj-iCHkjNJhem8vEXWneSyxxNHBQ3lj8vBWvYvIXnEWScz-7nXqQjDgB-OrFPFFW5uubO3X8eMQ';

type Percentile = {
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  cspm: number;
  goldEarned: number;
  goldAt10: number;
  csAt10: number;
  goldAt15: number;
  csAt15: number;
  dpm: number;
  dtpm: number;
  kpm: number;
  apm: number;
  deathsPerMin: number;
  firstItemCompletionTime: number | null;
  objectiveParticipationPct: number | null;
  earlyGankDeathRate: number | null;
};

type Result = {
  championName: string;
  role: string;
  totalMatches: number;
  wins: number;
  losses: number;
  winRate: number;
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
  avgApm: number;
  avgDeathsPerMin: number;
  avgObjectiveParticipationPct: number | null;
  avgEarlyGankDeathRate: number | null;
  avgFirstItemCompletionTime: number | null;
  percentiles: {
    p50: Percentile;
    p75: Percentile;
    p90: Percentile;
    p95: Percentile;
  };
};

async function pickTopChampionRoleForPuuid(puuid: string): Promise<{
  championName: string;
  role: string;
} | null> {
  const docs = await collections.matches
    .aggregate<{ _id: { championName: string; role: string }; count: number }>(
      [
        { $match: { 'info.participants.puuid': puuid } },
        { $unwind: '$info.participants' },
        { $match: { 'info.participants.puuid': puuid } },
        {
          $project: {
            championName: '$info.participants.championName',
            role: { $ifNull: ['$info.participants.teamPosition', 'UNKNOWN'] },
          },
        },
        {
          $group: {
            _id: { championName: '$championName', role: '$role' },
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1 } },
        { $limit: 1 },
      ],
      { allowDiskUse: true, maxTimeMS: 30_000 },
    )
    .toArray();

  const top = docs[0]?._id;
  if (!top) return null;
  // Normalize role strings similarly to the aggregation mapping
  let role = top.role;
  const R = String(role).toUpperCase();
  if (['MID', 'MIDDLE'].includes(R)) role = 'MIDDLE';
  else if (['ADC', 'BOT', 'BOTTOM'].includes(R)) role = 'BOTTOM';
  else if (['SUP', 'SUPPORT', 'UTILITY'].includes(R)) role = 'UTILITY';
  else if (['TOP'].includes(R)) role = 'TOP';
  else if (['JUNGLE'].includes(R)) role = 'JUNGLE';
  else role = 'UNKNOWN';

  return { championName: top.championName, role };
}

describe('playerChampRolePercentilesAggregation', () => {
  let result: Result;
  let champRole: { championName: string; role: string } | null = null;

  beforeAll(async () => {
    champRole = await pickTopChampionRoleForPuuid(PUUID);
    expect(champRole).not.toBeNull();
    if (!champRole) return;

    const completedItemIds = await getCompletedItemIds();
    const pipeline = playerChampRolePercentilesAggregation(
      PUUID,
      champRole.championName,
      champRole.role,
      { completedItemIds },
    );

    const res = await collections.matches
      .aggregate<Result>(pipeline, { allowDiskUse: true, maxTimeMS: 30_000 })
      .toArray();

    result = res[0] as Result;
  });

  it('should return the expected aggregation result', async () => {
    expect(result).toBeDefined();
    expect(result.championName).toBe(champRole?.championName);
    expect(result.role).toBe(champRole?.role);
    expect(typeof result.totalMatches).toBe('number');
    expect(result.totalMatches).toBeGreaterThan(0);
  });

  it('should return defined percentiles buckets', async () => {
    expect(result.percentiles.p50).toBeDefined();
    expect(result.percentiles.p75).toBeDefined();
    expect(result.percentiles.p90).toBeDefined();
    expect(result.percentiles.p95).toBeDefined();
  });

  it('firstItemCompletionTime percentiles are null or positive', async () => {
    const vals = [
      result.percentiles.p50.firstItemCompletionTime,
      result.percentiles.p75.firstItemCompletionTime,
      result.percentiles.p90.firstItemCompletionTime,
      result.percentiles.p95.firstItemCompletionTime,
    ];
    for (const v of vals) {
      if (v !== null) {
        expect(typeof v).toBe('number');
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThan(0);
      }
    }
  });

  it('earlyGankDeathRate percentiles are null for JUNGLE or within [0,1]', async () => {
    const vals = [
      result.percentiles.p50.earlyGankDeathRate,
      result.percentiles.p75.earlyGankDeathRate,
      result.percentiles.p90.earlyGankDeathRate,
      result.percentiles.p95.earlyGankDeathRate,
    ];
    for (const v of vals) {
      if (result.role === 'JUNGLE') {
        expect(v).toBeNull();
      } else if (v !== null) {
        expect(typeof v).toBe('number');
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('provides non-negative numeric metrics in each percentile', async () => {
    const percentileValues = Object.values(result.percentiles);

    const nonNegativeNumericFields: Array<keyof Percentile> = [
      'kills',
      'deaths',
      'assists',
      'cs',
      'cspm',
      'goldEarned',
      'goldAt10',
      'csAt10',
      'goldAt15',
      'csAt15',
      'dpm',
      'dtpm',
      'kpm',
      'apm',
      'deathsPerMin',
    ];

    for (const percentile of percentileValues) {
      for (const field of nonNegativeNumericFields) {
        const value = percentile[field];
        expect(typeof value).toBe('number');
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }

      const objectiveParticipation = percentile.objectiveParticipationPct;
      if (objectiveParticipation !== null) {
        expect(typeof objectiveParticipation).toBe('number');
        expect(Number.isFinite(objectiveParticipation)).toBe(true);
        expect(objectiveParticipation).toBeGreaterThanOrEqual(0);
        expect(objectiveParticipation).toBeLessThanOrEqual(1);
      }
    }
  });

  it('percentile ordering is consistent for select metrics', async () => {
    const p50 = result.percentiles.p50;
    const p95 = result.percentiles.p95;

    // Higher-is-better metrics should have p95 >= p50
    expect(p95.kills).toBeGreaterThanOrEqual(p50.kills);
    expect(p95.assists).toBeGreaterThanOrEqual(p50.assists);
    expect(p95.cs).toBeGreaterThanOrEqual(p50.cs);
    expect(p95.cspm).toBeGreaterThanOrEqual(p50.cspm);
    expect(p95.goldEarned).toBeGreaterThanOrEqual(p50.goldEarned);
    expect(p95.goldAt10).toBeGreaterThanOrEqual(p50.goldAt10);
    expect(p95.csAt10).toBeGreaterThanOrEqual(p50.csAt10);
    expect(p95.goldAt15).toBeGreaterThanOrEqual(p50.goldAt15);
    expect(p95.csAt15).toBeGreaterThanOrEqual(p50.csAt15);
    expect(p95.dpm).toBeGreaterThanOrEqual(p50.dpm);
    expect(p95.kpm).toBeGreaterThanOrEqual(p50.kpm);
    expect(p95.apm).toBeGreaterThanOrEqual(p50.apm);

    // Lower-is-better metrics should have p95 <= p50
    expect(p95.deaths).toBeLessThanOrEqual(p50.deaths);
    expect(p95.dtpm).toBeLessThanOrEqual(p50.dtpm);
    expect(p95.deathsPerMin).toBeLessThanOrEqual(p50.deathsPerMin);

    // First item completion time is lower-is-better (nullable)
    if (p50.firstItemCompletionTime !== null && p95.firstItemCompletionTime !== null) {
      expect(p95.firstItemCompletionTime).toBeLessThanOrEqual(
        p50.firstItemCompletionTime,
      );
    }

    // Objective participation is higher-is-better (nullable)
    if (p50.objectiveParticipationPct !== null && p95.objectiveParticipationPct !== null) {
      expect(p95.objectiveParticipationPct).toBeGreaterThanOrEqual(
        p50.objectiveParticipationPct,
      );
    }

    // Early gank death rate is lower-is-better (nullable/JUNGLE)
    if (p50.earlyGankDeathRate !== null && p95.earlyGankDeathRate !== null) {
      expect(p95.earlyGankDeathRate).toBeLessThanOrEqual(
        p50.earlyGankDeathRate,
      );
    }
  });
});