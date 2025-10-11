import {
  type PlatformId,
  type RiotAPITypes,
  regionToCluster,
} from '@fightmegg/riot-api';
import { riot } from '@riftcoach/clients.riot';
import { type Job, Queue, Worker, type WorkerOptions } from 'bullmq';
import chalk from 'chalk';
import { consola } from 'consola';
import ms from 'ms';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { client } from './clients/mongodb';
import { connection } from './clients/redis';

const db = client.db('riftcoach');

const matchesCollection =
  db.collection<RiotAPITypes.MatchV5.MatchDTO>('matches');
const timelinesCollection =
  db.collection<RiotAPITypes.MatchV5.MatchTimelineDTO>('timelines');

const queues: Record<RiotAPITypes.Cluster, Queue> = {
  americas: new Queue('americas', { connection }),
  europe: new Queue('europe', { connection }),
  asia: new Queue('asia', { connection }),
  sea: new Queue('sea', { connection }),
  esports: new Queue('esports', { connection }),
};

interface BaseJobOptions {
  type: string;
}

interface ListMatchesJobOptions extends BaseJobOptions {
  type: 'list-matches';
  puuid: string;
  start: number;
  cluster: PlatformId;
}

interface FetchMatchJobOptions extends BaseJobOptions {
  type: 'fetch-match';
  matchId: string;
  cluster: PlatformId;
}

interface FetchTimelineJobOptions extends BaseJobOptions {
  type: 'fetch-timeline';
  matchId: string;
  cluster: PlatformId;
}

const workerFn = async (
  job: Job<
    ListMatchesJobOptions | FetchMatchJobOptions | FetchTimelineJobOptions
  >,
) => {
  const { type } = job.data;
  switch (type) {
    case 'list-matches': {
      const { puuid, start, cluster } = job.data;
      break;
    }
    case 'fetch-match': {
      const { matchId, cluster } = job.data;
      break;
    }
    case 'fetch-timeline': {
      const { matchId, cluster } = job.data;
      consola.info(chalk.greenBright(`Fetching timeline for ${matchId}`));
      const timeline = await riot.getTimeline(cluster, matchId);
      await timelinesCollection.updateOne(
        { 'metadata.matchId': matchId },
        { $set: timeline },
        { upsert: true },
      );
      consola.success(chalk.green(`Timeline for ${matchId} saved`));
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

const workers: Record<RiotAPITypes.Cluster, Worker<SharedWorker>> = {
  americas: new Worker<SharedWorker>('americas', workerFn, sharedWorkerOptions),
  europe: new Worker<SharedWorker>('europe', workerFn, sharedWorkerOptions),
  asia: new Worker<SharedWorker>('asia', workerFn, sharedWorkerOptions),
  sea: new Worker<SharedWorker>('sea', workerFn, sharedWorkerOptions),
  esports: new Worker<SharedWorker>('esports', workerFn, sharedWorkerOptions),
};

async function syncTimelines() {
  consola.info(chalk.yellow('Syncing timelines...'));
  await client.connect();
  consola.info(chalk.green('Connected to MongoDB'));

  let isFinished = false;
  let start = 0;
  while (!isFinished) {
    consola.info(chalk.yellow(`Syncing timelines from ${start}`));
    const matchesCursor = matchesCollection
      .find()
      .sort({
        'info.gameCreation': -1,
      })
      .skip(start)
      .limit(100);

    const matches = await matchesCursor.toArray();

    consola.info(chalk.green(`Found ${matches.length} matches`));

    for await (const match of matches) {
      const { metadata, info } = match;
      const { matchId } = metadata;
      const { platformId } = info;
      const region = regionToCluster(platformId.toLowerCase());
      await queues[region].add('fetch-timeline', {
        type: 'fetch-timeline',
        matchId,
        cluster: region,
      });
    }

    start += matches.length;

    if (matches.length < 100) {
      isFinished = true;
    }
  }
}

yargs(hideBin(process.argv))
  .command({
    command: 'sync-timelines',
    describe: 'Add missing timelines to the DB from matches',
    handler: syncTimelines,
  })
  .command({
    command: 'clear-queues',
    describe: 'Clear all queues',
    handler: async () => {
      for (const queue of Object.values(queues)) {
        consola.info(chalk.greenBright(`Clearing ${queue.name} queue`));
        await queue.drain();
      }
    },
  })
  .command({
    command: 'idle',
    describe: 'Wait for all workers',
    handler: async () => {
      consola.info(chalk.yellow('Waiting for all workers to idle...'));
    },
  })
  .demandCommand()
  .help()
  .parse();
