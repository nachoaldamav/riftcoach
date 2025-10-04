import chalk from 'chalk';
import { consola } from 'consola';
import { runAthenaQuery } from '../utils/run-athena-query.js';
import { generateAIBadges, getCachedAIBadges } from './ai-service.js';
import { getCacheKey, getCachedData, setCachedData } from './cache-utils.js';
import {
  buildCohortStatsQuery,
  buildPlaystyleStatsQuery,
} from './query-builder.js';
import type {
  AIBadgeResult,
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

export async function getPlaystyleStats(
  puuid: string,
  options: { scope?: string | null; queues?: number[] } = {},
): Promise<PlaystyleQueryResult> {
  const sql = buildPlaystyleStatsQuery({ puuid });

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

  // Process role-specific records
  const roleStats: RoleStats[] = records.map((record) => ({
    roleBucket: record.role_bucket || '',
    games: Number.parseInt(record.matches_est ?? '0', 10) || 0,
    winRate: normalizePercentish(toNumber(record.avg_win_rate)),
    kpMean: normalizePercentish(toNumber(record.avg_kp)),
    visPerMinMean: toNumber(record.avg_vis_per_min),
    wclearPerMinMean: toNumber(record.avg_wclear_per_min),
    dpgMean: toNumber(record.avg_dpg),
    cs10Mean: toNumber(record.avg_cs10),
    csfullMean: toNumber(record.avg_csfull),
    drakeParticipationMean: toNumber(record.avg_drake_participation),
    heraldParticipationMean: toNumber(record.avg_herald_participation),
    baronParticipationMean: toNumber(record.avg_baron_participation),
    avgObjectiveParticipation: toNumber(record.avg_obj_participation),
    avgLaningSurvivalRate: toNumber(record.avg_laning_survival_rate),
    avgEarlyGameDeaths: toNumber(record.avg_early_game_deaths),
    killsNearEnemyTurretMean: toNumber(record.avg_kills_near_enemy_turret),
    killsUnderOwnTurretMean: toNumber(record.avg_kills_under_own_turret),
    deathsNearEnemyTurretMean: toNumber(record.avg_deaths_near_enemy_turret),
    deathsUnderOwnTurretMean: toNumber(record.avg_deaths_under_own_turret),
    avgDamagePerGold: toNumber(record.avg_damage_per_gold),
    avgKills: toNumber(record.avg_kills),
    avgDeaths: toNumber(record.avg_deaths),
    avgAssists: toNumber(record.avg_assists),
    avgKda: toNumber(record.avg_kda),
    avgKillParticipationPct: normalizePercentish(toNumber(record.avg_kp)),
    avgKillParticipationProp: normalizePercentish(toNumber(record.avg_kp)),
    avgDamagePerMinute: toNumber(record.avg_dpg),
    avgTeamDamagePct: normalizePercentish(toNumber(record.avg_team_damage_pct)),
    avgGoldPerMinute: toNumber(record.avg_gpm),
    avgVisionScorePerMinute: toNumber(record.avg_vis_per_min),
    avgWardsCleared: toNumber(record.avg_wards_cleared),
    avgWardsClearedEarly: toNumber(record.avg_wards_cleared_early),
    avgSoloKills: toNumber(record.avg_solo_kills),
    avgScuttleKills: toNumber(record.avg_scuttle_kills),
    roleDistributionPct: null,
  }));

  // Find the "ALL" role bucket for overall stats
  const allRoleRecord = roleStats.find((role) => role.roleBucket === 'ALL');

  // Calculate role distribution from non-ALL records
  const roleDistribution: { [role: string]: number } = {};
  const totalGames = allRoleRecord?.games || 0;

  for (const roleRecord of roleStats) {
    if (roleRecord.roleBucket !== 'ALL' && totalGames > 0) {
      roleDistribution[roleRecord.roleBucket] =
        (roleRecord.games / totalGames) * 100;
    }
  }

  const stats: PlaystyleStats | null = allRoleRecord
    ? {
        matchesPlayed: allRoleRecord.games,
        winRate: allRoleRecord.winRate,
        avgGameDurationMin: null, // Not provided by the query
        avgKills: allRoleRecord.avgKills,
        avgDeaths: allRoleRecord.avgDeaths,
        avgAssists: allRoleRecord.avgAssists,
        avgKda: allRoleRecord.avgKda,
        avgKillParticipation: allRoleRecord.kpMean,
        avgDamagePerMinute: allRoleRecord.dpgMean,
        avgTeamDamagePct: allRoleRecord.avgTeamDamagePct,
        avgGoldPerMinute: allRoleRecord.avgGoldPerMinute,
        avgCsPerMinute: allRoleRecord.csfullMean,
        avgCsAt10: allRoleRecord.cs10Mean,
        avgVisionScorePerMinute: allRoleRecord.visPerMinMean,
        avgControlWards: null, // Not provided by the query
        avgWardsCleared: allRoleRecord.avgWardsCleared,
        avgWardsClearedEarly: allRoleRecord.avgWardsClearedEarly,
        avgSoloKills: allRoleRecord.avgSoloKills,
        avgTurretTakedowns: null, // Not provided by the query
        avgInhibitorTakedowns: null, // Not provided by the query
        avgObjectiveTakedowns: null, // Not provided by the query
        avgScuttleKills: allRoleRecord.avgScuttleKills,
        avgKillsNearEnemyTurret: allRoleRecord.killsNearEnemyTurretMean,
        avgKillsUnderOwnTurret: allRoleRecord.killsUnderOwnTurretMean,
        avgDeathsNearEnemyTurret: allRoleRecord.deathsNearEnemyTurretMean,
        avgDeathsUnderOwnTurret: allRoleRecord.deathsUnderOwnTurretMean,
        avgLaningSurvivalRate: allRoleRecord.avgLaningSurvivalRate,
        avgEarlyGameDeaths: allRoleRecord.avgEarlyGameDeaths,
        avgObjectiveParticipation: allRoleRecord.avgObjectiveParticipation,
        avgDragonParticipation: allRoleRecord.drakeParticipationMean,
        avgBaronParticipation: allRoleRecord.baronParticipationMean,
        avgHeraldParticipation: allRoleRecord.heraldParticipationMean,
        roleDistribution:
          Object.keys(roleDistribution).length > 0 ? roleDistribution : null,
        roleStats: roleStats,
      }
    : null;

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

export async function getCohortStats(): Promise<CohortQueryResult> {
  const sql = buildCohortStatsQuery();

  const { queryExecutionId, records, statistics } = await runAthenaQuery({
    query: sql,
  });

  // Process all role records
  const roleStats: RoleStats[] = records.map((record) => ({
    roleBucket: record.role_bucket || '',
    games: Number.parseInt(record.matches_est ?? '0', 10) || 0,
    winRate: normalizePercentish(toNumber(record.avg_win_rate)),
    kpMean: normalizePercentish(toNumber(record.avg_kp)),
    visPerMinMean: toNumber(record.avg_vis_per_min),
    wclearPerMinMean: toNumber(record.avg_wclear_per_min),
    dpgMean: toNumber(record.avg_dpg),
    cs10Mean: toNumber(record.avg_cs10),
    csfullMean: toNumber(record.avg_csfull),
    drakeParticipationMean: toNumber(record.avg_drake_participation),
    heraldParticipationMean: toNumber(record.avg_herald_participation),
    baronParticipationMean: toNumber(record.avg_baron_participation),
    avgObjectiveParticipation: toNumber(record.avg_obj_participation),
    avgLaningSurvivalRate: toNumber(record.avg_laning_survival_rate),
    avgEarlyGameDeaths: toNumber(record.avg_early_game_deaths),
    killsNearEnemyTurretMean: toNumber(record.avg_kills_near_enemy_turret),
    killsUnderOwnTurretMean: toNumber(record.avg_kills_under_own_turret),
    deathsNearEnemyTurretMean: toNumber(record.avg_deaths_near_enemy_turret),
    deathsUnderOwnTurretMean: toNumber(record.avg_deaths_under_own_turret),

    // Newly surfaced by the rollup
    avgKills: toNumber(record.avg_kills),
    avgDeaths: toNumber(record.avg_deaths),
    avgAssists: toNumber(record.avg_assists),
    avgKda: toNumber(record.avg_kda),
    avgGoldPerMinute: toNumber(record.avg_gpm),
    avgTeamDamagePct: normalizePercentish(toNumber(record.avg_team_damage_pct)),
    avgWardsCleared: toNumber(record.avg_wards_cleared),
    avgWardsClearedEarly: toNumber(record.avg_wards_cleared_early),
    avgSoloKills: toNumber(record.avg_solo_kills),
    avgScuttleKills: toNumber(record.avg_scuttle_kills),

    // Keep compatible field (will be null as not provided by the rollup)
    avgDamagePerGold: toNumber(record.avg_damage_per_gold),

    // Existing mappings
    avgKillParticipationPct: null, // not needed here, we already return avg_kill_participation_pct at cohort level if desired
    avgKillParticipationProp: toNumber(record.avg_kp),
    avgDamagePerMinute: toNumber(record.avg_dpg),
    avgVisionScorePerMinute: toNumber(record.avg_vis_per_min),
    roleDistributionPct: null,
  }));

  // Find the "ALL" role bucket for overall stats
  const allRoleRecord = roleStats.find((role) => role.roleBucket === 'ALL');

  const stats: CohortStats | null = allRoleRecord
    ? {
        season: 2025, // Hardcoded for now (keep in sync with WHERE clause)
        totalPlayers:
          Number.parseInt(
            records.find((r) => r.role_bucket === 'ALL')?.players_appearances ??
              '0',
            10,
          ) || 0,
        totalGames: allRoleRecord.games,
        seasonAvgKp: allRoleRecord.kpMean,
        seasonAvgVisPerMin: allRoleRecord.visPerMinMean,
        seasonAvgWclearPerMin: allRoleRecord.wclearPerMinMean,
        seasonAvgDpg: allRoleRecord.dpgMean,
        seasonAvgCs10: allRoleRecord.cs10Mean,
        seasonAvgCsfull: allRoleRecord.csfullMean,
        seasonAvgDrakeParticipation: allRoleRecord.drakeParticipationMean,
        seasonAvgHeraldParticipation: allRoleRecord.heraldParticipationMean,
        seasonAvgBaronParticipation: allRoleRecord.baronParticipationMean,
        seasonAvgObjParticipation: allRoleRecord.avgObjectiveParticipation,
        seasonAvgLaningSurvivalRate: allRoleRecord.avgLaningSurvivalRate,
        seasonAvgEarlyGameDeaths: allRoleRecord.avgEarlyGameDeaths,
        seasonAvgKillsNearEnemyTurret: allRoleRecord.killsNearEnemyTurretMean,
        seasonAvgKillsUnderOwnTurret: allRoleRecord.killsUnderOwnTurretMean,
        seasonAvgDeathsNearEnemyTurret: allRoleRecord.deathsNearEnemyTurretMean,
        seasonAvgDeathsUnderOwnTurret: allRoleRecord.deathsUnderOwnTurretMean,
        seasonAvgDamagePerGold: toNumber(
          records.find((r) => r.role_bucket === 'ALL')?.avg_damage_per_gold ??
            null,
        ),
        seasonAvgWinRate: allRoleRecord.winRate,
        // Role-based breakdown
        roleStats: roleStats,
      }
    : null;

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

// Export AI functions from ai-service
export { generateAIBadges, getCachedAIBadges } from './ai-service.js';
