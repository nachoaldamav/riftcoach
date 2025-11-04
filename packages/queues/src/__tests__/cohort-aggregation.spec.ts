import { collections } from '@riftcoach/clients.mongodb';
import { beforeAll, describe, expect, it } from 'vitest';
import { cohortChampionRolePercentilesAggregation } from '../aggregations/cohort-role-champ.js';
import { getCompletedItemIds } from '../completed-items.js';

const params = {
  championName: 'Aatrox',
  role: 'TOP',
  startTs: new Date('2025-01-01').getTime(),
  endTs: new Date('2025-12-31').getTime(),
};

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
  firstItemCompletionTime: number;
  objectiveParticipationPct: number;
  earlyGankDeathRate: number;
};

type Result = {
  championName: string;
  role: string;
  year: number;
  patch: string;
  percentiles: {
    p50: Percentile;
    p75: Percentile;
    p90: Percentile;
    p95: Percentile;
  };
};

describe('cohortChampionRolePercentilesAggregation', () => {
  let result: Result;
  beforeAll(async () => {
    const completedItemIds = await getCompletedItemIds();
    const aggregation = cohortChampionRolePercentilesAggregation({
      ...params,
      completedItemIds,
    });

    const res = await collections.matches
      .aggregate<Result>(aggregation, {
        allowDiskUse: true,
        maxTimeMS: 30_000,
      })
      .toArray();

    result = res[0] as Result;
  });

  it('should return the expected aggregation pipeline', async () => {
    expect(result.championName).toBe(params.championName);
    expect(result.role).toBe(params.role);

    console.log(JSON.stringify(result, null, 2));
  });

  it('should return the expected percentiles', async () => {
    expect(result.percentiles.p50).toBeDefined();
    expect(result.percentiles.p75).toBeDefined();
    expect(result.percentiles.p90).toBeDefined();
    expect(result.percentiles.p95).toBeDefined();
  });

  it('should return valid firstItemCompletionTime for each percentile', async () => {
    expect(result.percentiles.p50.firstItemCompletionTime > 0).toBe(true);
    expect(result.percentiles.p75.firstItemCompletionTime > 0).toBe(true);
    expect(result.percentiles.p90.firstItemCompletionTime > 0).toBe(true);
    expect(result.percentiles.p95.firstItemCompletionTime > 0).toBe(true);
  });
});
