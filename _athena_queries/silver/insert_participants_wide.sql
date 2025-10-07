INSERT INTO rift_silver.participants_wide_v7
WITH
-- =========================
-- Edit only this block 👇
-- =========================
cfg AS (
  SELECT
    CAST(2025 AS integer)          AS season,      -- <== change once
    CAST('15.%' AS varchar)        AS patch_like,  -- e.g. '15.%' or '15.19'
    CAST('PUUID_HERE' AS varchar)  AS puuid        -- target player PUUID
),

-- --------------------------
-- Matches (partition-pruned + dedup by $path)
-- --------------------------
matches_dedup AS (
  SELECT *
  FROM (
    SELECT
      COALESCE(json_extract_scalar(raw,'$.matchId'),
               json_extract_scalar(raw,'$.metadata.matchId')) AS matchid,
      CAST(json_extract_scalar(raw,'$.season') AS integer) AS season_val,
      json_extract_scalar(raw,'$.patch') AS patch_full,
      split_part(json_extract_scalar(raw,'$.patch'),'.',1) || '.' ||
      split_part(json_extract_scalar(raw,'$.patch'),'.',2) AS patch_major,
      CAST(json_extract_scalar(raw,'$.queue') AS integer) AS queue,
      CAST(json_extract_scalar(raw,'$.info.gameDuration') AS integer)      AS game_duration_sec,
      CAST(json_extract_scalar(raw,'$.info.gameStartTimestamp') AS bigint) AS game_start_ts,
      CAST(json_extract_scalar(raw,'$.info.gameEndTimestamp')   AS bigint) AS game_end_ts,
      json_extract(raw,'$.info.participants') AS participants_json,
      raw AS match_raw,
      "$path" AS src_path,
      row_number() OVER (
        PARTITION BY COALESCE(json_extract_scalar(raw,'$.matchId'),
                              json_extract_scalar(raw,'$.metadata.matchId'))
        ORDER BY "$path" DESC
      ) AS rn
    FROM rift_raw.matches_json
    WHERE season = (SELECT season FROM cfg)                 -- partition pruning
      AND patch  LIKE (SELECT patch_like FROM cfg)          -- partition pruning
    -- AND queue IN (420,440)  -- optional extra pruning if helpful
  )
  WHERE rn = 1
),

-- --------------------------
-- Timelines (partition-pruned + dedup by $path)
-- --------------------------
timelines_dedup AS (
  SELECT *
  FROM (
    SELECT
      COALESCE(json_extract_scalar(raw,'$.matchId'),
               json_extract_scalar(raw,'$.metadata.matchId')) AS matchid,
      json_extract(raw,'$.frames') AS frames_json,
      raw AS timeline_raw,
      "$path" AS src_path,
      row_number() OVER (
        PARTITION BY COALESCE(json_extract_scalar(raw,'$.matchId'),
                              json_extract_scalar(raw,'$.metadata.matchId'))
        ORDER BY "$path" DESC
      ) AS rn
    FROM rift_raw.timelines_json
    WHERE season = (SELECT season FROM cfg)                 -- partition pruning
      AND patch  LIKE (SELECT patch_like FROM cfg)          -- partition pruning
  )
  WHERE rn = 1
),

-- --------------------------
-- Explode only THIS player's rows (filter in the UNNEST)
-- --------------------------
participants AS (
  SELECT
    m.matchid,
    (SELECT season FROM cfg)                     AS season,
    m.patch_major,
    m.patch_full,
    m.queue,
    m.game_duration_sec,
    m.game_start_ts,
    m.game_end_ts,
    CAST(pj AS JSON) AS p_json
  FROM matches_dedup m
  CROSS JOIN UNNEST(CAST(m.participants_json AS ARRAY(JSON))) AS t(pj)
  WHERE json_extract_scalar(pj,'$.puuid') = (SELECT puuid FROM cfg)
),

-- --------------------------
-- Frames from JUST the player's matches
-- --------------------------
frames AS (
  SELECT
    t.matchid,
    CAST(f AS JSON) AS f_json,
    CAST(json_extract_scalar(f,'$.timestamp') AS bigint) AS ts
  FROM timelines_dedup t
  JOIN (SELECT DISTINCT matchid FROM participants) u ON u.matchid = t.matchid
  CROSS JOIN UNNEST(CAST(t.frames_json AS ARRAY(JSON))) AS u2(f)
),

participant_frames AS (
  SELECT
    f.matchid,
    CAST(json_extract_scalar(pf,'$.participantId') AS integer) AS participant_id,
    f.ts,
    CAST(json_extract_scalar(pf,'$.minionsKilled') AS integer)           AS lane_minions,
    CAST(json_extract_scalar(pf,'$.jungleMinionsKilled') AS integer)     AS jungle_minions,
    CAST(json_extract_scalar(pf,'$.totalGold') AS integer)               AS total_gold,
    CAST(json_extract_scalar(pf,'$.xp') AS integer)                      AS xp,
    CAST(json_extract(pf,'$.position') AS JSON)                          AS position_json,
    CAST(json_extract_scalar(pf,'$.level') AS integer)                   AS level,
    CAST(json_extract(pf,'$.championStats') AS JSON)                     AS champ_stats_json,
    CAST(json_extract(pf,'$.damageStats') AS JSON)                       AS damage_stats_json
  FROM frames f
  CROSS JOIN UNNEST(
    MAP_VALUES(CAST(json_extract(f.f_json,'$.participantFrames') AS MAP(VARCHAR, JSON)))
  ) AS t(pf)
),

-- Snapshots (10/20)
snapshots AS (
  SELECT
    matchid,
    participant_id,
    max_by(lane_minions + jungle_minions, ts) FILTER (WHERE ts <= 10*60*1000) AS cs_at10,
    max_by(total_gold, ts)                     FILTER (WHERE ts <= 10*60*1000) AS gold_at10,
    max_by(xp, ts)                             FILTER (WHERE ts <= 10*60*1000) AS xp_at10,
    max_by(level, ts)                          FILTER (WHERE ts <= 10*60*1000) AS level_at10,
    max_by(lane_minions + jungle_minions, ts) FILTER (WHERE ts <= 20*60*1000) AS cs_at20,
    max_by(total_gold, ts)                     FILTER (WHERE ts <= 20*60*1000) AS gold_at20,
    max_by(xp, ts)                             FILTER (WHERE ts <= 20*60*1000) AS xp_at20,
    max_by(level, ts)                          FILTER (WHERE ts <= 20*60*1000) AS level_at20
  FROM participant_frames
  GROUP BY 1,2
),

-- Events
events AS (
  SELECT
    fr.matchid,
    CAST(json_extract_scalar(e,'$.type') AS varchar)         AS type,
    CAST(json_extract_scalar(e,'$.timestamp') AS bigint)     AS ts,
    CAST(json_extract(e,'$.position') AS JSON)               AS pos,
    CAST(json_extract_scalar(e,'$.killerId') AS integer)     AS killer_id,
    CAST(json_extract_scalar(e,'$.victimId') AS integer)     AS victim_id,
    CAST(json_extract(e,'$.assistingParticipantIds') AS ARRAY(INTEGER)) AS assists_ids,
    CAST(json_extract_scalar(e,'$.itemId') AS integer)       AS item_id,
    CAST(json_extract_scalar(e,'$.wardType') AS varchar)     AS ward_type,
    CAST(json_extract_scalar(e,'$.creatorId') AS integer)    AS ward_creator_id,
    CAST(json_extract_scalar(e,'$.monsterSubType') AS varchar) AS monster_subtype,
    CAST(json_extract_scalar(e,'$.monsterType') AS varchar)  AS monster_type,
    CAST(json_extract_scalar(e,'$.buildingType') AS varchar) AS building_type,
    CAST(json_extract_scalar(e,'$.towerType') AS varchar)    AS tower_type,
    CAST(json_extract_scalar(e,'$.teamId') AS integer)       AS team_id,
    CAST(json_extract_scalar(e,'$.participantId') AS integer) AS participant_id
  FROM frames fr
  CROSS JOIN UNNEST(CAST(json_extract(fr.f_json,'$.events') AS ARRAY(JSON))) AS t(e)
),

-- Ward/objective tallies
ward_events AS (
  SELECT matchid, ward_creator_id AS participant_id, ward_type, count(*) AS wards_placed_by_type
  FROM events
  WHERE type = 'WARD_PLACED' AND ward_creator_id BETWEEN 1 AND 10
  GROUP BY 1,2,3
),
ward_destroys AS (
  SELECT matchid, killer_id AS participant_id, ward_type, count(*) AS wards_destroyed_by_type
  FROM events
  WHERE type = 'WARD_KILL' AND killer_id BETWEEN 1 AND 10
  GROUP BY 1,2,3
),
item_events AS (
  SELECT matchid, participant_id, type, ts, item_id
  FROM events
  WHERE type IN ('ITEM_PURCHASED','ITEM_SOLD','ITEM_DESTROYED','ITEM_UNDO')
    AND participant_id BETWEEN 1 AND 10
),
kill_events AS (
  SELECT matchid, ts, killer_id, victim_id, assists_ids, pos
  FROM events
  WHERE type = 'CHAMPION_KILL'
),
objective_events AS (
  SELECT matchid, ts, monster_type, monster_subtype, killer_id, assists_ids
  FROM events
  WHERE type = 'ELITE_MONSTER_KILL'
),

-- Normalize objective kinds
objective_events_norm AS (
  SELECT
    matchid,
    ts,
    killer_id,
    assists_ids,
    CASE
      WHEN monster_type = 'DRAGON' AND monster_subtype = 'ELDER_DRAGON' THEN 'ELDER'
      WHEN monster_type = 'DRAGON' THEN 'DRAGON'
      WHEN monster_type = 'RIFTHERALD' THEN 'HERALD'
      WHEN monster_type = 'BARON_NASHOR' THEN 'BARON'
      WHEN monster_subtype = 'HORDE' THEN 'GRUBS'
      WHEN monster_subtype = 'ATAKHAN' THEN 'ATAKHAN'
      ELSE COALESCE(monster_type, monster_subtype, 'OTHER')
    END AS obj_norm
  FROM objective_events
),

-- Participant -> team lookup
team_lookup AS (
  SELECT
    matchid,
    CAST(json_extract_scalar(p_json,'$.participantId') AS integer) AS participant_id,
    CAST(json_extract_scalar(p_json,'$.teamId') AS integer) AS team_id
  FROM participants
),

objective_participation AS (
  SELECT matchid, obj_kind, participant_id, count(DISTINCT ts) AS takedowns
  FROM (
    SELECT
      o.matchid,
      o.ts,
      CASE
        WHEN monster_type = 'DRAGON' THEN COALESCE(monster_subtype,'DRAGON')
        WHEN monster_type = 'RIFTHERALD' THEN 'HERALD'
        WHEN monster_type = 'BARON_NASHOR' THEN 'BARON'
        WHEN monster_type = 'ELDER_DRAGON' THEN 'ELDER'
        WHEN monster_subtype = 'HORDE' THEN 'GRUBS'
        WHEN monster_subtype = 'ATAKHAN' THEN 'ATAKHAN'
        ELSE COALESCE(monster_type, monster_subtype, 'OTHER')
      END AS obj_kind,
      p AS participant_id
    FROM objective_events o
    CROSS JOIN UNNEST(ARRAY[o.killer_id]) AS t(p)
    WHERE p BETWEEN 1 AND 10
    UNION ALL
    SELECT
      o.matchid,
      o.ts,
      CASE
        WHEN monster_type = 'DRAGON' THEN COALESCE(monster_subtype,'DRAGON')
        WHEN monster_type = 'RIFTHERALD' THEN 'HERALD'
        WHEN monster_type = 'BARON_NASHOR' THEN 'BARON'
        WHEN monster_type = 'ELDER_DRAGON' THEN 'ELDER'
        WHEN monster_subtype = 'HORDE' THEN 'GRUBS'
        WHEN monster_subtype = 'ATAKHAN' THEN 'ATAKHAN'
        ELSE COALESCE(monster_type, monster_subtype, 'OTHER')
      END AS obj_kind,
      a AS participant_id
    FROM objective_events o
    CROSS JOIN UNNEST(o.assists_ids) AS t(a)
    LEFT JOIN team_lookup killer_team ON o.matchid = killer_team.matchid AND o.killer_id = killer_team.participant_id
    LEFT JOIN team_lookup assist_team ON o.matchid = assist_team.matchid AND a = assist_team.participant_id
    WHERE a BETWEEN 1 AND 10 
      AND killer_team.team_id = assist_team.team_id  -- Only count assists from same team as killer
  ) x
  GROUP BY 1,2,3
),

-- Normalized per-participant takedowns (DRAGON collapsed, ELDER separate)
objective_participation_norm AS (
  SELECT matchid, obj_norm, participant_id, count(DISTINCT ts) AS takedowns_norm
  FROM (
    SELECT e.matchid, e.ts, e.obj_norm, e.killer_id AS participant_id
    FROM objective_events_norm e
    WHERE e.killer_id BETWEEN 1 AND 10
    UNION ALL
    SELECT e.matchid, e.ts, e.obj_norm, a AS participant_id
    FROM objective_events_norm e
    CROSS JOIN UNNEST(e.assists_ids) AS t(a)
    LEFT JOIN team_lookup killer_team ON e.matchid = killer_team.matchid AND e.killer_id = killer_team.participant_id
    LEFT JOIN team_lookup assist_team ON e.matchid = assist_team.matchid AND a = assist_team.participant_id
    WHERE a BETWEEN 1 AND 10 
      AND killer_team.team_id = assist_team.team_id  -- Only count assists from same team as killer
  ) u
  GROUP BY 1,2,3
),

-- Maps & arrays
ward_maps AS (
  SELECT matchid, participant_id, map_agg(ward_type, wards_placed_by_type) AS wards_placed_map
  FROM ward_events
  GROUP BY 1,2
),
ward_destroy_maps AS (
  SELECT matchid, participant_id, map_agg(ward_type, wards_destroyed_by_type) AS wards_destroyed_map
  FROM ward_destroys
  GROUP BY 1,2
),
objective_maps AS (
  SELECT matchid, participant_id, map_agg(obj_kind, takedowns) AS objective_takedowns_map
  FROM objective_participation
  GROUP BY 1,2
),
objective_maps_norm AS (
  SELECT matchid, participant_id, map_agg(obj_norm, takedowns_norm) AS objective_takedowns_norm_map
  FROM objective_participation_norm
  GROUP BY 1,2
),

-- Infer team for each objective event (killer team first, else first-assist team)
objective_events_norm_with_team AS (
  SELECT
    e.matchid,
    e.ts,
    e.obj_norm,
    COALESCE(tk.team_id, ta.team_id) AS team_id
  FROM objective_events_norm e
  LEFT JOIN team_lookup tk
    ON e.matchid = tk.matchid AND e.killer_id BETWEEN 1 AND 10 AND e.killer_id = tk.participant_id
  LEFT JOIN team_lookup ta
    ON e.matchid = ta.matchid
   AND CARDINALITY(e.assists_ids) > 0
   AND element_at(e.assists_ids, 1) = ta.participant_id
),

-- Team totals per normalized objective kind (count distinct events)
team_objective_totals_norm AS (
  SELECT matchid, team_id, obj_norm, count(DISTINCT ts) AS team_total
  FROM objective_events_norm_with_team
  WHERE team_id IS NOT NULL
  GROUP BY 1,2,3
),
team_objective_totals_map AS (
  SELECT matchid, team_id, map_agg(obj_norm, team_total) AS team_objective_totals_map
  FROM team_objective_totals_norm
  GROUP BY 1,2
),
positions_ts AS (
  SELECT
    pf.matchid,
    pf.participant_id,
    ARRAY_AGG(
      CAST(ROW(
        ts,
        CAST(json_extract_scalar(position_json,'$.x') AS integer),
        CAST(json_extract_scalar(position_json,'$.y') AS integer)
      ) AS ROW(ts bigint, x integer, y integer))
      ORDER BY ts
    ) AS positions
  FROM participant_frames pf
  WHERE position_json IS NOT NULL
  GROUP BY 1,2
),
item_ts AS (
  SELECT
    ie.matchid,
    ie.participant_id,
    ARRAY_AGG(CAST(ROW(ts, type, item_id) AS ROW(ts bigint, type varchar, item_id integer)) ORDER BY ts) AS item_events
  FROM item_events ie
  WHERE participant_id BETWEEN 1 AND 10
  GROUP BY 1,2
),
kills_ts AS (
  SELECT
    k.matchid,
    p_id AS participant_id,
    ARRAY_AGG(
      CAST(ROW(
        ts,
        CAST(json_extract_scalar(pos,'$.x') AS integer),
        CAST(json_extract_scalar(pos,'$.y') AS integer),
        kind,
        killer_id,
        victim_id,
        CARDINALITY(assists_ids),
        assists_ids
      ) AS ROW(
        ts bigint,
        x integer,
        y integer,
        kind varchar,
        killer_id integer,
        victim_id integer,
        assists_count integer,
        assists_ids ARRAY(integer)
      ))
      ORDER BY ts
    ) AS combat_events
  FROM (
    SELECT matchid, ts, pos, killer_id, victim_id, assists_ids, killer_id AS p_id, 'KILL'  AS kind FROM kill_events
    UNION ALL
    SELECT matchid, ts, pos, killer_id, victim_id, assists_ids, victim_id AS p_id, 'DEATH' AS kind FROM kill_events
  ) k
  WHERE p_id BETWEEN 1 AND 10
  GROUP BY 1,2
),

-- Base columns (already filtered to the PUUID)
p_base AS (
  SELECT
    matchid,
    season,
    patch_major,
    patch_full,
    queue,
    game_duration_sec,
    game_start_ts,
    game_end_ts,
    CAST(json_extract_scalar(p_json,'$.participantId') AS integer) AS participant_id,
    json_extract_scalar(p_json,'$.puuid') AS puuid,
    CAST(json_extract_scalar(p_json,'$.teamId') AS integer) AS team_id,
    json_extract_scalar(p_json,'$.teamPosition') AS team_position,
    COALESCE(NULLIF(json_extract_scalar(p_json,'$.individualPosition'), ''),
             json_extract_scalar(p_json,'$.teamPosition'))   AS individual_position,
    json_extract_scalar(p_json,'$.lane') AS lane,
    json_extract_scalar(p_json,'$.role') AS role,
    CAST(json_extract_scalar(p_json,'$.championId') AS integer) AS champion_id,
    json_extract_scalar(p_json,'$.championName') AS champion_name,
    CAST(json_extract_scalar(p_json,'$.champLevel') AS integer) AS final_champ_level,
    CAST(json_extract_scalar(p_json,'$.profileIcon') AS integer) AS profile_icon,
    json_extract_scalar(p_json,'$.summonerName') AS summoner_name,
    json_extract_scalar(p_json,'$.summonerId')   AS summoner_id,
    CAST(json_extract_scalar(p_json,'$.summoner1Id') AS integer) AS summoner_d,
    CAST(json_extract_scalar(p_json,'$.summoner2Id') AS integer) AS summoner_f,
    CAST(json_extract_scalar(p_json,'$.spell1Casts') AS integer) AS spell1_casts,
    CAST(json_extract_scalar(p_json,'$.spell2Casts') AS integer) AS spell2_casts,
    CAST(json_extract_scalar(p_json,'$.spell3Casts') AS integer) AS spell3_casts,
    CAST(json_extract_scalar(p_json,'$.spell4Casts') AS integer) AS spell4_casts,
    CAST(json_extract_scalar(p_json,'$.kills')   AS integer) AS kills,
    CAST(json_extract_scalar(p_json,'$.deaths')  AS integer) AS deaths,
    CAST(json_extract_scalar(p_json,'$.assists') AS integer) AS assists,
    CAST(json_extract_scalar(p_json,'$.challenges.damagePerMinute') AS double)   AS dpm,
    CAST(json_extract_scalar(p_json,'$.totalDamageDealtToChampions') AS integer) AS total_dmg_to_champs,
    CAST(json_extract_scalar(p_json,'$.challenges.teamDamagePercentage') AS double) AS team_dmg_pct,
    CAST(json_extract_scalar(p_json,'$.totalDamageDealt')  AS integer) AS total_dmg_dealt,
    CAST(json_extract_scalar(p_json,'$.totalDamageTaken')  AS integer) AS total_dmg_taken,
    CAST(json_extract_scalar(p_json,'$.goldEarned') AS integer)        AS gold_earned,
    CAST(json_extract_scalar(p_json,'$.challenges.goldPerMinute') AS double) AS gpm,
    CAST(json_extract_scalar(p_json,'$.totalMinionsKilled')   AS integer) AS total_minions_killed,
    CAST(json_extract_scalar(p_json,'$.neutralMinionsKilled') AS integer) AS neutral_minions_killed,
    CAST(json_extract_scalar(p_json,'$.totalTimeSpentDead')   AS integer) AS total_time_spent_dead,
    CAST(json_extract_scalar(p_json,'$.visionScore') AS double) AS vision_score,
    CAST(json_extract_scalar(p_json,'$.wardsPlaced') AS integer) AS wards_placed,
    CAST(json_extract_scalar(p_json,'$.wardsKilled') AS integer) AS wards_killed,
    CAST(json_extract_scalar(p_json,'$.detectorWardsPlaced') AS integer) AS control_wards_placed,
    CAST(json_extract_scalar(p_json,'$.challenges.visionScorePerMinute') AS double) AS vision_score_per_min,
    CAST(json_extract_scalar(p_json,'$.dragonKills')      AS integer) AS dragon_kills_personal,
    CAST(json_extract_scalar(p_json,'$.baronKills')       AS integer) AS baron_kills_personal,
    CAST(json_extract_scalar(p_json,'$.riftHeraldKills')  AS integer) AS rift_herald_kills_personal,
    CAST(json_extract_scalar(p_json,'$.turretTakedowns')  AS integer) AS turret_takedowns,
    CAST(json_extract_scalar(p_json,'$.inhibitorTakedowns') AS integer) AS inhib_takedowns,
    CAST(json_extract_scalar(p_json,'$.item0') AS integer) AS item0,
    CAST(json_extract_scalar(p_json,'$.item1') AS integer) AS item1,
    CAST(json_extract_scalar(p_json,'$.item2') AS integer) AS item2,
    CAST(json_extract_scalar(p_json,'$.item3') AS integer) AS item3,
    CAST(json_extract_scalar(p_json,'$.item4') AS integer) AS item4,
    CAST(json_extract_scalar(p_json,'$.item5') AS integer) AS item5,
    CAST(json_extract_scalar(p_json,'$.item6') AS integer) AS item6,
    json_extract(p_json,'$.perks') AS perks_json,
    p_json
  FROM participants
),

-- Final join & dedup and anti-join target
final AS (
  SELECT
    b.matchid,
    b.puuid,
    b.season,
    b.patch_major,
    b.queue,
    b.participant_id,
    b.team_id,
    b.team_position,
    b.individual_position,
    b.lane,
    b.role,
    b.champion_id,
    b.champion_name,
    b.final_champ_level,
    b.profile_icon,
    b.summoner_name,
    b.summoner_id,
    b.summoner_d, b.summoner_f,
    b.spell1_casts, b.spell2_casts, b.spell3_casts, b.spell4_casts,
    b.kills, b.deaths, b.assists,
    IF(b.deaths = 0, CAST(b.kills + b.assists AS double), CAST((b.kills + b.assists) / b.deaths AS double)) AS kda,
    b.dpm, b.total_dmg_to_champs, b.team_dmg_pct, b.total_dmg_dealt, b.total_dmg_taken,
    b.gold_earned, b.gpm,
    b.total_minions_killed, b.neutral_minions_killed,
    b.total_time_spent_dead,
    b.vision_score, b.vision_score_per_min,
    b.wards_placed, b.wards_killed, b.control_wards_placed,
    b.dragon_kills_personal, b.baron_kills_personal, b.rift_herald_kills_personal,
    b.turret_takedowns, b.inhib_takedowns,
    s.cs_at10, s.gold_at10, s.xp_at10, s.level_at10,
    s.cs_at20, s.gold_at20, s.xp_at20, s.level_at20,
    COALESCE(wm.wards_placed_map, CAST(MAP(ARRAY[], ARRAY[]) AS MAP(varchar, integer)))     AS wards_placed_by_type,
    COALESCE(wdm.wards_destroyed_map, CAST(MAP(ARRAY[], ARRAY[]) AS MAP(varchar, integer))) AS wards_destroyed_by_type,
    COALESCE(om.objective_takedowns_map, CAST(MAP(ARRAY[], ARRAY[]) AS MAP(varchar, integer))) AS objective_takedowns_by_type,
    COALESCE(omn.objective_takedowns_norm_map, CAST(MAP(ARRAY[], ARRAY[]) AS MAP(varchar, integer))) AS objective_takedowns_by_type_norm,
    COALESCE(totm.team_objective_totals_map, CAST(MAP(ARRAY[], ARRAY[]) AS MAP(varchar, integer))) AS team_objective_totals_by_type,
    transform_values(totm.team_objective_totals_map, (k, v) -> 
      COALESCE(CAST(element_at(omn.objective_takedowns_norm_map, k) AS double) / NULLIF(v, 0), 0.0)
    ) AS objective_participation_by_type,
    COALESCE(pos.positions,   CAST(ARRAY[] AS ARRAY(ROW(ts bigint, x integer, y integer)))) AS positions_ts,
    COALESCE(it.item_events,  CAST(ARRAY[] AS ARRAY(ROW(ts bigint, type varchar, item_id integer)))) AS item_events_ts,
    COALESCE(kt.combat_events,CAST(ARRAY[] AS ARRAY(ROW(ts bigint, x integer, y integer, kind varchar, killer_id integer, victim_id integer, assists_count integer, assists_ids ARRAY(integer))))) AS combat_events_ts,
    CAST(ROW(b.game_start_ts, b.game_end_ts, b.patch_full, b.game_duration_sec)
         AS ROW(game_start_ts bigint, game_end_ts bigint, patch_full varchar, game_duration_sec integer)) AS meta,
    json_format(b.perks_json) AS perks_json,
    json_format(b.p_json)     AS participant_json
  FROM p_base b
  LEFT JOIN snapshots s            ON s.matchid = b.matchid AND s.participant_id = b.participant_id
  LEFT JOIN ward_maps wm           ON wm.matchid = b.matchid AND wm.participant_id = b.participant_id
  LEFT JOIN ward_destroy_maps wdm  ON wdm.matchid = b.matchid AND wdm.participant_id = b.participant_id
  LEFT JOIN objective_maps om      ON om.matchid = b.matchid AND om.participant_id = b.participant_id
  LEFT JOIN objective_maps_norm omn ON omn.matchid = b.matchid AND omn.participant_id = b.participant_id
  LEFT JOIN team_objective_totals_map totm ON totm.matchid = b.matchid AND totm.team_id = b.team_id
  LEFT JOIN positions_ts pos       ON pos.matchid = b.matchid AND pos.participant_id = b.participant_id
  LEFT JOIN item_ts it             ON it.matchid = b.matchid AND it.participant_id = b.participant_id
  LEFT JOIN kills_ts kt            ON kt.matchid = b.matchid AND kt.participant_id = b.participant_id
),
final_dedup AS (
  SELECT f.*, row_number() OVER (PARTITION BY f.matchid, f.puuid ORDER BY f.meta.game_end_ts DESC) rn
  FROM final f
),
to_insert AS (
  SELECT fr.*
  FROM final_dedup fr
  LEFT JOIN rift_silver.participants_wide_v7 t
    ON t.matchid     = fr.matchid
   AND t.puuid       = fr.puuid
   AND t.season      = fr.season
   AND t.patch_major = fr.patch_major
  WHERE fr.rn = 1
    AND t.matchid IS NULL
)
SELECT
  participant_id, team_id, team_position, individual_position, lane, role,
  champion_id, champion_name, final_champ_level, profile_icon, summoner_name, summoner_id,
  summoner_d, summoner_f, spell1_casts, spell2_casts, spell3_casts, spell4_casts,
  kills, deaths, assists, kda,
  dpm, total_dmg_to_champs, team_dmg_pct, total_dmg_dealt, total_dmg_taken,
  gold_earned, gpm, total_minions_killed, neutral_minions_killed, total_time_spent_dead,
  vision_score, vision_score_per_min, wards_placed, wards_killed, control_wards_placed,
  dragon_kills_personal, baron_kills_personal, rift_herald_kills_personal, turret_takedowns, inhib_takedowns,
  cs_at10, gold_at10, xp_at10, level_at10, cs_at20, gold_at20, xp_at20, level_at20,
  wards_placed_by_type, wards_destroyed_by_type, objective_takedowns_by_type,
  objective_takedowns_by_type_norm, team_objective_totals_by_type, objective_participation_by_type,
  positions_ts, item_events_ts, combat_events_ts,
  meta, perks_json, participant_json,
  matchid, puuid, queue,
  season, patch_major
FROM to_insert;
