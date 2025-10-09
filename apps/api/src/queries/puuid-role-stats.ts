import { SQL } from 'sql-template-strings';

export interface PlayerStatsPerRole {
  role: string;
  games: number;
  avg_kills: number;
  avg_deaths: number;
  avg_assists: number;
  avg_kda: number;
  kills_p50: number;
  kills_p75: number;
  kills_p90: number;
  deaths_p50: number;
  deaths_p75: number;
  deaths_p90: number;
  assists_p50: number;
  assists_p75: number;
  assists_p90: number;
  avg_dpm: number;
  avg_dmg_to_champs: number;
  avg_team_dmg_pct: number;
  dpm_p50: number;
  dpm_p75: number;
  dpm_p90: number;
  avg_cs_total: number;
  avg_gold_total: number;
  avg_gpm: number;
  cs_total_p50: number;
  cs_total_p90: number;
  gold_total_p50: number;
  gold_total_p75: number;
  gold_total_p90: number;
  avg_cs_at10: number;
  cs_at10_p50: number;
  cs_at10_p75: number;
  cs_at10_p90: number;
  avg_cs_at15: number;
  cs_at15_p50: number;
  cs_at15_p75: number;
  cs_at15_p90: number;
  avg_cs_at20: number;
  cs_at20_p50: number;
  cs_at20_p75: number;
  cs_at20_p90: number;
  avg_gold_at10: number;
  gold_at10_p50: number;
  gold_at10_p75: number;
  gold_at10_p90: number;
  avg_gold_at15: number;
  gold_at15_p50: number;
  gold_at15_p75: number;
  gold_at15_p90: number;
  avg_gold_at20: number;
  gold_at20_p50: number;
  gold_at20_p75: number;
  gold_at20_p90: number;
  avg_xp_at10: number;
  avg_xp_at15: number;
  avg_xp_at20: number;
  xp_at10_p50: number;
  xp_at15_p50: number;
  xp_at20_p50: number;
  avg_vision_score: number;
  avg_vision_score_per_min: number;
  avg_wards_placed: number;
  avg_control_wards: number;
  avg_wards_killed: number;
  vision_score_p50: number;
  vision_score_p75: number;
  vision_score_p90: number;
  avg_dragon_participation: number;
  avg_baron_participation: number;
  avg_herald_participation: number;
  avg_grubs_participation: number;
  avg_elder_participation: number;
  avg_dragon_takedowns: number;
  avg_baron_takedowns: number;
  avg_herald_takedowns: number;
  avg_grubs_takedowns: number;
  avg_turret_takedowns: number;
  avg_inhib_takedowns: number;
  avg_early_kills: number;
  avg_early_deaths: number;
  avg_early_solo_kills: number;
  avg_early_kills_near_ally_tower: number;
  avg_early_kills_near_enemy_tower: number;
  avg_early_deaths_near_ally_tower: number;
  avg_early_overextended_deaths: number;
  avg_early_deaths_by_jungle_gank: number;
  avg_roam_kills: number;
  avg_roam_deaths: number;
  avg_roam_kd_ratio: number;
  avg_jungle_lane_kills: number;
  avg_early_jungle_lane_kills: number;
  avg_jungle_lane_assists: number;
  avg_laner_kills_with_jungle: number;
  avg_time_dead_seconds: number;
  avg_death_time_pct: number;
  avg_team_fight_kills: number;
  first_blood_rate_pct: number;
  lane_cs_ratio_pct: number;
  jungle_cs_ratio_pct: number;
  avg_gold_per_cs: number;
  dmg_efficiency_per_gold: number;
  kill_participation_pct_est: number;
  win_rate_pct_estimate: number;
}

export const getPlayerStatsPerRole = (puuid: string) => {
  if (!puuid) {
    throw new Error('PUUID is required');
  }

  return SQL`
WITH base AS (
  SELECT *
  FROM rift_silver.stats_puuid_role_champ
  WHERE season = 2025
    AND CAST(patch_major AS VARCHAR) LIKE '15.%'
    AND puuid = ':puuid'
),
agg AS (
  SELECT
    role,
    SUM(games) AS games,

    -- Core
    SUM(games * avg_kills)   / NULLIF(SUM(games),0) AS avg_kills,
    SUM(games * avg_deaths)  / NULLIF(SUM(games),0) AS avg_deaths,
    SUM(games * avg_assists) / NULLIF(SUM(games),0) AS avg_assists,
    SUM(games * avg_kda)     / NULLIF(SUM(games),0) AS avg_kda,

    -- Percentiles (games-weighted mean of per-champ percentiles)
    SUM(games * kills_p50) / NULLIF(SUM(games),0) AS kills_p50,
    SUM(games * kills_p75) / NULLIF(SUM(games),0) AS kills_p75,
    SUM(games * kills_p90) / NULLIF(SUM(games),0) AS kills_p90,
    SUM(games * deaths_p50)/ NULLIF(SUM(games),0) AS deaths_p50,
    SUM(games * deaths_p75)/ NULLIF(SUM(games),0) AS deaths_p75,
    SUM(games * deaths_p90)/ NULLIF(SUM(games),0) AS deaths_p90,
    SUM(games * assists_p50)/NULLIF(SUM(games),0) AS assists_p50,
    SUM(games * assists_p75)/NULLIF(SUM(games),0) AS assists_p75,
    SUM(games * assists_p90)/NULLIF(SUM(games),0) AS assists_p90,

    -- Damage
    SUM(games * avg_dpm)              / NULLIF(SUM(games),0) AS avg_dpm,
    SUM(games * avg_dmg_to_champs)    / NULLIF(SUM(games),0) AS avg_dmg_to_champs,
    SUM(games * avg_team_dmg_pct)     / NULLIF(SUM(games),0) AS avg_team_dmg_pct,
    SUM(games * dpm_p50)              / NULLIF(SUM(games),0) AS dpm_p50,
    SUM(games * dpm_p75)              / NULLIF(SUM(games),0) AS dpm_p75,
    SUM(games * dpm_p90)              / NULLIF(SUM(games),0) AS dpm_p90,

    -- CS/Gold overall
    SUM(games * avg_cs_total)         / NULLIF(SUM(games),0) AS avg_cs_total,
    SUM(games * avg_gold_total)       / NULLIF(SUM(games),0) AS avg_gold_total,
    SUM(games * avg_gpm)              / NULLIF(SUM(games),0) AS avg_gpm,
    SUM(games * cs_total_p50)         / NULLIF(SUM(games),0) AS cs_total_p50,
    SUM(games * cs_total_p90)         / NULLIF(SUM(games),0) AS cs_total_p90,
    SUM(games * gold_total_p50)       / NULLIF(SUM(games),0) AS gold_total_p50,
    SUM(games * gold_total_p75)       / NULLIF(SUM(games),0) AS gold_total_p75,
    SUM(games * gold_total_p90)       / NULLIF(SUM(games),0) AS gold_total_p90,

    -- Time-slice CS
    SUM(games * avg_cs_at10)          / NULLIF(SUM(games),0) AS avg_cs_at10,
    SUM(games * cs_at10_p50)          / NULLIF(SUM(games),0) AS cs_at10_p50,
    SUM(games * cs_at10_p75)          / NULLIF(SUM(games),0) AS cs_at10_p75,
    SUM(games * cs_at10_p90)          / NULLIF(SUM(games),0) AS cs_at10_p90,
    SUM(games * avg_cs_at15)          / NULLIF(SUM(games),0) AS avg_cs_at15,
    SUM(games * cs_at15_p50)          / NULLIF(SUM(games),0) AS cs_at15_p50,
    SUM(games * cs_at15_p75)          / NULLIF(SUM(games),0) AS cs_at15_p75,
    SUM(games * cs_at15_p90)          / NULLIF(SUM(games),0) AS cs_at15_p90,
    SUM(games * avg_cs_at20)          / NULLIF(SUM(games),0) AS avg_cs_at20,
    SUM(games * cs_at20_p50)          / NULLIF(SUM(games),0) AS cs_at20_p50,
    SUM(games * cs_at20_p75)          / NULLIF(SUM(games),0) AS cs_at20_p75,
    SUM(games * cs_at20_p90)          / NULLIF(SUM(games),0) AS cs_at20_p90,

    -- Time-slice Gold
    SUM(games * avg_gold_at10)        / NULLIF(SUM(games),0) AS avg_gold_at10,
    SUM(games * gold_at10_p50)        / NULLIF(SUM(games),0) AS gold_at10_p50,
    SUM(games * gold_at10_p75)        / NULLIF(SUM(games),0) AS gold_at10_p75,
    SUM(games * gold_at10_p90)        / NULLIF(SUM(games),0) AS gold_at10_p90,
    SUM(games * avg_gold_at15)        / NULLIF(SUM(games),0) AS avg_gold_at15,
    SUM(games * gold_at15_p50)        / NULLIF(SUM(games),0) AS gold_at15_p50,
    SUM(games * gold_at15_p75)        / NULLIF(SUM(games),0) AS gold_at15_p75,
    SUM(games * gold_at15_p90)        / NULLIF(SUM(games),0) AS gold_at15_p90,
    SUM(games * avg_gold_at20)        / NULLIF(SUM(games),0) AS avg_gold_at20,
    SUM(games * gold_at20_p50)        / NULLIF(SUM(games),0) AS gold_at20_p50,
    SUM(games * gold_at20_p75)        / NULLIF(SUM(games),0) AS gold_at20_p75,
    SUM(games * gold_at20_p90)        / NULLIF(SUM(games),0) AS gold_at20_p90,

    -- XP
    SUM(games * avg_xp_at10)          / NULLIF(SUM(games),0) AS avg_xp_at10,
    SUM(games * avg_xp_at15)          / NULLIF(SUM(games),0) AS avg_xp_at15,
    SUM(games * avg_xp_at20)          / NULLIF(SUM(games),0) AS avg_xp_at20,
    SUM(games * xp_at10_p50)          / NULLIF(SUM(games),0) AS xp_at10_p50,
    SUM(games * xp_at15_p50)          / NULLIF(SUM(games),0) AS xp_at15_p50,
    SUM(games * xp_at20_p50)          / NULLIF(SUM(games),0) AS xp_at20_p50,

    -- Vision
    SUM(games * avg_vision_score)         / NULLIF(SUM(games),0) AS avg_vision_score,
    SUM(games * avg_vision_score_per_min) / NULLIF(SUM(games),0) AS avg_vision_score_per_min,
    SUM(games * avg_wards_placed)         / NULLIF(SUM(games),0) AS avg_wards_placed,
    SUM(games * avg_control_wards)        / NULLIF(SUM(games),0) AS avg_control_wards,
    SUM(games * avg_wards_killed)         / NULLIF(SUM(games),0) AS avg_wards_killed,
    SUM(games * vision_score_p50)         / NULLIF(SUM(games),0) AS vision_score_p50,
    SUM(games * vision_score_p75)         / NULLIF(SUM(games),0) AS vision_score_p75,
    SUM(games * vision_score_p90)         / NULLIF(SUM(games),0) AS vision_score_p90,

    -- Objectives (participation and takedowns)
    SUM(games * avg_dragon_participation) / NULLIF(SUM(games),0) AS avg_dragon_participation,
    SUM(games * avg_baron_participation)  / NULLIF(SUM(games),0) AS avg_baron_participation,
    SUM(games * avg_herald_participation) / NULLIF(SUM(games),0) AS avg_herald_participation,
    SUM(games * avg_grubs_participation)  / NULLIF(SUM(games),0) AS avg_grubs_participation,
    SUM(games * avg_elder_participation)  / NULLIF(SUM(games),0) AS avg_elder_participation,

    SUM(games * avg_dragon_takedowns)     / NULLIF(SUM(games),0) AS avg_dragon_takedowns,
    SUM(games * avg_baron_takedowns)      / NULLIF(SUM(games),0) AS avg_baron_takedowns,
    SUM(games * avg_herald_takedowns)     / NULLIF(SUM(games),0) AS avg_herald_takedowns,
    SUM(games * avg_grubs_takedowns)      / NULLIF(SUM(games),0) AS avg_grubs_takedowns,
    SUM(games * avg_turret_takedowns)     / NULLIF(SUM(games),0) AS avg_turret_takedowns,
    SUM(games * avg_inhib_takedowns)      / NULLIF(SUM(games),0) AS avg_inhib_takedowns,

    -- Early combat & roam
    SUM(games * avg_early_kills)                 / NULLIF(SUM(games),0) AS avg_early_kills,
    SUM(games * avg_early_deaths)                / NULLIF(SUM(games),0) AS avg_early_deaths,
    SUM(games * avg_early_solo_kills)            / NULLIF(SUM(games),0) AS avg_early_solo_kills,
    SUM(games * avg_early_kills_near_ally_tower) / NULLIF(SUM(games),0) AS avg_early_kills_near_ally_tower,
    SUM(games * avg_early_kills_near_enemy_tower)/ NULLIF(SUM(games),0) AS avg_early_kills_near_enemy_tower,
    SUM(games * avg_early_deaths_near_ally_tower)/ NULLIF(SUM(games),0) AS avg_early_deaths_near_ally_tower,
    SUM(games * avg_early_overextended_deaths)   / NULLIF(SUM(games),0) AS avg_early_overextended_deaths,
    SUM(games * avg_early_deaths_by_jungle_gank) / NULLIF(SUM(games),0) AS avg_early_deaths_by_jungle_gank,

    SUM(games * avg_roam_kills)  / NULLIF(SUM(games),0) AS avg_roam_kills,
    SUM(games * avg_roam_deaths) / NULLIF(SUM(games),0) AS avg_roam_deaths,
    SUM(games * avg_roam_kd_ratio)/ NULLIF(SUM(games),0) AS avg_roam_kd_ratio,

    -- Jungler impact
    SUM(games * avg_jungle_lane_kills)       / NULLIF(SUM(games),0) AS avg_jungle_lane_kills,
    SUM(games * avg_early_jungle_lane_kills) / NULLIF(SUM(games),0) AS avg_early_jungle_lane_kills,
    SUM(games * avg_jungle_lane_assists)     / NULLIF(SUM(games),0) AS avg_jungle_lane_assists,
    SUM(games * avg_laner_kills_with_jungle) / NULLIF(SUM(games),0) AS avg_laner_kills_with_jungle,

    -- Extended
    SUM(games * avg_time_dead_seconds)   / NULLIF(SUM(games),0) AS avg_time_dead_seconds,
    SUM(games * avg_death_time_pct)      / NULLIF(SUM(games),0) AS avg_death_time_pct,
    SUM(games * avg_team_fight_kills)    / NULLIF(SUM(games),0) AS avg_team_fight_kills,
    SUM(games * first_blood_rate_pct)    / NULLIF(SUM(games),0) AS first_blood_rate_pct,

    -- Efficiency
    SUM(games * lane_cs_ratio_pct)       / NULLIF(SUM(games),0) AS lane_cs_ratio_pct,
    SUM(games * jungle_cs_ratio_pct)     / NULLIF(SUM(games),0) AS jungle_cs_ratio_pct,
    SUM(games * avg_gold_per_cs)         / NULLIF(SUM(games),0) AS avg_gold_per_cs,
    SUM(games * dmg_efficiency_per_gold) / NULLIF(SUM(games),0) AS dmg_efficiency_per_gold,
    SUM(games * kill_participation_pct_est)/NULLIF(SUM(games),0) AS kill_participation_pct_est,
    SUM(games * win_rate_pct_estimate)   / NULLIF(SUM(games),0) AS win_rate_pct_estimate

  FROM base
  GROUP BY role
)
SELECT *
FROM agg
ORDER BY role;`.text.replaceAll(':puuid', puuid);
};
