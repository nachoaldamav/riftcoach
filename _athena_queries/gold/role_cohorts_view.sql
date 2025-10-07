CREATE OR REPLACE VIEW rift_gold.v_cohort_role_stats AS
WITH p AS (
  SELECT
    season,
    patch_major,
    queue,
    CASE
      WHEN team_position IS NOT NULL AND team_position <> 'NONE' THEN team_position
      WHEN role IS NOT NULL AND role <> 'NONE' THEN role
      WHEN individual_position IS NOT NULL AND individual_position <> 'NONE' THEN individual_position
      ELSE COALESCE(lane, 'UNKNOWN')
    END AS role,
    matchid,
    puuid,

    -- duration & minutes (meta is a ROW)
    CAST(meta.game_duration_sec AS double) AS game_duration_sec,
    GREATEST(CAST(meta.game_duration_sec AS double), 1.0) / 60.0 AS game_minutes,

    -- combat
    kills, deaths, assists,
    (kills + assists) / NULLIF(deaths, 0) AS kda_per_game,
    dpm,
    total_dmg_to_champs,
    team_dmg_pct,
    total_dmg_dealt,
    total_dmg_taken,

    -- economy & cs
    gold_earned,
    gpm,
    total_minions_killed,
    neutral_minions_killed,
    total_minions_killed
      / NULLIF(GREATEST(CAST(meta.game_duration_sec AS double), 1.0) / 60.0, 0.0) AS cs_per_min,

    -- laning
    cs_at10, gold_at10, xp_at10, level_at10,
    cs_at20, gold_at20, xp_at20, level_at20,

    -- vision
    vision_score,
    TRY_CAST(vision_score_per_min AS double) AS vision_score_per_min,
    wards_placed,
    wards_killed,
    control_wards_placed,
    (wards_placed * 10.0)
      / NULLIF(GREATEST(CAST(meta.game_duration_sec AS double), 1.0) / 60.0, 0.0) AS wards_placed_per10,
    (wards_killed * 10.0)
      / NULLIF(GREATEST(CAST(meta.game_duration_sec AS double), 1.0) / 60.0, 0.0) AS wards_killed_per10,

    -- objective participation (map<varchar,bigint>)
    CAST(COALESCE(element_at(objective_takedowns_by_type,'BARON'), 0) AS double)    AS part_baron,
    CAST(COALESCE(element_at(objective_takedowns_by_type,'HERALD'), 0) AS double)   AS part_herald,
    CAST(COALESCE(element_at(objective_takedowns_by_type,'ATAKHAN'), 0) AS double)  AS part_atakhan,
    CAST(COALESCE(element_at(objective_takedowns_by_type,'HORDE'), 0) AS double)    AS part_grubs,
    CAST(COALESCE(
           element_at(objective_takedowns_by_type,'ELDER'),
           element_at(objective_takedowns_by_type,'ELDER_DRAGON'), 0) AS double)    AS part_elder,
    CAST(COALESCE(element_at(objective_takedowns_by_type,'AIR_DRAGON'),     0) AS double) AS part_air,
    CAST(COALESCE(element_at(objective_takedowns_by_type,'WATER_DRAGON'),   0) AS double) AS part_water,
    CAST(COALESCE(element_at(objective_takedowns_by_type,'FIRE_DRAGON'),    0) AS double) AS part_fire,
    CAST(COALESCE(element_at(objective_takedowns_by_type,'EARTH_DRAGON'),   0) AS double) AS part_earth,
    CAST(COALESCE(element_at(objective_takedowns_by_type,'HEXTECH_DRAGON'), 0) AS double) AS part_hextech,
    CAST(COALESCE(element_at(objective_takedowns_by_type,'CHEMTECH_DRAGON'),0) AS double) AS part_chemtech,

    -- personal last-hits
    TRY_CAST(dragon_kills_personal AS double)      AS dragons_personal,
    TRY_CAST(baron_kills_personal  AS double)      AS barons_personal,
    TRY_CAST(rift_herald_kills_personal AS double) AS heralds_personal,

    -- structures
    turret_takedowns,
    inhib_takedowns,

    -- outcomes & misc (derive from participant_json varchar)
    CASE
      WHEN COALESCE(TRY_CAST(json_extract_scalar(participant_json,'$.win') AS boolean), false)
      THEN 1.0 ELSE 0.0
    END AS win_f,
    CASE
      WHEN COALESCE(TRY_CAST(json_extract_scalar(participant_json,'$.firstBloodKill')  AS boolean), false)
        OR COALESCE(TRY_CAST(json_extract_scalar(participant_json,'$.firstBloodAssist') AS boolean), false)
      THEN 1.0 ELSE 0.0
    END AS fb_involved_f,
    TRY_CAST(json_extract_scalar(participant_json,'$.soloKills')            AS double) AS solo_kills,
    TRY_CAST(json_extract_scalar(participant_json,'$.doubleKills')          AS double) AS double_kills,
    TRY_CAST(json_extract_scalar(participant_json,'$.tripleKills')          AS double) AS triple_kills,
    TRY_CAST(json_extract_scalar(participant_json,'$.quadraKills')          AS double) AS quadra_kills,
    TRY_CAST(json_extract_scalar(participant_json,'$.pentaKills')           AS double) AS penta_kills,
    TRY_CAST(json_extract_scalar(participant_json,'$.largestKillingSpree')  AS double) AS largest_killing_spree
  FROM rift_silver.participants_wide_v4
)

SELECT
  season,
  patch_major,
  queue,
  role,

  COUNT(*)                                   AS games,
  COUNT(DISTINCT puuid)                      AS unique_players,
  COUNT(DISTINCT matchid)                    AS distinct_matches,

  AVG(game_minutes)                          AS avg_game_minutes,

  AVG(kills)                                 AS avg_kills,
  AVG(deaths)                                AS avg_deaths,
  AVG(assists)                               AS avg_assists,
  AVG(kda_per_game)                          AS kda_ratio,
  approx_percentile(kda_per_game, 0.5)       AS p50_kda,

  AVG(dpm)                                   AS avg_dpm,
  approx_percentile(dpm, ARRAY[0.05,0.25,0.5,0.75,0.95]) AS dpm_percentiles,
  AVG(team_dmg_pct)                          AS avg_team_dmg_pct,
  AVG(total_dmg_taken)                       AS avg_dmg_taken,

  AVG(gpm)                                   AS avg_gpm,
  approx_percentile(gpm, ARRAY[0.05,0.25,0.5,0.75,0.95]) AS gpm_percentiles,

  AVG(total_minions_killed)                  AS avg_cs,
  AVG(neutral_minions_killed)                AS avg_jungle_cs,
  AVG(cs_per_min)                            AS avg_cs_per_min,

  AVG(cs_at10)                               AS avg_cs_at10,
  approx_percentile(cs_at10, 0.5)            AS p50_cs_at10,
  AVG(cs_at20)                               AS avg_cs_at20,
  approx_percentile(cs_at20, 0.5)            AS p50_cs_at20,

  AVG(gold_at10)                             AS avg_gold_at10,
  AVG(gold_at20)                             AS avg_gold_at20,
  AVG(xp_at10)                               AS avg_xp_at10,
  AVG(xp_at20)                               AS avg_xp_at20,
  AVG(level_at10)                            AS avg_level_at10,
  AVG(level_at20)                            AS avg_level_at20,

  AVG(vision_score)                          AS avg_vision_score,
  AVG(vision_score_per_min)                  AS avg_vision_score_per_min,
  AVG(wards_placed)                          AS avg_wards_placed,
  AVG(wards_killed)                          AS avg_wards_killed,
  AVG(control_wards_placed)                  AS avg_control_wards_placed,
  AVG(wards_placed_per10)                    AS wards_placed_per10,
  AVG(wards_killed_per10)                    AS wards_killed_per10,

  -- personal last-hits
  AVG(COALESCE(dragons_personal,0.0))        AS avg_dragons_personal,
  AVG(COALESCE(barons_personal,0.0))         AS avg_barons_personal,
  AVG(COALESCE(heralds_personal,0.0))        AS avg_heralds_personal,

  -- participation (API names)
  AVG(part_baron)                            AS avg_participation_baron,
  AVG(part_herald)                           AS avg_participation_herald,
  AVG(part_elder)                            AS avg_participation_elder,
  AVG(part_grubs)                            AS avg_participation_grubs,
  AVG(part_atakhan)                          AS avg_participation_athakan,
  AVG(part_air + part_water + part_fire + part_earth + part_hextech + part_chemtech)
                                             AS avg_participation_dragons,

  -- structures
  AVG(turret_takedowns)                      AS avg_turret_takedowns,
  AVG(inhib_takedowns)                       AS avg_inhib_takedowns,

  -- outcomes & extras
  AVG(win_f)                                 AS win_rate,
  AVG(fb_involved_f)                         AS first_blood_involvement_rate,
  AVG(COALESCE(solo_kills,0.0))              AS avg_solo_kills,
  AVG(COALESCE(double_kills,0.0))            AS avg_double_kills,
  AVG(COALESCE(triple_kills,0.0))            AS avg_triple_kills,
  AVG(COALESCE(quadra_kills,0.0))            AS avg_quadra_kills,
  AVG(COALESCE(penta_kills,0.0))             AS avg_penta_kills,
  MAX(largest_killing_spree)                 AS max_largest_killing_spree

FROM p
GROUP BY 1,2,3,4;
