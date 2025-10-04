import {
  PlatformId,
  type RiotAPITypes,
  regionToCluster,
} from '@fightmegg/riot-api';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import type { Queue } from 'bullmq';
import chalk from 'chalk';
import { consola } from 'consola';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import z from 'zod';
import { redis } from './clients/redis.js';
import { type Region, riot } from './clients/riot-api.js';
import { riotAPI } from './clients/riot.js';
import { s3Client } from './clients/s3.js';
import {
  buildPlaystyleBadgePrompt,
  getCachedAIBadges,
  getCachedPlaystyleStats,
  getCohortStats,
  getPlaystyleStats,
} from './queues/playstyle-badges.js';
import {
  PROG,
  generateJobUUID,
  getJobMapping,
  rewindQ,
  storeJobMapping,
} from './queues/rewind.js';
import { fetchQ, listQ } from './queues/scan.js';

const JOB_SCOPE = process.env.JOB_SCOPE ?? 'Y2025';

const app = new Hono();

app.use(
  '*',
  cors({
    origin: '*',
  }),
);

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.get(
  '/ws',
  upgradeWebSocket((c) => {
    return {
      onMessage(event, ws) {
        console.log(`Message from client: ${event.data}`);
        ws.send('Hello from server!');
      },
      onClose: () => {
        console.log('Connection closed');
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
      throw new Error(`Failed to get playstyle stats: ${playstyleResult.reason}`);
    }

    const { stats, meta } = playstyleResult.value;

    if (!stats || stats.matchesPlayed === 0) {
      return c.json(
        {
          jobId,
          puuid: jobMapping.puuid,
          scope: jobMapping.scope,
          stats,
          message: 'No ranked matches found for this player in Athena.',
          analysisContext: {
            season: meta.season ?? null,
            queues: meta.queues,
          },
          athena: {
            queryExecutionId: meta.queryExecutionId,
            statistics: meta.statistics ?? null,
            sql: meta.sql,
          },
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
    const aiBadges = await getCachedAIBadges(stats, cohortData?.stats || undefined, jobMapping.puuid);
    
    const prompt = buildPlaystyleBadgePrompt(stats);

    return c.json({
      jobId,
      puuid: jobMapping.puuid,
      scope: jobMapping.scope,
      stats,
      cohort: cohortData,
      aiBadges,
      prompt,
      analysisContext: {
        season: meta.season ?? null,
        queues: meta.queues,
      },
      athena: {
        queryExecutionId: meta.queryExecutionId,
        statistics: meta.statistics ?? null,
        sql: meta.sql,
      },
    });
  } catch (error) {
    consola.error(
      chalk.red(`❌ Failed to build playstyle badges for job ${jobId}`),
      error,
    );
    return c.json({ error: 'Failed to build playstyle badges' }, 500);
  }
});

app.get('/queues', async (c) => {
  return c.json({
    rewind: await rewindQ.count(),
    list: await listQ.count(),
    fetch: await fetchQ.count(),
  });
});

async function getQueuePosition(queue: Queue, jobId: string) {
  const job = await queue.getJob(jobId);
  if (!job) return null;
  const state = await job.getState();
  if (state === 'active' || state === 'completed' || state === 'failed')
    return 0;

  const prefix = queue.opts.prefix ?? 'bull';
  const base = `${prefix}:${queue.name}`;
  const waitKey = `${base}:wait`;
  const prioKey = `${base}:prioritized`;
  const delayedKey = `${base}:delayed`;

  if (job.opts?.priority && job.opts.priority > 0) {
    const rank = await redis.zrank(prioKey, jobId);
    if (rank !== null) return rank + 1;
  }
  if (state === 'waiting') {
    const idx = await redis.lpos(waitKey, jobId);
    if (idx !== null) return (idx as number) + 1;
  }
  if (state === 'delayed') {
    const rank = await redis.zrank(delayedKey, jobId);
    if (rank !== null) return rank + 1;
  }
  return 0;
}

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
