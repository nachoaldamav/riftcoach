function escapeLiteral(value: string) {
  return value.replace(/'/g, "''");
}

export function buildPlaystyleStatsQuery({ puuid }: { puuid: string }): string {
  return `
WITH player_matches AS (
  SELECT
    s.match_id,
    s.time_played_sec as game_duration_seconds,
    s.queue as queue_id,
    s.season,
    CONCAT(s.patch_major, '.0') as patch,
    s.role,
    NULL as champion_name, -- Not available in silver table, would need champion lookup
    s.kills,
    s.deaths,
    s.assists,
    s.total_damage_to_champions as total_damage_dealt_to_champions,
    s.gold_earned,
    s.cs_total as total_minions_killed,
    0 as neutral_minions_killed, -- Included in cs_total
    s.vision_score,
    0 as control_wards_placed, -- Not available in silver table
    s.wards_cleared as wards_killed,
    s.solo_kills,
    0 as turret_takedowns, -- Not available in silver table
    0 as inhibitor_takedowns, -- Not available in silver table
    0 as objective_stolen, -- Not available in silver table
    0 as baron_kills, -- Not available in silver table
    0 as dragon_kills, -- Not available in silver table
    0 as rift_herald_kills, -- Not available in silver table
    s.role as team_position,
    CASE WHEN s.win_flag = 1 THEN true ELSE false END as win,
    s.cs10_per_min * 10 as cs_at_10_min,
    s.kills_near_enemy_turret,
    s.kills_under_own_turret,
    s.deaths_near_enemy_turret,
    s.deaths_under_own_turret,
    s.early_game_deaths,
    NULL as laning_survival_rate, -- Not available in silver table
    s.scuttle_kills as scuttle_crab_kills,
    s.wards_cleared_early as wards_killed_early,
    CASE 
      WHEN s.team_kill_events > 0 
      THEN s.kp_events / CAST(s.team_kill_events AS DOUBLE)
      ELSE 0 
    END as objective_participation,
    s.drake_participation as dragon_participation,
    s.baron_participation,
    s.herald_participation,
    -- Team stats for damage percentage calculation
    s.team_total_damage_to_champions as total_team_damage,
    s.team_id
  FROM lol.silver_player_match_summary s
  WHERE s.participant_puuid = '${escapeLiteral(puuid)}'
    AND s.season = 2025
    AND s.patch_major = '15'
    AND s.queue IN (400, 420, 440)
    AND s.time_played_sec >= 300
),
role_distribution AS (
  SELECT
    COALESCE(NULLIF(role, ''), 'UNKNOWN') as role_name,
    COUNT(*) as games_in_role,
    ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) as role_percentage
  FROM player_matches
  GROUP BY COALESCE(NULLIF(role, ''), 'UNKNOWN')
),
role_stats AS (
  SELECT
    COALESCE(NULLIF(pm.role, ''), 'UNKNOWN') as role_bucket,
    COUNT(*) as games,
    
    -- Basic KDA stats
    ROUND(AVG(CAST(pm.kills AS DOUBLE)), 2) as avg_kills,
    ROUND(AVG(CAST(pm.deaths AS DOUBLE)), 2) as avg_deaths,
    ROUND(AVG(CAST(pm.assists AS DOUBLE)), 2) as avg_assists,
    ROUND(AVG(CASE WHEN pm.deaths = 0 THEN pm.kills + pm.assists ELSE (pm.kills + pm.assists) / CAST(pm.deaths AS DOUBLE) END), 2) as avg_kda,
    
    -- Win rate
    ROUND(100.0 * AVG(CASE WHEN pm.win THEN 1.0 ELSE 0.0 END), 1) as win_rate,
    
    -- Kill participation (calculated from team stats)
    ROUND(100.0 * AVG(pm.objective_participation), 1) as kp_mean,
    
    -- Economic stats
    ROUND(AVG(pm.gold_earned / (pm.game_duration_seconds / 60.0)), 1) as avg_gpm,
    ROUND(AVG((pm.total_minions_killed + pm.neutral_minions_killed) / (pm.game_duration_seconds / 60.0)), 1) as avg_cs_per_min,
    ROUND(AVG(CAST(pm.cs_at_10_min AS DOUBLE)), 1) as cs10_mean,
    ROUND(AVG(CAST(pm.total_minions_killed + pm.neutral_minions_killed AS DOUBLE)), 1) as csfull_mean,
    
    -- Damage stats
    ROUND(AVG(pm.total_damage_dealt_to_champions / (pm.game_duration_seconds / 60.0)), 0) as avg_dpm,
    ROUND(100.0 * AVG(
      CASE 
        WHEN pm.total_team_damage > 0 
        THEN pm.total_damage_dealt_to_champions / CAST(pm.total_team_damage AS DOUBLE)
        ELSE 0 
      END
    ), 1) as avg_team_damage_pct,
    
    -- Vision stats
    ROUND(AVG(pm.vision_score / (pm.game_duration_seconds / 60.0)), 2) as vis_per_min_mean,
    ROUND(AVG(CAST(pm.wards_killed AS DOUBLE)), 1) as avg_wards_cleared,
    ROUND(AVG(pm.wards_killed / (pm.game_duration_seconds / 60.0)), 2) as wclear_per_min_mean,
    ROUND(AVG(CAST(pm.wards_killed_early AS DOUBLE)), 1) as avg_wards_cleared_early,
    
    -- Objective participation
    ROUND(100.0 * AVG(COALESCE(pm.objective_participation, 0)), 1) as avg_obj_participation,
    ROUND(100.0 * AVG(COALESCE(pm.dragon_participation, 0)), 1) as drake_participation_mean,
    ROUND(100.0 * AVG(COALESCE(pm.baron_participation, 0)), 1) as baron_participation_mean,
    ROUND(100.0 * AVG(COALESCE(pm.herald_participation, 0)), 1) as herald_participation_mean,
    
    -- Laning phase stats
    ROUND(100.0 * AVG(COALESCE(pm.laning_survival_rate, 0)), 1) as avg_laning_survival_rate,
    ROUND(AVG(COALESCE(CAST(pm.early_game_deaths AS DOUBLE), 0)), 2) as avg_early_game_deaths,
    
    -- Turret proximity stats
    ROUND(AVG(COALESCE(CAST(pm.kills_near_enemy_turret AS DOUBLE), 0)), 2) as kills_near_enemy_turret_mean,
    ROUND(AVG(COALESCE(CAST(pm.kills_under_own_turret AS DOUBLE), 0)), 2) as kills_under_own_turret_mean,
    ROUND(AVG(COALESCE(CAST(pm.deaths_near_enemy_turret AS DOUBLE), 0)), 2) as deaths_near_enemy_turret_mean,
    ROUND(AVG(COALESCE(CAST(pm.deaths_under_own_turret AS DOUBLE), 0)), 2) as deaths_under_own_turret_mean,
    
    -- Additional stats
    ROUND(AVG(COALESCE(CAST(pm.solo_kills AS DOUBLE), 0)), 2) as solo_kills_mean,
    ROUND(AVG(COALESCE(CAST(pm.scuttle_crab_kills AS DOUBLE), 0)), 2) as scuttle_kills_mean
    
  FROM player_matches pm
  GROUP BY COALESCE(NULLIF(pm.role, ''), 'UNKNOWN')
),
overall_stats AS (
  SELECT
    COUNT(*) as matches_played,
    ROUND(AVG(CAST(game_duration_seconds AS DOUBLE) / 60.0), 1) as avg_game_duration_min,
    
    -- Basic KDA stats
    ROUND(AVG(CAST(kills AS DOUBLE)), 2) as avg_kills,
    ROUND(AVG(CAST(deaths AS DOUBLE)), 2) as avg_deaths,
    ROUND(AVG(CAST(assists AS DOUBLE)), 2) as avg_assists,
    ROUND(AVG(CASE WHEN deaths = 0 THEN kills + assists ELSE (kills + assists) / CAST(deaths AS DOUBLE) END), 2) as avg_kda,
    
    -- Win rate and kill participation
    ROUND(100.0 * AVG(CASE WHEN win THEN 1.0 ELSE 0.0 END), 1) as win_rate,
    ROUND(100.0 * AVG(objective_participation), 1) as avg_kill_participation,
    
    -- Economic stats
    ROUND(AVG(gold_earned / (game_duration_seconds / 60.0)), 1) as avg_gold_per_minute,
    ROUND(AVG((total_minions_killed + neutral_minions_killed) / (game_duration_seconds / 60.0)), 1) as avg_cs_per_minute,
    ROUND(AVG(CAST(cs_at_10_min AS DOUBLE)), 1) as avg_cs_at_10,
    
    -- Damage stats
    ROUND(AVG(total_damage_dealt_to_champions / (game_duration_seconds / 60.0)), 0) as avg_damage_per_minute,
    ROUND(100.0 * AVG(
      CASE 
        WHEN total_team_damage > 0 
        THEN total_damage_dealt_to_champions / CAST(total_team_damage AS DOUBLE)
        ELSE 0 
      END
    ), 1) as avg_team_damage_pct,
    
    -- Vision stats
    ROUND(AVG(vision_score / (game_duration_seconds / 60.0)), 2) as avg_vision_score_per_minute,
    ROUND(AVG(CAST(0 AS DOUBLE)), 1) as avg_control_wards, -- Not available in silver table
    ROUND(AVG(CAST(wards_killed AS DOUBLE)), 1) as avg_wards_cleared,
    ROUND(AVG(CAST(wards_killed_early AS DOUBLE)), 1) as avg_wards_cleared_early,
    
    -- Combat stats
    ROUND(AVG(CAST(solo_kills AS DOUBLE)), 2) as avg_solo_kills,
    ROUND(AVG(CAST(0 AS DOUBLE)), 1) as avg_turret_takedowns, -- Not available in silver table
    ROUND(AVG(CAST(0 AS DOUBLE)), 1) as avg_inhibitor_takedowns, -- Not available in silver table
    ROUND(AVG(CAST(0 AS DOUBLE)), 1) as avg_objective_takedowns, -- Not available in silver table
    ROUND(AVG(CAST(scuttle_crab_kills AS DOUBLE)), 2) as avg_scuttle_kills,
    
    -- Turret proximity stats
    ROUND(AVG(COALESCE(CAST(kills_near_enemy_turret AS DOUBLE), 0)), 2) as avg_kills_near_enemy_turret,
    ROUND(AVG(COALESCE(CAST(kills_under_own_turret AS DOUBLE), 0)), 2) as avg_kills_under_own_turret,
    ROUND(AVG(COALESCE(CAST(deaths_near_enemy_turret AS DOUBLE), 0)), 2) as avg_deaths_near_enemy_turret,
    ROUND(AVG(COALESCE(CAST(deaths_under_own_turret AS DOUBLE), 0)), 2) as avg_deaths_under_own_turret,
    
    -- Laning phase stats
    ROUND(100.0 * AVG(COALESCE(laning_survival_rate, 0)), 1) as avg_laning_survival_rate,
    ROUND(AVG(COALESCE(CAST(early_game_deaths AS DOUBLE), 0)), 2) as avg_early_game_deaths,
    
    -- Objective participation
    ROUND(100.0 * AVG(COALESCE(objective_participation, 0)), 1) as avg_objective_participation,
    ROUND(100.0 * AVG(COALESCE(dragon_participation, 0)), 1) as avg_dragon_participation,
    ROUND(100.0 * AVG(COALESCE(baron_participation, 0)), 1) as avg_baron_participation,
    ROUND(100.0 * AVG(COALESCE(herald_participation, 0)), 1) as avg_herald_participation
    
  FROM player_matches
)

SELECT 
  -- Overall stats
  os.*,
  
  -- Role distribution as JSON
  (SELECT CAST(MAP(
    ARRAY_AGG(role_name),
    ARRAY_AGG(role_percentage)
  ) AS JSON) FROM role_distribution) as role_distribution_json,
  
  -- Role stats as JSON array
  (SELECT CAST(ARRAY_AGG(
    MAP(
      ARRAY['role_bucket', 'games', 'win_rate', 'kp_mean', 'vis_per_min_mean', 'wclear_per_min_mean', 
            'avg_dpm', 'cs10_mean', 'csfull_mean', 'drake_participation_mean', 'herald_participation_mean', 
            'baron_participation_mean', 'avg_obj_participation', 'avg_laning_survival_rate', 'avg_early_game_deaths',
            'kills_near_enemy_turret_mean', 'kills_under_own_turret_mean', 'deaths_near_enemy_turret_mean', 
            'deaths_under_own_turret_mean', 'avg_kills', 'avg_deaths', 'avg_assists', 'avg_kda', 
            'avg_gpm', 'avg_team_damage_pct', 'avg_cs_per_min', 'avg_wards_cleared', 'avg_wards_cleared_early', 
            'solo_kills_mean', 'scuttle_kills_mean'],
      ARRAY[role_bucket, CAST(games AS VARCHAR), CAST(win_rate AS VARCHAR), CAST(kp_mean AS VARCHAR),
            CAST(vis_per_min_mean AS VARCHAR), CAST(wclear_per_min_mean AS VARCHAR), CAST(avg_dpm AS VARCHAR),
            CAST(cs10_mean AS VARCHAR), CAST(csfull_mean AS VARCHAR), CAST(drake_participation_mean AS VARCHAR),
            CAST(herald_participation_mean AS VARCHAR), CAST(baron_participation_mean AS VARCHAR), 
            CAST(avg_obj_participation AS VARCHAR), CAST(avg_laning_survival_rate AS VARCHAR), 
            CAST(avg_early_game_deaths AS VARCHAR), CAST(kills_near_enemy_turret_mean AS VARCHAR),
            CAST(kills_under_own_turret_mean AS VARCHAR), CAST(deaths_near_enemy_turret_mean AS VARCHAR),
            CAST(deaths_under_own_turret_mean AS VARCHAR), CAST(avg_kills AS VARCHAR), CAST(avg_deaths AS VARCHAR),
            CAST(avg_assists AS VARCHAR), CAST(avg_kda AS VARCHAR), CAST(avg_gpm AS VARCHAR),
            CAST(avg_team_damage_pct AS VARCHAR), CAST(avg_cs_per_min AS VARCHAR), CAST(avg_wards_cleared AS VARCHAR),
            CAST(avg_wards_cleared_early AS VARCHAR), CAST(solo_kills_mean AS VARCHAR), CAST(scuttle_kills_mean AS VARCHAR)]
    )
  ) AS JSON) FROM role_stats) as role_stats_json

FROM overall_stats os;
`;
}

export function buildCohortStatsQuery(): string {
  return `
SELECT
  season,
  CASE WHEN GROUPING(role)=1 THEN 'ALL' ELSE COALESCE(NULLIF(role,''),'UNKNOWN') END AS role_bucket,

  -- counts
  SUM(unique_players) AS players_appearances,
  SUM(games) AS matches_est,

  -- core stats
  AVG(kda_ratio) AS avg_kda,
  AVG(avg_dpm) AS avg_dpg,
  AVG(avg_gpm) AS avg_gpm,
  AVG(avg_team_dmg_pct) AS avg_team_damage_pct,
  AVG(avg_cs_per_min) AS avg_csfull,
  AVG(avg_cs_at10) AS avg_cs10,
  AVG(avg_vision_score_per_min) AS avg_vis_per_min,
  AVG(wards_killed_per10) AS avg_wclear_per_min,
  AVG(avg_wards_killed) AS avg_wards_cleared,

  -- combat stats
  AVG(avg_kills) AS avg_kills,
  AVG(avg_deaths) AS avg_deaths,
  AVG(avg_assists) AS avg_assists,
  AVG(avg_solo_kills) AS avg_solo_kills,

  -- objective participation (using corrected participation rates 0-1)
  AVG(avg_participation_dragons) AS avg_drake_participation,
  AVG(avg_participation_herald) AS avg_herald_participation,
  AVG(avg_participation_baron) AS avg_baron_participation,
  
  -- calculate overall objective participation as average of major objectives
  (AVG(avg_participation_dragons) + AVG(avg_participation_baron) + AVG(avg_participation_herald)) / 3.0 AS avg_obj_participation,

  -- structures
  AVG(avg_turret_takedowns) AS avg_turret_takedowns,
  AVG(avg_inhib_takedowns) AS avg_inhibitor_takedowns,

  -- win rate and kill participation
  AVG(win_rate) AS avg_win_rate,
  100.0 * AVG(avg_kills + avg_assists) / NULLIF(AVG(avg_kills + avg_deaths + avg_assists), 0) AS avg_kp,
  100.0 * AVG(avg_kills + avg_assists) / NULLIF(AVG(avg_kills + avg_deaths + avg_assists), 0) AS avg_kill_participation_pct

FROM rift_gold.v_cohort_role_stats
WHERE season = 2025
  AND patch_major = '15'
  AND queue IN (400,420,440)
  AND avg_cs_at10 > 0
GROUP BY GROUPING SETS ((season, role), (season))
ORDER BY season, CASE WHEN role IS NULL THEN 0 ELSE 1 END, role;
`;
}
