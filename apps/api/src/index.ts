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
import z from 'zod';
import { redis } from './clients/redis.js';
import {
  type Platform,
  type Region,
  RiotClient,
  riot,
} from './clients/riot-api.js';
import { riotAPI } from './clients/riot.js';
import { s3Client } from './clients/s3.js';
import {
  PROG,
  generateJobUUID,
  getJobMapping,
  rewindQ,
  storeJobMapping,
} from './queues/rewind.js';
import { fetchQ, listQ } from './queues/scan.js';
import {
  getCachedAIBadges,
  getCachedPlaystyleStats,
  getCohortStats,
} from './services/playstyle-badges.js';
import { getQueuePosition } from './utils/queue-position.js';

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
    if ((ws as any).readyState === 1 && subscriptions.has(channel)) { // WebSocket.OPEN
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
        console.log('WebSocket connection opened, total connections:', wsConnections.size);
      },
      onMessage(event, ws) {
        try {
          const data = JSON.parse(event.data.toString());
          
          if (data.type === 'subscribe' && data.channel) {
            const subscriptions = wsConnections.get(ws);
            if (subscriptions) {
              subscriptions.add(data.channel);
              console.log(`Client subscribed to channel: ${data.channel}`);
              ws.send(JSON.stringify({ 
                type: 'subscription_confirmed', 
                channel: data.channel 
              }));
            }
          } else if (data.type === 'unsubscribe' && data.channel) {
            const subscriptions = wsConnections.get(ws);
            if (subscriptions) {
              subscriptions.delete(data.channel);
              console.log(`Client unsubscribed from channel: ${data.channel}`);
              ws.send(JSON.stringify({ 
                type: 'unsubscription_confirmed', 
                channel: data.channel 
              }));
            }
          }
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      },
      onClose: (event, ws) => {
        wsConnections.delete(ws);
        console.log('WebSocket connection closed, remaining connections:', wsConnections.size);
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
  const jobId = c.req.param('jobId');

  const jobMapping = await getJobMapping(jobId);
  if (!jobMapping) {
    return c.json({ error: 'Job not found' }, 404);
  }

  try {
    // Run both queries in parallel using Promise.allSettled
    const [playstyleResult, cohortResult] = await Promise.allSettled([
      getCachedPlaystyleStats(jobMapping.puuid, {
        scope: jobMapping.scope,
      }),
      getCohortStats(),
    ]);

    // Handle playstyle stats result
    if (playstyleResult.status === 'rejected') {
      throw new Error(
        `Failed to get playstyle stats: ${playstyleResult.reason}`,
      );
    }

    const { stats } = playstyleResult.value;

    if (!stats || stats.matchesPlayed === 0) {
      return c.json(
        {
          message: 'No ranked matches found for this player in Athena.',
        },
        404,
      );
    }

    // Handle cohort stats result
    let cohortData = null;
    if (cohortResult.status === 'fulfilled') {
      cohortData = cohortResult.value;
    } else {
      consola.warn(
        chalk.yellow(`⚠️ Failed to get cohort stats for job ${jobId}:`),
        cohortResult.reason,
      );
    }

    // Generate AI badges using cached function
    const aiBadges = await getCachedAIBadges(
      stats,
      cohortData?.stats || undefined,
      jobMapping.puuid,
    );

    return c.json(aiBadges);
  } catch (error) {
    consola.error(
      chalk.red(`❌ Failed to build playstyle badges for job ${jobId}`),
      error,
    );
    return c.json({ error: 'Failed to build playstyle badges' }, 500);
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

  const account = await riot
    .summonerByPuuid(platform, jobMapping.puuid)
    .catch((error) => {
      consola.error(
        chalk.red(`❌ Failed to fetch profile for job ${jobId}`),
        error,
      );
      return null;
    });

  // Cache the profile for future use
  if (account) {
    await redis.set(
      cacheProfileKey,
      JSON.stringify(account),
      'EX',
      60 * 5, // 5-minute cache
    );
  }

  // If account is still null, return error
  if (!account) {
    return c.json({ error: 'Failed to fetch profile' }, 500);
  }

  return c.json(account);
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
