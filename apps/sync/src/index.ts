import { type RiotAPITypes, regionToCluster } from '@fightmegg/riot-api';
import { client, collections } from '@riftcoach/clients.mongodb';
import {
  monitorQueues,
  queues,
  setupQueues,
  setupWorkers,
  shutdownWorkers,
} from '@riftcoach/queues';
import chalk from 'chalk';
import { consola } from 'consola';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

// Initialize queues and workers at startup
setupQueues();
setupWorkers();

async function syncTimelines() {
  consola.info(chalk.yellow('Syncing timelines...'));
  await client.connect();
  consola.info(chalk.green('Connected to MongoDB'));

  let isFinished = false;
  let start = 0;
  while (!isFinished) {
    consola.info(chalk.yellow(`Syncing timelines from ${start}`));
    const matchesCursor = collections.matches
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
      const region = regionToCluster(
        platformId.toLowerCase() as RiotAPITypes.LoLRegion,
      );
      await queues[region].add('fetch-timeline', {
        type: 'fetch-timeline',
        matchId,
        region: platformId as RiotAPITypes.LoLRegion,
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
    describe: 'Wait for all workers to idle',
    handler: async () => {
      consola.info(chalk.yellow('Waiting for all workers to idle...'));

      // Keep the process alive and monitor workers
      const checkInterval = setInterval(async () => {
        const { totalWaiting, totalActive } = await monitorQueues();

        if (totalWaiting === 0 && totalActive === 0) {
          consola.success(chalk.green('All workers are idle!'));
          clearInterval(checkInterval);
          process.exit(0);
        }
      }, 5000); // Check every 5 seconds

      // Handle graceful shutdown
      process.on('SIGINT', () => {
        consola.info(chalk.yellow('Shutting down workers...'));
        clearInterval(checkInterval);
        shutdownWorkers().then(() => {
          process.exit(0);
        });
      });
    },
  })
  .demandCommand()
  .help()
  .parse();
