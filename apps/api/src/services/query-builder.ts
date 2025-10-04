import type { BuildQueryOptions } from './types.js';

function escapeLiteral(value: string) {
  return value.replace(/'/g, "''");
}

function parseSeason(scope?: string | null): number | undefined {
  if (!scope) return undefined;
  const match = scope.match(/season-(\d+)/);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

export function buildPlaystyleStatsQuery({ puuid }: { puuid: string }): string {
  return `
WITH player_matches AS (
  SELECT
    m.match_id,
    m.game_duration_seconds,
    m.queue_id,
    m.season,
    m.patch,
    p.role,
    p.champion_name,
    p.kills,
    p.deaths,
    p.assists,
    p.total_damage_dealt_to_champions,
    p.gold_earned,
    p.total_minions_killed,
    p.neutral_minions_killed,
    p.vision_score,
    p.control_wards_placed,
    p.wards_killed,
    p.solo_kills,
    p.turret_takedowns,
    p.inhibitor_takedowns,
    p.objective_stolen,
    p.baron_kills,
    p.dragon_kills,
    p.rift_herald_kills,
    p.team_position,
    p.win,
    p.cs_at_10_min,
    p.kills_near_enemy_turret,
    p.kills_under_own_turret,
    p.deaths_near_enemy_turret,
    p.deaths_under_own_turret,
    p.early_game_deaths,
    p.laning_survival_rate,
    p.scuttle_crab_kills,
    p.wards_killed_early,
    p.objective_participation,
    p.dragon_participation,
    p.baron_participation,
    p.herald_participation,
    -- Team stats for damage percentage calculation
    team.total_team_damage
  FROM lol.matches m
  JOIN lol.participants p ON m.match_id = p.match_id
  LEFT JOIN (
    SELECT 
      match_id,
      team_id,
      SUM(total_damage_dealt_to_champions) as total_team_damage
    FROM lol.participants
    GROUP BY match_id, team_id
  ) team ON m.match_id = team.match_id AND p.team_id = team.team_id
  WHERE p.puuid = '${escapeLiteral(puuid)}'
    AND m.season = 2025
    AND m.patch LIKE '15.%'
    AND m.queue_id IN (400, 420, 440)
    AND m.game_duration_seconds >= 300
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
    ROUND(100.0 * AVG(
      CASE 
        WHEN team_kills.team_kills > 0 
        THEN (pm.kills + pm.assists) / CAST(team_kills.team_kills AS DOUBLE)
        ELSE 0 
      END
    ), 1) as kp_mean,
    
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
  LEFT JOIN (
    SELECT 
      m2.match_id,
      p2.team_id,
      SUM(p2.kills) as team_kills
    FROM lol.matches m2
    JOIN lol.participants p2 ON m2.match_id = p2.match_id
    GROUP BY m2.match_id, p2.team_id
  ) team_kills ON pm.match_id = team_kills.match_id AND pm.team_id = team_kills.team_id
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
    ROUND(100.0 * AVG(
      CASE 
        WHEN team_kills.team_kills > 0 
        THEN (kills + assists) / CAST(team_kills.team_kills AS DOUBLE)
        ELSE 0 
      END
    ), 1) as avg_kill_participation,
    
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
    ROUND(AVG(CAST(control_wards_placed AS DOUBLE)), 1) as avg_control_wards,
    ROUND(AVG(CAST(wards_killed AS DOUBLE)), 1) as avg_wards_cleared,
    ROUND(AVG(CAST(wards_killed_early AS DOUBLE)), 1) as avg_wards_cleared_early,
    
    -- Combat stats
    ROUND(AVG(CAST(solo_kills AS DOUBLE)), 2) as avg_solo_kills,
    ROUND(AVG(CAST(turret_takedowns AS DOUBLE)), 1) as avg_turret_takedowns,
    ROUND(AVG(CAST(inhibitor_takedowns AS DOUBLE)), 1) as avg_inhibitor_takedowns,
    ROUND(AVG(CAST(objective_stolen AS DOUBLE)), 1) as avg_objective_takedowns,
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
  LEFT JOIN (
    SELECT 
      m2.match_id,
      p2.team_id,
      SUM(p2.kills) as team_kills
    FROM lol.matches m2
    JOIN lol.participants p2 ON m2.match_id = p2.match_id
    GROUP BY m2.match_id, p2.team_id
  ) team_kills ON player_matches.match_id = team_kills.match_id AND player_matches.team_id = team_kills.team_id
)

SELECT 
  -- Overall stats
  os.*,
  
  -- Role distribution as JSON
  CAST(MAP(
    ARRAY_AGG(rd.role_name),
    ARRAY_AGG(rd.role_percentage)
  ) AS JSON) as role_distribution_json,
  
  -- Role stats as JSON array
  CAST(ARRAY_AGG(
    MAP(
      ARRAY['role_bucket', 'games', 'win_rate', 'kp_mean', 'vis_per_min_mean', 'wclear_per_min_mean', 
            'avg_dpm', 'cs10_mean', 'csfull_mean', 'drake_participation_mean', 'herald_participation_mean', 
            'baron_participation_mean', 'avg_obj_participation', 'avg_laning_survival_rate', 'avg_early_game_deaths',
            'kills_near_enemy_turret_mean', 'kills_under_own_turret_mean', 'deaths_near_enemy_turret_mean', 
            'deaths_under_own_turret_mean', 'avg_kills', 'avg_deaths', 'avg_assists', 'avg_kda', 
            'avg_gpm', 'avg_team_damage_pct', 'avg_cs_per_min', 'avg_wards_cleared', 'avg_wards_cleared_early', 
            'solo_kills_mean', 'scuttle_kills_mean'],
      ARRAY[rs.role_bucket, CAST(rs.games AS VARCHAR), CAST(rs.win_rate AS VARCHAR), CAST(rs.kp_mean AS VARCHAR),
            CAST(rs.vis_per_min_mean AS VARCHAR), CAST(rs.wclear_per_min_mean AS VARCHAR), CAST(rs.avg_dpm AS VARCHAR),
            CAST(rs.cs10_mean AS VARCHAR), CAST(rs.csfull_mean AS VARCHAR), CAST(rs.drake_participation_mean AS VARCHAR),
            CAST(rs.herald_participation_mean AS VARCHAR), CAST(rs.baron_participation_mean AS VARCHAR), 
            CAST(rs.avg_obj_participation AS VARCHAR), CAST(rs.avg_laning_survival_rate AS VARCHAR), 
            CAST(rs.avg_early_game_deaths AS VARCHAR), CAST(rs.kills_near_enemy_turret_mean AS VARCHAR),
            CAST(rs.kills_under_own_turret_mean AS VARCHAR), CAST(rs.deaths_near_enemy_turret_mean AS VARCHAR),
            CAST(rs.deaths_under_own_turret_mean AS VARCHAR), CAST(rs.avg_kills AS VARCHAR), CAST(rs.avg_deaths AS VARCHAR),
            CAST(rs.avg_assists AS VARCHAR), CAST(rs.avg_kda AS VARCHAR), CAST(rs.avg_gpm AS VARCHAR),
            CAST(rs.avg_team_damage_pct AS VARCHAR), CAST(rs.avg_cs_per_min AS VARCHAR), CAST(rs.avg_wards_cleared AS VARCHAR),
            CAST(rs.avg_wards_cleared_early AS VARCHAR), CAST(rs.solo_kills_mean AS VARCHAR), CAST(rs.scuttle_kills_mean AS VARCHAR)]
    )
  ) AS JSON) as role_stats_json

FROM overall_stats os
CROSS JOIN role_distribution rd
CROSS JOIN role_stats rs
GROUP BY os.matches_played, os.avg_game_duration_min, os.avg_kills, os.avg_deaths, os.avg_assists, os.avg_kda,
         os.win_rate, os.avg_kill_participation, os.avg_gold_per_minute, os.avg_cs_per_minute, os.avg_cs_at_10,
         os.avg_damage_per_minute, os.avg_team_damage_pct, os.avg_vision_score_per_minute, os.avg_control_wards,
         os.avg_wards_cleared, os.avg_wards_cleared_early, os.avg_solo_kills, os.avg_turret_takedowns,
         os.avg_inhibitor_takedowns, os.avg_objective_takedowns, os.avg_scuttle_kills, os.avg_kills_near_enemy_turret,
         os.avg_kills_under_own_turret, os.avg_deaths_near_enemy_turret, os.avg_deaths_under_own_turret,
         os.avg_laning_survival_rate, os.avg_early_game_deaths, os.avg_objective_participation,
         os.avg_dragon_participation, os.avg_baron_participation, os.avg_herald_participation;
`;
}

export function buildCohortStatsQuery(): string {
  return `
SELECT
  season,
  CASE WHEN GROUPING(role)=1 THEN 'ALL' ELSE COALESCE(NULLIF(role,''),'UNKNOWN') END AS role_bucket,

  -- counts
  SUM(players) AS players_appearances,
  CAST(CASE WHEN GROUPING(role)=1 THEN SUM(games)/10 ELSE SUM(games)/2 END AS BIGINT) AS matches_est,

  -- weighted means (by games) -- core
  SUM(kp_mean                  * games) / NULLIF(SUM(games),0) AS avg_kp,
  SUM(vis_per_min_mean         * games) / NULLIF(SUM(games),0) AS avg_vis_per_min,
  SUM(wclear_per_min_mean      * games) / NULLIF(SUM(games),0) AS avg_wclear_per_min,
  SUM(dpg_mean                 * games) / NULLIF(SUM(games),0) AS avg_dpg,
  SUM(cs10_mean                * games) / NULLIF(SUM(games),0) AS avg_cs10,
  SUM(csfull_mean              * games) / NULLIF(SUM(games),0) AS avg_csfull,

  -- objectives (0..1 each; sum 0..3)
  SUM(drake_participation_mean * games) / NULLIF(SUM(games),0) AS avg_drake_participation,
  SUM(herald_participation_mean* games) / NULLIF(SUM(games),0) AS avg_herald_participation,
  SUM(baron_participation_mean * games) / NULLIF(SUM(games),0) AS avg_baron_participation,
  SUM(avg_objective_participation * games) / NULLIF(SUM(games),0) AS avg_obj_participation,

  -- early lane
  SUM(avg_laning_survival_rate * games) / NULLIF(SUM(games),0) AS avg_laning_survival_rate,
  SUM(avg_early_game_deaths    * games) / NULLIF(SUM(games),0) AS avg_early_game_deaths,

  -- laning-phase turret proximity
  SUM(kills_near_enemy_turret_mean  * games) / NULLIF(SUM(games),0) AS avg_kills_near_enemy_turret,
  SUM(kills_under_own_turret_mean   * games) / NULLIF(SUM(games),0) AS avg_kills_under_own_turret,
  SUM(deaths_near_enemy_turret_mean * games) / NULLIF(SUM(games),0) AS avg_deaths_near_enemy_turret,
  SUM(deaths_under_own_turret_mean  * games) / NULLIF(SUM(games),0) AS avg_deaths_under_own_turret,

  -- extras from v2.2 we can now surface in cohorts rollup
  SUM(kills_mean            * games) / NULLIF(SUM(games),0) AS avg_kills,
  SUM(deaths_mean           * games) / NULLIF(SUM(games),0) AS avg_deaths,
  SUM(assists_mean          * games) / NULLIF(SUM(games),0) AS avg_assists,
  SUM(kda_mean              * games) / NULLIF(SUM(games),0) AS avg_kda,
  SUM(gpm_mean              * games) / NULLIF(SUM(games),0) AS avg_gpm,
  SUM(team_damage_pct_mean  * games) / NULLIF(SUM(games),0) AS avg_team_damage_pct,
  SUM(wclear_mean           * games) / NULLIF(SUM(games),0) AS avg_wards_cleared,
  SUM(wclear_early_mean     * games) / NULLIF(SUM(games),0) AS avg_wards_cleared_early,
  SUM(solo_kills_mean       * games) / NULLIF(SUM(games),0) AS avg_solo_kills,
  SUM(scuttle_kills_mean    * games) / NULLIF(SUM(games),0) AS avg_scuttle_kills,

  -- win rate and convenience % for KP
  SUM(win_rate * games) / NULLIF(SUM(games),0)              AS avg_win_rate,
  100.0 * (SUM(kp_mean * games) / NULLIF(SUM(games),0))     AS avg_kill_participation_pct

FROM lol.cohorts_role_champ_snap_v2
WHERE season = 2025
  AND patch LIKE '15.%'
  AND queue IN (400,420,440)
  AND cs10_mean > 0
GROUP BY GROUPING SETS ((season, role), (season))
ORDER BY season, CASE WHEN role IS NULL THEN 0 ELSE 1 END, role;
`;
}
