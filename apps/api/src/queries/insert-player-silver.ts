import consola from 'consola';
import { SQL } from 'sql-template-strings';
import { runAthenaQuery } from '../utils/run-athena-query.js';

// Bulk version - processes multiple patches in single query
export const insertPlayerSilverEntriesBulk = (
  puuid: string,
  patches: string[],
) => {
  if (!puuid || patches.length === 0) {
    throw new Error('PUUID and patches required');
  }

  const patchList = patches.map((p) => `'${p}'`).join(', ');

  return SQL`
-- ============================================
-- UPSERT (MERGE) into ICEBERG v9: participants_wide_v9
-- - Expands ALL 10 participants for matches that include :puuid
-- - Recomputes snapshots, ward/objective maps, time-series arrays
-- - Deduplicates raw sources per match via $path ranking
-- - MERGE keys: (matchid, puuid)
-- - Safe re-run: updates existing rows, inserts new ones
-- - OPTIMIZED: Processes multiple patches in single query
-- ============================================

MERGE INTO rift_silver.participants_wide_v9 AS tgt
USING (
  WITH
  cfg AS (
    SELECT
      CAST(2025 AS integer) AS season,
      CAST(':puuid' AS varchar) AS puuid
  ),

  -- --------------------------
  -- Matches (partition-pruned + dedup by $path)
  -- Uses IN clause for efficient multi-patch filtering
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
        CAST(json_extract_scalar(raw,'$.info.gameDuration') AS integer) AS game_duration_sec,
        CAST(json_extract_scalar(raw,'$.info.gameStartTimestamp') AS bigint) AS game_start_ts,
        CAST(json_extract_scalar(raw,'$.info.gameEndTimestamp') AS bigint) AS game_end_ts,
        CAST(json_extract_scalar(raw,'$.queue') AS integer) AS queue,
        json_extract(raw,'$.info.participants') AS participants_json,
        raw AS match_raw,
        "$path" AS src_path,
        row_number() OVER (
          PARTITION BY COALESCE(json_extract_scalar(raw,'$.matchId'),
                                json_extract_scalar(raw,'$.metadata.matchId'))
          ORDER BY "$path" DESC
        ) AS rn
      FROM rift_raw.matches_json
      WHERE season = (SELECT season FROM cfg)
        AND patch IN (:patchList)
    )
    WHERE rn = 1
  ),

  my_matches AS (
    SELECT DISTINCT m.matchid
    FROM matches_dedup m
    CROSS JOIN UNNEST(CAST(m.participants_json AS ARRAY(JSON))) AS t(pj)
    WHERE json_extract_scalar(pj,'$.puuid') = (SELECT puuid FROM cfg)
  ),

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
      WHERE season = (SELECT season FROM cfg)
        AND patch IN (:patchList)
    )
    WHERE rn = 1
  ),

  participants AS (
    SELECT
      m.matchid,
      (SELECT season FROM cfg) AS season,
      m.patch_major,
      m.patch_full,
      m.queue,
      m.game_duration_sec,
      m.game_start_ts,
      m.game_end_ts,
      CAST(pj AS JSON) AS p_json
    FROM matches_dedup m
    JOIN my_matches mm ON mm.matchid = m.matchid
    CROSS JOIN UNNEST(CAST(m.participants_json AS ARRAY(JSON))) AS t(pj)
  ),

  frames AS (
    SELECT
      t.matchid,
      CAST(f AS JSON) AS f_json,
      CAST(json_extract_scalar(f,'$.timestamp') AS bigint) AS ts
    FROM timelines_dedup t
    JOIN my_matches mm ON mm.matchid = t.matchid
    CROSS JOIN UNNEST(CAST(t.frames_json AS ARRAY(JSON))) AS u(f)
  ),

  participant_frames AS (
    SELECT
      f.matchid,
      CAST(json_extract_scalar(pf,'$.participantId') AS integer) AS participant_id,
      f.ts,
      CAST(json_extract_scalar(pf,'$.minionsKilled') AS integer) AS lane_minions,
      CAST(json_extract_scalar(pf,'$.jungleMinionsKilled') AS integer) AS jungle_minions,
      CAST(json_extract_scalar(pf,'$.totalGold') AS integer) AS total_gold,
      CAST(json_extract_scalar(pf,'$.xp') AS integer) AS xp,
      CAST(json_extract(pf,'$.position') AS JSON) AS position_json,
      CAST(json_extract_scalar(pf,'$.level') AS integer) AS level,
      CAST(json_extract(pf,'$.championStats') AS JSON) AS champ_stats_json,
      CAST(json_extract(pf,'$.damageStats') AS JSON) AS damage_stats_json
    FROM frames f
    CROSS JOIN UNNEST(
      MAP_VALUES(CAST(json_extract(f.f_json,'$.participantFrames') AS MAP(VARCHAR, JSON)))
    ) AS t(pf)
  ),

  snapshots AS (
    SELECT
      matchid,
      participant_id,
      max_by(lane_minions + jungle_minions, ts) FILTER (WHERE ts <= 600000) AS cs_at10,
      max_by(total_gold, ts) FILTER (WHERE ts <= 600000) AS gold_at10,
      max_by(xp, ts) FILTER (WHERE ts <= 600000) AS xp_at10,
      max_by(level, ts) FILTER (WHERE ts <= 600000) AS level_at10,
      max_by(lane_minions + jungle_minions, ts) FILTER (WHERE ts <= 1200000) AS cs_at20,
      max_by(total_gold, ts) FILTER (WHERE ts <= 1200000) AS gold_at20,
      max_by(xp, ts) FILTER (WHERE ts <= 1200000) AS xp_at20,
      max_by(level, ts) FILTER (WHERE ts <= 1200000) AS level_at20
    FROM participant_frames
    GROUP BY 1, 2
  ),

  events AS (
    SELECT
      fr.matchid,
      CAST(json_extract_scalar(e,'$.type') AS varchar) AS type,
      CAST(json_extract_scalar(e,'$.timestamp') AS bigint) AS ts,
      CAST(json_extract(e,'$.position') AS JSON) AS pos,
      CAST(json_extract_scalar(e,'$.killerId') AS integer) AS killer_id,
      CAST(json_extract_scalar(e,'$.victimId') AS integer) AS victim_id,
      CAST(json_extract(e,'$.assistingParticipantIds') AS ARRAY(INTEGER)) AS assists_ids,
      CAST(json_extract_scalar(e,'$.itemId') AS integer) AS item_id,
      CAST(json_extract_scalar(e,'$.wardType') AS varchar) AS ward_type,
      CAST(json_extract_scalar(e,'$.creatorId') AS integer) AS ward_creator_id,
      CAST(json_extract_scalar(e,'$.monsterSubType') AS varchar) AS monster_subtype,
      CAST(json_extract_scalar(e,'$.monsterType') AS varchar) AS monster_type,
      CAST(json_extract_scalar(e,'$.buildingType') AS varchar) AS building_type,
      CAST(json_extract_scalar(e,'$.towerType') AS varchar) AS tower_type,
      CAST(json_extract_scalar(e,'$.teamId') AS integer) AS team_event_id,
      CAST(json_extract_scalar(e,'$.participantId') AS integer) AS participant_event_id
    FROM frames fr
    CROSS JOIN UNNEST(CAST(json_extract(fr.f_json,'$.events') AS ARRAY(JSON))) AS t(e)
  ),

  ward_events AS (
    SELECT matchid, ward_creator_id AS participant_id, ward_type, count(*) AS wards_placed_by_type
    FROM events
    WHERE type = 'WARD_PLACED' AND ward_creator_id BETWEEN 1 AND 10
    GROUP BY 1, 2, 3
  ),
  ward_destroys AS (
    SELECT matchid, killer_id AS participant_id, ward_type, count(*) AS wards_destroyed_by_type
    FROM events
    WHERE type = 'WARD_KILL' AND killer_id BETWEEN 1 AND 10
    GROUP BY 1, 2, 3
  ),
  item_events AS (
    SELECT matchid, participant_event_id AS participant_id, type, ts, item_id
    FROM events
    WHERE type IN ('ITEM_PURCHASED','ITEM_SOLD','ITEM_DESTROYED','ITEM_UNDO')
      AND participant_event_id BETWEEN 1 AND 10
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

  team_lookup AS (
    SELECT
      x.matchid,
      CAST(json_extract_scalar(x.p_json,'$.participantId') AS integer) AS participant_id,
      CAST(json_extract_scalar(x.p_json,'$.teamId') AS integer) AS team_id
    FROM (
      SELECT m.matchid, CAST(pj AS JSON) AS p_json
      FROM matches_dedup m
      JOIN my_matches mm ON mm.matchid = m.matchid
      CROSS JOIN UNNEST(CAST(m.participants_json AS ARRAY(JSON))) AS t(pj)
    ) x
  ),

  objective_participation AS (
    SELECT matchid, obj_kind, participant_id, count(DISTINCT ts) AS takedowns
    FROM (
      SELECT
        o.matchid, o.ts,
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
        o.matchid, o.ts,
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
        AND killer_team.team_id = assist_team.team_id
    ) x
    GROUP BY 1, 2, 3
  ),

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
        AND killer_team.team_id = assist_team.team_id
    ) u
    GROUP BY 1, 2, 3
  ),

  ward_maps AS (
    SELECT matchid, participant_id, map_agg(ward_type, wards_placed_by_type) AS wards_placed_map
    FROM ward_events
    GROUP BY 1, 2
  ),
  ward_destroy_maps AS (
    SELECT matchid, participant_id, map_agg(ward_type, wards_destroyed_by_type) AS wards_destroyed_map
    FROM ward_destroys
    GROUP BY 1, 2
  ),
  objective_maps AS (
    SELECT matchid, participant_id, map_agg(obj_kind, takedowns) AS objective_takedowns_map
    FROM objective_participation
    GROUP BY 1, 2
  ),
  objective_maps_norm AS (
    SELECT matchid, participant_id, map_agg(obj_norm, takedowns_norm) AS objective_takedowns_norm_map
    FROM objective_participation_norm
    GROUP BY 1, 2
  ),

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

  team_objective_totals_norm AS (
    SELECT matchid, team_id, obj_norm, count(DISTINCT ts) AS team_total
    FROM objective_events_norm_with_team
    WHERE team_id IS NOT NULL
    GROUP BY 1, 2, 3
  ),
  team_objective_totals_map AS (
    SELECT matchid, team_id, map_agg(obj_norm, team_total) AS team_objective_totals_map
    FROM team_objective_totals_norm
    GROUP BY 1, 2
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
    GROUP BY 1, 2
  ),
  item_ts AS (
    SELECT
      ie.matchid,
      ie.participant_id,
      ARRAY_AGG(CAST(ROW(ts, type, item_id) AS ROW(ts bigint, type varchar, item_id integer)) ORDER BY ts) AS item_events
    FROM item_events ie
    WHERE participant_id BETWEEN 1 AND 10
    GROUP BY 1, 2
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
      SELECT matchid, ts, pos, killer_id, victim_id, assists_ids, killer_id AS p_id, 'KILL' AS kind FROM kill_events
      UNION ALL
      SELECT matchid, ts, pos, killer_id, victim_id, assists_ids, victim_id AS p_id, 'DEATH' AS kind FROM kill_events
    ) k
    WHERE p_id BETWEEN 1 AND 10
    GROUP BY 1, 2
  ),

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
               json_extract_scalar(p_json,'$.teamPosition')) AS individual_position,
      json_extract_scalar(p_json,'$.lane') AS lane,
      json_extract_scalar(p_json,'$.role') AS role,
      CAST(json_extract_scalar(p_json,'$.championId') AS integer) AS champion_id,
      json_extract_scalar(p_json,'$.championName') AS champion_name,
      CAST(json_extract_scalar(p_json,'$.champLevel') AS integer) AS final_champ_level,
      CAST(json_extract_scalar(p_json,'$.profileIcon') AS integer) AS profile_icon,
      json_extract_scalar(p_json,'$.summonerName') AS summoner_name,
      json_extract_scalar(p_json,'$.summonerId') AS summoner_id,
      CAST(json_extract_scalar(p_json,'$.summoner1Id') AS integer) AS summoner_d,
      CAST(json_extract_scalar(p_json,'$.summoner2Id') AS integer) AS summoner_f,
      CAST(json_extract_scalar(p_json,'$.spell1Casts') AS integer) AS spell1_casts,
      CAST(json_extract_scalar(p_json,'$.spell2Casts') AS integer) AS spell2_casts,
      CAST(json_extract_scalar(p_json,'$.spell3Casts') AS integer) AS spell3_casts,
      CAST(json_extract_scalar(p_json,'$.spell4Casts') AS integer) AS spell4_casts,
      CAST(json_extract_scalar(p_json,'$.kills') AS integer) AS kills,
      CAST(json_extract_scalar(p_json,'$.deaths') AS integer) AS deaths,
      CAST(json_extract_scalar(p_json,'$.assists') AS integer) AS assists,
      CAST(json_extract_scalar(p_json,'$.challenges.damagePerMinute') AS double) AS dpm,
      CAST(json_extract_scalar(p_json,'$.totalDamageDealtToChampions') AS integer) AS total_dmg_to_champs,
      CAST(json_extract_scalar(p_json,'$.challenges.teamDamagePercentage') AS double) AS team_dmg_pct,
      CAST(json_extract_scalar(p_json,'$.totalDamageDealt') AS integer) AS total_dmg_dealt,
      CAST(json_extract_scalar(p_json,'$.totalDamageTaken') AS integer) AS total_dmg_taken,
      CAST(json_extract_scalar(p_json,'$.goldEarned') AS integer) AS gold_earned,
      CAST(json_extract_scalar(p_json,'$.challenges.goldPerMinute') AS double) AS gpm,
      CAST(json_extract_scalar(p_json,'$.totalMinionsKilled') AS integer) AS total_minions_killed,
      CAST(json_extract_scalar(p_json,'$.neutralMinionsKilled') AS integer) AS neutral_minions_killed,
      CAST(json_extract_scalar(p_json,'$.totalTimeSpentDead') AS integer) AS total_time_spent_dead,
      CAST(json_extract_scalar(p_json,'$.visionScore') AS double) AS vision_score,
      CAST(json_extract_scalar(p_json,'$.wardsPlaced') AS integer) AS wards_placed,
      CAST(json_extract_scalar(p_json,'$.wardsKilled') AS integer) AS wards_killed,
      CAST(json_extract_scalar(p_json,'$.detectorWardsPlaced') AS integer) AS control_wards_placed,
      CAST(json_extract_scalar(p_json,'$.challenges.visionScorePerMinute') AS double) AS vision_score_per_min,
      CAST(json_extract_scalar(p_json,'$.dragonKills') AS integer) AS dragon_kills_personal,
      CAST(json_extract_scalar(p_json,'$.baronKills') AS integer) AS baron_kills_personal,
      CAST(json_extract_scalar(p_json,'$.riftHeraldKills') AS integer) AS rift_herald_kills_personal,
      CAST(json_extract_scalar(p_json,'$.turretTakedowns') AS integer) AS turret_takedowns,
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
      COALESCE(wm.wards_placed_map, CAST(MAP(ARRAY[], ARRAY[]) AS MAP(varchar, integer))) AS wards_placed_by_type,
      COALESCE(wdm.wards_destroyed_map, CAST(MAP(ARRAY[], ARRAY[]) AS MAP(varchar, integer))) AS wards_destroyed_by_type,
      COALESCE(om.objective_takedowns_map, CAST(MAP(ARRAY[], ARRAY[]) AS MAP(varchar, integer))) AS objective_takedowns_by_type,
      COALESCE(omn.objective_takedowns_norm_map, CAST(MAP(ARRAY[], ARRAY[]) AS MAP(varchar, integer))) AS objective_takedowns_by_type_norm,
      COALESCE(tom.team_objective_totals_map, CAST(MAP(ARRAY[], ARRAY[]) AS MAP(varchar, integer))) AS team_objective_totals_by_type,
      transform_values(
        COALESCE(tom.team_objective_totals_map, CAST(MAP(ARRAY[], ARRAY[]) AS MAP(varchar, integer))),
        (k, teamv) -> CASE
                        WHEN teamv > 0
                          THEN CAST(COALESCE(omn.objective_takedowns_norm_map[k], 0) AS double)
                               / CAST(teamv AS double)
                        ELSE CAST(NULL AS double)
                      END
      ) AS objective_participation_by_type,
      COALESCE(pos.positions, CAST(ARRAY[] AS ARRAY(ROW(ts bigint, x integer, y integer)))) AS positions_ts,
      COALESCE(it.item_events, CAST(ARRAY[] AS ARRAY(ROW(ts bigint, type varchar, item_id integer)))) AS item_events_ts,
      COALESCE(kt.combat_events, CAST(ARRAY[] AS ARRAY(ROW(ts bigint, x integer, y integer, kind varchar, killer_id integer, victim_id integer, assists_count integer, assists_ids ARRAY(integer))))) AS combat_events_ts,
      CAST(ROW(b.game_start_ts, b.game_end_ts, b.patch_full, b.game_duration_sec)
           AS ROW(game_start_ts bigint, game_end_ts bigint, patch_full varchar, game_duration_sec integer)) AS meta,
      json_format(b.perks_json) AS perks_json,
      json_format(b.p_json) AS participant_json
    FROM p_base b
    LEFT JOIN snapshots s ON s.matchid = b.matchid AND s.participant_id = b.participant_id
    LEFT JOIN ward_maps wm ON wm.matchid = b.matchid AND wm.participant_id = b.participant_id
    LEFT JOIN ward_destroy_maps wdm ON wdm.matchid = b.matchid AND wdm.participant_id = b.participant_id
    LEFT JOIN objective_maps om ON om.matchid = b.matchid AND om.participant_id = b.participant_id
    LEFT JOIN objective_maps_norm omn ON omn.matchid = b.matchid AND omn.participant_id = b.participant_id
    LEFT JOIN team_objective_totals_map tom ON tom.matchid = b.matchid AND tom.team_id = b.team_id
    LEFT JOIN positions_ts pos ON pos.matchid = b.matchid AND pos.participant_id = b.participant_id
    LEFT JOIN item_ts it ON it.matchid = b.matchid AND it.participant_id = b.participant_id
    LEFT JOIN kills_ts kt ON kt.matchid = b.matchid AND kt.participant_id = b.participant_id
  ),

  final_dedup AS (
    SELECT f.*, row_number() OVER (PARTITION BY f.matchid, f.puuid ORDER BY f.meta.game_end_ts DESC) rn
    FROM final f
  ),

  src_rows AS (
    SELECT * FROM final_dedup WHERE rn = 1
  )

  SELECT * FROM src_rows
) AS src
ON (
  tgt.matchid = src.matchid
  AND tgt.puuid = src.puuid
  AND tgt.season = src.season
)
WHEN MATCHED THEN UPDATE SET
  participant_id = src.participant_id,
  team_id = src.team_id,
  team_position = src.team_position,
  individual_position = src.individual_position,
  lane = src.lane,
  role = src.role,
  champion_id = src.champion_id,
  champion_name = src.champion_name,
  final_champ_level = src.final_champ_level,
  profile_icon = src.profile_icon,
  summoner_name = src.summoner_name,
  summoner_id = src.summoner_id,
  summoner_d = src.summoner_d,
  summoner_f = src.summoner_f,
  spell1_casts = src.spell1_casts,
  spell2_casts = src.spell2_casts,
  spell3_casts = src.spell3_casts,
  spell4_casts = src.spell4_casts,
  kills = src.kills,
  deaths = src.deaths,
  assists = src.assists,
  kda = src.kda,
  dpm = src.dpm,
  total_dmg_to_champs = src.total_dmg_to_champs,
  team_dmg_pct = src.team_dmg_pct,
  total_dmg_dealt = src.total_dmg_dealt,
  total_dmg_taken = src.total_dmg_taken,
  gold_earned = src.gold_earned,
  gpm = src.gpm,
  total_minions_killed = src.total_minions_killed,
  neutral_minions_killed = src.neutral_minions_killed,
  total_time_spent_dead = src.total_time_spent_dead,
  vision_score = src.vision_score,
  vision_score_per_min = src.vision_score_per_min,
  wards_placed = src.wards_placed,
  wards_killed = src.wards_killed,
  control_wards_placed = src.control_wards_placed,
  dragon_kills_personal = src.dragon_kills_personal,
  baron_kills_personal = src.baron_kills_personal,
  rift_herald_kills_personal = src.rift_herald_kills_personal,
  turret_takedowns = src.turret_takedowns,
  inhib_takedowns = src.inhib_takedowns,
  cs_at10 = src.cs_at10,
  gold_at10 = src.gold_at10,
  xp_at10 = src.xp_at10,
  level_at10 = src.level_at10,
  cs_at20 = src.cs_at20,
  gold_at20 = src.gold_at20,
  xp_at20 = src.xp_at20,
  level_at20 = src.level_at20,
  wards_placed_by_type = src.wards_placed_by_type,
  wards_destroyed_by_type = src.wards_destroyed_by_type,
  objective_takedowns_by_type = src.objective_takedowns_by_type,
  objective_takedowns_by_type_norm = src.objective_takedowns_by_type_norm,
  team_objective_totals_by_type = src.team_objective_totals_by_type,
  objective_participation_by_type = src.objective_participation_by_type,
  positions_ts = src.positions_ts,
  item_events_ts = src.item_events_ts,
  combat_events_ts = src.combat_events_ts,
  meta = src.meta,
  perks_json = src.perks_json,
  participant_json = src.participant_json,
  queue = src.queue,
  season = src.season,
  patch_major = src.patch_major
WHEN NOT MATCHED THEN INSERT (
  participant_id, team_id, team_position, individual_position, lane, role,
  champion_id, champion_name, final_champ_level, profile_icon, summoner_name,
  summoner_id, summoner_d, summoner_f, spell1_casts, spell2_casts, spell3_casts,
  spell4_casts, kills, deaths, assists, kda, dpm, total_dmg_to_champs, team_dmg_pct,
  total_dmg_dealt, total_dmg_taken, gold_earned, gpm, total_minions_killed,
  neutral_minions_killed, total_time_spent_dead, vision_score, vision_score_per_min,
  wards_placed, wards_killed, control_wards_placed, dragon_kills_personal,
  baron_kills_personal, rift_herald_kills_personal, turret_takedowns, inhib_takedowns,
  cs_at10, gold_at10, xp_at10, level_at10, cs_at20, gold_at20, xp_at20, level_at20,
  wards_placed_by_type, wards_destroyed_by_type, objective_takedowns_by_type,
  objective_takedowns_by_type_norm, team_objective_totals_by_type,
  objective_participation_by_type, positions_ts, item_events_ts, combat_events_ts,
  meta, perks_json, participant_json, matchid, puuid, queue, season, patch_major
) VALUES (
  src.participant_id, src.team_id, src.team_position, src.individual_position,
  src.lane, src.role, src.champion_id, src.champion_name, src.final_champ_level,
  src.profile_icon, src.summoner_name, src.summoner_id, src.summoner_d, src.summoner_f,
  src.spell1_casts, src.spell2_casts, src.spell3_casts, src.spell4_casts, src.kills,
  src.deaths, src.assists, src.kda, src.dpm, src.total_dmg_to_champs, src.team_dmg_pct,
  src.total_dmg_dealt, src.total_dmg_taken, src.gold_earned, src.gpm,
  src.total_minions_killed, src.neutral_minions_killed, src.total_time_spent_dead,
  src.vision_score, src.vision_score_per_min, src.wards_placed, src.wards_killed,
  src.control_wards_placed, src.dragon_kills_personal, src.baron_kills_personal,
  src.rift_herald_kills_personal, src.turret_takedowns, src.inhib_takedowns,
  src.cs_at10, src.gold_at10, src.xp_at10, src.level_at10, src.cs_at20, src.gold_at20,
  src.xp_at20, src.level_at20, src.wards_placed_by_type, src.wards_destroyed_by_type,
  src.objective_takedowns_by_type, src.objective_takedowns_by_type_norm,
  src.team_objective_totals_by_type, src.objective_participation_by_type,
  src.positions_ts, src.item_events_ts, src.combat_events_ts, src.meta, src.perks_json,
  src.participant_json, src.matchid, src.puuid, src.queue, src.season, src.patch_major
);`.text
    .replaceAll(':puuid', puuid)
    .replaceAll(':patchList', patchList);
};

// Helper to generate patch list
export function generatePatchList(): string[] {
  const patches: string[] = [];
  for (let i = 1; i <= 24; i++) {
    patches.push(`15.${i}`);
  }
  return patches;
}

// Helper to chunk array
function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

interface BatchResult {
  patches: string[];
  success: boolean;
  error?: unknown;
  duration: number;
}

// Optimized batch processing - processes 8 patches per query
export async function processPlayerInBatches(puuid: string) {
  const allPatches = generatePatchList(); // 24 patches
  const patchGroups = chunkArray(allPatches, 8); // 3 groups of 8
  const startTime = Date.now();

  consola.info(
    `Processing ${allPatches.length} patches in ${patchGroups.length} bulk queries for player ${puuid}`,
  );

  const results: BatchResult[] = [];

  // Process groups sequentially to avoid Iceberg conflicts
  for (let i = 0; i < patchGroups.length; i++) {
    const group = patchGroups[i];
    const groupStart = Date.now();

    consola.info(
      `Processing group ${i + 1}/${patchGroups.length}: patches ${group[0]} to ${group[group.length - 1]}`,
    );

    try {
      await runAthenaQuery({
        query: insertPlayerSilverEntriesBulk(puuid, group),
        maxAttempts: 1_000,
        pollIntervalMs: 30_000,
      });

      const duration = Date.now() - groupStart;
      consola.success(
        `Completed group ${i + 1}/${patchGroups.length} in ${Math.round(duration / 1000)}s`,
      );

      results.push({ patches: group, success: true, duration });
    } catch (error) {
      const duration = Date.now() - groupStart;
      consola.error(`Failed group ${i + 1}/${patchGroups.length}`, error);
      results.push({ patches: group, success: false, error, duration });

      // Fallback: try individual patches in this failed group
      consola.warn(`Retrying group ${i + 1} with individual patches`);

      for (const patch of group) {
        try {
          const patchStart = Date.now();
          await runAthenaQuery({
            query: insertPlayerSilverEntriesBulk(puuid, [patch]),
            maxAttempts: 1_000,
            pollIntervalMs: 30_000,
          });

          const patchDuration = Date.now() - patchStart;
          consola.success(
            `Completed patch ${patch} in ${Math.round(patchDuration / 1000)}s`,
          );
        } catch (patchError) {
          consola.error(`Failed patch ${patch}`, patchError);
        }
      }
    }

    // Small delay between groups to avoid Iceberg metadata conflicts
    if (i < patchGroups.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  // Summary
  const totalTime = Math.round((Date.now() - startTime) / 1000);
  const successful = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  if (failed > 0) {
    consola.warn(
      `Completed with ${successful}/${patchGroups.length} successful groups in ${totalTime}s (~${Math.round(totalTime / 60)} minutes)`,
    );
    const failedPatches = results
      .filter((r) => !r.success)
      .flatMap((r) => r.patches);
    consola.warn(`Failed patches: ${failedPatches.join(', ')}`);
  } else {
    consola.success(
      `All ${patchGroups.length} groups (${allPatches.length} patches) completed successfully in ${totalTime}s (~${Math.round(totalTime / 60)} minutes)`,
    );
  }

  return {
    successful,
    failed,
    totalTime,
    totalMinutes: Math.round(totalTime / 60),
  };
}
