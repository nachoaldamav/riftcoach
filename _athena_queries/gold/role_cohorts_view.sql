-- STATS_PUUID_ROLE_CHAMP – decorrelated v2
-- - Removes ALL correlated subqueries (including the one in jungler_impact)
-- - Uses precomputed flags tables + joins
-- - Athena/Trino compatible

CREATE OR REPLACE VIEW rift_silver.stats_puuid_role_champ AS
WITH
-- -----------------------------  STATIC / HELPERS  -----------------------------
tower_positions AS (
  SELECT * FROM (
    VALUES
      (100, 'OUTER','TOP',  981, 10441),
      (100, 'OUTER','MID',  5846,  6396),
      (100, 'OUTER','BOT', 10504,  1029),
      (100, 'INNER','TOP',  1512,  6699),
      (100, 'INNER','MID',  5048,  4812),
      (100, 'INNER','BOT',  6919,  1483),
      (100, 'INHIB','TOP',  1171,  3571),
      (100, 'INHIB','MID',  3203,  3208),
      (100, 'INHIB','BOT',  3452,  1236),
      (200, 'OUTER','TOP',  4318, 13875),
      (200, 'OUTER','MID',  8955,  8510),
      (200, 'OUTER','BOT', 13866,  4505),
      (200, 'INNER','TOP',  7943, 13411),
      (200, 'INNER','MID',  9767, 10113),
      (200, 'INNER','BOT', 13327,  8226),
      (200, 'INHIB','TOP', 11134, 13654),
      (200, 'INHIB','MID', 11598, 11667),
      (200, 'INHIB','BOT', 13604, 11316)
  ) AS t(team_id, tower_type, lane, x, y)
),

tower_radius AS ( SELECT 900 AS r ),

early_game_threshold AS ( SELECT 15 * 60 * 1000 AS cutoff_ms ),

-- -----------------------------  BASE ROW  -------------------------------------
participants_base AS (
  SELECT
    puuid, matchid, participant_id, team_id,
    champion_id, champion_name, season, patch_major,
    CASE
      WHEN individual_position IN ('TOP','JUNGLE','MIDDLE','BOTTOM','UTILITY') THEN individual_position
      WHEN team_position       IN ('TOP','JUNGLE','MIDDLE','BOTTOM','UTILITY') THEN team_position
      WHEN lane = 'TOP_LANE' THEN 'TOP'
      WHEN lane = 'MIDDLE_LANE' THEN 'MIDDLE'
      WHEN lane = 'BOTTOM_LANE' AND role = 'DUO_CARRY'   THEN 'BOTTOM'
      WHEN lane = 'BOTTOM_LANE' AND role = 'DUO_SUPPORT' THEN 'UTILITY'
      WHEN role = 'JUNGLE' OR lane = 'JUNGLE'            THEN 'JUNGLE'
      ELSE COALESCE(individual_position, team_position, 'UNKNOWN')
    END AS role_normalized,

    -- core
    kills, deaths, assists, kda,
    total_dmg_to_champs, team_dmg_pct, dpm,
    total_dmg_dealt, total_dmg_taken,
    gold_earned, gpm,
    total_minions_killed, neutral_minions_killed,
    vision_score, vision_score_per_min,
    wards_placed, wards_killed, control_wards_placed,
    total_time_spent_dead,
    turret_takedowns, inhib_takedowns,

    -- snapshots
    cs_at10, gold_at10, xp_at10, level_at10,
    cs_at20, gold_at20, xp_at20, level_at20,

    -- approx @15
    CAST((cs_at10 + cs_at20)/2 AS INTEGER)     AS cs_at15,
    CAST((gold_at10 + gold_at20)/2 AS INTEGER) AS gold_at15,
    CAST((xp_at10 + xp_at20)/2 AS INTEGER)     AS xp_at15,

    -- maps/TS
    objective_takedowns_by_type_norm,
    team_objective_totals_by_type,
    objective_participation_by_type,
    combat_events_ts,
    positions_ts,

    meta.game_duration_sec
  FROM rift_silver.participants_wide_v9
  WHERE queue IN (420,440,400)
),

participants_dim AS (
  SELECT matchid, participant_id, team_id, role_normalized
  FROM participants_base
),

-- -----------------------------  EVENTS (typed)  --------------------------------
combat_events_exploded AS (
  SELECT
    p.puuid, p.matchid, p.participant_id, p.team_id, p.role_normalized, p.champion_id,
    e.ts, e.x, e.y, e.kind, e.killer_id, e.victim_id, e.assists_count, e.assists_ids
  FROM participants_base p
  CROSS JOIN UNNEST(p.combat_events_ts) AS t(e)
),

events_with_lane AS (
  SELECT
    c.*,
    CASE
      WHEN x BETWEEN  500 AND  4000 AND y BETWEEN 13000 AND 14500 THEN 'TOP'
      WHEN x BETWEEN 3500 AND 11500 AND y BETWEEN  3500 AND 11500 THEN 'MIDDLE'
      WHEN x BETWEEN 10000 AND 14500 AND y BETWEEN   500 AND  4000 THEN 'BOTTOM'
      WHEN x BETWEEN  2000 AND  8000 AND y BETWEEN  8000 AND 13000 THEN 'JUNGLE_TOP'
      WHEN x BETWEEN  7000 AND 13000 AND y BETWEEN  2000 AND  8000 THEN 'JUNGLE_BOT'
      WHEN x BETWEEN  6000 AND  9000 AND y BETWEEN  6000 AND  9000 THEN 'RIVER'
      ELSE 'OTHER'
    END AS evt_lane
  FROM combat_events_exploded c
),

typed_events AS (
  SELECT
    e.*,
    CAST(e.killer_id AS INTEGER)                      AS killer_id_i,
    CAST(e.victim_id AS INTEGER)                      AS victim_id_i,
    TRANSFORM(e.assists_ids, x -> CAST(x AS INTEGER)) AS assists_ids_i
  FROM events_with_lane e
),

-- ------------------  PRECOMPUTED FLAGS (DE-CORRELATED)  -----------------------
-- Tower proximity flags per event
event_tower_flags AS (
  SELECT
    te.matchid, te.ts,
    CAST(MAX(CASE WHEN tp.team_id = 100 THEN 1 ELSE 0 END) AS INTEGER) AS near_blue,
    CAST(MAX(CASE WHEN tp.team_id = 200 THEN 1 ELSE 0 END) AS INTEGER) AS near_red
  FROM typed_events te
  CROSS JOIN tower_radius tr
  JOIN tower_positions tp
    ON ((te.x - tp.x)*(te.x - tp.x) + (te.y - tp.y)*(te.y - tp.y)) <= tr.r * tr.r
  GROUP BY te.matchid, te.ts
),

early_flags AS (
  SELECT f.*, eg.cutoff_ms
  FROM event_tower_flags f
  CROSS JOIN early_game_threshold eg
),

-- Killer/victim/assist roles per KILL event (detect jungle ganks)
kill_role_flags AS (
  SELECT
    te.matchid,
    te.ts,
    te.killer_id_i,
    te.victim_id_i,
    MAX(CASE WHEN pk.role_normalized = 'JUNGLE' THEN 1 ELSE 0 END) AS killer_is_jungle,
    MAX(CASE WHEN pa.role_normalized = 'JUNGLE' THEN 1 ELSE 0 END) AS any_assist_is_jungle
  FROM typed_events te
  LEFT JOIN participants_dim pk
    ON pk.matchid = te.matchid AND pk.participant_id = te.killer_id_i
  LEFT JOIN UNNEST(te.assists_ids_i) AS a(aid) ON TRUE
  LEFT JOIN participants_dim pa
    ON pa.matchid = te.matchid AND pa.participant_id = a.aid
  WHERE te.kind = 'KILL'
  GROUP BY te.matchid, te.ts, te.killer_id_i, te.victim_id_i
),

-- First blood members (killer + all assists at earliest KILL ts per match)
first_kill_ts AS (
  SELECT matchid, MIN(ts) AS fb_ts
  FROM typed_events
  WHERE kind = 'KILL'
  GROUP BY matchid
),
first_blood_members AS (
  SELECT te.matchid, te.killer_id_i AS participant_id
  FROM typed_events te
  JOIN first_kill_ts f ON f.matchid = te.matchid AND f.fb_ts = te.ts
  WHERE te.kind='KILL'
  UNION ALL
  SELECT te.matchid, a AS participant_id
  FROM typed_events te
  JOIN first_kill_ts f ON f.matchid = te.matchid AND f.fb_ts = te.ts
  CROSS JOIN UNNEST(te.assists_ids_i) AS t(a)
  WHERE te.kind='KILL'
),

-- -----------------------------  METRICS (NO CORRELATED EXISTS)  ----------------
early_combat_analysis AS (
  SELECT
    p.puuid, p.matchid, p.participant_id, p.team_id, p.role_normalized, p.champion_id,

    SUM(CASE WHEN e.kind='KILL'  AND e.killer_id_i = p.participant_id AND e.ts <= ef.cutoff_ms THEN 1 ELSE 0 END) AS early_kills,
    SUM(CASE WHEN e.kind='DEATH' AND e.victim_id_i = p.participant_id AND e.ts <= ef.cutoff_ms THEN 1 ELSE 0 END) AS early_deaths,

    SUM(CASE WHEN e.kind='KILL' AND e.killer_id_i = p.participant_id AND e.assists_count = 0 AND e.ts <= ef.cutoff_ms THEN 1 ELSE 0 END) AS early_solo_kills,

    SUM(CASE WHEN e.kind='KILL' AND e.killer_id_i = p.participant_id AND e.assists_count > 0 THEN 1 ELSE 0 END) AS team_fight_kills,

    -- near ALLY tower (use precomputed flags)
    SUM(CASE
          WHEN e.kind='KILL' AND e.killer_id_i=p.participant_id AND e.ts<=ef.cutoff_ms
           AND ((p.team_id=100 AND ef.near_blue=1) OR (p.team_id=200 AND ef.near_red=1))
          THEN 1 ELSE 0 END) AS early_kills_near_ally_tower,

    SUM(CASE
          WHEN e.kind='DEATH' AND e.victim_id_i=p.participant_id AND e.ts<=ef.cutoff_ms
           AND ((p.team_id=100 AND ef.near_blue=1) OR (p.team_id=200 AND ef.near_red=1))
          THEN 1 ELSE 0 END) AS early_deaths_near_ally_tower,

    -- near ENEMY tower
    SUM(CASE
          WHEN e.kind='KILL' AND e.killer_id_i=p.participant_id AND e.ts<=ef.cutoff_ms
           AND ((p.team_id=100 AND ef.near_red=1) OR (p.team_id=200 AND ef.near_blue=1))
          THEN 1 ELSE 0 END) AS early_kills_near_enemy_tower,

    SUM(CASE
          WHEN e.kind='DEATH' AND e.victim_id_i=p.participant_id AND e.ts<=ef.cutoff_ms
           AND ((p.team_id=100 AND ef.near_red=1) OR (p.team_id=200 AND ef.near_blue=1))
          THEN 1 ELSE 0 END) AS early_overextended_deaths,

    -- early deaths by jungle gank (victim is laner, killer or any assister is JUNGLE)
    SUM(CASE
          WHEN e.kind='DEATH'
           AND e.victim_id_i = p.participant_id
           AND p.role_normalized IN ('TOP','MIDDLE','BOTTOM','UTILITY')
           AND e.ts <= ef.cutoff_ms
           AND krf.matchid IS NOT NULL
           AND krf.victim_id_i = p.participant_id
           AND (krf.killer_is_jungle = 1 OR krf.any_assist_is_jungle = 1)
          THEN 1 ELSE 0 END) AS early_deaths_by_jungle_gank,

    -- Roam KILLS (laner kills outside lane in early; exclude bot/support mirror)
    SUM(CASE
      WHEN e.kind='KILL'
       AND e.killer_id_i = p.participant_id
       AND e.ts <= ef.cutoff_ms
       AND e.evt_lane IN ('TOP','MIDDLE','BOTTOM')
       AND (
         CASE
           WHEN e.x BETWEEN  500 AND  4000 AND e.y BETWEEN 13000 AND 14500 THEN 'TOP'
           WHEN e.x BETWEEN 3500 AND 11500 AND e.y BETWEEN  3500 AND 11500 THEN 'MIDDLE'
           WHEN e.x BETWEEN 10000 AND 14500 AND e.y BETWEEN   500 AND  4000 THEN 'BOTTOM'
           ELSE 'OTHER'
         END
       ) <> p.role_normalized
       AND p.role_normalized <> 'JUNGLE'
       AND NOT (p.role_normalized IN ('BOTTOM','UTILITY') AND e.evt_lane='BOTTOM')
      THEN 1 ELSE 0 END) AS roam_kills,

    -- Roam DEATHS (non-jungler dies outside their lane region in early)
    SUM(CASE
      WHEN e.kind='DEATH'
       AND e.victim_id_i = p.participant_id
       AND p.role_normalized <> 'JUNGLE'
       AND e.ts <= ef.cutoff_ms
       AND (
         CASE p.role_normalized
           WHEN 'TOP'     THEN NOT (e.x BETWEEN  500 AND  4000 AND e.y BETWEEN 13000 AND 14500)
           WHEN 'MIDDLE'  THEN NOT (e.x BETWEEN 3500 AND 11500 AND e.y BETWEEN  3500 AND 11500)
           WHEN 'BOTTOM'  THEN NOT (e.x BETWEEN 10000 AND 14500 AND e.y BETWEEN   500 AND  4000)
           WHEN 'UTILITY' THEN NOT (e.x BETWEEN 10000 AND 14500 AND e.y BETWEEN   500 AND  4000)
           ELSE FALSE
         END
       )
      THEN 1 ELSE 0 END) AS roam_deaths

  FROM participants_base p
  JOIN typed_events e
    ON e.puuid = p.puuid AND e.matchid = p.matchid AND e.participant_id = p.participant_id
  LEFT JOIN early_flags ef
    ON ef.matchid = e.matchid AND ef.ts = e.ts
  LEFT JOIN kill_role_flags krf
    ON krf.matchid = e.matchid AND krf.ts = e.ts
  GROUP BY p.puuid, p.matchid, p.participant_id, p.team_id, p.role_normalized, p.champion_id
),

jungler_impact AS (
  SELECT
    p.puuid, p.matchid, p.participant_id, p.role_normalized,

    SUM(CASE
      WHEN e.kind='KILL'
       AND e.killer_id_i = p.participant_id
       AND p.role_normalized = 'JUNGLE'
       AND e.evt_lane IN ('TOP','MIDDLE','BOTTOM')
       AND pv.role_normalized IN ('TOP','MIDDLE','BOTTOM','UTILITY')
      THEN 1 ELSE 0 END) AS jungle_lane_kills,

    SUM(CASE
      WHEN e.kind='KILL'
       AND e.killer_id_i = p.participant_id
       AND p.role_normalized = 'JUNGLE'
       AND e.evt_lane IN ('TOP','MIDDLE','BOTTOM')
       AND e.ts <= (15*60*1000)
       AND pv.role_normalized IN ('TOP','MIDDLE','BOTTOM','UTILITY')
      THEN 1 ELSE 0 END) AS early_jungle_lane_kills,

    SUM(CASE
      WHEN e.kind='KILL'
       AND p.role_normalized = 'JUNGLE'
       AND contains(e.assists_ids_i, p.participant_id)
       AND e.evt_lane IN ('TOP','MIDDLE','BOTTOM')
       AND pv.role_normalized IN ('TOP','MIDDLE','BOTTOM','UTILITY')
      THEN 1 ELSE 0 END) AS jungle_lane_assists,

    -- laner kills with jungle presence (use precomputed flag)
    SUM(CASE
      WHEN e.kind='KILL'
       AND e.killer_id_i = p.participant_id
       AND p.role_normalized IN ('TOP','MIDDLE','BOTTOM','UTILITY')
       AND e.evt_lane IN ('TOP','MIDDLE','BOTTOM')
       AND krf.any_assist_is_jungle = 1
      THEN 1 ELSE 0 END) AS laner_kills_with_jungle

  FROM participants_base p
  JOIN typed_events e
    ON e.puuid = p.puuid AND e.matchid = p.matchid AND e.participant_id = p.participant_id
  LEFT JOIN participants_dim pv
    ON pv.matchid = e.matchid AND pv.participant_id = e.victim_id_i
  LEFT JOIN kill_role_flags krf
    ON krf.matchid = e.matchid AND krf.ts = e.ts
  GROUP BY p.puuid, p.matchid, p.participant_id, p.role_normalized
),

first_blood_calc AS (
  SELECT
    p.puuid, p.matchid, p.participant_id,
    CASE WHEN fb.participant_id IS NOT NULL THEN 1 ELSE 0 END AS first_blood_participation
  FROM participants_base p
  LEFT JOIN first_blood_members fb
    ON fb.matchid = p.matchid AND fb.participant_id = p.participant_id
),

-- -----------------------------  AGGREGATION  ----------------------------------
aggregated_stats AS (
  SELECT
    p.puuid, p.season, p.patch_major, p.role_normalized AS role,
    p.champion_id, p.champion_name,
    COUNT(DISTINCT p.matchid) AS games,

    AVG(p.kills)   AS avg_kills,
    AVG(p.deaths)  AS avg_deaths,
    AVG(p.assists) AS avg_assists,
    AVG(p.kda)     AS avg_kda,

    approx_percentile(p.kills,   0.5)  AS kills_p50,
    approx_percentile(p.kills,   0.75) AS kills_p75,
    approx_percentile(p.kills,   0.9)  AS kills_p90,
    approx_percentile(p.deaths,  0.5)  AS deaths_p50,
    approx_percentile(p.deaths,  0.75) AS deaths_p75,
    approx_percentile(p.deaths,  0.9)  AS deaths_p90,
    approx_percentile(p.assists, 0.5)  AS assists_p50,
    approx_percentile(p.assists, 0.75) AS assists_p75,
    approx_percentile(p.assists, 0.9)  AS assists_p90,

    AVG(p.dpm)                 AS avg_dpm,
    AVG(p.total_dmg_to_champs) AS avg_dmg_to_champs,
    AVG(p.team_dmg_pct)        AS avg_team_dmg_pct,
    approx_percentile(p.dpm, 0.5)  AS dpm_p50,
    approx_percentile(p.dpm, 0.75) AS dpm_p75,
    approx_percentile(p.dpm, 0.9)  AS dpm_p90,

    AVG(p.total_minions_killed + p.neutral_minions_killed) AS avg_cs_total,
    AVG(p.gold_earned) AS avg_gold_total,
    AVG(p.gpm)         AS avg_gpm,
    approx_percentile(p.total_minions_killed + p.neutral_minions_killed, 0.5) AS cs_total_p50,
    approx_percentile(p.total_minions_killed + p.neutral_minions_killed, 0.9) AS cs_total_p90,
    approx_percentile(p.gold_earned, 0.5)  AS gold_total_p50,
    approx_percentile(p.gold_earned, 0.75) AS gold_total_p75,
    approx_percentile(p.gold_earned, 0.9)  AS gold_total_p90,

    AVG(p.cs_at10)  AS avg_cs_at10,
    approx_percentile(p.cs_at10, 0.5)  AS cs_at10_p50,
    approx_percentile(p.cs_at10, 0.75) AS cs_at10_p75,
    approx_percentile(p.cs_at10, 0.9)  AS cs_at10_p90,

    AVG(p.gold_at10) AS avg_gold_at10,
    approx_percentile(p.gold_at10, 0.5)  AS gold_at10_p50,
    approx_percentile(p.gold_at10, 0.75) AS gold_at10_p75,
    approx_percentile(p.gold_at10, 0.9)  AS gold_at10_p90,

    AVG(p.cs_at15) AS avg_cs_at15,
    approx_percentile(p.cs_at15, 0.5)  AS cs_at15_p50,
    approx_percentile(p.cs_at15, 0.75) AS cs_at15_p75,
    approx_percentile(p.cs_at15, 0.9)  AS cs_at15_p90,

    AVG(p.gold_at15) AS avg_gold_at15,
    approx_percentile(p.gold_at15, 0.5)  AS gold_at15_p50,
    approx_percentile(p.gold_at15, 0.75) AS gold_at15_p75,
    approx_percentile(p.gold_at15, 0.9)  AS gold_at15_p90,

    AVG(p.cs_at20) AS avg_cs_at20,
    approx_percentile(p.cs_at20, 0.5)  AS cs_at20_p50,
    approx_percentile(p.cs_at20, 0.75) AS cs_at20_p75,
    approx_percentile(p.cs_at20, 0.9)  AS cs_at20_p90,

    AVG(p.gold_at20) AS avg_gold_at20,
    approx_percentile(p.gold_at20, 0.5)  AS gold_at20_p50,
    approx_percentile(p.gold_at20, 0.75) AS gold_at20_p75,
    approx_percentile(p.gold_at20, 0.9)  AS gold_at20_p90,

    AVG(p.xp_at10) AS avg_xp_at10,
    AVG(p.xp_at15) AS avg_xp_at15,
    AVG(p.xp_at20) AS avg_xp_at20,
    approx_percentile(p.xp_at10, 0.5) AS xp_at10_p50,
    approx_percentile(p.xp_at15, 0.5) AS xp_at15_p50,
    approx_percentile(p.xp_at20, 0.5) AS xp_at20_p50,

    AVG(p.vision_score)         AS avg_vision_score,
    AVG(p.vision_score_per_min) AS avg_vision_score_per_min,
    AVG(p.wards_placed)         AS avg_wards_placed,
    AVG(p.control_wards_placed) AS avg_control_wards,
    AVG(p.wards_killed)         AS avg_wards_killed,
    approx_percentile(p.vision_score, 0.5)  AS vision_score_p50,
    approx_percentile(p.vision_score, 0.75) AS vision_score_p75,
    approx_percentile(p.vision_score, 0.9)  AS vision_score_p90,

    AVG(COALESCE(p.objective_participation_by_type['DRAGON'], 0)) AS avg_dragon_participation,
    AVG(COALESCE(p.objective_participation_by_type['BARON'],  0)) AS avg_baron_participation,
    AVG(COALESCE(p.objective_participation_by_type['HERALD'], 0)) AS avg_herald_participation,
    AVG(COALESCE(p.objective_participation_by_type['GRUBS'],  0)) AS avg_grubs_participation,
    AVG(COALESCE(p.objective_participation_by_type['ELDER'],  0)) AS avg_elder_participation,

    AVG(COALESCE(p.objective_takedowns_by_type_norm['DRAGON'], 0)) AS avg_dragon_takedowns,
    AVG(COALESCE(p.objective_takedowns_by_type_norm['BARON'],  0)) AS avg_baron_takedowns,
    AVG(COALESCE(p.objective_takedowns_by_type_norm['HERALD'], 0)) AS avg_herald_takedowns,
    AVG(COALESCE(p.objective_takedowns_by_type_norm['GRUBS'],  0)) AS avg_grubs_takedowns,
    AVG(p.turret_takedowns) AS avg_turret_takedowns,
    AVG(p.inhib_takedowns)  AS avg_inhib_takedowns,

    AVG(eca.early_kills)                    AS avg_early_kills,
    AVG(eca.early_deaths)                   AS avg_early_deaths,
    AVG(eca.early_solo_kills)               AS avg_early_solo_kills,
    AVG(eca.early_kills_near_ally_tower)    AS avg_early_kills_near_ally_tower,
    AVG(eca.early_kills_near_enemy_tower)   AS avg_early_kills_near_enemy_tower,
    AVG(eca.early_deaths_near_ally_tower)   AS avg_early_deaths_near_ally_tower,
    AVG(eca.early_overextended_deaths)      AS avg_early_overextended_deaths,
    AVG(eca.early_deaths_by_jungle_gank)    AS avg_early_deaths_by_jungle_gank,
    AVG(eca.team_fight_kills)               AS avg_team_fight_kills,
    AVG(fb.first_blood_participation)       AS first_blood_rate,

    AVG(eca.roam_kills)                     AS avg_roam_kills,
    AVG(eca.roam_deaths)                    AS avg_roam_deaths,
    AVG(CAST(eca.roam_kills AS DOUBLE) / NULLIF(eca.roam_deaths, 0)) AS avg_roam_kd_ratio,

    AVG(ji.jungle_lane_kills)         AS avg_jungle_lane_kills,
    AVG(ji.early_jungle_lane_kills)   AS avg_early_jungle_lane_kills,
    AVG(ji.jungle_lane_assists)       AS avg_jungle_lane_assists,
    AVG(ji.laner_kills_with_jungle)   AS avg_laner_kills_with_jungle,

    AVG(p.total_time_spent_dead) AS avg_time_dead,
    AVG(CAST(p.total_time_spent_dead AS DOUBLE) / NULLIF(p.game_duration_sec, 0)) AS avg_death_time_ratio,

    AVG(CAST(p.total_minions_killed AS DOUBLE) / NULLIF(p.total_minions_killed + p.neutral_minions_killed, 0)) AS avg_lane_cs_ratio,
    AVG(CAST(p.neutral_minions_killed AS DOUBLE) / NULLIF(p.total_minions_killed + p.neutral_minions_killed, 0)) AS avg_jungle_cs_ratio,

    AVG(CAST(p.gold_earned AS DOUBLE) / NULLIF(p.total_minions_killed + p.neutral_minions_killed, 0)) AS avg_gold_per_cs,
    AVG(CAST(p.total_dmg_to_champs AS DOUBLE) / NULLIF(p.gold_earned, 0)) AS avg_dmg_per_gold,

    AVG(CAST(p.kills + p.assists AS DOUBLE) / GREATEST(20, p.kills + p.assists)) AS avg_kill_participation_est,

    AVG(CASE WHEN COALESCE(p.team_objective_totals_by_type['DRAGON'], 0) > 2
               OR COALESCE(p.team_objective_totals_by_type['BARON'], 0) > 0
             THEN 0.65 ELSE 0.35 END) AS win_rate_estimate

  FROM participants_base p
  LEFT JOIN early_combat_analysis eca
    ON p.puuid = eca.puuid AND p.matchid = eca.matchid AND p.participant_id = eca.participant_id
  LEFT JOIN jungler_impact ji
    ON p.puuid = ji.puuid  AND p.matchid = ji.matchid  AND p.participant_id = ji.participant_id
  LEFT JOIN first_blood_calc fb
    ON p.puuid = fb.puuid  AND p.matchid = fb.matchid  AND p.participant_id = fb.participant_id
  GROUP BY p.puuid, p.season, p.patch_major, p.role_normalized, p.champion_id, p.champion_name
  HAVING COUNT(DISTINCT p.matchid) >= 3
)

SELECT
  puuid,
  season,
  patch_major,
  role,
  champion_id,
  champion_name,
  games,

  -- Core KDA stats
  ROUND(avg_kills,   2) AS avg_kills,
  ROUND(avg_deaths,  2) AS avg_deaths,
  ROUND(avg_assists, 2) AS avg_assists,
  ROUND(avg_kda,     2) AS avg_kda,
  kills_p50, kills_p75, kills_p90,
  deaths_p50, deaths_p75, deaths_p90,
  assists_p50, assists_p75, assists_p90,

  -- Damage
  ROUND(avg_dpm, 1)               AS avg_dpm,
  ROUND(avg_dmg_to_champs, 0)     AS avg_dmg_to_champs,
  ROUND(avg_team_dmg_pct * 100,1) AS avg_team_dmg_pct,
  dpm_p50, dpm_p75, dpm_p90,

  -- CS & Gold (overall)
  ROUND(avg_cs_total,  1) AS avg_cs_total,
  ROUND(avg_gold_total,0) AS avg_gold_total,
  ROUND(avg_gpm,       1) AS avg_gpm,
  cs_total_p50, cs_total_p90,
  gold_total_p50, gold_total_p75, gold_total_p90,

  -- Time-based CS
  ROUND(avg_cs_at10, 1) AS avg_cs_at10, cs_at10_p50, cs_at10_p75, cs_at10_p90,
  ROUND(avg_cs_at15, 1) AS avg_cs_at15, cs_at15_p50, cs_at15_p75, cs_at15_p90,
  ROUND(avg_cs_at20, 1) AS avg_cs_at20, cs_at20_p50, cs_at20_p75, cs_at20_p90,

  -- Time-based Gold
  ROUND(avg_gold_at10, 0) AS avg_gold_at10, gold_at10_p50, gold_at10_p75, gold_at10_p90,
  ROUND(avg_gold_at15, 0) AS avg_gold_at15, gold_at15_p50, gold_at15_p75, gold_at15_p90,
  ROUND(avg_gold_at20, 0) AS avg_gold_at20, gold_at20_p50, gold_at20_p75, gold_at20_p90,

  -- XP
  ROUND(avg_xp_at10, 0) AS avg_xp_at10,
  ROUND(avg_xp_at15, 0) AS avg_xp_at15,
  ROUND(avg_xp_at20, 0) AS avg_xp_at20,
  xp_at10_p50, xp_at15_p50, xp_at20_p50,

  -- Vision
  ROUND(avg_vision_score,         1) AS avg_vision_score,
  ROUND(avg_vision_score_per_min, 2) AS avg_vision_score_per_min,
  ROUND(avg_wards_placed,         1) AS avg_wards_placed,
  ROUND(avg_control_wards,        1) AS avg_control_wards,
  ROUND(avg_wards_killed,         1) AS avg_wards_killed,
  vision_score_p50, vision_score_p75, vision_score_p90,

  -- Objective participation
  ROUND(avg_dragon_participation, 3) AS avg_dragon_participation,
  ROUND(avg_baron_participation,  3) AS avg_baron_participation,
  ROUND(avg_herald_participation, 3) AS avg_herald_participation,
  ROUND(avg_grubs_participation,  3) AS avg_grubs_participation,
  ROUND(avg_elder_participation,  3) AS avg_elder_participation,

  -- Objective takedowns
  ROUND(avg_dragon_takedowns, 2) AS avg_dragon_takedowns,
  ROUND(avg_baron_takedowns,  2) AS avg_baron_takedowns,
  ROUND(avg_herald_takedowns, 2) AS avg_herald_takedowns,
  ROUND(avg_grubs_takedowns,  2) AS avg_grubs_takedowns,
  ROUND(avg_turret_takedowns, 2) AS avg_turret_takedowns,
  ROUND(avg_inhib_takedowns,  2) AS avg_inhib_takedowns,

  -- Early combat
  ROUND(avg_early_kills,                 2) AS avg_early_kills,
  ROUND(avg_early_deaths,                2) AS avg_early_deaths,
  ROUND(avg_early_solo_kills,            2) AS avg_early_solo_kills,
  ROUND(avg_early_kills_near_ally_tower, 2) AS avg_early_kills_near_ally_tower,
  ROUND(avg_early_kills_near_enemy_tower,2) AS avg_early_kills_near_enemy_tower,
  ROUND(avg_early_deaths_near_ally_tower,2) AS avg_early_deaths_near_ally_tower,
  ROUND(avg_early_overextended_deaths,   2) AS avg_early_overextended_deaths,
  ROUND(avg_early_deaths_by_jungle_gank, 2) AS avg_early_deaths_by_jungle_gank,

  -- Roaming (laner)
  ROUND(avg_roam_kills,  2) AS avg_roam_kills,
  ROUND(avg_roam_deaths, 2) AS avg_roam_deaths,
  ROUND(avg_roam_kd_ratio, 2) AS avg_roam_kd_ratio,

  -- Jungler lane impact
  ROUND(avg_jungle_lane_kills,        2) AS avg_jungle_lane_kills,
  ROUND(avg_early_jungle_lane_kills,  2) AS avg_early_jungle_lane_kills,
  ROUND(avg_jungle_lane_assists,      2) AS avg_jungle_lane_assists,
  ROUND(avg_laner_kills_with_jungle,  2) AS avg_laner_kills_with_jungle,

  -- Extended
  ROUND(avg_time_dead, 0)              AS avg_time_dead_seconds,
  ROUND(avg_death_time_ratio * 100, 2) AS avg_death_time_pct,
  ROUND(avg_team_fight_kills, 2)       AS avg_team_fight_kills,

  -- First blood
  ROUND(first_blood_rate * 100, 1)     AS first_blood_rate_pct,

  -- Efficiency
  ROUND(avg_lane_cs_ratio * 100, 1) AS lane_cs_ratio_pct,
  ROUND(avg_jungle_cs_ratio * 100, 1) AS jungle_cs_ratio_pct,
  ROUND(avg_gold_per_cs, 1)         AS avg_gold_per_cs,
  ROUND(avg_dmg_per_gold, 2)        AS dmg_efficiency_per_gold,
  ROUND(avg_kill_participation_est * 100, 1) AS kill_participation_pct_est,

  -- Win rate proxy
  ROUND(win_rate_estimate * 100, 1) AS win_rate_pct_estimate

FROM aggregated_stats
WHERE role IN ('TOP','JUNGLE','MIDDLE','BOTTOM','UTILITY')
ORDER BY puuid, season DESC, patch_major DESC, role, champion_id;
