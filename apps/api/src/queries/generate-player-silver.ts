import { SQL } from 'sql-template-strings';

// tiny helper: escape a SQL string literal for Athena/Trino (single quotes doubled)
const sqlStr = (s: string) => `'${String(s).replace(/'/g, "''")}'`;

// if queues are numeric, keep them numeric; otherwise quote them
const buildInList = (vals: (string | number)[], asNumbers = true) => {
  const cleaned = vals
    .map((v) => (asNumbers ? Number(v) : v))
    .filter((v) =>
      asNumbers ? Number.isFinite(v as number) : String(v).length > 0,
    );
  if (cleaned.length === 0) return '/* empty */ 0'; // never matches
  return asNumbers
    ? cleaned.join(',')
    : cleaned.map((v) => sqlStr(String(v))).join(',');
};

export const GENERATE_PLAYER_SILVER_SQL = ({
  season,
  patch_major, // pass as string "15" or number 15 – both OK
  puuid,
  queues, // e.g. ["400","420","440"]
}: {
  season: number;
  patch_major: string | number;
  puuid: string;
  queues: string[];
}) => {
  const patchMajorStr = String(patch_major); // convert to string but don't quote yet
  const queuesIn = buildInList(queues, true); // numeric IN list

  return SQL`
INSERT INTO lol.silver_player_match_summary
WITH
/* ----------------------- params ----------------------- */
params AS (
  SELECT
    CAST(${season} AS INTEGER)      AS season_filter,
    CAST(${patchMajorStr} AS VARCHAR) AS patch_major_filter
),

/* ----------------------- participants (player-only) ----------------------- */
parts_all AS (
  SELECT
    CAST(m.matchid AS VARCHAR)                           AS match_id,
    m.season, CAST(REGEXP_EXTRACT(m.patch, '^([0-9]+)') AS VARCHAR) AS patch_major,
    m.queue,
    p.participantid                                      AS participant_id,
    p.puuid                                              AS participant_puuid,
    p.teamid                                             AS team_id,
    COALESCE(NULLIF(p.teamposition,''),'UNKNOWN')        AS role,
    CAST(p.championid AS INT)                            AS champion_id,
    m.info.gameduration                                  AS game_duration_sec,
    p.kills, p.deaths, p.assists,
    (p.totalminionskilled + COALESCE(p.neutralminionskilled,0)) AS cs_total,
    p.timeplayed                                         AS time_played_sec,
    p.visionscore                                        AS vision_score,
    p.wardskilled                                        AS wards_cleared,
    p.goldearned                                         AS gold_earned,
    p.totaldamagedealttochampions                        AS total_damage_to_champions,
    CAST(p.win AS INTEGER)                               AS win_flag
  FROM lol.raw_matches m
  CROSS JOIN UNNEST(m.info.participants) AS t(p)
  CROSS JOIN params pr
  WHERE p.puuid    = ${puuid}
    AND m.season   = pr.season_filter
    AND m.patch LIKE pr.patch_major_filter || '.%'
    AND m.queue   IN (${queuesIn})
),

/* ----------------------- team totals (only those matches) ----------------------- */
team_totals AS (
  SELECT
    CAST(m.matchid AS VARCHAR) AS match_id,
    p.teamid                   AS team_id,
    SUM(p.totaldamagedealttochampions) AS team_total_damage_to_champions
  FROM lol.raw_matches m
  CROSS JOIN UNNEST(m.info.participants) AS t(p)
  WHERE CAST(m.matchid AS VARCHAR) IN (SELECT DISTINCT match_id FROM parts_all)
  GROUP BY 1,2
),

/* killer -> team map (for KP denominator) */
participant_team AS (
  SELECT
    CAST(m.matchid AS VARCHAR) AS match_id,
    p.participantid            AS participant_id,
    p.teamid                   AS team_id
  FROM lol.raw_matches m
  CROSS JOIN UNNEST(m.info.participants) AS t(p)
  WHERE CAST(m.matchid AS VARCHAR) IN (SELECT DISTINCT match_id FROM parts_all)
),

/* ----------------------- events (single pass) ----------------------- */
events_base AS (
  SELECT pa.match_id, pa.participant_id, pa.team_id, fr
  FROM parts_all pa
  JOIN lol.raw_timelines tl
    ON CAST(tl.matchid AS VARCHAR) = pa.match_id
  CROSS JOIN UNNEST(tl.frames) AS f(fr)
  WHERE cardinality(fr.events) > 0
),

events AS (
  SELECT
    eb.match_id,
    eb.participant_id,
    eb.team_id AS player_team_id,
    e."type"                            AS type,
    e.timestamp                         AS ts_ms,
    CAST(e.killerid AS INT)             AS killer_id,
    CAST(e.victimid AS INT)             AS victim_id,
    COALESCE(e.assistingparticipantids, CAST(ARRAY[] AS ARRAY(INTEGER))) AS assists,
    UPPER(COALESCE(e.monstersubtype, e.monstertype, '')) AS monster_type,
    e.position
  FROM events_base eb
  CROSS JOIN UNNEST(eb.fr.events) AS ev(e)
),

event_metrics AS (
  SELECT
    e.match_id,
    e.participant_id,
    COUNT_IF(e.type='WARD_KILL'     AND e.ts_ms<=600000 AND e.killer_id = e.participant_id) AS wards_cleared_early,
    COUNT_IF(e.type='CHAMPION_KILL' AND e.ts_ms<=600000 AND e.victim_id = e.participant_id) AS early_game_deaths,
    COUNT_IF(e.type='CHAMPION_KILL'
             AND e.killer_id = e.participant_id
             AND cardinality(e.assists) = 0
             AND e.killer_id BETWEEN 1 AND 10) AS solo_kills,
    COUNT_IF(e.type='ELITE_MONSTER_KILL'
             AND e.killer_id = e.participant_id
             AND e.monster_type = 'RIFTSCUTTLER') AS scuttle_kills,
    COUNT_IF(e.type='CHAMPION_KILL'
             AND (e.killer_id = e.participant_id OR contains(e.assists, e.participant_id))
             AND e.killer_id BETWEEN 1 AND 10) AS kp_events,
    COUNT_IF(e.type='CHAMPION_KILL'
             AND e.killer_id BETWEEN 1 AND 10
             AND kt.team_id = e.player_team_id) AS team_kill_events,
    MAX(CASE WHEN e.type='ELITE_MONSTER_KILL' AND e.monster_type LIKE '%DRAGON%'
             AND (e.killer_id = e.participant_id OR contains(e.assists, e.participant_id))
             THEN 1 ELSE 0 END) AS drake_participation,
    MAX(CASE WHEN e.type='ELITE_MONSTER_KILL' AND e.monster_type LIKE '%BARON%'
             AND (e.killer_id = e.participant_id OR contains(e.assists, e.participant_id))
             THEN 1 ELSE 0 END) AS baron_participation,
    MAX(CASE WHEN e.type='ELITE_MONSTER_KILL' AND e.monster_type LIKE '%HERALD%'
             AND (e.killer_id = e.participant_id OR contains(e.assists, e.participant_id))
             THEN 1 ELSE 0 END) AS herald_participation
  FROM events e
  LEFT JOIN participant_team kt
    ON kt.match_id = e.match_id AND kt.participant_id = e.killer_id
  GROUP BY e.match_id, e.participant_id
),

/* ----------------------- turret proximity (laning<=14:00) ----------------------- */
player_kill_death_events AS (
  SELECT
    e.match_id,
    e.ts_ms AS ts,
    e.killer_id AS killer_pid,
    e.victim_id AS victim_pid,
    e.position.x AS x,
    e.position.y AS y,
    e.participant_id,
    e.player_team_id AS team_id
  FROM events e
  WHERE e.type='CHAMPION_KILL'
    AND e.position.x IS NOT NULL AND e.position.y IS NOT NULL
    AND (e.killer_id = e.participant_id OR e.victim_id = e.participant_id)
    AND e.ts_ms <= 840000
),

turrets AS (
  SELECT * FROM (
    VALUES
      (100,'TOP','OUTER',  981 ,10441),
      (100,'MID','OUTER',  5048, 4812),
      (100,'BOTTOM','OUTER',10441,  981),
      (200,'TOP','OUTER',  4319,13866),
      (200,'MID','OUTER',  9813, 9817),
      (200,'BOTTOM','OUTER',13866, 4319)
  ) AS t(teamid,lane,tier,x,y)
),

event_distances AS (
  SELECT
    e.match_id, e.ts, e.killer_pid, e.victim_pid, e.x, e.y, e.participant_id, e.team_id,
    MIN( sqrt( (CAST(e.x AS DOUBLE)-CAST(t_own.x AS DOUBLE))*(CAST(e.x AS DOUBLE)-CAST(t_own.x AS DOUBLE))
             + (CAST(e.y AS DOUBLE)-CAST(t_own.y AS DOUBLE))*(CAST(e.y AS DOUBLE)-CAST(t_own.y AS DOUBLE)) ) )
      FILTER (WHERE t_own.teamid = e.team_id AND t_own.tier='OUTER') AS dist_to_own_outer,
    MIN( sqrt( (CAST(e.x AS DOUBLE)-CAST(t_opp.x AS DOUBLE))*(CAST(e.x AS DOUBLE)-CAST(t_opp.x AS DOUBLE))
             + (CAST(e.y AS DOUBLE)-CAST(t_opp.y AS DOUBLE))*(CAST(e.y AS DOUBLE)-CAST(t_opp.y AS DOUBLE)) ) )
      FILTER (WHERE t_opp.teamid <> e.team_id AND t_opp.tier='OUTER') AS dist_to_enemy_outer
  FROM player_kill_death_events e
  LEFT JOIN turrets t_own ON TRUE
  LEFT JOIN turrets t_opp ON TRUE
  GROUP BY e.match_id, e.ts, e.killer_pid, e.victim_pid, e.x, e.y, e.participant_id, e.team_id
),

turret_prox AS (
  SELECT
    ed.match_id,
    ed.participant_id,
    SUM(CASE WHEN ed.killer_pid = ed.participant_id AND ed.dist_to_enemy_outer <= 750 THEN 1 ELSE 0 END) AS kills_near_enemy_turret,
    SUM(CASE WHEN ed.killer_pid = ed.participant_id AND ed.dist_to_own_outer   <= 750 THEN 1 ELSE 0 END) AS kills_under_own_turret,
    SUM(CASE WHEN ed.victim_pid = ed.participant_id AND ed.dist_to_enemy_outer <= 750 THEN 1 ELSE 0 END) AS deaths_near_enemy_turret,
    SUM(CASE WHEN ed.victim_pid = ed.participant_id AND ed.dist_to_own_outer   <= 750 THEN 1 ELSE 0 END) AS deaths_under_own_turret
  FROM event_distances ed
  GROUP BY ed.match_id, ed.participant_id
),

/* ----------------------- CS@10 (≤10:00) ----------------------- */
cs10_metrics AS (
  SELECT
    CAST(tl.matchid AS VARCHAR) AS match_id,
    CAST(k AS INT)              AS participant_id,
    MAX(
      CASE WHEN fr.timestamp <= 600000
           THEN (CAST(v.minionskilled AS DOUBLE) + CAST(v.jungleminionskilled AS DOUBLE)) / 10.0
           ELSE 0 END
    ) AS cs10_per_min
  FROM lol.raw_timelines tl
  CROSS JOIN UNNEST(tl.frames) AS f(fr)
  CROSS JOIN UNNEST(fr.participantframes) AS pf(k, v)
  WHERE fr.timestamp <= 600000
    AND CAST(tl.matchid AS VARCHAR) IN (SELECT DISTINCT match_id FROM parts_all)
  GROUP BY CAST(tl.matchid AS VARCHAR), CAST(k AS INT)
),

/* ----------------------- new rows only (anti-join) ----------------------- */
new_rows AS (
  SELECT
    pa.match_id,
    pa.participant_id,
    pa.participant_puuid,
    pa.team_id,
    pa.role,
    pa.champion_id,
    pa.season,
    pa.patch_major,
    pa.queue,
    pa.time_played_sec,
    pa.vision_score,
    pa.wards_cleared,
    pa.gold_earned,
    pa.total_damage_to_champions,
    COALESCE(tt.team_total_damage_to_champions, 0) AS team_total_damage_to_champions,
    pa.kills, pa.deaths, pa.assists,
    pa.cs_total,
    pa.win_flag,
    COALESCE(cm.cs10_per_min, 0.0)                        AS cs10_per_min,
    COALESCE(em.wards_cleared_early, 0)                   AS wards_cleared_early,
    COALESCE(em.early_game_deaths, 0)                     AS early_game_deaths,
    COALESCE(em.solo_kills, 0)                            AS solo_kills,
    COALESCE(em.scuttle_kills, 0)                         AS scuttle_kills,
    COALESCE(em.kp_events, 0)                             AS kp_events,
    COALESCE(em.team_kill_events, 0)                      AS team_kill_events,
    COALESCE(em.drake_participation, 0)                   AS drake_participation,
    COALESCE(em.baron_participation, 0)                   AS baron_participation,
    COALESCE(em.herald_participation, 0)                  AS herald_participation,
    COALESCE(tp.kills_near_enemy_turret, 0)               AS kills_near_enemy_turret,
    COALESCE(tp.kills_under_own_turret,  0)               AS kills_under_own_turret,
    COALESCE(tp.deaths_near_enemy_turret, 0)              AS deaths_near_enemy_turret,
    COALESCE(tp.deaths_under_own_turret,  0)              AS deaths_under_own_turret,
    CURRENT_TIMESTAMP AS ingested_at,
    -- partitions
    pa.participant_puuid AS player_p,
    pa.season            AS season_p,
    pa.patch_major       AS patch_major_p,
    pa.queue             AS queue_p
  FROM parts_all pa
  LEFT JOIN team_totals tt
    ON tt.match_id = pa.match_id AND tt.team_id = pa.team_id
  LEFT JOIN event_metrics em
    ON em.match_id = pa.match_id AND em.participant_id = pa.participant_id
  LEFT JOIN cs10_metrics cm
    ON cm.match_id = pa.match_id AND cm.participant_id = pa.participant_id
  LEFT JOIN turret_prox tp
    ON tp.match_id = pa.match_id AND tp.participant_id = pa.participant_id
  WHERE NOT EXISTS (
    SELECT 1
    FROM lol.silver_player_match_summary ex
    WHERE ex.player_p       = pa.participant_puuid
      AND ex.season_p       = pa.season
      AND ex.patch_major_p  = pa.patch_major
      AND ex.queue_p        = pa.queue
      AND ex.match_id       = pa.match_id
      AND ex.participant_id = pa.participant_id
  )
)
SELECT * FROM new_rows;
`.text.trim();
};
