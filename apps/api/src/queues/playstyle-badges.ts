import { runAthenaQuery } from '../utils/run-athena-query.js';

export interface RoleStats {
  roleBucket: string;
  games: number;
  winRate: number | null;
  kpMean: number | null;
  visPerMinMean: number | null;
  wclearPerMinMean: number | null;
  dpgMean: number | null; // damage per minute
  cs10Mean: number | null;
  csfullMean: number | null;
  drakeParticipationMean: number | null;
  heraldParticipationMean: number | null;
  baronParticipationMean: number | null;
  avgObjectiveParticipation: number | null;
  avgLaningSurvivalRate: number | null;
  avgEarlyGameDeaths: number | null;
  killsNearEnemyTurretMean: number | null;
  killsUnderOwnTurretMean: number | null;
  deathsNearEnemyTurretMean: number | null;
  deathsUnderOwnTurretMean: number | null;
  avgDamagePerGold: number | null; // may be null (not provided by cohort rollup)
  avgKills: number | null;
  avgDeaths: number | null;
  avgAssists: number | null;
  avgKda: number | null;
  avgKillParticipationPct: number | null;
  avgKillParticipationProp: number | null;
  avgDamagePerMinute: number | null;
  avgTeamDamagePct: number | null; // NEW: now filled from cohorts rollup
  avgGoldPerMinute: number | null; // NEW: now filled from cohorts rollup
  avgVisionScorePerMinute: number | null;
  avgWardsCleared: number | null; // NEW: now filled from cohorts rollup
  avgWardsClearedEarly: number | null; // NEW: now filled from cohorts rollup
  avgSoloKills: number | null; // NEW: now filled from cohorts rollup
  avgScuttleKills: number | null; // NEW: now filled from cohorts rollup
  roleDistributionPct: { [role: string]: number } | null;
}

export interface PlaystyleStats {
  // Overall stats (from ALL role bucket)
  matchesPlayed: number;
  winRate: number | null;
  avgGameDurationMin: number | null;
  avgKills: number | null;
  avgDeaths: number | null;
  avgAssists: number | null;
  avgKda: number | null;
  avgKillParticipation: number | null;
  avgDamagePerMinute: number | null;
  avgTeamDamagePct: number | null;
  avgGoldPerMinute: number | null;
  avgCsPerMinute: number | null;
  avgCsAt10: number | null;
  avgVisionScorePerMinute: number | null;
  avgControlWards: number | null;
  avgWardsCleared: number | null;
  avgWardsClearedEarly: number | null;
  avgSoloKills: number | null;
  avgTurretTakedowns: number | null;
  avgInhibitorTakedowns: number | null;
  avgObjectiveTakedowns: number | null;
  avgScuttleKills: number | null;
  avgKillsNearEnemyTurret: number | null;
  avgKillsUnderOwnTurret: number | null;
  // New comprehensive metrics
  avgLaningSurvivalRate: number | null;
  avgEarlyGameDeaths: number | null;
  avgObjectiveParticipation: number | null;
  avgDragonParticipation: number | null;
  avgBaronParticipation: number | null;
  avgHeraldParticipation: number | null;
  roleDistribution: { [role: string]: number } | null;
  // Role-based breakdown
  roleStats: RoleStats[];
}

export interface PlaystyleQueryMeta {
  queryExecutionId: string;
  statistics?: {
    dataScannedInBytes?: number;
    engineExecutionTimeInMillis?: number;
  };
  sql: string;
  season?: number | null;
  queues?: number[];
}

export interface CohortStats {
  // Overall cohort stats (from ALL role bucket)
  season: number;
  totalPlayers: number;
  totalGames: number;
  seasonAvgKp: number | null;
  seasonAvgVisPerMin: number | null;
  seasonAvgWclearPerMin: number | null;
  seasonAvgDpg: number | null;
  seasonAvgCs10: number | null;
  seasonAvgCsfull: number | null;
  seasonAvgDrakeParticipation: number | null;
  seasonAvgHeraldParticipation: number | null;
  seasonAvgBaronParticipation: number | null;
  seasonAvgObjParticipation: number | null;
  seasonAvgLaningSurvivalRate: number | null;
  seasonAvgEarlyGameDeaths: number | null;
  seasonAvgKillsNearEnemyTurret: number | null;
  seasonAvgKillsUnderOwnTurret: number | null;
  seasonAvgDeathsNearEnemyTurret: number | null;
  seasonAvgDeathsUnderOwnTurret: number | null;
  seasonAvgDamagePerGold: number | null; // may be null (not produced by v2.2 rollup)
  seasonAvgWinRate: number | null;
  // Role-based breakdown
  roleStats: RoleStats[];
}

export interface CohortQueryResult {
  stats: CohortStats | null;
  meta: PlaystyleQueryMeta;
}

export interface PlaystyleQueryResult {
  stats: PlaystyleStats | null;
  meta: PlaystyleQueryMeta;
}

interface BuildQueryOptions {
  puuid: string;
  season?: number;
  queues?: number[];
}

const DEFAULT_QUEUES = [420, 440, 400];

const BADGE_CATALOG = [
  {
    name: 'Early Game Bully',
    focus:
      'High CS at 10 minutes, strong gold per minute, and frequent solo kills that indicate laning dominance across all roles.',
  },
  {
    name: 'Teamfight Anchor',
    focus:
      'Outstanding kill participation, damage share, and low deaths that show up big in coordinated fights.',
  },
  {
    name: 'Objective Captain',
    focus:
      'Secures dragons, barons, heralds, and structures consistently to convert leads into map control.',
  },
  {
    name: 'Vision Controller',
    focus:
      'Heavy vision investment with control wards and ward takedowns that keep the map lit and safe.',
  },
  {
    name: 'Macro Farmer',
    focus:
      'Top tier CS per minute and farming efficiency to stay rich and relevant deep into games.',
  },
  {
    name: 'Skirmish Specialist',
    focus:
      'Aggressive picks, skirmishes, and turret dives reflected by high solo kills and kills near enemy structures.',
  },
  {
    name: 'Defensive Bastion',
    focus:
      'Low deaths, turret defense, and kills under own turret that stabilize shaky games.',
  },
  {
    name: 'Objective Scout',
    focus:
      'Early vision clears and scuttle control to set up for neutral objectives and river dominance.',
  },
  {
    name: 'Lane Survivor',
    focus:
      'High survival rate during laning phase with minimal early game deaths, showing strong positioning and safety.',
  },
  {
    name: 'Versatile Player',
    focus:
      'Adapts playstyle across multiple roles while maintaining consistent performance metrics.',
  },
];

function escapeLiteral(value: string) {
  return value.replace(/'/g, "''");
}

function parseSeason(scope?: string | null): number | undefined {
  if (!scope) return undefined;
  const match = scope.match(/(19|20)\d{2}/);
  if (!match) return undefined;
  const year = Number(match[0]);
  return Number.isFinite(year) ? year : undefined;
}

function buildPlaystyleStatsQuery({ puuid }: BuildQueryOptions): string {
  const safePuuid = escapeLiteral(puuid);
  return `
-- Player rollup aligned to cohorts v2 + laning turret proximity.
WITH
params AS (
  SELECT 840000 AS laning_cutoff_ms, 750 AS turret_radius  -- 14:00, 750 units
),

user_games AS (
  SELECT
    CAST(m.matchid AS VARCHAR)                             AS game_id,
    p.participantid                                        AS participant_id,
    p.teamid                                               AS team_id,
    COALESCE(NULLIF(p.teamposition, ''), 'UNKNOWN')        AS role,
    m.info.gameduration                                    AS game_duration_sec,
    p.kills, p.deaths, p.assists,
    (p.totalminionskilled + COALESCE(p.neutralminionskilled, 0)) AS cs_total,
    p.timeplayed                                           AS time_played_sec,
    p.visionscore                                          AS vision_score,
    p.wardskilled                                          AS wards_cleared,
    p.goldearned                                           AS gold_earned,
    p.totaldamagedealttochampions                          AS total_damage_to_champions,
    p.detectorwardsplaced                                  AS control_wards_placed,
    p.sightwardsboughtingame                               AS sight_wards_bought,
    p.visionwardsboughtingame                              AS vision_wards_bought,
    CAST(p.win AS INTEGER)                                 AS win_flag,
    -- team aggregates for KP / team damage share
    SUM(p.kills) OVER (PARTITION BY m.matchid, p.teamid)   AS team_total_kills,
    SUM(p.totaldamagedealttochampions)
      OVER (PARTITION BY m.matchid, p.teamid)              AS team_total_damage_to_champions
  FROM lol.raw_matches AS m
  CROSS JOIN UNNEST(m.info.participants) AS u(p)
  WHERE
    p.puuid = '${safePuuid}'
    AND season = 2025
    AND patch LIKE '15.%'
    AND queue IN (420, 440, 400)
),

-- CS@10 (per minute) + early lane counters + objective participation (boolean per game)
timeline_metrics AS (
  SELECT
    ug.game_id,

    -- CS per min at 10 (same semantics as cohorts: cs10_mean)
    MAX(
      CASE
        WHEN CAST(pf_key AS INTEGER) = ug.participant_id AND f.timestamp <= 600000
        THEN (pf.minionskilled + COALESCE(pf.jungleminionskilled, 0)) / 10.0
        ELSE 0
      END
    ) AS cs10_per_min,

    -- Early lane
    COUNT_IF(ev.type = 'WARD_KILL'
             AND ev.timestamp <= 600000
             AND ev.killerid = ug.participant_id)         AS wards_cleared_early,
    COUNT_IF(ev.type = 'CHAMPION_KILL'
             AND ev.timestamp <= 600000
             AND ev.victimid = ug.participant_id)         AS early_game_deaths,
    -- Solo kills (no assistants)
    COUNT_IF(ev.type = 'CHAMPION_KILL'
             AND ev.killerid = ug.participant_id
             AND (ev.assistingparticipantids IS NULL
                  OR cardinality(ev.assistingparticipantids) = 0)) AS solo_kills,

    -- Scuttle takedowns (as killer)
    COUNT_IF(ev.type = 'ELITE_MONSTER_KILL'
             AND ev.killerid = ug.participant_id
             AND ev.monstertype = 'RIFTSCUTTLER')         AS scuttle_kills,

    -- Objective participation booleans (0/1 per game)
    MAX( CASE WHEN ev.type = 'ELITE_MONSTER_KILL'
                AND ev.monstertype = 'DRAGON'
                AND (ev.killerid = ug.participant_id
                     OR contains(ev.assistingparticipantids, ug.participant_id))
              THEN 1 ELSE 0 END ) AS drake_participation,
    MAX( CASE WHEN ev.type = 'ELITE_MONSTER_KILL'
                AND ev.monstertype = 'BARON_NASHOR'
                AND (ev.killerid = ug.participant_id
                     OR contains(ev.assistingparticipantids, ug.participant_id))
              THEN 1 ELSE 0 END ) AS baron_participation,
    MAX( CASE WHEN ev.type = 'ELITE_MONSTER_KILL'
                AND ev.monstertype = 'RIFTHERALD'
                AND (ev.killerid = ug.participant_id
                     OR contains(ev.assistingparticipantids, ug.participant_id))
              THEN 1 ELSE 0 END ) AS herald_participation

  FROM user_games ug
  JOIN lol.raw_timelines t
    ON CAST(t.matchid AS VARCHAR) = ug.game_id
  CROSS JOIN UNNEST(t.frames)                       AS u_frames(f)
  CROSS JOIN UNNEST(f.participantframes)            AS pf_unnest(pf_key, pf)
  CROSS JOIN UNNEST(f.events)                       AS ev_unnest(ev)
  GROUP BY ug.game_id
),

-- Static OUTER turrets (Summoner's Rift)
turrets AS (
  SELECT * FROM (
    VALUES
      -- team 100 (blue)
      (100, 'TOP',    'OUTER',  981 , 10441),
      (100, 'MID',    'OUTER',  5048,  4812),
      (100, 'BOTTOM', 'OUTER', 10441,   981),
      -- team 200 (red)
      (200, 'TOP',    'OUTER',  4319, 13866),
      (200, 'MID',    'OUTER',  9813,  9817),
      (200, 'BOTTOM', 'OUTER', 13866,  4319)
  ) AS t(teamid, lane, tier, x, y)
),

-- Player-involved CHAMPION_KILL events with positions, laning phase only
player_kill_death_events AS (
  SELECT
    ug.game_id,
    e.timestamp           AS ts,
    CAST(e.killerid AS INT) AS killer_pid,
    CAST(e.victimid AS INT) AS victim_pid,
    e.position.x          AS x,
    e.position.y          AS y,
    ug.participant_id,
    ug.team_id
  FROM user_games ug
  JOIN lol.raw_timelines tl
    ON CAST(tl.matchid AS VARCHAR) = ug.game_id
  CROSS JOIN UNNEST(tl.frames)        AS f(fr)
  CROSS JOIN UNNEST(fr.events)        AS ev(e)
  CROSS JOIN params p
  WHERE e."type" = 'CHAMPION_KILL'
    AND e.position.x IS NOT NULL AND e.position.y IS NOT NULL
    AND (e.killerid = ug.participant_id OR e.victimid = ug.participant_id)
    AND e.timestamp <= p.laning_cutoff_ms
),

-- Distances to nearest OWN vs ENEMY OUTER turret for each event
event_distances AS (
  SELECT
    e.game_id, e.ts, e.killer_pid, e.victim_pid, e.x, e.y, e.participant_id, e.team_id,
    MIN( sqrt( (CAST(e.x AS DOUBLE) - CAST(t_own.x AS DOUBLE)) * (CAST(e.x AS DOUBLE) - CAST(t_own.x AS DOUBLE))
             + (CAST(e.y AS DOUBLE) - CAST(t_own.y AS DOUBLE)) * (CAST(e.y AS DOUBLE) - CAST(t_own.y AS DOUBLE)) ) )
      FILTER (WHERE t_own.teamid = e.team_id AND t_own.tier = 'OUTER')  AS dist_to_own_outer,
    MIN( sqrt( (CAST(e.x AS DOUBLE) - CAST(t_opp.x AS DOUBLE)) * (CAST(e.x AS DOUBLE) - CAST(t_opp.x AS DOUBLE))
             + (CAST(e.y AS DOUBLE) - CAST(t_opp.y AS DOUBLE)) * (CAST(e.y AS DOUBLE) - CAST(t_opp.y AS DOUBLE)) ) )
      FILTER (WHERE t_opp.teamid <> e.team_id AND t_opp.tier = 'OUTER') AS dist_to_enemy_outer
  FROM player_kill_death_events e
  LEFT JOIN turrets t_own ON TRUE
  LEFT JOIN turrets t_opp ON TRUE
  GROUP BY e.game_id, e.ts, e.killer_pid, e.victim_pid, e.x, e.y, e.participant_id, e.team_id
),

-- Per-game turret-prox counters for the player
turret_prox AS (
  SELECT
    ed.game_id,
    SUM( CASE WHEN ed.killer_pid = ed.participant_id AND ed.dist_to_enemy_outer <= (SELECT turret_radius FROM params) THEN 1 ELSE 0 END ) AS kills_near_enemy_turret,
    SUM( CASE WHEN ed.killer_pid = ed.participant_id AND ed.dist_to_own_outer   <= (SELECT turret_radius FROM params) THEN 1 ELSE 0 END ) AS kills_under_own_turret,
    SUM( CASE WHEN ed.victim_pid = ed.participant_id AND ed.dist_to_enemy_outer <= (SELECT turret_radius FROM params) THEN 1 ELSE 0 END ) AS deaths_near_enemy_turret,
    SUM( CASE WHEN ed.victim_pid = ed.participant_id AND ed.dist_to_own_outer   <= (SELECT turret_radius FROM params) THEN 1 ELSE 0 END ) AS deaths_under_own_turret
  FROM event_distances ed
  GROUP BY ed.game_id
),

-- Join everything to one per-game row
per_game AS (
  SELECT
    ug.role, ug.game_id,
    ug.win_flag, ug.kills, ug.deaths, ug.assists,
    ug.team_total_kills,
    ug.total_damage_to_champions, ug.team_total_damage_to_champions, ug.time_played_sec, ug.vision_score, ug.wards_cleared,
    ug.cs_total, ug.gold_earned,

    tm.cs10_per_min,
    tm.wards_cleared_early,
    tm.early_game_deaths,
    tm.solo_kills,
    tm.scuttle_kills,
    tm.drake_participation,
    tm.baron_participation,
    tm.herald_participation,

    COALESCE(tp.kills_near_enemy_turret, 0)  AS kills_near_enemy_turret,
    COALESCE(tp.kills_under_own_turret,  0)  AS kills_under_own_turret,
    COALESCE(tp.deaths_near_enemy_turret, 0) AS deaths_near_enemy_turret,
    COALESCE(tp.deaths_under_own_turret,  0) AS deaths_under_own_turret

  FROM user_games ug
  LEFT JOIN timeline_metrics tm ON tm.game_id = ug.game_id
  LEFT JOIN turret_prox     tp ON tp.game_id = ug.game_id
)

-- Final: per-role + ALL row
SELECT
  CASE WHEN role IS NULL THEN 'ALL' ELSE role END AS role_bucket,

  COUNT(*)                                         AS games,

  -- Alignment with cohorts v2 (proportions, per-minute means, etc.)
  ROUND(AVG( CAST(win_flag AS DOUBLE) ), 4)        AS win_rate,                -- 0..1
  ROUND(AVG( CASE WHEN team_total_kills > 0
                   THEN (kills + assists) / CAST(team_total_kills AS DOUBLE)
                   ELSE NULL END ), 4)             AS kp_mean,                 -- 0..1
  ROUND(AVG( CASE WHEN time_played_sec > 0
                   THEN vision_score * 60.0 / time_played_sec
                   ELSE NULL END ), 4)             AS vis_per_min_mean,
  ROUND(AVG( CASE WHEN time_played_sec > 0
                   THEN wards_cleared * 60.0 / time_played_sec
                   ELSE NULL END ), 4)             AS wclear_per_min_mean,
  ROUND(AVG( CASE WHEN time_played_sec > 0
                   THEN total_damage_to_champions * 60.0 / time_played_sec
                   ELSE NULL END ), 2)             AS dpg_mean,                -- dmg/min
  ROUND(AVG(cs10_per_min), 2)                      AS cs10_mean,
  ROUND(AVG( CASE WHEN time_played_sec > 0
                   THEN cs_total * 60.0 / time_played_sec
                   ELSE NULL END ), 3)             AS csfull_mean,

  ROUND(AVG( CAST(drake_participation AS DOUBLE) ), 4)  AS drake_participation_mean,
  ROUND(AVG(CAST(herald_participation AS DOUBLE)), 4) AS herald_participation_mean,
  ROUND(AVG( CAST(baron_participation  AS DOUBLE) ), 4)  AS baron_participation_mean,
  ROUND(AVG( CAST(drake_participation AS DOUBLE)
           + CAST(herald_participation AS DOUBLE)
           + CAST(baron_participation  AS DOUBLE) ), 4)  AS avg_objective_participation,

  ROUND(AVG( CASE WHEN early_game_deaths = 0 THEN 1.0 ELSE 0.0 END ), 4) AS avg_laning_survival_rate,
  ROUND(AVG( CAST(early_game_deaths AS DOUBLE) ), 3)                      AS avg_early_game_deaths,

  -- Laning-phase turret proximity (counts per game)
  ROUND(AVG( CAST(kills_near_enemy_turret  AS DOUBLE) ), 3) AS kills_near_enemy_turret_mean,
  ROUND(AVG( CAST(kills_under_own_turret   AS DOUBLE) ), 3) AS kills_under_own_turret_mean,
  ROUND(AVG( CAST(deaths_near_enemy_turret AS DOUBLE) ), 3) AS deaths_near_enemy_turret_mean,
  ROUND(AVG( CAST(deaths_under_own_turret  AS DOUBLE) ), 3) AS deaths_under_own_turret_mean,

  -- Extras you were already using (keep if you want them in UI)
  ROUND(AVG(kills), 2)                               AS avg_kills,
  ROUND(AVG(deaths), 2)                              AS avg_deaths,
  ROUND(AVG(assists), 2)                             AS avg_assists,
  ROUND(AVG( CASE WHEN deaths > 0
                   THEN (kills + assists) / CAST(deaths AS DOUBLE)
                   ELSE kills + assists END ), 2)    AS avg_kda,
  ROUND(AVG( CASE WHEN team_total_kills > 0
                   THEN (kills + assists) / CAST(team_total_kills AS DOUBLE) * 100
                   ELSE NULL END ), 2)               AS avg_kill_participation_pct,  -- % form
  ROUND(AVG( CASE WHEN team_total_kills > 0
                   THEN (kills + assists) / CAST(team_total_kills AS DOUBLE)
                   ELSE NULL END ), 4)               AS avg_kill_participation_prop, -- 0..1 form
  ROUND(AVG( CASE WHEN time_played_sec > 0
                   THEN total_damage_to_champions * 60.0 / time_played_sec
                   ELSE NULL END ), 2)               AS avg_damage_per_minute,       -- = dpg_mean
  ROUND(AVG( CASE WHEN team_total_damage_to_champions > 0
                   THEN CAST(total_damage_to_champions AS DOUBLE) / team_total_damage_to_champions * 100
                   ELSE NULL END ), 2)               AS avg_team_damage_pct,
  ROUND(AVG( CASE WHEN time_played_sec > 0
                   THEN gold_earned * 60.0 / time_played_sec
                   ELSE NULL END ), 2)               AS avg_gold_per_minute,
  ROUND(AVG( CASE WHEN time_played_sec > 0
                   THEN vision_score * 60.0 / time_played_sec
                   ELSE NULL END ), 3)               AS avg_vision_score_per_minute,
  ROUND(AVG(wards_cleared), 2)                       AS avg_wards_cleared,
  ROUND(AVG(wards_cleared_early), 2)                 AS avg_wards_cleared_early,
  ROUND(AVG(solo_kills), 2)                          AS avg_solo_kills,
  ROUND(AVG(scuttle_kills), 2)                       AS avg_scuttle_kills,

  -- Role distribution only on ALL row
  CASE
    WHEN role IS NULL THEN (
      SELECT CAST(
        map_agg(rrole, rcount * 100.0 / NULLIF(tgames, 0))
        AS JSON
      )
      FROM (
        SELECT role AS rrole, COUNT(*) AS rcount
        FROM user_games
        GROUP BY role
      ) rd
      CROSS JOIN (SELECT COUNT(*) AS tgames FROM user_games) tg
    )
    ELSE NULL
  END AS role_distribution_pct

FROM per_game
GROUP BY GROUPING SETS ( (role), () )
ORDER BY
  CASE WHEN role IS NULL THEN 0 ELSE 1 END,  -- ALL row first
  role;
`;
}

function toNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export async function getPlaystyleStats(
  puuid: string,
  options: { scope?: string | null; queues?: number[] } = {},
): Promise<PlaystyleQueryResult> {
  const season = options.scope ? parseSeason(options.scope) : undefined;
  const sql = buildPlaystyleStatsQuery({
    puuid,
    season,
    queues: options.queues,
  });

  console.log(sql);

  const { queryExecutionId, records, statistics } = await runAthenaQuery({
    query: sql,
  });

  // Process all role records
  const roleStats: RoleStats[] = records.map((record) => ({
    roleBucket: record.role_bucket || '',
    games: Number.parseInt(record.games ?? '0', 10) || 0,
    winRate: toNumber(record.win_rate),
    kpMean: toNumber(record.kp_mean),
    visPerMinMean: toNumber(record.vis_per_min_mean),
    wclearPerMinMean: toNumber(record.wclear_per_min_mean),
    dpgMean: toNumber(record.dpg_mean),
    cs10Mean: toNumber(record.cs10_mean),
    csfullMean: toNumber(record.csfull_mean),
    drakeParticipationMean: toNumber(record.drake_participation_mean),
    heraldParticipationMean: toNumber(record.herald_participation_mean),
    baronParticipationMean: toNumber(record.baron_participation_mean),
    avgObjectiveParticipation: toNumber(record.avg_objective_participation),
    avgLaningSurvivalRate: toNumber(record.avg_laning_survival_rate),
    avgEarlyGameDeaths: toNumber(record.avg_early_game_deaths),
    killsNearEnemyTurretMean: toNumber(record.kills_near_enemy_turret_mean),
    killsUnderOwnTurretMean: toNumber(record.kills_under_own_turret_mean),
    deathsNearEnemyTurretMean: toNumber(record.deaths_near_enemy_turret_mean),
    deathsUnderOwnTurretMean: toNumber(record.deaths_under_own_turret_mean),
    avgKills: toNumber(record.avg_kills),
    avgDeaths: toNumber(record.avg_deaths),
    avgAssists: toNumber(record.avg_assists),
    avgKda: toNumber(record.avg_kda),
    avgKillParticipationPct: toNumber(record.avg_kill_participation_pct),
    avgKillParticipationProp: toNumber(record.avg_kill_participation_prop),
    avgDamagePerMinute: toNumber(record.avg_damage_per_minute),
    avgTeamDamagePct: toNumber(record.avg_team_damage_pct),
    avgGoldPerMinute: toNumber(record.avg_gold_per_minute),
    avgVisionScorePerMinute: toNumber(record.avg_vision_score_per_minute),
    avgWardsCleared: toNumber(record.avg_wards_cleared),
    avgWardsClearedEarly: toNumber(record.avg_wards_cleared_early),
    avgSoloKills: toNumber(record.avg_solo_kills),
    avgScuttleKills: toNumber(record.avg_scuttle_kills),
    avgDamagePerGold: toNumber(record.avg_damage_per_gold), // may be undefined -> null
    roleDistributionPct: record.role_distribution_pct
      ? JSON.parse(record.role_distribution_pct)
      : null,
  }));

  // Find the "ALL" role bucket for overall stats
  const allRoleRecord = roleStats.find((role) => role.roleBucket === 'ALL');

  const stats: PlaystyleStats | null = allRoleRecord
    ? {
        matchesPlayed: allRoleRecord.games,
        winRate: allRoleRecord.winRate,
        avgGameDurationMin: null, // Not available in new structure
        avgKills: allRoleRecord.avgKills,
        avgDeaths: allRoleRecord.avgDeaths,
        avgAssists: allRoleRecord.avgAssists,
        avgKda: allRoleRecord.avgKda,
        avgKillParticipation: allRoleRecord.kpMean,
        avgDamagePerMinute: allRoleRecord.avgDamagePerMinute,
        avgTeamDamagePct: allRoleRecord.avgTeamDamagePct,
        avgGoldPerMinute: allRoleRecord.avgGoldPerMinute,
        avgCsPerMinute: allRoleRecord.csfullMean,
        avgCsAt10: allRoleRecord.cs10Mean,
        avgVisionScorePerMinute: allRoleRecord.avgVisionScorePerMinute,
        avgControlWards: null, // Not available in new structure
        avgWardsCleared: allRoleRecord.avgWardsCleared,
        avgWardsClearedEarly: allRoleRecord.avgWardsClearedEarly,
        avgSoloKills: allRoleRecord.avgSoloKills,
        avgTurretTakedowns: null, // Not available in new structure
        avgInhibitorTakedowns: null, // Not available in new structure
        avgObjectiveTakedowns: null, // Not available in new structure
        avgScuttleKills: allRoleRecord.avgScuttleKills,
        avgKillsNearEnemyTurret: allRoleRecord.killsNearEnemyTurretMean,
        avgKillsUnderOwnTurret: allRoleRecord.killsUnderOwnTurretMean,
        // New comprehensive metrics
        avgLaningSurvivalRate: allRoleRecord.avgLaningSurvivalRate,
        avgEarlyGameDeaths: allRoleRecord.avgEarlyGameDeaths,
        avgObjectiveParticipation: allRoleRecord.avgObjectiveParticipation,
        avgDragonParticipation: allRoleRecord.drakeParticipationMean,
        avgBaronParticipation: allRoleRecord.baronParticipationMean,
        avgHeraldParticipation: allRoleRecord.heraldParticipationMean,
        roleDistribution: allRoleRecord.roleDistributionPct,
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
      season: season ?? null,
      queues: options.queues?.length ? options.queues : DEFAULT_QUEUES,
    },
  };
}

function buildCohortStatsQuery(): string {
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

export async function getCohortStats(): Promise<CohortQueryResult> {
  const sql = buildCohortStatsQuery();

  console.log(sql);

  const { queryExecutionId, records, statistics } = await runAthenaQuery({
    query: sql,
  });

  // Process all role records
  const roleStats: RoleStats[] = records.map((record) => ({
    roleBucket: record.role_bucket || '',
    games: Number.parseInt(record.matches_est ?? '0', 10) || 0,
    winRate: toNumber(record.avg_win_rate),
    kpMean: toNumber(record.avg_kp),
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
    avgTeamDamagePct: toNumber(record.avg_team_damage_pct),
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

export function buildPlaystyleBadgePrompt(stats: PlaystyleStats): string {
  const statsForPrompt = {
    ...stats,
  };
  const statsJson = JSON.stringify(statsForPrompt, null, 2);
  const catalog = BADGE_CATALOG.map(
    (badge, idx) => `${idx + 1}. ${badge.name} – ${badge.focus}`,
  ).join('\n');

  return [
    "You are RiftCoach's playstyle scout. Review the aggregated ranked match metrics across all roles and pick the three badges that best describe the player's comprehensive playstyle.",
    'Badge catalog:',
    catalog,
    'Analysis guidelines:',
    '- Consider metrics across all roles the player has played, not just one specific role.',
    '- Pay special attention to new comprehensive metrics like laning survival rate, early game deaths, objective participation, and role distribution.',
    '- Prioritise badges where the relevant metrics clearly stand out versus typical player averages.',
    '- Use the roleDistribution data to understand if the player is versatile across multiple roles.',
    '- Consider survival metrics (avgLaningSurvivalRate, avgEarlyGameDeaths) for defensive playstyles.',
    '- Evaluate objective participation metrics (avgDragonParticipation, avgBaronParticipation, avgHeraldParticipation) for macro-focused playstyles.',
    '- Never fabricate stats; use only what is provided.',
    '- Prefer variety: avoid picking badges that describe the exact same behaviour unless the stats overwhelmingly point to a single archetype.',
    'Output JSON with this shape: {"badges": [{"name": string, "summary": string, "confidence": number, "supportingStats": string[]}], "notes": string }.',
    '- confidence is a 0-100 score based on how strongly the metrics support the badge.',
    '- supportingStats should reference specific metric names and values that justify the badge.',
    "- notes should explain any interesting patterns in the player's cross-role performance.",
    'Player comprehensive stats (JSON):',
    statsJson,
  ].join('\n\n');
}
