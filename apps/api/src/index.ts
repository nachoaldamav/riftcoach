import {
  PlatformId,
  type RiotAPITypes,
  regionToCluster,
} from '@fightmegg/riot-api';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import chalk from 'chalk';
import { consola } from 'consola';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import z from 'zod';
import { redis } from './clients/redis.js';
import { type Platform, type Region, riot } from './clients/riot-api.js';
import { riotAPI } from './clients/riot.js';
import { s3Client } from './clients/s3.js';
import { getCohortStatsPerRole } from './queries/cohorts-role-stats.js';
import { getPlayerStatsPerRole } from './queries/puuid-role-stats.js';
import {
  PROG,
  generateJobUUID,
  getJobMapping,
  rewindQ,
  storeJobMapping,
} from './queues/rewind.js';
import { fetchQ, listQ } from './queues/scan.js';
import { getCachedAIBadges } from './services/ai-service.js';
import { getQueuePosition } from './utils/queue-position.js';
import { runAthenaQueryWithCache } from './utils/run-athena-query.js';

const JOB_SCOPE = process.env.JOB_SCOPE ?? 'Y2025';

const app = new Hono();

app.use(
  '*',
  cors({
    origin: '*',
  }),
);

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// WebSocket connection management with subscriptions
const wsConnections = new Map<unknown, Set<string>>();

// Broadcast function for sending messages to subscribed clients only
export const broadcastToWebSockets = (channel: string, message: unknown) => {
  const messageStr = JSON.stringify(message);
  for (const [ws, subscriptions] of wsConnections) {
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    if ((ws as any).readyState === 1 && subscriptions.has(channel)) {
      // WebSocket.OPEN
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      (ws as any).send(messageStr);
    }
  }
};

app.get(
  '/ws',
  upgradeWebSocket((c) => {
    return {
      onOpen(event, ws) {
        wsConnections.set(ws, new Set<string>());
        console.log(
          'WebSocket connection opened, total connections:',
          wsConnections.size,
        );
      },
      onMessage(event, ws) {
        try {
          const data = JSON.parse(event.data.toString());

          if (data.type === 'subscribe' && data.channel) {
            const subscriptions = wsConnections.get(ws);
            if (subscriptions) {
              subscriptions.add(data.channel);
              console.log(`Client subscribed to channel: ${data.channel}`);
              ws.send(
                JSON.stringify({
                  type: 'subscription_confirmed',
                  channel: data.channel,
                }),
              );
            }
          } else if (data.type === 'unsubscribe' && data.channel) {
            const subscriptions = wsConnections.get(ws);
            if (subscriptions) {
              subscriptions.delete(data.channel);
              console.log(`Client unsubscribed from channel: ${data.channel}`);
              ws.send(
                JSON.stringify({
                  type: 'unsubscription_confirmed',
                  channel: data.channel,
                }),
              );
            }
          }
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      },
      onClose: (event, ws) => {
        wsConnections.delete(ws);
        console.log(
          'WebSocket connection closed, remaining connections:',
          wsConnections.size,
        );
      },
    };
  }),
);

app.get('/', (c) => {
  return c.text('Hello Hono!');
});

/**
 * Health check endpoint
 * Showcase the health of the server and the clients
 */
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    redis: redis.status,
    riotAPI: riotAPI.token ? 'ready' : 'failed',
    s3: s3Client.config ? 'ready' : 'failed',
  });
});

const StartRewindSchema = z.object({
  tagName: z.string(),
  tagLine: z.string(),
  region: z.enum([
    PlatformId.BR1,
    PlatformId.EUNE1,
    PlatformId.EUW1,
    PlatformId.JP1,
    PlatformId.KR,
    PlatformId.LA1,
    PlatformId.LA2,
    PlatformId.NA1,
    PlatformId.ME1,
    PlatformId.OC1,
    PlatformId.RU,
    PlatformId.TR1,
    PlatformId.PH2,
    PlatformId.SG2,
    PlatformId.TH2,
    PlatformId.TW2,
    PlatformId.VN2,
  ]),
});

type StartRewindTypes = z.infer<typeof StartRewindSchema>;

app.post('/rewind/start', async (c) => {
  consola.info(chalk.blue('🚀 Starting rewind request'));

  const body = await c.req.json<StartRewindTypes>().catch(() => null);

  if (!body) {
    consola.error(chalk.red('❌ Invalid request body'));
    return c.json({ error: 'Invalid request body' }, 400);
  }

  const { success, data } = StartRewindSchema.safeParse(body);

  if (!success) {
    consola.error(chalk.red('❌ Schema validation failed:'), data);
    return c.json({ error: data }, 400);
  }

  const { tagName, tagLine, region } = data;
  consola.info(
    chalk.cyan(`🎮 Processing request for ${tagName}#${tagLine} in ${region}`),
  );

  const cluster = regionToCluster(region as RiotAPITypes.LoLRegion) as
    | PlatformId.EUROPE
    | PlatformId.ASIA
    | PlatformId.AMERICAS
    | PlatformId.ESPORTS;

  consola.info(
    chalk.yellow(`🌍 Mapped region ${region} to cluster ${cluster}`),
  );

  const summoner = await riot
    .getAccountByRiotId(cluster as Region, tagName, tagLine)
    .catch((err) => {
      consola.error(
        chalk.red(`❌ Error fetching summoner: ${tagName}#${tagLine}`),
        err,
      );
      return null;
    });

  if (!summoner || !summoner.puuid) {
    consola.error(chalk.red(`❌ Summoner not found: ${tagName}#${tagLine}`));
    return c.json({ error: 'Summoner not found' }, 404);
  }

  consola.success(
    chalk.green(`✅ Found summoner with PUUID: ${summoner.puuid}`),
  );

  // Generate UUID for this job using the cluster region (same as worker)
  const jobUUID = generateJobUUID(
    JOB_SCOPE,
    cluster.toLowerCase(),
    summoner.puuid,
  );
  consola.info(chalk.magenta(`🆔 Generated job UUID: ${jobUUID}`));

  // Store job mapping in Redis
  await storeJobMapping(
    jobUUID,
    JOB_SCOPE,
    cluster.toLowerCase(),
    summoner.puuid,
  );

  // Optional alias for later lookups by RiotId
  await redis.setex(
    `rc:rewind:alias:${region}:${tagName.toLowerCase()}#${tagLine}`,
    7 * 86400,
    jobUUID,
  );
  consola.info(
    chalk.blue(`💾 Set Redis alias for ${tagName.toLowerCase()}#${tagLine}`),
  );

  // Check if job already exists and clean it up if completed/failed
  const existingJob = await rewindQ.getJob(jobUUID);
  if (existingJob) {
    const state = await existingJob.getState();
    if (state === 'completed' || state === 'failed') {
      consola.info(
        chalk.blue(`🧹 Cleaning up ${state} job ${jobUUID} to allow re-run`),
      );
      await existingJob.remove();
    } else {
      consola.warn(
        chalk.yellow(`⚠️ Job ${jobUUID} already exists in state: ${state}`),
      );
      // Position
      const position = await getQueuePosition(rewindQ, jobUUID);
      return c.json({ jobId: jobUUID, position });
    }
  }

  const currentYear = new Date().getUTCFullYear();

  await rewindQ.add(
    'rewind',
    {
      scope: JOB_SCOPE,
      region: cluster.toLowerCase(),
      puuid: summoner.puuid,
      season: currentYear,
    },
    { jobId: jobUUID },
  );

  consola.success(chalk.green(`✅ Job enqueued successfully: ${jobUUID}`));

  // Init progress hash (if first time)
  const progKey = `rc:rewind:prog:${jobUUID}`;
  const created = await redis.hsetnx(
    progKey,
    'startedAt',
    Date.now().toString(),
  );
  if (created) {
    await redis.expire(progKey, 7 * 86400);
    consola.info(chalk.blue(`📊 Initialized progress tracking for ${jobUUID}`));
  } else {
    consola.info(
      chalk.yellow(`📊 Progress tracking already exists for ${jobUUID}`),
    );
  }

  // Position
  const position = await getQueuePosition(rewindQ, jobUUID);
  consola.success(
    chalk.green(
      `🎯 Request completed - Job UUID: ${jobUUID}, Queue position: ${position}`,
    ),
  );

  return c.json({ jobId: jobUUID, position });
});

app.get('/rewind/:jobId/status', async (c) => {
  const jobId = c.req.param('jobId');

  // Try to get job mapping first to validate UUID
  const jobMapping = await getJobMapping(jobId);
  if (!jobMapping) {
    return c.json({ error: 'Job not found' }, 404);
  }

  const key = PROG(jobId);

  const prog = await redis.hgetall(key);

  if (!prog || Object.keys(prog).length === 0)
    return c.json({ error: 'Progress not found' }, 404);

  const position = await getQueuePosition(rewindQ, jobId);
  return c.json({
    jobId,
    position,
    state: prog.state ?? 'unknown',
    pagesDone_420: Number(prog.pagesDone_420 || 0),
    pagesDone_440: Number(prog.pagesDone_440 || 0),
    idsFound: Number(prog.idsFound || 0),
    matchesFetched: Number(prog.matchesFetched || 0),
    timelinesFetched: Number(prog.timelinesFetched || 0),
    startedAt: prog.startedAt ? Number(prog.startedAt) : null,
    updatedAt: prog.updatedAt ? Number(prog.updatedAt) : null,
    resultKey: prog.resultKey || null,
    jobMapping, // Include job mapping info for debugging
  });
});

app.get('/rewind/:jobId/playstyle-badges', async (c) => {
  // AI-focused implementation using new per-role queries and prompt builder.
  const jobId = c.req.param('jobId');

  const jobMapping = await getJobMapping(jobId);
  if (!jobMapping) {
    return c.json({ error: 'Job not found' }, 404);
  }

  try {
    const playerSql = getPlayerStatsPerRole(jobMapping.puuid);
    const cohortSql = getCohortStatsPerRole(jobMapping.puuid);

    const [playerRes, cohortRes] = await Promise.allSettled([
      runAthenaQueryWithCache({ query: playerSql }),
      runAthenaQueryWithCache({ query: cohortSql }),
    ]);

    if (cohortRes.status === 'rejected') {
      throw new HTTPException(500, {
        message: `Failed to get cohort per-role stats: ${String(
          cohortRes.reason,
        )}`,
      });
    }

    if (playerRes.status === 'rejected') {
      throw new HTTPException(500, {
        message: `Failed to get player per-role stats: ${String(
          playerRes.reason,
        )}`,
      });
    }

    const playerRecords = playerRes.value.records;
    if (!playerRecords || playerRecords.length === 0) {
      return c.json(
        { message: 'No ranked matches found for this player in Athena.' },
        404,
      );
    }

    const toNumber = (value: string | null | undefined): number | null => {
      if (value === null || value === undefined || value === '') return null;
      const num = Number.parseFloat(value);
      return Number.isNaN(num) ? null : num;
    };

    const normalizePercentish = (
      v: number | null | undefined,
    ): number | null => {
      if (v == null) return null;
      return v > 1 ? v / 100 : v;
    };

    const mapPlayerRecord = (record: Record<string, string | null>) => ({
      role: (record.role ?? '') as string,
      games: Number.parseInt(record.games ?? '0', 10) || 0,
      win_rate_pct_estimate: normalizePercentish(
        toNumber(record.win_rate_pct_estimate),
      ),
      kill_participation_pct_est: normalizePercentish(
        toNumber(record.kill_participation_pct_est),
      ),
      avg_vision_score_per_min: toNumber(record.avg_vision_score_per_min),
      avg_dpm: toNumber(record.avg_dpm),
      avg_cs_at10: toNumber(record.avg_cs_at10),
      avg_cs_total: toNumber(record.avg_cs_total),
      avg_dragon_participation: normalizePercentish(
        toNumber(record.avg_dragon_participation),
      ),
      avg_herald_participation: normalizePercentish(
        toNumber(record.avg_herald_participation),
      ),
      avg_baron_participation: normalizePercentish(
        toNumber(record.avg_baron_participation),
      ),
      avg_early_deaths: toNumber(record.avg_early_deaths),
      avg_early_kills_near_enemy_tower: toNumber(
        record.avg_early_kills_near_enemy_tower,
      ),
      avg_early_kills_near_ally_tower: toNumber(
        record.avg_early_kills_near_ally_tower,
      ),
      avg_early_deaths_near_ally_tower: toNumber(
        record.avg_early_deaths_near_ally_tower,
      ),
      avg_kills: toNumber(record.avg_kills),
      avg_deaths: toNumber(record.avg_deaths),
      avg_assists: toNumber(record.avg_assists),
      avg_kda: toNumber(record.avg_kda),
      avg_team_dmg_pct: normalizePercentish(toNumber(record.avg_team_dmg_pct)),
      avg_gpm: toNumber(record.avg_gpm),
      avg_wards_killed: toNumber(record.avg_wards_killed),
      avg_early_solo_kills: toNumber(record.avg_early_solo_kills),
    });

    const mapCohortRecord = (record: Record<string, string | null>) => ({
      role: (record.role ?? '') as string,
      games: Number.parseInt(record.weighted_games ?? '0', 10) || 0,
      win_rate_pct_estimate: normalizePercentish(
        toNumber(record.win_rate_pct_estimate),
      ),
      kill_participation_pct_est: normalizePercentish(
        toNumber(record.kill_participation_pct_est),
      ),
      avg_vision_score_per_min: toNumber(record.avg_vision_score_per_min),
      avg_dpm: toNumber(record.avg_dpm),
      avg_cs_at10: toNumber(record.avg_cs_at10),
      avg_cs_total: toNumber(record.avg_cs_total),
      avg_dragon_participation: normalizePercentish(
        toNumber(record.avg_dragon_participation),
      ),
      avg_herald_participation: normalizePercentish(
        toNumber(record.avg_herald_participation),
      ),
      avg_baron_participation: normalizePercentish(
        toNumber(record.avg_baron_participation),
      ),
      avg_early_deaths: toNumber(record.avg_early_deaths),
      avg_early_kills_near_enemy_tower: toNumber(
        record.avg_early_kills_near_enemy_tower,
      ),
      avg_early_kills_near_ally_tower: toNumber(
        record.avg_early_kills_near_ally_tower,
      ),
      avg_early_deaths_near_ally_tower: toNumber(
        record.avg_early_deaths_near_ally_tower,
      ),
      avg_kills: toNumber(record.avg_kills),
      avg_deaths: toNumber(record.avg_deaths),
      avg_assists: toNumber(record.avg_assists),
      avg_kda: toNumber(record.avg_kda),
      avg_team_dmg_pct: normalizePercentish(toNumber(record.avg_team_dmg_pct)),
      avg_gpm: toNumber(record.avg_gpm),
      avg_wards_killed: toNumber(record.avg_wards_killed),
      avg_early_solo_kills: toNumber(record.avg_early_solo_kills),
    });

    const playerPerRole = playerRecords.map(mapPlayerRecord);
    const cohortPerRole =
      cohortRes.status === 'fulfilled'
        ? cohortRes.value.records.map(mapCohortRecord)
        : undefined;

    // Generate AI badges with caching using per-role arrays
    const aiJson = await getCachedAIBadges(
      // @ts-expect-error
      playerPerRole,
      cohortPerRole,
      jobMapping.puuid,
    );

    return c.json({
      ...aiJson,
      playerPerRole,
      cohortPerRole,
    });
  } catch (error) {
    consola.error(
      chalk.red(`❌ Failed to generate AI playstyle badges for job ${jobId}`),
      error,
    );
    return c.json({ error: 'Failed to generate AI badges' }, 500);
  }
});

app.get('/rewind/:jobId/profile', async (c) => {
  const jobId = c.req.param('jobId');
  consola.info(chalk.blue(`🔍 Fetching profile for job ${jobId}`));

  const jobMapping = await getJobMapping(jobId);
  if (!jobMapping) {
    return c.json({ error: 'Job not found' }, 404);
  }

  const cachePlatformKey = `rc:platform:${jobMapping.puuid}:${jobMapping.region}`;
  const cacheProfileKey = `rc:profile:${jobMapping.puuid}:${jobMapping.region}`;

  // Check profile cache
  const cachedProfile = await redis.get(cacheProfileKey);
  if (cachedProfile) {
    return c.json(JSON.parse(cachedProfile));
  }

  // Check platform cache
  let platform: Platform | null = null;
  const cachedPlatform = await redis.get(cachePlatformKey);
  if (cachedPlatform) {
    platform = JSON.parse(cachedPlatform).region;
  } else {
    // If not in cache, fetch from Riot API
    platform = (
      await riot.getPlatform(jobMapping.puuid, jobMapping.region as Region)
    ).region;
    // Cache the platform for future use
    await redis.set(
      cachePlatformKey,
      JSON.stringify({ region: platform }),
      'EX',
      60 * 5, // 5-minute cache
    );
  }

  // If platform is still null, return error
  if (!platform) {
    return c.json({ error: 'Failed to fetch platform' }, 500);
  }

  const [summoner, account] = await Promise.all([
    riot.summonerByPuuid(platform, jobMapping.puuid),
    riot.accountByPuuid(platform, jobMapping.puuid),
  ]);

  // Cache the profile for future use
  if (summoner && account) {
    await redis.set(
      cacheProfileKey,
      JSON.stringify({ ...summoner, ...account }),
      'EX',
      60 * 5, // 5-minute cache
    );
  }

  // If summoner is still null, return error
  if (!summoner || !account) {
    return c.json({ error: 'Failed to fetch profile' }, 500);
  }

  return c.json({ ...summoner, ...account });
});

app.get('/queues', async (c) => {
  return c.json({
    rewind: await rewindQ.count(),
    list: await listQ.count(),
    fetch: await fetchQ.count(),
  });
});

const server = serve(
  {
    fetch: app.fetch,
    port: 4000,
  },
  (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
  },
);

injectWebSocket(server);
