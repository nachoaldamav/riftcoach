import { consola } from 'consola';
import { getCohortStatsPerRole } from '../queries/cohorts-role-stats.js';
import { getPlayerStatsPerRole } from '../queries/puuid-role-stats.js';
import { runAthenaQuery } from '../utils/run-athena-query.js';
import { getCacheKey, getCachedData, setCachedData } from './cache-utils.js';
import type {
  CohortQueryResult,
  CohortStats,
  PlaystyleQueryResult,
  PlaystyleStats,
  RoleStats,
} from './types.js';

function toNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const num = Number.parseFloat(value);
  return Number.isNaN(num) ? null : num;
}

function normalizePercentish(v: number | null | undefined): number | null {
  if (v == null) return null;
  return v > 1 ? v / 100 : v;
}

function sum<T>(arr: T[], pick: (x: T) => number): number {
  return arr.reduce((acc, x) => acc + pick(x), 0);
}

function weightedAverage<T>(
  arr: T[],
  pickValue: (x: T) => number | null,
  pickWeight: (x: T) => number,
): number | null {
  let num = 0;
  let den = 0;
  for (const item of arr) {
    const v = pickValue(item);
    const w = pickWeight(item);
    if (v != null && !Number.isNaN(v) && w > 0) {
      num += v * w;
      den += w;
    }
  }
  return den > 0 ? num / den : null;
}

function convertPlayerRecordToRoleStats(
  record: Record<string, string | null>,
): RoleStats {
  return {
    roleBucket: (record.role ?? '') as string,
    games: Number.parseInt(record.games ?? '0', 10) || 0,
    winRate: normalizePercentish(toNumber(record.win_rate_pct_estimate)),
    kpMean: normalizePercentish(toNumber(record.kill_participation_pct_est)),
    visPerMinMean: toNumber(record.avg_vision_score_per_min),
    wclearPerMinMean: null,
    dpgMean: toNumber(record.avg_dpm),
    cs10Mean: toNumber(record.avg_cs_at10),
    csfullMean: toNumber(record.avg_cs_total),
    drakeParticipationMean: normalizePercentish(
      toNumber(record.avg_dragon_participation),
    ),
    heraldParticipationMean: normalizePercentish(
      toNumber(record.avg_herald_participation),
    ),
    baronParticipationMean: normalizePercentish(
      toNumber(record.avg_baron_participation),
    ),
    avgObjectiveParticipation: null,
    avgLaningSurvivalRate: null,
    avgEarlyGameDeaths: toNumber(record.avg_early_deaths),
    killsNearEnemyTurretMean: toNumber(record.avg_early_kills_near_enemy_tower),
    killsUnderOwnTurretMean: toNumber(record.avg_early_kills_near_ally_tower),
    deathsNearEnemyTurretMean: toNumber(
      record.avg_early_deaths_near_ally_tower,
    ),
    deathsUnderOwnTurretMean: null,
    avgDamagePerGold: null,
    avgKills: toNumber(record.avg_kills),
    avgDeaths: toNumber(record.avg_deaths),
    avgAssists: toNumber(record.avg_assists),
    avgKda: toNumber(record.avg_kda),
    avgKillParticipationPct: normalizePercentish(
      toNumber(record.kill_participation_pct_est),
    ),
    avgKillParticipationProp: normalizePercentish(
      toNumber(record.kill_participation_pct_est),
    ),
    avgDamagePerMinute: toNumber(record.avg_dpm),
    avgTeamDamagePct: normalizePercentish(toNumber(record.avg_team_dmg_pct)),
    avgGoldPerMinute: toNumber(record.avg_gpm),
    avgVisionScorePerMinute: toNumber(record.avg_vision_score_per_min),
    avgWardsCleared: toNumber(record.avg_wards_killed),
    avgWardsClearedEarly: null,
    avgSoloKills: toNumber(record.avg_early_solo_kills),
    avgScuttleKills: null,
    roleDistributionPct: null,
  };
}

function convertCohortRecordToRoleStats(
  record: Record<string, string | null>,
): RoleStats {
  return {
    roleBucket: (record.role ?? '') as string,
    games: Number.parseInt(record.games ?? '0', 10) || 0,
    winRate: normalizePercentish(toNumber(record.win_rate_pct_estimate)),
    kpMean: normalizePercentish(toNumber(record.kill_participation_pct_est)),
    visPerMinMean: toNumber(record.avg_vision_score_per_min),
    wclearPerMinMean: null,
    dpgMean: toNumber(record.avg_dpm),
    cs10Mean: toNumber(record.avg_cs_at10),
    csfullMean: toNumber(record.avg_cs_total),
    drakeParticipationMean: normalizePercentish(
      toNumber(record.avg_dragon_participation),
    ),
    heraldParticipationMean: normalizePercentish(
      toNumber(record.avg_herald_participation),
    ),
    baronParticipationMean: normalizePercentish(
      toNumber(record.avg_baron_participation),
    ),
    avgObjectiveParticipation: null,
    avgLaningSurvivalRate: null,
    avgEarlyGameDeaths: toNumber(record.avg_early_deaths),
    killsNearEnemyTurretMean: toNumber(record.avg_early_kills_near_enemy_tower),
    killsUnderOwnTurretMean: toNumber(record.avg_early_kills_near_ally_tower),
    deathsNearEnemyTurretMean: toNumber(
      record.avg_early_deaths_near_ally_tower,
    ),
    deathsUnderOwnTurretMean: null,
    avgDamagePerGold: null,
    avgKills: toNumber(record.avg_kills),
    avgDeaths: toNumber(record.avg_deaths),
    avgAssists: toNumber(record.avg_assists),
    avgKda: toNumber(record.avg_kda),
    avgKillParticipationPct: normalizePercentish(
      toNumber(record.kill_participation_pct_est),
    ),
    avgKillParticipationProp: normalizePercentish(
      toNumber(record.kill_participation_pct_est),
    ),
    avgDamagePerMinute: toNumber(record.avg_dpm),
    avgTeamDamagePct: normalizePercentish(toNumber(record.avg_team_dmg_pct)),
    avgGoldPerMinute: toNumber(record.avg_gpm),
    avgVisionScorePerMinute: toNumber(record.avg_vision_score_per_min),
    avgWardsCleared: toNumber(record.avg_wards_killed),
    avgWardsClearedEarly: null,
    avgSoloKills: toNumber(record.avg_early_solo_kills),
    avgScuttleKills: null,
    roleDistributionPct: null,
  };
}

export async function getPlaystyleStats(
  puuid: string,
  options: { scope?: string | null; queues?: number[] } = {},
): Promise<PlaystyleQueryResult> {
  const sql = getPlayerStatsPerRole(puuid);

  const { queryExecutionId, records, statistics } = await runAthenaQuery({
    query: sql,
  });

  if (records.length === 0) {
    return {
      stats: null,
      meta: {
        queryExecutionId,
        statistics: statistics
          ? {
              dataScannedInBytes: statistics.DataScannedInBytes,
              engineExecutionTimeInMillis:
                statistics.EngineExecutionTimeInMillis,
            }
          : undefined,
        sql,
        season: 2025,
        queues: [400, 420, 440],
      },
    };
  }

  consola.info(`Athena per-role stats result for ${puuid}`, records);

  // Convert each record (one per role) to RoleStats
  const roleStats: RoleStats[] = records.map(convertPlayerRecordToRoleStats);

  const totalGames = sum(roleStats, (r) => r.games);
  const roleDistribution: { [role: string]: number } = {};
  for (const r of roleStats) {
    const share = totalGames > 0 ? r.games / totalGames : 0;
    roleDistribution[r.roleBucket] = share;
  }

  const stats: PlaystyleStats | null = {
    matchesPlayed: totalGames,
    winRate: normalizePercentish(
      weightedAverage(
        roleStats,
        (r) => r.winRate,
        (r) => r.games,
      ),
    ),
    avgGameDurationMin: null,
    avgKills: weightedAverage(
      roleStats,
      (r) => r.avgKills,
      (r) => r.games,
    ),
    avgDeaths: weightedAverage(
      roleStats,
      (r) => r.avgDeaths,
      (r) => r.games,
    ),
    avgAssists: weightedAverage(
      roleStats,
      (r) => r.avgAssists,
      (r) => r.games,
    ),
    avgKda: weightedAverage(
      roleStats,
      (r) => r.avgKda,
      (r) => r.games,
    ),
    avgKillParticipation: normalizePercentish(
      weightedAverage(
        roleStats,
        (r) => r.avgKillParticipationPct,
        (r) => r.games,
      ),
    ),
    avgDamagePerMinute: weightedAverage(
      roleStats,
      (r) => r.avgDamagePerMinute,
      (r) => r.games,
    ),
    avgTeamDamagePct: normalizePercentish(
      weightedAverage(
        roleStats,
        (r) => r.avgTeamDamagePct,
        (r) => r.games,
      ),
    ),
    avgGoldPerMinute: weightedAverage(
      roleStats,
      (r) => r.avgGoldPerMinute,
      (r) => r.games,
    ),
    avgCsPerMinute: null,
    avgCsAt10: weightedAverage(
      roleStats,
      (r) => r.cs10Mean,
      (r) => r.games,
    ),
    avgVisionScorePerMinute: weightedAverage(
      roleStats,
      (r) => r.avgVisionScorePerMinute,
      (r) => r.games,
    ),
    avgControlWards: null,
    avgWardsCleared: weightedAverage(
      roleStats,
      (r) => r.avgWardsCleared,
      (r) => r.games,
    ),
    avgWardsClearedEarly: null,
    avgSoloKills: weightedAverage(
      roleStats,
      (r) => r.avgSoloKills,
      (r) => r.games,
    ),
    avgTurretTakedowns: null,
    avgInhibitorTakedowns: null,
    avgObjectiveTakedowns: null,
    avgScuttleKills: null,
    avgKillsNearEnemyTurret: weightedAverage(
      roleStats,
      (r) => r.killsNearEnemyTurretMean,
      (r) => r.games,
    ),
    avgKillsUnderOwnTurret: weightedAverage(
      roleStats,
      (r) => r.killsUnderOwnTurretMean,
      (r) => r.games,
    ),
    avgDeathsNearEnemyTurret: weightedAverage(
      roleStats,
      (r) => r.deathsNearEnemyTurretMean,
      (r) => r.games,
    ),
    avgDeathsUnderOwnTurret: weightedAverage(
      roleStats,
      (r) => r.deathsUnderOwnTurretMean,
      (r) => r.games,
    ),
    avgLaningSurvivalRate: null,
    avgEarlyGameDeaths: weightedAverage(
      roleStats,
      (r) => r.avgEarlyGameDeaths,
      (r) => r.games,
    ),
    avgObjectiveParticipation: null,
    avgDragonParticipation: normalizePercentish(
      weightedAverage(
        roleStats,
        (r) => r.drakeParticipationMean,
        (r) => r.games,
      ),
    ),
    avgBaronParticipation: normalizePercentish(
      weightedAverage(
        roleStats,
        (r) => r.baronParticipationMean,
        (r) => r.games,
      ),
    ),
    avgHeraldParticipation: normalizePercentish(
      weightedAverage(
        roleStats,
        (r) => r.heraldParticipationMean,
        (r) => r.games,
      ),
    ),
    roleDistribution: roleDistribution,
    roleStats,
  };

  consola.info(stats);

  return {
    stats,
    meta: {
      queryExecutionId,
      statistics: statistics
        ? {
            dataScannedInBytes: statistics.DataScannedInBytes,
            engineExecutionTimeInMillis: statistics.EngineExecutionTimeInMillis,
          }
        : undefined,
      sql,
      season: 2025,
      queues: [400, 420, 440],
    },
  };
}

export async function getCohortStats(
  puuid: string,
): Promise<CohortQueryResult> {
  const sql = getCohortStatsPerRole(puuid);

  const { queryExecutionId, records, statistics } = await runAthenaQuery({
    query: sql,
  });

  const roleStats: RoleStats[] = records.map(convertCohortRecordToRoleStats);
  const totalGames = sum(roleStats, (r) => r.games);

  const stats: CohortStats | null = {
    season: 2025,
    totalPlayers: 0,
    totalGames,
    seasonAvgKp: normalizePercentish(
      weightedAverage(
        roleStats,
        (r) => r.kpMean,
        (r) => r.games,
      ),
    ),
    seasonAvgVisPerMin: weightedAverage(
      roleStats,
      (r) => r.visPerMinMean,
      (r) => r.games,
    ),
    seasonAvgWclearPerMin: null,
    seasonAvgDpg: weightedAverage(
      roleStats,
      (r) => r.dpgMean,
      (r) => r.games,
    ),
    seasonAvgCs10: weightedAverage(
      roleStats,
      (r) => r.cs10Mean,
      (r) => r.games,
    ),
    seasonAvgCsfull: weightedAverage(
      roleStats,
      (r) => r.csfullMean,
      (r) => r.games,
    ),
    seasonAvgDrakeParticipation: normalizePercentish(
      weightedAverage(
        roleStats,
        (r) => r.drakeParticipationMean,
        (r) => r.games,
      ),
    ),
    seasonAvgHeraldParticipation: normalizePercentish(
      weightedAverage(
        roleStats,
        (r) => r.heraldParticipationMean,
        (r) => r.games,
      ),
    ),
    seasonAvgBaronParticipation: normalizePercentish(
      weightedAverage(
        roleStats,
        (r) => r.baronParticipationMean,
        (r) => r.games,
      ),
    ),
    seasonAvgObjParticipation: null,
    seasonAvgLaningSurvivalRate: null,
    seasonAvgEarlyGameDeaths: weightedAverage(
      roleStats,
      (r) => r.avgEarlyGameDeaths,
      (r) => r.games,
    ),
    seasonAvgKillsNearEnemyTurret: weightedAverage(
      roleStats,
      (r) => r.killsNearEnemyTurretMean,
      (r) => r.games,
    ),
    seasonAvgKillsUnderOwnTurret: weightedAverage(
      roleStats,
      (r) => r.killsUnderOwnTurretMean,
      (r) => r.games,
    ),
    seasonAvgDeathsNearEnemyTurret: weightedAverage(
      roleStats,
      (r) => r.deathsNearEnemyTurretMean,
      (r) => r.games,
    ),
    seasonAvgDeathsUnderOwnTurret: weightedAverage(
      roleStats,
      (r) => r.deathsUnderOwnTurretMean,
      (r) => r.games,
    ),
    seasonAvgDamagePerGold: null,
    seasonAvgWinRate: normalizePercentish(
      weightedAverage(
        roleStats,
        (r) => r.winRate,
        (r) => r.games,
      ),
    ),
    roleStats,
  };

  return {
    stats,
    meta: {
      queryExecutionId,
      statistics: statistics
        ? {
            dataScannedInBytes: statistics.DataScannedInBytes,
            engineExecutionTimeInMillis: statistics.EngineExecutionTimeInMillis,
          }
        : undefined,
      sql,
      season: 2025,
      queues: [400, 420, 440],
    },
  };
}

// Cached version of getPlaystyleStats
export async function getCachedPlaystyleStats(
  puuid: string,
  options: { scope?: string | null; queues?: number[] } = {},
): Promise<PlaystyleQueryResult> {
  const cacheKey = getCacheKey(
    'player-stats',
    puuid,
    options.scope || 'default',
  );

  try {
    // Try to get cached data first
    const cachedResult = await getCachedData<PlaystyleQueryResult>(cacheKey);
    if (cachedResult) {
      consola.info(`Using cached player stats for ${puuid}`);
      return cachedResult;
    }
  } catch (error) {
    consola.warn(`Failed to retrieve cached player stats for ${puuid}:`, error);
  }

  // If no cache or cache failed, fetch fresh data
  consola.info(`Fetching fresh player stats for ${puuid}`);
  const result = await getPlaystyleStats(puuid, options);

  consola.info(`Fetched player stats for ${puuid}`, result);

  // Cache the result if successful
  if (result.stats) {
    try {
      await setCachedData(cacheKey, result);
      consola.info(`Cached player stats for ${puuid}`);
    } catch (error) {
      consola.warn(`Failed to cache player stats for ${puuid}:`, error);
    }
  }

  return result;
}
