import { type RiotAPITypes, regionToCluster } from '@fightmegg/riot-api';
import { collections } from '@riftcoach/clients.mongodb';
import { type Region, riot } from '@riftcoach/clients.riot';
import { type Job, Queue, Worker, type WorkerOptions } from 'bullmq';
import chalk from 'chalk';
import { consola } from 'consola';
// @ts-ignore
import ms from 'ms';
import { connection } from './clients/redis.js';

const priorities = {
  'list-matches': 100,
  'fetch-timeline': 500,
  'fetch-match': 1000,
};

interface BaseJobOptions {
  type: string;
  rewindId?: string;
}

interface ListMatchesJobOptions extends BaseJobOptions {
  type: 'list-matches';
  puuid: string;
  start: number;
  region: RiotAPITypes.LoLRegion;
}

interface FetchMatchJobOptions extends BaseJobOptions {
  type: 'fetch-match';
  matchId: string;
  region: RiotAPITypes.LoLRegion;
}

interface FetchTimelineJobOptions extends BaseJobOptions {
  type: 'fetch-timeline';
  matchId: string;
  region: RiotAPITypes.LoLRegion;
}

type MergedJobOptions =
  | ListMatchesJobOptions
  | FetchMatchJobOptions
  | FetchTimelineJobOptions;

export const queues: Record<RiotAPITypes.Cluster, Queue<MergedJobOptions>> = {
  americas: new Queue<MergedJobOptions>('americas', { connection }),
  europe: new Queue<MergedJobOptions>('europe', { connection }),
  asia: new Queue<MergedJobOptions>('asia', { connection }),
  sea: new Queue<MergedJobOptions>('sea', { connection }),
  esports: new Queue<MergedJobOptions>('esports', { connection }),
};

const workerFn = async (job: Job<MergedJobOptions>) => {
  const { type, rewindId } = job.data;
  switch (type) {
    case 'list-matches': {
      const { puuid, start, region } = job.data;
      consola.info(chalk.greenBright(`Listing matches for ${puuid}`));
      const matches = await riot.getIdsByPuuid(
        regionToCluster(region) as Region,
        puuid,
        {
          start,
          count: 100,
        },
      );

      if (matches.length === 100) {
        await queues[regionToCluster(region)].add(
          `list-matches-${puuid}-${start + 100}`,
          {
            type: 'list-matches',
            puuid,
            start: start + 100,
            region,
            rewindId,
          },
          {
            delay: ms('1s'),
            priority: priorities['list-matches'],
          },
        );
        await connection.incr(`rewind:${rewindId}:listing`);
      } else {
        await connection.set(`rewind:${rewindId}:status`, 'processing');
      }

      if (rewindId) {
        await connection.incrby(`rewind:${rewindId}:matches`, matches.length);
        await connection.incrby(`rewind:${rewindId}:total`, matches.length);
        await connection.decr(`rewind:${rewindId}:listing`);
      }

      // Exclude matches that already exist in the database
      const existingMatches = await collections.matches
        .find({
          'metadata.matchId': { $in: matches },
        })
        .project({ 'metadata.matchId': 1 })
        .toArray();

      const missingMatches = matches.filter(
        (match) =>
          !existingMatches.map((m) => m.metadata.matchId).includes(match),
      );

      const alreadyProcessed = existingMatches.map((m) => m.metadata.matchId);

      // Increase processed matches
      await connection.incrby(
        `rewind:${rewindId}:processed`,
        alreadyProcessed.length,
      );
      // Decrease pending matches
      await connection.decrby(
        `rewind:${rewindId}:matches`,
        alreadyProcessed.length,
      );

      if (rewindId) {
        const listing = await connection.get(`rewind:${rewindId}:listing`);
        const matches = await connection.get(`rewind:${rewindId}:matches`);
        if (listing === '0' && matches === '0') {
          await connection.set(`rewind:${rewindId}:status`, 'completed');
          await connection.del(`cache:stats:${rewindId}`);
          // Remove from visual queue
          const cluster = regionToCluster(region);
          await connection.zrem(`rewind:queue:${cluster}` as string, rewindId);
        }
      }

      await queues[regionToCluster(region)].addBulk(
        missingMatches.map((match) => ({
          name: `fetch-match-${match}`,
          data: {
            type: 'fetch-match',
            matchId: match,
            region,
            rewindId,
          },
          opts: {
            delay: ms('1s'),
            priority: priorities['fetch-match'],
          },
        })),
      );

      consola.success(chalk.green(`Matches for ${puuid} added to queue`));
      break;
    }

    case 'fetch-match': {
      const { matchId, region } = job.data;
      consola.info(chalk.greenBright(`Fetching match for ${matchId}`));
      const match = await riot
        .getMatchById(regionToCluster(region) as Region, matchId)
        .catch((error) => {
          consola.error(error);
          return null;
        });

      if (!match) {
        break;
      }

      await collections.matches.updateOne(
        { 'metadata.matchId': matchId },
        { $set: match },
        { upsert: true },
      );
      consola.success(chalk.green(`Match for ${matchId} saved`));

      await queues[regionToCluster(region)].add(
        `fetch-timeline-${matchId}`,
        {
          type: 'fetch-timeline',
          matchId,
          region,
          rewindId,
        },
        {
          delay: ms('1s'),
          priority: priorities['fetch-timeline'],
        },
      );

      break;
    }
    case 'fetch-timeline': {
      const { matchId, region, cluster } =
        job.data as FetchTimelineJobOptions & {
          cluster: string;
        };
      const isLegacyJob = !!cluster;
      consola.info(
        chalk.greenBright(
          `Fetching timeline for ${matchId} (${cluster ?? region})`,
        ),
      );
      const timeline = await riot.getTimeline(
        // @ts-expect-error
        regionToCluster(isLegacyJob ? cluster : region) as Region,
        matchId,
      );
      await collections.timelines.updateOne(
        { 'metadata.matchId': matchId },
        { $set: timeline as RiotAPITypes.MatchV5.MatchTimelineDTO },
        { upsert: true },
      );

      if (rewindId) {
        await connection.incr(`rewind:${rewindId}:processed`);
        await connection.decr(`rewind:${rewindId}:matches`);
        const listing = await connection.get(`rewind:${rewindId}:listing`);
        const matches = await connection.get(`rewind:${rewindId}:matches`);
        if (listing === '0' && matches === '0') {
          await connection.set(`rewind:${rewindId}:status`, 'completed');
          await connection.del(`cache:stats:${rewindId}`);
          // Remove from visual queue
          const targetCluster = isLegacyJob
            ? (cluster as RiotAPITypes.Cluster)
            : regionToCluster(region);
          await connection.zrem(`rewind:queue:${targetCluster}` as string, rewindId);
        }
      }

      consola.success(
        chalk.green(`Timeline for ${matchId} (${cluster ?? region}) saved`),
      );
      break;
    }
  }
};

const sharedWorkerOptions: WorkerOptions = {
  connection,
  concurrency: 1,
  limiter: {
    duration: ms('1m'),
    max: 50,
  },
};

type SharedWorker =
  | ListMatchesJobOptions
  | FetchMatchJobOptions
  | FetchTimelineJobOptions;

export let workers: Record<
  RiotAPITypes.Cluster,
  Worker<SharedWorker>
> = {} as Record<RiotAPITypes.Cluster, Worker<SharedWorker>>;

export function setupQueues() {
  consola.info(chalk.blue('Setting up queues...'));
  for (const [, queue] of Object.entries(queues)) {
    consola.success(chalk.green(`${queue.name} initialized...`));
  }
  consola.success(chalk.green('Queues setup complete'));
}

export function setupWorkers() {
  consola.info(chalk.blue('Setting up workers...'));

  workers = {
    americas: new Worker<SharedWorker>(
      queues.americas.name,
      workerFn,
      sharedWorkerOptions,
    ),
    europe: new Worker<SharedWorker>(
      queues.europe.name,
      workerFn,
      sharedWorkerOptions,
    ),
    asia: new Worker<SharedWorker>(
      queues.asia.name,
      workerFn,
      sharedWorkerOptions,
    ),
    sea: new Worker<SharedWorker>(
      queues.sea.name,
      workerFn,
      sharedWorkerOptions,
    ),
    esports: new Worker<SharedWorker>(
      queues.esports.name,
      workerFn,
      sharedWorkerOptions,
    ),
  };

  for (const [cluster, worker] of Object.entries(workers)) {
    worker.on('error', (error) => {
      consola.error(`[${cluster}]`, error);
    });
  }

  consola.success(chalk.green('Workers setup complete'));
}

export async function shutdownWorkers() {
  consola.info(chalk.yellow('Shutting down workers...'));
  await Promise.all(Object.values(workers).map((worker) => worker.close()));
  consola.success(chalk.green('Workers shutdown complete'));
}

export async function monitorQueues(): Promise<{
  totalWaiting: number;
  totalActive: number;
}> {
  let totalWaiting = 0;
  let totalActive = 0;

  for (const [region, queue] of Object.entries(queues)) {
    const waiting = await queue.getWaiting();
    const active = await queue.getActive();
    totalWaiting += waiting.length;
    totalActive += active.length;

    if (waiting.length > 0 || active.length > 0) {
      consola.info(
        chalk.blue(
          `${region}: ${waiting.length} waiting, ${active.length} active`,
        ),
      );
    }
  }

  return { totalWaiting, totalActive };
}
