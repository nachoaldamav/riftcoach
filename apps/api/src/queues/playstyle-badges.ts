import { promisify } from 'node:util';
import { gunzipSync, gzip as gzipCallback } from 'node:zlib';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import chalk from 'chalk';
import { consola } from 'consola';
import { s3Client } from '../clients/s3.js';
import { runAthenaQuery } from '../utils/run-athena-query.js';

const gzip = promisify(gzipCallback);

// AWS Bedrock client for AI model invocation
const bedrockClient = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || 'eu-west-1',
});

// S3 bucket for caching
const CACHE_BUCKET = process.env.S3_BUCKET || 'riftcoach';
const CACHE_TTL_HOURS = 24; // 1 day TTL

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

// S3 caching utilities
interface CacheMetadata {
  cachedAt: string;
  expiresAt: string;
  version: string;
}

interface CachedData<T> {
  data: T;
  metadata: CacheMetadata;
}

function getCacheKey(
  type: 'player-stats' | 'ai-results',
  puuid: string,
  scope?: string,
): string {
  const scopeStr = scope || 'default';
  return `cache/${type}/puuid=${puuid}/scope=${scopeStr}/data.json.gz`;
}

function isExpired(expiresAt: string): boolean {
  return new Date() > new Date(expiresAt);
}

async function getCachedData<T>(cacheKey: string): Promise<T | null> {
  try {
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: CACHE_BUCKET,
        Key: cacheKey,
      }),
    );

    if (!response.Body) {
      return null;
    }

    const buffer = Buffer.from(await response.Body.transformToByteArray());
    const decompressed = gunzipSync(buffer);
    const cached: CachedData<T> = JSON.parse(decompressed.toString('utf8'));

    if (isExpired(cached.metadata.expiresAt)) {
      consola.debug(chalk.gray(`Cache expired for key: ${cacheKey}`));
      return null;
    }

    consola.debug(chalk.green(`Cache hit for key: ${cacheKey}`));
    return cached.data;
  } catch (error: unknown) {
    const err = error as Error;
    if (err.name === 'NoSuchKey') {
      consola.debug(chalk.gray(`Cache miss for key: ${cacheKey}`));
      return null;
    }
    consola.warn(chalk.yellow(`Failed to get cached data: ${err.message}`));
    return null;
  }
}

async function setCachedData<T>(cacheKey: string, data: T): Promise<void> {
  try {
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + CACHE_TTL_HOURS * 60 * 60 * 1000,
    );

    const cachedData: CachedData<T> = {
      data,
      metadata: {
        cachedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        version: '1.0.0',
      },
    };

    const jsonString = JSON.stringify(cachedData);
    const compressed = await gzip(jsonString);

    await s3Client.send(
      new PutObjectCommand({
        Bucket: CACHE_BUCKET,
        Key: cacheKey,
        Body: compressed,
        ContentType: 'application/json',
        ContentEncoding: 'gzip',
        Metadata: {
          'cache-version': '1.0.0',
          'cached-at': now.toISOString(),
          'expires-at': expiresAt.toISOString(),
        },
      }),
    );

    consola.debug(chalk.blue(`Cached data for key: ${cacheKey}`));
  } catch (error: unknown) {
    const err = error as Error;
    consola.warn(chalk.yellow(`Failed to cache data: ${err.message}`));
  }
}

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
-- FIXES in this version:
--  1) Use explicit column aliases in UNNEST to avoid COLUMN_NOT_FOUND (Trino/Athena requirement)
--  2) Rename thorret_prox -> turret_prox
--  3) Keep KP as proportion (0..1) and solo-kill inflation fix (separate frames vs events)

WITH
params AS (
SELECT 840000 AS laning_cutoff_ms, 750 AS turret_radius  -- 14:00, 750 units
),

user_participants AS (
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
CAST(p.win AS INTEGER)                                 AS win_flag
FROM lol.raw_matches AS m
CROSS JOIN UNNEST(m.info.participants) AS u(p)
WHERE
p.puuid = '${safePuuid}'
AND season = 2025
AND patch LIKE '15.%'
AND queue IN (420, 440, 400)
),

all_participants_in_user_games AS (
SELECT
CAST(m.matchid AS VARCHAR) AS game_id,
p.teamid,
p.kills,
p.totaldamagedealttochampions
FROM lol.raw_matches m
CROSS JOIN UNNEST(m.info.participants) AS u(p)
WHERE CAST(m.matchid AS VARCHAR) IN (SELECT game_id FROM user_participants)
),

team_totals AS (
SELECT
game_id,
teamid,
SUM(kills) AS team_total_kills,
SUM(totaldamagedealttochampions) AS team_total_damage_to_champions
FROM all_participants_in_user_games
GROUP BY game_id, teamid
),

user_games AS (
SELECT
up.*,
tt.team_total_kills,
tt.team_total_damage_to_champions
FROM user_participants up
JOIN team_totals tt ON tt.game_id = up.game_id AND tt.teamid = up.team_id
),

-- Map participant -> team for the user's games
participants_map AS (
WITH deduped_participants AS (
SELECT
CAST(m.matchid AS VARCHAR) AS game_id,
p.participantid,
p.teamid,
ROW_NUMBER() OVER (PARTITION BY m.matchid, p.participantid) AS rn
FROM lol.raw_matches AS m
CROSS JOIN UNNEST(m.info.participants) AS u(p)
WHERE CAST(m.matchid AS VARCHAR) IN (SELECT game_id FROM user_participants)
)
SELECT
game_id,
map_agg(CAST(participantid AS INT), CAST(teamid AS INT)) AS team_map
FROM deduped_participants
WHERE rn = 1
GROUP BY game_id
),

-- CS@10 only (per player, per game) — uses participantframes (requires explicit aliasing)
cs10_metrics AS (
SELECT
ug.game_id,
ug.participant_id,
MAX(
CASE
WHEN CAST(pf_key AS INTEGER) = ug.participant_id AND fr.timestamp <= 600000
THEN (pf.minionskilled + COALESCE(pf.jungleminionskilled, 0)) / 10.0
ELSE 0
END
) AS cs10_per_min
FROM user_games ug
JOIN lol.raw_timelines t
ON CAST(t.matchid AS VARCHAR) = ug.game_id
CROSS JOIN UNNEST(t.frames) AS u_frames(fr)
CROSS JOIN UNNEST(fr.participantframes) AS pf_unnest(pf_key, pf)
GROUP BY ug.game_id, ug.participant_id
),

-- Event metrics only (no participantframes join) — avoids event inflation
event_metrics AS (
SELECT
ug.game_id,
ug.participant_id,


-- early lane
COUNT_IF(e.type = 'WARD_KILL'     AND e.timestamp <= 600000 AND CAST(e.killerid AS INT) = ug.participant_id) AS wards_cleared_early,
COUNT_IF(e.type = 'CHAMPION_KILL' AND e.timestamp <= 600000 AND CAST(e.victimid AS INT) = ug.participant_id) AS early_game_deaths,

-- solo kills (full game)
COUNT_IF(
  e.type = 'CHAMPION_KILL'
  AND CAST(e.killerid AS INT) = ug.participant_id
  AND (e.assistingparticipantids IS NULL OR cardinality(e.assistingparticipantids) = 0)
  AND CAST(e.killerid AS INT) BETWEEN 1 AND 10
) AS solo_kills,

-- scuttles
COUNT_IF(
  e.type = 'ELITE_MONSTER_KILL' AND CAST(e.killerid AS INT) = ug.participant_id AND e.monstertype = 'RIFTSCUTTLER'
) AS scuttle_kills,

-- KP events (player involved in a team kill)
COUNT_IF(
  e.type = 'CHAMPION_KILL'
  AND (
    CAST(e.killerid AS INT) = ug.participant_id OR contains(e.assistingparticipantids, ug.participant_id)
  )
  AND CAST(e.killerid AS INT) BETWEEN 1 AND 10
) AS kp_events,

-- Team kill events (kills credited to player's team)
COUNT_IF(
  e.type = 'CHAMPION_KILL'
  AND CAST(e.killerid AS INT) BETWEEN 1 AND 10
  AND pm.team_map[CAST(e.killerid AS INT)] = ug.team_id
) AS team_kill_events,

-- Objectives (0/1 per game)
MAX(CASE WHEN e.type = 'ELITE_MONSTER_KILL' AND e.monstertype = 'DRAGON'       AND (CAST(e.killerid AS INT) = ug.participant_id OR contains(e.assistingparticipantids, ug.participant_id)) THEN 1 ELSE 0 END) AS drake_participation,
MAX(CASE WHEN e.type = 'ELITE_MONSTER_KILL' AND e.monstertype = 'BARON_NASHOR' AND (CAST(e.killerid AS INT) = ug.participant_id OR contains(e.assistingparticipantids, ug.participant_id)) THEN 1 ELSE 0 END) AS baron_participation,
MAX(CASE WHEN e.type = 'ELITE_MONSTER_KILL' AND e.monstertype = 'RIFTHERALD'   AND (CAST(e.killerid AS INT) = ug.participant_id OR contains(e.assistingparticipantids, ug.participant_id)) THEN 1 ELSE 0 END) AS herald_participation


FROM user_games ug
JOIN lol.raw_timelines t
ON CAST(t.matchid AS VARCHAR) = ug.game_id
CROSS JOIN UNNEST(t.frames) AS u_frames(fr)
CROSS JOIN UNNEST(fr.events) AS ev(e)
LEFT JOIN participants_map pm  ON pm.game_id = ug.game_id
GROUP BY ug.game_id, ug.participant_id
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
e.timestamp             AS ts,
CAST(e.killerid AS INT) AS killer_pid,
CAST(e.victimid AS INT) AS victim_pid,
e.position.x            AS x,
e.position.y            AS y,
ug.participant_id,
ug.team_id
FROM user_games ug
JOIN lol.raw_timelines tl
ON CAST(tl.matchid AS VARCHAR) = ug.game_id
CROSS JOIN UNNEST(tl.frames) AS tlf(fr)
CROSS JOIN UNNEST(fr.events) AS ev(e)
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

-- Per-game turret-proximity counters for the player
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

-- Merge cs10 + event metrics
timeline_metrics AS (
SELECT
em.game_id,
em.participant_id,
cm.cs10_per_min,
em.wards_cleared_early,
em.early_game_deaths,
em.solo_kills,
em.scuttle_kills,
em.drake_participation,
em.baron_participation,
em.herald_participation,
em.kp_events,
em.team_kill_events
FROM event_metrics em
LEFT JOIN cs10_metrics cm
ON cm.game_id = em.game_id AND cm.participant_id = em.participant_id
),

-- Final per-game row
per_game AS (
SELECT
ug.role, ug.game_id,
ug.win_flag, ug.kills, ug.deaths, ug.assists,
ug.team_total_kills,
ug.total_damage_to_champions,
ug.team_total_damage_to_champions,
ug.time_played_sec,
ug.vision_score,
ug.wards_cleared,
ug.cs_total,
ug.gold_earned,


tm.cs10_per_min,
tm.wards_cleared_early,
tm.early_game_deaths,
tm.solo_kills,
tm.scuttle_kills,
tm.drake_participation,
tm.baron_participation,
tm.herald_participation,
tm.kp_events,
tm.team_kill_events,

CASE
  WHEN tm.team_kill_events > 0 THEN tm.kp_events / CAST(tm.team_kill_events AS DOUBLE)
  WHEN ug.team_total_kills > 0 THEN LEAST(1.0, (ug.kills + ug.assists) / CAST(ug.team_total_kills AS DOUBLE))
  ELSE NULL
END AS kp_prop,

COALESCE(tp.kills_near_enemy_turret, 0)  AS kills_near_enemy_turret,
COALESCE(tp.kills_under_own_turret,  0)  AS kills_under_own_turret,
COALESCE(tp.deaths_near_enemy_turret, 0) AS deaths_near_enemy_turret,
COALESCE(tp.deaths_under_own_turret,  0) AS deaths_under_own_turret


FROM user_games ug
LEFT JOIN timeline_metrics tm ON tm.game_id = ug.game_id AND tm.participant_id = ug.participant_id
LEFT JOIN turret_prox     tp ON tp.game_id = ug.game_id
)

-- Final: per-role + ALL row
SELECT
CASE WHEN role IS NULL THEN 'ALL' ELSE role END AS role_bucket,

COUNT(*)                                         AS games,

-- Cohorts-aligned: proportions, per-minute means, etc.
ROUND(AVG( CAST(win_flag AS DOUBLE) ), 4)        AS win_rate,               -- 0..1
ROUND(AVG(kp_prop), 4)                           AS kp_mean,                -- 0..1
ROUND(AVG( CASE WHEN time_played_sec > 0
THEN vision_score * 60.0 / time_played_sec
ELSE NULL END ), 4)             AS vis_per_min_mean,
ROUND(AVG( CASE WHEN time_played_sec > 0
THEN wards_cleared * 60.0 / time_played_sec
ELSE NULL END ), 4)             AS wclear_per_min_mean,
ROUND(AVG( CASE WHEN time_played_sec > 0
THEN total_damage_to_champions * 60.0 / time_played_sec
ELSE NULL END ), 2)             AS dpg_mean,
ROUND(AVG(cs10_per_min), 2)                      AS cs10_mean,
ROUND(AVG( CASE WHEN time_played_sec > 0
THEN cs_total * 60.0 / time_played_sec
ELSE NULL END ), 3)             AS csfull_mean,

ROUND(AVG( CAST(drake_participation AS DOUBLE) ), 4)  AS drake_participation_mean,
ROUND(AVG( CAST(herald_participation AS DOUBLE)), 4)  AS herald_participation_mean,
ROUND(AVG( CAST(baron_participation  AS DOUBLE) ), 4) AS baron_participation_mean,
ROUND(AVG( CAST(drake_participation AS DOUBLE)
+ CAST(herald_participation AS DOUBLE)
+ CAST(baron_participation  AS DOUBLE) ), 4) AS avg_objective_participation,

ROUND(AVG( CASE WHEN early_game_deaths = 0 THEN 1.0 ELSE 0.0 END ), 4) AS avg_laning_survival_rate,
ROUND(AVG( CAST(early_game_deaths AS DOUBLE) ), 3)                      AS avg_early_game_deaths,

-- Laning-phase turret proximity (counts per game)
ROUND(AVG( CAST(kills_near_enemy_turret  AS DOUBLE) ), 3) AS kills_near_enemy_turret_mean,
ROUND(AVG( CAST(kills_under_own_turret   AS DOUBLE) ), 3) AS kills_under_own_turret_mean,
ROUND(AVG( CAST(deaths_near_enemy_turret AS DOUBLE) ), 3) AS deaths_near_enemy_turret_mean,
ROUND(AVG( CAST(deaths_under_own_turret  AS DOUBLE) ), 3) AS deaths_under_own_turret_mean,

-- Extras for UI
ROUND(AVG(kills), 2)                               AS avg_kills,
ROUND(AVG(deaths), 2)                              AS avg_deaths,
ROUND(AVG(assists), 2)                             AS avg_assists,
ROUND(AVG( CASE WHEN deaths > 0
THEN (kills + assists) / CAST(deaths AS DOUBLE)
ELSE kills + assists END ), 2)    AS avg_kda,
ROUND(AVG(kp_prop) * 100.0, 2)                     AS avg_kill_participation_pct,  -- display
ROUND(AVG(kp_prop), 4)                             AS avg_kill_participation_prop, -- 0..1
ROUND(AVG( CASE WHEN time_played_sec > 0
THEN total_damage_to_champions * 60.0 / time_played_sec
ELSE NULL END ), 2)               AS avg_damage_per_minute,
ROUND(AVG( CASE WHEN team_total_damage_to_champions > 0
THEN CAST(total_damage_to_champions AS DOUBLE) / team_total_damage_to_champions
ELSE NULL END ), 4)               AS avg_team_damage_pct,
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
map_agg(rrole, rcount * 100.0 / NULLIF(tgames, 0)) AS JSON
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

function normalizePercentish(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  // If it looks like a percentage (> 1), coerce to proportion
  return v > 1 ? v / 100 : v;
}

function toDisplayPercent(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const pct = v > 1 ? v : v * 100;
  return `${pct.toFixed(digits)}%`;
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
        avgKillParticipation: allRoleRecord.avgKillParticipationProp,
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

// AI Badge Generation
interface AIBadgeResult {
  badges: Array<{
    name: string;
    description: string;
    confidence: number;
    reasoning: string;
  }>;
  summary: string;
  strengths: string[];
  improvements: string[];
}

// Enhanced data structure for AI analysis
interface StatComparison {
  value: number;
  cohortAverage: number;
  percentageDifference: number;
  isAboveAverage: boolean;
  significance: 'much_higher' | 'higher' | 'similar' | 'lower' | 'much_lower';
  roleWeightedValue?: number;
  roleWeightedAverage?: number;
}

interface EnhancedPlayerAnalysis {
  playerStats: PlaystyleStats;
  cohortStats: CohortStats;
  roleWeights: { [role: string]: number };
  primaryRole: string;
  secondaryRole?: string;
  comparisons: {
    killParticipation: StatComparison | null;
    visionScorePerMinute: StatComparison | null;
    damagePerMinute: StatComparison | null;
    teamDamagePercent: StatComparison | null;
    goldPerMinute: StatComparison | null;
    csPerMinute: StatComparison | null;
    winRate: StatComparison | null;
    kda: StatComparison | null;
    objectiveParticipation: StatComparison | null;
    laningSurvivalRate: StatComparison | null;
    earlyGameDeaths: StatComparison | null;
    soloKills: StatComparison | null;
    wardsCleared: StatComparison | null;
    dragonParticipation: StatComparison | null;
    baronParticipation: StatComparison | null;
    heraldParticipation: StatComparison | null;
  };
  roleSpecificInsights: {
    [role: string]: {
      gamesPlayed: number;
      percentage: number;
      keyStrengths: string[];
      keyWeaknesses: string[];
    };
  };
}

interface FormattedStatLine {
  statName: string;
  role: string;
  playerValue: number;
  cohortValue: number;
  weight: number;
  percentageDiff: number;
  significance: 'much_higher' | 'higher' | 'similar' | 'lower' | 'much_lower';
}

function formatStatsForAI(analysis: EnhancedPlayerAnalysis): string[] {
  const formattedLines: string[] = [];

  // Get all roles except 'ALL' and sort by weight (highest first)
  const rolesByWeight = Object.entries(analysis.roleWeights)
    .filter(([role]) => role !== 'ALL')
    .sort(([, a], [, b]) => b - a);

  // Key stats to analyze per role
  const keyStats: Array<{
    statKey: keyof RoleStats;
    displayName: string;
    isPercentage?: boolean;
  }> = [
    {
      statKey: 'kpMean',
      displayName: 'Kill Participation',
      isPercentage: true,
    },
    { statKey: 'visPerMinMean', displayName: 'Vision Score/Min' },
    { statKey: 'dpgMean', displayName: 'Damage/Min' },
    { statKey: 'csfullMean', displayName: 'CS/Min' },
    { statKey: 'winRate', displayName: 'Win Rate', isPercentage: true },
    { statKey: 'avgKda', displayName: 'KDA' },
    {
      statKey: 'avgTeamDamagePct',
      displayName: 'Team Damage %',
      isPercentage: true,
    },
    { statKey: 'avgGoldPerMinute', displayName: 'Gold/Min' },
    { statKey: 'avgSoloKills', displayName: 'Solo Kills' },
    { statKey: 'avgWardsCleared', displayName: 'Wards Cleared' },
  ];

  // Process each role
  for (const [role, weight] of rolesByWeight) {
    if (weight < 0.05) continue; // Skip roles with less than 5% play time

    const playerRoleStats = analysis.playerStats.roleStats.find(
      (rs) => rs.roleBucket === role,
    );
    const cohortRoleStats = analysis.cohortStats.roleStats.find(
      (rs) => rs.roleBucket === role,
    );

    if (!playerRoleStats || !cohortRoleStats) continue;

    // Process each stat for this role
    for (const stat of keyStats) {
      const playerValue = playerRoleStats[stat.statKey] as number | null;
      const cohortValue = cohortRoleStats[stat.statKey] as number | null;

      if (playerValue === null || cohortValue === null || cohortValue === 0)
        continue;

      // For percent-ish metrics, compute on normalized proportions
      let pForMath = playerValue;
      let cForMath = cohortValue;
      if (stat.isPercentage) {
        pForMath = normalizePercentish(playerValue) || 0;
        cForMath = normalizePercentish(cohortValue) || 0;
      }
      const percentageDiff = ((pForMath - cForMath) / cForMath) * 100;
      const significance = calculateSignificance(percentageDiff);

      // Only include significant differences or high-weight roles
      if (Math.abs(percentageDiff) >= 10 || weight >= 0.3) {
        const playerDisplay = stat.isPercentage
          ? toDisplayPercent(pForMath)
          : pForMath.toFixed(2);
        const cohortDisplay = stat.isPercentage
          ? toDisplayPercent(cForMath)
          : cForMath.toFixed(2);

        formattedLines.push(
          `${stat.displayName}:${role} | ${playerDisplay} - ${cohortDisplay} | ${(weight * 100).toFixed(0)}% (${percentageDiff >= 0 ? '+' : ''}${percentageDiff.toFixed(1)}%, ${significance})`,
        );
      }
    }
  }

  // Add overall weighted averages for key metrics
  const overallStats = [
    {
      name: 'Overall Kill Participation',
      comparison: analysis.comparisons.killParticipation,
    },
    {
      name: 'Overall Vision Score/Min',
      comparison: analysis.comparisons.visionScorePerMinute,
    },
    {
      name: 'Overall Damage/Min',
      comparison: analysis.comparisons.damagePerMinute,
    },
    {
      name: 'Overall Win Rate',
      comparison: analysis.comparisons.winRate,
    },
  ];

  formattedLines.push(''); // Separator
  formattedLines.push('=== WEIGHTED OVERALL PERFORMANCE ===');

  for (const stat of overallStats) {
    if (
      stat.comparison &&
      Math.abs(stat.comparison.percentageDifference) >= 5
    ) {
      const weightedInfo =
        stat.comparison.roleWeightedValue && stat.comparison.roleWeightedAverage
          ? ` | Weighted: ${stat.comparison.roleWeightedValue.toFixed(2)} - ${stat.comparison.roleWeightedAverage.toFixed(2)}`
          : '';

      formattedLines.push(
        `${stat.name} | ${stat.comparison.value.toFixed(2)} - ${stat.comparison.cohortAverage.toFixed(2)} | (${stat.comparison.percentageDifference >= 0 ? '+' : ''}${stat.comparison.percentageDifference.toFixed(1)}%, ${stat.comparison.significance})${weightedInfo}`,
      );
    }
  }

  return formattedLines;
}

function createRoleSpecificInsights(
  analysis: EnhancedPlayerAnalysis,
): string[] {
  const insights: string[] = [];

  const rolesByWeight = Object.entries(analysis.roleWeights)
    .filter(([role]) => role !== 'ALL')
    .sort(([, a], [, b]) => b - a);

  insights.push('=== ROLE-SPECIFIC ANALYSIS ===');

  for (const [role, weight] of rolesByWeight) {
    if (weight < 0.05) continue;

    const roleInsight = analysis.roleSpecificInsights[role];
    if (!roleInsight) continue;

    insights.push(
      `\n${role.toUpperCase()} (${roleInsight.percentage}% of games, ${roleInsight.gamesPlayed} matches):`,
    );

    if (roleInsight.keyStrengths.length > 0) {
      insights.push(`  Strengths: ${roleInsight.keyStrengths.join(', ')}`);
    }

    if (roleInsight.keyWeaknesses.length > 0) {
      insights.push(`  Weaknesses: ${roleInsight.keyWeaknesses.join(', ')}`);
    }
  }

  return insights;
}

function calculateSignificance(
  percentageDifference: number,
): 'much_higher' | 'higher' | 'similar' | 'lower' | 'much_lower' {
  if (percentageDifference >= 25) return 'much_higher';
  if (percentageDifference >= 10) return 'higher';
  if (percentageDifference >= -10) return 'similar';
  if (percentageDifference >= -25) return 'lower';
  return 'much_lower';
}

function createStatComparison(
  playerValue: number | null,
  cohortValue: number | null,
  roleWeightedPlayerValue?: number | null,
  roleWeightedCohortValue?: number | null,
): StatComparison | null {
  if (playerValue === null || cohortValue === null || cohortValue === 0) {
    return null;
  }

  const percentageDifference =
    ((playerValue - cohortValue) / cohortValue) * 100;
  const isAboveAverage = playerValue > cohortValue;
  const significance = calculateSignificance(percentageDifference);

  return {
    value: playerValue,
    cohortAverage: cohortValue,
    percentageDifference: Math.round(percentageDifference * 100) / 100,
    isAboveAverage,
    significance,
    roleWeightedValue: roleWeightedPlayerValue || undefined,
    roleWeightedAverage: roleWeightedCohortValue || undefined,
  };
}

function calculateRoleWeights(
  roleDistribution: { [role: string]: number } | null,
): { [role: string]: number } {
  if (!roleDistribution) {
    return { ALL: 1.0 };
  }

  const weights: { [role: string]: number } = {};
  const totalPercentage = Object.values(roleDistribution).reduce(
    (sum, pct) => sum + pct,
    0,
  );

  for (const [role, percentage] of Object.entries(roleDistribution)) {
    weights[role] = percentage / totalPercentage;
  }

  return weights;
}

function getRoleWeightedValue(
  playerStats: PlaystyleStats,
  cohortStats: CohortStats,
  statName: keyof RoleStats,
  roleWeights: { [role: string]: number },
): { playerWeighted: number; cohortWeighted: number } | null {
  let playerWeightedSum = 0;
  let cohortWeightedSum = 0;
  let totalWeight = 0;

  for (const [role, weight] of Object.entries(roleWeights)) {
    if (role === 'ALL') continue;
    const p = playerStats.roleStats.find((rs) => rs.roleBucket === role);
    const c = cohortStats.roleStats.find((rs) => rs.roleBucket === role);
    if (!p || !c) continue;

    let pv = p[statName] as number | null;
    let cv = c[statName] as number | null;

    // Normalize percent-ish metrics to proportions
    const percentish: (keyof RoleStats)[] = [
      'kpMean',
      'winRate',
      'avgTeamDamagePct',
    ];
    if (percentish.includes(statName)) {
      pv = normalizePercentish(pv);
      cv = normalizePercentish(cv);
    }

    if (pv != null && cv != null) {
      playerWeightedSum += pv * weight;
      cohortWeightedSum += cv * weight;
      totalWeight += weight;
    }
  }

  if (totalWeight === 0) return null;
  return {
    playerWeighted: playerWeightedSum / totalWeight,
    cohortWeighted: cohortWeightedSum / totalWeight,
  };
}

function createEnhancedPlayerAnalysis(
  playerStats: PlaystyleStats,
  cohortStats: CohortStats,
): EnhancedPlayerAnalysis {
  const roleWeights = calculateRoleWeights(playerStats.roleDistribution);
  const sortedRoles = Object.entries(roleWeights)
    .filter(([role]) => role !== 'ALL')
    .sort(([, a], [, b]) => b - a);

  const primaryRole = sortedRoles[0]?.[0] || 'ALL';
  const secondaryRole = sortedRoles[1]?.[0];

  // Get role-weighted values for key stats
  const killParticipationWeighted = getRoleWeightedValue(
    playerStats,
    cohortStats,
    'kpMean',
    roleWeights,
  );
  const visionWeighted = getRoleWeightedValue(
    playerStats,
    cohortStats,
    'visPerMinMean',
    roleWeights,
  );
  const damageWeighted = getRoleWeightedValue(
    playerStats,
    cohortStats,
    'dpgMean',
    roleWeights,
  );

  const comparisons = {
    killParticipation: createStatComparison(
      normalizePercentish(playerStats.avgKillParticipation),
      normalizePercentish(cohortStats.seasonAvgKp),
      normalizePercentish(killParticipationWeighted?.playerWeighted ?? null),
      normalizePercentish(killParticipationWeighted?.cohortWeighted ?? null),
    ),
    visionScorePerMinute: createStatComparison(
      playerStats.avgVisionScorePerMinute,
      cohortStats.seasonAvgVisPerMin,
      visionWeighted?.playerWeighted,
      visionWeighted?.cohortWeighted,
    ),
    damagePerMinute: createStatComparison(
      playerStats.avgDamagePerMinute,
      cohortStats.seasonAvgDpg,
      damageWeighted?.playerWeighted,
      damageWeighted?.cohortWeighted,
    ),
    teamDamagePercent: createStatComparison(
      normalizePercentish(playerStats.avgTeamDamagePct),
      normalizePercentish(
        cohortStats.roleStats.find((rs) => rs.roleBucket === 'ALL')
          ?.avgTeamDamagePct ?? null,
      ),
    ),
    goldPerMinute: createStatComparison(
      playerStats.avgGoldPerMinute,
      cohortStats.roleStats.find((rs) => rs.roleBucket === 'ALL')
        ?.avgGoldPerMinute || null,
    ),
    csPerMinute: createStatComparison(
      playerStats.avgCsPerMinute,
      cohortStats.seasonAvgCsfull,
    ),
    winRate: createStatComparison(
      normalizePercentish(playerStats.winRate),
      normalizePercentish(cohortStats.seasonAvgWinRate),
    ),
    kda: createStatComparison(
      playerStats.avgKda,
      cohortStats.roleStats.find((rs) => rs.roleBucket === 'ALL')?.avgKda ||
        null,
    ),
    objectiveParticipation: createStatComparison(
      normalizePercentish(playerStats.avgObjectiveParticipation),
      normalizePercentish(cohortStats.seasonAvgObjParticipation),
    ),
    laningSurvivalRate: createStatComparison(
      normalizePercentish(playerStats.avgLaningSurvivalRate),
      normalizePercentish(cohortStats.seasonAvgLaningSurvivalRate),
    ),
    earlyGameDeaths: createStatComparison(
      playerStats.avgEarlyGameDeaths,
      cohortStats.seasonAvgEarlyGameDeaths,
    ),
    soloKills: createStatComparison(
      playerStats.avgSoloKills,
      cohortStats.roleStats.find((rs) => rs.roleBucket === 'ALL')
        ?.avgSoloKills || null,
    ),
    wardsCleared: createStatComparison(
      playerStats.avgWardsCleared,
      cohortStats.roleStats.find((rs) => rs.roleBucket === 'ALL')
        ?.avgWardsCleared || null,
    ),
    dragonParticipation: createStatComparison(
      normalizePercentish(playerStats.avgDragonParticipation),
      normalizePercentish(cohortStats.seasonAvgDrakeParticipation),
    ),
    baronParticipation: createStatComparison(
      normalizePercentish(playerStats.avgBaronParticipation),
      normalizePercentish(cohortStats.seasonAvgBaronParticipation),
    ),
    heraldParticipation: createStatComparison(
      normalizePercentish(playerStats.avgHeraldParticipation),
      normalizePercentish(cohortStats.seasonAvgHeraldParticipation),
    ),
  };

  // Create role-specific insights
  const roleSpecificInsights: {
    [role: string]: {
      gamesPlayed: number;
      percentage: number;
      keyStrengths: string[];
      keyWeaknesses: string[];
    };
  } = {};

  for (const [role, weight] of Object.entries(roleWeights)) {
    if (role === 'ALL' || weight < 0.05) continue; // Skip roles with less than 5% play time

    const playerRoleStats = playerStats.roleStats.find(
      (rs) => rs.roleBucket === role,
    );
    const cohortRoleStats = cohortStats.roleStats.find(
      (rs) => rs.roleBucket === role,
    );

    if (playerRoleStats && cohortRoleStats) {
      const keyStrengths: string[] = [];
      const keyWeaknesses: string[] = [];

      // Analyze key metrics for this role
      const roleComparisons = [
        {
          name: 'Kill Participation',
          player: playerRoleStats.kpMean,
          cohort: cohortRoleStats.kpMean,
        },
        {
          name: 'Vision Score/Min',
          player: playerRoleStats.visPerMinMean,
          cohort: cohortRoleStats.visPerMinMean,
        },
        {
          name: 'Damage/Min',
          player: playerRoleStats.dpgMean,
          cohort: cohortRoleStats.dpgMean,
        },
        {
          name: 'CS/Min',
          player: playerRoleStats.csfullMean,
          cohort: cohortRoleStats.csfullMean,
        },
        {
          name: 'Win Rate',
          player: playerRoleStats.winRate,
          cohort: cohortRoleStats.winRate,
        },
      ];

      for (const comp of roleComparisons) {
        if (comp.player !== null && comp.cohort !== null) {
          const diff = ((comp.player - comp.cohort) / comp.cohort) * 100;
          if (diff >= 15) {
            keyStrengths.push(`${comp.name} (+${diff.toFixed(1)}%)`);
          } else if (diff <= -15) {
            keyWeaknesses.push(`${comp.name} (${diff.toFixed(1)}%)`);
          }
        }
      }

      roleSpecificInsights[role] = {
        gamesPlayed: playerRoleStats.games,
        percentage: Math.round(weight * 100),
        keyStrengths,
        keyWeaknesses,
      };
    }
  }

  return {
    playerStats,
    cohortStats,
    roleWeights,
    primaryRole,
    secondaryRole,
    comparisons,
    roleSpecificInsights,
  };
}

async function generateAIBadges(
  stats: PlaystyleStats,
  cohortStats?: CohortStats,
): Promise<AIBadgeResult> {
  try {
    let enhancedPrompt: string;

    if (cohortStats) {
      // Create enhanced analysis with proper comparisons
      const analysis = createEnhancedPlayerAnalysis(stats, cohortStats);
      enhancedPrompt = buildEnhancedPlaystyleBadgePrompt(analysis);
    } else {
      consola.warn('No cohort stats available for enhanced analysis');
      // Fallback to basic prompt if no cohort data
      enhancedPrompt = buildPlaystyleBadgePrompt(stats);
    }

    enhancedPrompt += `\n\nPlease analyze this player's performance and provide:
1. Top 3-5 most fitting badges from the catalog with confidence scores (0-100)
2. A brief summary of their playstyle
3. Key strengths (2-3 points)
4. Areas for improvement (2-3 points)

Respond in JSON format:
{
  "badges": [
    {
      "name": "Badge Name",
      "description": "Why this badge fits",
      "confidence": 85,
      "reasoning": "Specific stats that support this badge"
    }
  ],
  "summary": "Overall playstyle description",
  "strengths": ["Strength 1", "Strength 2"],
  "improvements": ["Improvement 1", "Improvement 2"]
}`;

    const payload = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: enhancedPrompt,
        },
      ],
    };

    const command = new InvokeModelCommand({
      modelId: 'anthropic.claude-3-haiku-20240307-v1:0', // Using Claude 3 Haiku for cost efficiency
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });

    consola.debug(chalk.blue('Invoking AI model for badge generation...'));
    consola.info('Prompt', enhancedPrompt);
    const response = await bedrockClient.send(command);

    if (!response.body) {
      throw new Error('No response body from Bedrock');
    }

    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    const aiResponse = responseBody.content[0].text;

    consola.info(`AI Response: ${aiResponse}`);

    // Parse the JSON response from the AI
    const result: AIBadgeResult = JSON.parse(aiResponse);

    consola.debug(chalk.green('AI badge generation completed successfully'));
    return result;
  } catch (error: unknown) {
    const err = error as Error;
    consola.error(chalk.red('Failed to generate AI badges:'), err.message);

    // Fallback response in case of AI failure
    return {
      badges: [
        {
          name: 'Consistent Player',
          description: 'Shows steady performance across matches',
          confidence: 50,
          reasoning: 'Fallback badge due to AI generation failure',
        },
      ],
      summary: 'Analysis unavailable due to technical issues',
      strengths: ['Plays regularly', 'Maintains consistent performance'],
      improvements: ['AI analysis temporarily unavailable'],
    };
  }
}

function buildEnhancedPlaystyleBadgePrompt(
  analysis: EnhancedPlayerAnalysis,
): string {
  // Generate formatted statistics for AI
  const formattedStats = formatStatsForAI(analysis);
  const roleInsights = createRoleSpecificInsights(analysis);

  return `You are an expert League of Legends analyst tasked with generating personalized playstyle badges for a player based on their performance data and cohort comparisons.

## CRITICAL STATISTICAL INTERPRETATIONS

**ALWAYS verify the logical consistency of your badge assignments:**

1. **High values are GOOD for:** Kill Participation, Vision Score/Min, Damage/Min, CS/Min, Win Rate, KDA, Team Damage %, Gold/Min, Solo Kills, Wards Cleared, Objective Participation, Laning Survival Rate
2. **Low values are GOOD for:** Early Game Deaths, Deaths Near Enemy Turret
3. **Context matters:** A "Defensive Bastion" should have LOW deaths and HIGH survival rates, not the opposite

## BADGE ASSIGNMENT RULES

**Before assigning any badge, verify:**
- The player's stats actually support the badge's theme
- There are no contradictory statistics (e.g., low survival + "Defensive" badge)
- The reasoning aligns with the statistical evidence
- Focus on role-weighted performance, not overall averages

## FORMATTED PLAYER STATISTICS

**Format:** <Stat>:<Role> | <Player Value> - <Cohort Average> | <Role Weight>% (<Percentage Difference>, <Significance>)

${formattedStats.join('\n')}

${roleInsights.join('\n')}

## COMMON BADGE PATTERNS

**Early Game Bully:** High CS@10, Gold/Min, Solo Kills + Low Early Deaths
**Teamfight Anchor:** High KP, Team Damage%, KDA + Low Deaths
**Objective Captain:** High Dragon/Baron/Herald Participation + High Win Rate
**Vision Controller:** High Vision Score/Min, Wards Cleared + Strategic impact
**Macro Farmer:** High CS/Min, Gold/Min + Consistent performance
**Skirmish Specialist:** High Solo Kills, Kills Near Enemy Turret + Aggressive stats
**Defensive Bastion:** HIGH Survival Rate, LOW Deaths, Kills Under Own Turret
**Objective Scout:** High Early Ward Clears, Scuttle Control + Vision impact
**Lane Survivor:** HIGH Laning Survival Rate, LOW Early Game Deaths
**Versatile Player:** Consistent performance across multiple roles

## AVAILABLE BADGES
${BADGE_CATALOG.map((badge) => `- **${badge.name}**: ${badge.focus}`).join('\n')}

## TASK
Analyze this player's performance using the formatted statistics above. Focus on role-weighted performance and ignore overall averages. Generate 2-4 badges that accurately reflect their playstyle.

**CRITICAL:** 
- Use the formatted statistics to understand actual performance vs cohort
- Pay attention to role weights - higher weight roles are more representative
- Double-check that your badge reasoning matches the actual statistics
- If a stat shows "lower" or "much_lower", it means the player performs WORSE than average

CRITICAL: You MUST respond with ONLY valid JSON. Do not include any explanatory text, introductions, or conclusions. Start your response immediately with the opening brace "{" and end with the closing brace "}".

Return your analysis as a JSON object with this exact structure:
{
  "badges": [
    {
      "name": "Badge Name",
      "description": "Brief description of what this badge represents for this player",
      "confidence": 85,
      "reasoning": "Specific statistical evidence supporting this badge (cite actual numbers from the formatted stats)"
    }
  ],
  "summary": "2-3 sentence overview of the player's overall playstyle and key characteristics",
  "strengths": ["List of 2-3 key strengths based on the data"],
  "improvements": ["List of 2-3 areas for improvement based on the data"]
}`;
}

function getStatInterpretation(
  statName: string,
  isAbove: boolean,
  significance: string,
): string {
  const interpretations: { [key: string]: { above: string; below: string } } = {
    killParticipation: {
      above: '→ Strong teamfighter',
      below: '→ Plays alone/splitpush style',
    },
    visionScorePerMinute: {
      above: '→ Good map awareness',
      below: '→ Poor vision control',
    },
    damagePerMinute: {
      above: '→ High damage output',
      below: '→ Low damage contribution',
    },
    earlyGameDeaths: {
      above: '→ Dies too much early (weakness)',
      below: '→ Survives early game well (strength)',
    },
    laningSurvivalRate: {
      above: '→ Survives lane well (strength)',
      below: '→ Dies frequently in lane (weakness)',
    },
    soloKills: {
      above: '→ Strong 1v1 player',
      below: '→ Avoids duels',
    },
    objectiveParticipation: {
      above: '→ Good at securing objectives',
      below: '→ Misses objectives',
    },
    winRate: {
      above: '→ Performs well overall',
      below: '→ Struggles to win games',
    },
    teamDamagePercent: {
      above: '→ High damage share',
      below: '→ Low damage share',
    },
    goldPerMinute: {
      above: '→ Good resource generation',
      below: '→ Poor resource generation',
    },
    csPerMinute: {
      above: '→ Good farming',
      below: '→ Poor farming',
    },
    kda: {
      above: '→ Good KDA ratio',
      below: '→ Poor KDA ratio',
    },
    wardsCleared: {
      above: '→ Good vision denial',
      below: '→ Poor vision denial',
    },
    dragonParticipation: {
      above: '→ Good at dragon fights',
      below: '→ Misses dragon fights',
    },
    baronParticipation: {
      above: '→ Good at baron fights',
      below: '→ Misses baron fights',
    },
    heraldParticipation: {
      above: '→ Good at herald fights',
      below: '→ Misses herald fights',
    },
  };

  const stat = interpretations[statName];
  if (!stat) return '';

  return isAbove ? stat.above : stat.below;
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

// Cached version of generateAIBadges
export async function getCachedAIBadges(
  stats: PlaystyleStats,
  cohortStats?: CohortStats,
  puuid?: string,
): Promise<AIBadgeResult> {
  if (!puuid) {
    // If no puuid provided, generate without caching
    return generateAIBadges(stats, cohortStats);
  }

  const cacheKey = getCacheKey('ai-results', puuid);

  // try {
  //   // Try to get cached AI results first
  //   const cachedResult = await getCachedData<AIBadgeResult>(cacheKey);
  //   if (cachedResult) {
  //     consola.info(`Using cached AI badges for ${puuid}`);
  //     return cachedResult;
  //   }
  // } catch (error) {
  //   consola.warn(`Failed to retrieve cached AI badges for ${puuid}:`, error);
  // }

  // If no cache or cache failed, generate fresh AI badges
  consola.info(`Generating fresh AI badges for ${puuid}`);
  const result = await generateAIBadges(stats, cohortStats);

  // Cache the result
  try {
    await setCachedData(cacheKey, result);
    consola.info(`Cached AI badges for ${puuid}`);
  } catch (error) {
    consola.warn(`Failed to cache AI badges for ${puuid}:`, error);
  }

  return result;
}
