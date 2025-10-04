import type { RiotAPITypes } from '@fightmegg/riot-api';
import { ALLOWED_QUEUE_IDS, patchBucket } from '@riftcoach/shared.constants';
import { Queue, Worker } from 'bullmq';
import chalk from 'chalk';
import { consola } from 'consola';
import ms from 'ms';
import { redis } from '../clients/redis.js';
import { type Region, riot } from '../clients/riot-api.js';
import { GENERATE_PLAYER_SILVER_SQL } from '../queries/generate-player-silver.js';
import { runAthenaQuery } from '../utils/run-athena-query.js';
import { createS3Uploaders } from '../utils/upload.js';
import { getJobMapping } from './rewind.js';

const { uploadMatch, uploadTimeline } = createS3Uploaders({
  bucket: process.env.S3_BUCKET as string,
});

export const listQ = new Queue('scan-list', {
  connection: redis,
  defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 1000 },
});
export const fetchQ = new Queue('scan-fetch', {
  connection: redis,
  defaultJobOptions: { removeOnComplete: 10000, removeOnFail: 10000 },
});

interface BaseWorkerParams {
  region: RiotAPITypes.LoLRegion;
  puuid: string;
  step: 'getMatchList' | 'getMatch';
  opts: Record<string, unknown>;
}

interface GetMatchListWorkerParams extends BaseWorkerParams {
  step: 'getMatchList';
  opts: {
    start: number;
    /**
     * Year of season to scan
     * e.g. 2023 for season 2023-2024
     */
    season: number;
    queue: number;
    rootId: string;
  };
}

interface GetMatchWorkerParams extends BaseWorkerParams {
  step: 'getMatch';
  opts: {
    matchId: string;
    rootId: string;
  };
}

export const listWorker = new Worker<GetMatchListWorkerParams>(
  listQ.name,
  async (job) => {
    const {
      region,
      puuid,
      opts: { start, season, queue, rootId },
    } = job.data;

    consola.info(
      chalk.blue(
        `📋 Listing matches - Queue: ${queue}, Start: ${start}, Season: ${season}`,
      ),
    );

    const startSec = new Date(Date.UTC(season, 0, 1)).getTime() / 1000;

    consola.info(
      `Using ${new Date(startSec * 1000).toISOString()} as season start`,
    );

    let ids: string[] = [];
    try {
      consola.info(chalk.yellow('🔍 Fetching match IDs from Riot API...'));
      ids = await riot.getIdsByPuuid(region as Region, puuid, {
        start,
        count: 100,
        queue,
        startTime: startSec,
      });
      consola.success(chalk.green(`✅ Found ${ids.length} match IDs`));
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    } catch (e: any) {
      if (String(e?.status) === '429') {
        consola.warn(
          chalk.yellow(
            `⚠️ Rate limited - retry after: ${e?.headers?.['retry-after']}s`,
          ),
        );
        await job.updateProgress({ retryAfter: e?.headers?.['retry-after'] });
        throw e;
      }
      consola.error(chalk.red('❌ Error fetching match IDs:'), e);
      throw e;
    }

    const progKey = `rc:rewind:prog:${rootId}`;
    await Promise.all([
      redis.hincrby(progKey, `pagesDone_${queue}`, 1),
      redis.hincrby(progKey, 'idsFound', ids.length),
      redis.hset(progKey, 'updatedAt', Date.now().toString()),
      redis.expire(progKey, 7 * 86400),
    ]);

    consola.info(
      chalk.cyan(`📊 Updated progress - Queue ${queue} page completed`),
    );

    // stream matches into fetchQ (dedup by jobId = matchId)
    const fetchJobs = [];
    for (const matchId of ids) {
      // Check if fetch job already exists
      const existingFetchJob = await fetchQ.getJob(matchId);
      if (existingFetchJob) {
        const state = await existingFetchJob.getState();
        if (state === 'completed') {
          // Job is completed - match and timeline already indexed in S3
          // Count it as completed for progress tracking but don't remove the job
          consola.info(
            chalk.green(
              `✅ Match ${matchId} already processed and indexed in S3`,
            ),
          );

          // Update progress counters as if the job just completed
          await Promise.all([
            redis.hincrby(progKey, 'matchesFetched', 1),
            redis.hincrby(progKey, 'timelinesFetched', 1), // Assume timeline was also fetched
            redis.hset(progKey, 'updatedAt', Date.now().toString()),
            redis.expire(progKey, 7 * 86400),
          ]);

          continue; // Skip creating a new job
        }
        if (state === 'failed') {
          consola.info(
            chalk.blue(`🧹 Cleaning up failed fetch job for match ${matchId}`),
          );
          await existingFetchJob.remove();
        } else {
          consola.warn(
            chalk.yellow(
              `⚠️ Fetch job for match ${matchId} already exists in state: ${state}`,
            ),
          );
          continue; // Skip this match if job is still active
        }
      }

      await redis.incr(`rc:rewind:openFetch:${rootId}`);
      fetchJobs.push(
        fetchQ.add(
          'scan:fetch',
          { region, puuid, opts: { matchId, rootId } },
          { jobId: matchId },
        ),
      );
    }

    await Promise.all(fetchJobs);

    consola.success(chalk.green(`🚀 Enqueued ${ids.length} fetch jobs`));

    // next page if needed
    if (ids.length === 100) {
      await redis.incr(`rc:rewind:openPages:${rootId}`);
      await listQ.add(
        'scan-list',
        {
          region,
          puuid,
          step: 'getMatchList',
          opts: { start: start + 100, season, queue, rootId },
        },
        // No jobId - allow multiple pagination jobs to run freely
      );
      consola.info(
        chalk.yellow(
          `📋 Enqueued next page - Queue: ${queue}, Start: ${start + 100}`,
        ),
      );
    } else {
      consola.info(
        chalk.blue(
          `🏁 Last page for queue ${queue} (${start / 100} page) - found ${
            start + ids.length
          } matches`,
        ),
      );
    }

    const left = await redis.decr(`rc:rewind:openPages:${rootId}`);
    if (ids.length === 100) {
      // you scheduled the next page above; counter will be incremented there
    } else {
      // if no more pages & no fetches left, mark ready
      const openFetch =
        Number(await redis.get(`rc:rewind:openFetch:${rootId}`)) || 0;

      // Also check for queued jobs in the fetch queue that haven't started yet
      const queuedJobs = await fetchQ.getJobs(['waiting', 'delayed']);
      const pendingJobsForThisRoot = queuedJobs.filter(
        (job) => job.data?.opts?.rootId === rootId,
      ).length;

      if (left <= 0 && openFetch === 0 && pendingJobsForThisRoot === 0) {
        consola.info('Fetching complete - marking as ready');
        await redis.hset(progKey, {
          state: 'ready',
          updatedAt: Date.now().toString(),
        });

        consola.info('Running Athena query to generate player silver');
        await runAthenaQuery({
          query: GENERATE_PLAYER_SILVER_SQL({
            patch_major: '15',
            queues: ALLOWED_QUEUE_IDS.map((id) => id.toString()),
            puuid: (await getJobMapping(rootId).then(
              (mapping) => mapping?.puuid,
            )) as string,
            season: 2025,
          }),
        }).catch((error) => {
          consola.error(
            chalk.red('❌ Failed to generate player silver:'),
            error,
          );
          throw error;
        });

        consola.success(
          chalk.green('🎯 Player silver generated successfully!'),
        );

        consola.success(
          chalk.green('🎯 All fetching complete - marked as ready!'),
        );
      } else {
        consola.info(
          chalk.cyan(
            `📈 Pages left: ${left}, Fetches pending: ${openFetch}, Queued: ${pendingJobsForThisRoot}`,
          ),
        );
      }
    }
  },
  {
    connection: redis,
    concurrency: 1,
    limiter: { duration: ms('1s'), max: 1 },
  },
);

export const fetchWorker = new Worker<GetMatchWorkerParams>(
  fetchQ.name,
  async (job) => {
    const { matchId, rootId } = job.data.opts;

    consola.info(chalk.blue(`🎮 Fetching match: ${matchId}`));

    const progKey = `rc:rewind:prog:${rootId}`;
    const openFetchKey = `rc:rewind:openFetch:${rootId}`;

    try {
      consola.info(
        chalk.yellow('🔍 Fetching match data and timeline from Riot API...'),
      );
      const m = await riot.getMatchById(matchId);

      consola.info(chalk.blue('🔎 Fetched match data'));

      // Wait one second
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      consola.info(chalk.blue('🔎 Fetching match timeline'));

      const t = await riot.getTimeline(matchId);

      if (!t) {
        consola.error(chalk.red(`❌ Failed to fetch timeline for ${matchId}`));
        return;
      }

      consola.info(chalk.blue('🔎 Fetched match timeline'));

      consola.success(chalk.green(`✅ Retrieved match data for ${matchId}`));

      consola.info(chalk.cyan('☁️ Uploading match to S3...'));
      await uploadMatch({
        matchId,
        info: m.info,
        source: 'riot-api',
      });

      const season = new Date(m.info.gameCreation).getUTCFullYear();
      const pb = patchBucket(m.info.gameVersion);
      const queue = m.info.queueId;

      consola.info(chalk.cyan('☁️ Uploading timeline to S3...'));
      await uploadTimeline({
        matchId,
        frames: t.info.frames,
        season,
        patchBucket: pb,
        queue,
        source: 'riot-api',
      });

      consola.success(
        chalk.green(
          `📤 Successfully uploaded ${matchId} - Queue: ${queue}, Patch: ${m.info.gameVersion}`,
        ),
      );

      // bump counters
      await redis.hincrby(progKey, 'matchesFetched', 1);
      if (t?.info?.frames?.length) {
        await redis.hincrby(progKey, 'timelinesFetched', 1);
        consola.info(
          chalk.cyan('📊 Updated counters - Match & timeline processed'),
        );
      } else {
        consola.warn(chalk.yellow(`⚠️ No timeline frames found for ${matchId}`));
        consola.info(
          chalk.cyan('📊 Updated counters - Match processed (no timeline)'),
        );
      }
      await redis.hset(progKey, 'updatedAt', Date.now().toString());
      await redis.expire(progKey, 7 * 86400);

      // Atomic completion check using Lua script to prevent race conditions
      const completionScript = `
        local openFetchKey = KEYS[1]
        local openPagesKey = KEYS[2]
        local progKey = KEYS[3]
        local completionKey = KEYS[4]
        
        -- Decrement open fetch counter
        local left = redis.call('DECR', openFetchKey)
        local openPages = tonumber(redis.call('GET', openPagesKey)) or 0
        
        -- Check if already marked as complete to prevent double execution
        local alreadyComplete = redis.call('GET', completionKey)
        if alreadyComplete then
          return {left, openPages, 1} -- 1 indicates already complete
        end
        
        -- Check completion conditions
        if left <= 0 and openPages <= 0 then
          -- Mark as completing to prevent other workers from triggering
          redis.call('SET', completionKey, '1', 'EX', 300) -- 5 min expiry
          redis.call('HSET', progKey, 'state', 'ready', 'updatedAt', tostring(tonumber(ARGV[1])))
          return {left, openPages, 2} -- 2 indicates this worker should trigger completion
        end
        
        return {left, openPages, 0} -- 0 indicates not complete yet
      `;

      const completionKey = `rc:rewind:completing:${rootId}`;
      const openPagesKey = `rc:rewind:openPages:${rootId}`;

      const [left, openPages, shouldComplete] = (await redis.eval(
        completionScript,
        4,
        openFetchKey,
        openPagesKey,
        progKey,
        completionKey,
        Date.now().toString(),
      )) as [number, number, number];

      if (shouldComplete === 1) {
        consola.info(
          chalk.blue('📋 Completion already handled by another worker'),
        );
        return { queueId: m.info.queueId, patch: m.info.gameVersion };
      }

      if (shouldComplete === 2) {
        // Also check for queued jobs in the fetch queue that haven't started yet
        const queuedJobs = await fetchQ.getJobs(['waiting', 'delayed']);
        const pendingJobsForThisRoot = queuedJobs.filter(
          (job) => job.data?.opts?.rootId === rootId,
        ).length;

        if (pendingJobsForThisRoot === 0) {
          consola.info('Fetching complete - marked as ready');

          consola.info('Running Athena query to generate player silver');
          await runAthenaQuery({
            query: GENERATE_PLAYER_SILVER_SQL({
              patch_major: '15',
              queues: ALLOWED_QUEUE_IDS.map((id) => id.toString()),
              puuid: (await getJobMapping(rootId).then(
                (mapping) => mapping?.puuid,
              )) as string,
              season: 2025,
            }),
          }).catch(async (error) => {
            consola.error(
              chalk.red('❌ Failed to generate player silver:'),
              error,
            );
            // Clean up completion lock on error
            await redis.del(completionKey);
            throw error;
          });

          consola.success(
            chalk.green('🎯 Player silver generated successfully!'),
          );

          consola.success(
            chalk.green('🎯 All fetching complete - marked as ready!'),
          );
        } else {
          // Still have queued jobs, revert the completion state
          await redis.del(completionKey);
          await redis.hset(progKey, 'state', 'processing');
          consola.info(
            chalk.cyan(
              `📈 Found ${pendingJobsForThisRoot} queued jobs, continuing...`,
            ),
          );
        }
      } else {
        consola.info(
          chalk.cyan(`📈 Fetches left: ${left}, Pages pending: ${openPages}`),
        );
      }

      return { queueId: m.info.queueId, patch: m.info.gameVersion };
    } catch (error) {
      consola.error(chalk.red(`❌ Failed to process match ${matchId}:`), error);
      throw error;
    }
  },
  {
    connection: redis,
    concurrency: 2, // parallel fetch jobs
    limiter: { duration: ms('1s'), max: 5 },
  },
);
