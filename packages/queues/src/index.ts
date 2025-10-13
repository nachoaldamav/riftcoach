import { type RiotAPITypes, regionToCluster } from '@fightmegg/riot-api';
import { collections } from '@riftcoach/clients.mongodb';
import { type Region, riot } from '@riftcoach/clients.riot';
import { type Job, Queue, Worker, type WorkerOptions } from 'bullmq';
import chalk from 'chalk';
import { consola } from 'consola';
// @ts-ignore
import ms from 'ms';
import { connection } from './clients/redis.js';

interface BaseJobOptions {
  type: string;
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
  const { type } = job.data;
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
      await queues[regionToCluster(region)].addBulk(
        matches.map((match) => ({
          name: `fetch-match-${match}`,
          data: {
            type: 'fetch-match',
            matchId: match,
            region,
          },
          delay: ms('1s'),
          jobId: `fetch-match-${match}`,
          deduplication: {
            id: `fetch-match-${match}`,
            replace: false,
          },
        })),
      );
      consola.success(chalk.green(`Matches for ${puuid} added to queue`));
      break;
    }
    case 'fetch-match': {
      const { matchId, region } = job.data;
      consola.info(chalk.greenBright(`Fetching match for ${matchId}`));
      const match = await riot.getMatchById(region, matchId);
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
        },
        {
          delay: ms('1s'),
          jobId: `fetch-timeline-${matchId}`,
          deduplication: {
            id: `fetch-timeline-${matchId}`,
            replace: false,
          },
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
        isLegacyJob ? cluster : region,
        matchId,
      );
      await collections.timelines.updateOne(
        { 'metadata.matchId': matchId },
        { $set: timeline as RiotAPITypes.MatchV5.MatchTimelineDTO },
        { upsert: true },
      );
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
