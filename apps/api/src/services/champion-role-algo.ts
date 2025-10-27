import { collections } from '@riftcoach/clients.mongodb';
import consola from 'consola';
import { cohortChampionRolePercentilesAggregation } from '../aggregations/cohortChampionRolePercentiles.js';
import { redis } from '../clients/redis.js';
import type { ChampionRoleStats } from './champion-role-score.js';

export type CohortPercentilesDoc = {
  championName: string;
  role: string;
  percentiles: {
    p50: Record<string, number>;
    p75: Record<string, number>;
    p90: Record<string, number>;
    p95: Record<string, number>;
  };
};

function contribPositive(
  value: number,
  p: { p50?: number; p75?: number; p90?: number },
): number {
  const p50 = typeof p.p50 === 'number' ? p.p50 : 0;
  const p75 = typeof p.p75 === 'number' ? p.p75 : p50;
  const p90 = typeof p.p90 === 'number' ? p.p90 : p75;
  if (value >= p90) return 10;
  if (value >= p75) return 5;
  if (value >= p50) return 2;
  return -2;
}

function contribNegative(
  value: number,
  p: { p50?: number; p75?: number; p90?: number },
): number {
  const p50 = typeof p.p50 === 'number' ? p.p50 : 0;
  const p75 = typeof p.p75 === 'number' ? p.p75 : p50;
  const p90 = typeof p.p90 === 'number' ? p.p90 : p75;
  if (value <= p50) return 3;
  if (value >= p90) return -10;
  if (value >= p75) return -6;
  return -1;
}

function getRoleMods(role: string) {
  switch (role) {
    case 'BOTTOM':
      return {
        posScale: 1.1,
        negScale: 0.8,
        dpmWeight: 1.2,
        csWeight: 1.15,
        apmWeight: 1.0,
        dpminWeight: 0.7,
        dtpmWeight: 0.5,
        objWeight: 0.8,
      } as const;
    case 'UTILITY':
      return {
        posScale: 1.0,
        negScale: 0.9,
        dpmWeight: 0.8,
        csWeight: 0.9,
        apmWeight: 1.2,
        dpminWeight: 1.0,
        dtpmWeight: 1.0,
        objWeight: 1.1,
      } as const;
    case 'MIDDLE':
      return {
        posScale: 1.05,
        negScale: 0.9,
        dpmWeight: 1.1,
        csWeight: 1.05,
        apmWeight: 1.0,
        dpminWeight: 0.85,
        dtpmWeight: 0.7,
        objWeight: 1.0,
      } as const;
    default:
      return {
        posScale: 1.0,
        negScale: 1.0,
        dpmWeight: 1.0,
        csWeight: 1.0,
        apmWeight: 1.0,
        dpminWeight: 1.0,
        dtpmWeight: 1.0,
        objWeight: 1.0,
      } as const;
  }
}

export function computeChampionRoleAlgoScore(
  stats: ChampionRoleStats,
  cohort: CohortPercentilesDoc | null,
): number {
  let score = 50; // baseline

  const percentiles = cohort?.percentiles;
  const getP = (name: string) => ({
    p50: percentiles?.p50?.[name],
    p75: percentiles?.p75?.[name],
    p90: percentiles?.p90?.[name],
  });

  const mods = getRoleMods(stats.role);

  // Positive metrics
  const posWins = contribPositive(stats.winRate, { p50: 0.5, p75: 0.55, p90: 0.6 });
  const posKda = contribPositive(stats.kda, { p50: 2.0, p75: 3.0, p90: 4.0 });
  const posDpm = contribPositive(stats.avgDpm, getP('dpm')) * mods.dpmWeight;
  const posKpm = contribPositive(stats.avgKpm, getP('kpm'));
  const posApm = contribPositive(stats.avgApm, getP('apm')) * mods.apmWeight;
  const posGold10 = contribPositive(stats.avgGoldAt10, getP('goldAt10')) * mods.csWeight;
  const posCs10 = contribPositive(stats.avgCsAt10, getP('csAt10')) * mods.csWeight;
  const posGold15 = contribPositive(stats.avgGoldAt15, getP('goldAt15')) * mods.csWeight;
  const posCs15 = contribPositive(stats.avgCsAt15, getP('csAt15')) * mods.csWeight;

  // Additional positives if available
  const posDmgShare = typeof stats.avgDamageShare === 'number'
    ? contribPositive(stats.avgDamageShare, { p50: 0.22, p75: 0.26, p90: 0.3 }) * (mods.dpmWeight * 0.5)
    : 0;
  const posObjPart = typeof stats.avgObjectiveParticipationPct === 'number'
    ? contribPositive(stats.avgObjectiveParticipationPct, { p50: 0.3, p75: 0.4, p90: 0.5 }) * mods.objWeight
    : 0;

  const posTotal = mods.posScale * (
    posWins + posKda + posDpm + posKpm + posApm + posGold10 + posCs10 + posGold15 + posCs15 + posDmgShare + posObjPart
  );
  score += posTotal;

  // Negative metrics
  const negDeaths = contribNegative(stats.avgDeathsPerMin, getP('deathsPerMin')) * mods.dpminWeight;
  // dtpm is role/context dependent; penalize lightly and role-adjusted
  const negDtpm = (contribNegative(stats.avgDtpm, getP('dtpm')) / 2) * mods.dtpmWeight;

  // Optional early gank death penalty (very light)
  const earlyPenalty = typeof stats.earlyGankDeathRateSmart === 'number'
    ? Math.max(0, stats.earlyGankDeathRateSmart - 0.35) * -4 // small penalty above 35%
    : 0;

  const negTotal = mods.negScale * (negDeaths + negDtpm) + earlyPenalty;
  score += negTotal;

  // Volume effect
  if (stats.totalMatches >= 20) score += 4;
  else if (stats.totalMatches >= 10) score += 2;
  else if (stats.totalMatches >= 5) score += 1;
  else score -= 6;

  // Clamp 0..100
  if (!Number.isFinite(score)) score = 50;
  score = Math.max(0, Math.min(100, Math.round(score)));
  return score;
}

export async function fetchCohortPercentiles(
  championName: string,
  role: string,
): Promise<CohortPercentilesDoc | null> {
  try {
    // Simple cache keyed by champion-role and fixed cohort parameters
    const cacheKey = `cache:cohort:percentiles:v1:${championName}:${role}:2025:wins:limit100`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as CohortPercentilesDoc;
      } catch {
        // ignore cache parse error and recompute
      }
    }
    // Optimization defaults:
    // - Restrict to year 2025 (inclusive of Jan 1, exclusive of Jan 1, 2026)
    // - Consider wins only to tighten distribution and reduce docs
    // - Sort by newest games and limit sample size to 500
    const startTs = Date.UTC(2025, 0, 1);
    const endTs = Date.UTC(2026, 0, 1);

    const pipeline = cohortChampionRolePercentilesAggregation({
      championName,
      role,
      startTs,
      endTs,
      winsOnly: true,
      sampleLimit: 100,
      sortDesc: true,
    });
    consola.debug(
      '[champion-role-algo] getting cohorts for',
      championName,
      role,
    );
    const start = Date.now();
    const docs = await collections.matches
      .aggregate<CohortPercentilesDoc>(pipeline, { allowDiskUse: true })
      .toArray();
    const end = Date.now();
    consola.debug(
      '[champion-role-algo] cohort percentile aggregation took',
      end - start,
      'ms',
    );
    const doc = docs[0] ?? null;
    if (doc) {
      // Cache for 30 minutes
      await redis.set(cacheKey, JSON.stringify(doc), 'EX', 60 * 30);
    }
    return doc;
  } catch (e) {
    consola.warn(
      '[champion-role-algo] cohort percentile aggregation failed',
      e,
    );
    return null;
  }
}
