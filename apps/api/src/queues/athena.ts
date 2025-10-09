import { Queue, Worker } from 'bullmq';
import chalk from 'chalk';
import { consola } from 'consola';
import { redis } from '../clients/redis.js';
import { insertPlayerSilverEntries } from '../queries/insert-player-silver.js';
import { runAthenaQuery } from '../utils/run-athena-query.js';
import { getJobMapping } from './rewind.js';

export const athenaQ = new Queue('athena-processing', {
  connection: redis,
  defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 1000 },
});

interface AthenaWorkerParams {
  rootId: string;
  season: number;
  patchMajor: string;
}

export const athenaWorker = new Worker<AthenaWorkerParams>(
  athenaQ.name,
  async (job) => {
    const { rootId } = job.data;

    consola.info(
      chalk.blue(`🔍 Processing Athena query for rootId: ${rootId}`),
    );

    const progKey = `rc:rewind:prog:${rootId}`;

    try {
      // Get job mapping to find the player's PUUID
      const jobMapping = await getJobMapping(rootId);
      if (!jobMapping?.puuid) {
        throw new Error(`No job mapping found for rootId: ${rootId}`);
      }

      consola.info(
        chalk.yellow('🏗️ Running Athena query to generate player silver...'),
      );

      await runAthenaQuery({
        query: insertPlayerSilverEntries(jobMapping.puuid),
        // Long-running query, so allow more attempts
        maxAttempts: 1_000,
        pollIntervalMs: 30_000,
      });

      consola.success(chalk.green('🎯 Player silver generated successfully!'));

      // Now mark the progress as ready
      await redis.hset(
        progKey,
        'state',
        'ready',
        'updatedAt',
        Date.now().toString(),
      );
      await redis.expire(progKey, 7 * 86400);

      consola.success(
        chalk.green('✅ Progress marked as ready after Athena completion!'),
      );

      return { success: true, rootId };
    } catch (error) {
      consola.error(
        chalk.red(`❌ Failed to process Athena query for ${rootId}:`),
        error,
      );

      // Mark progress as failed
      await redis.hset(
        progKey,
        'state',
        'failed',
        'error',
        String(error),
        'updatedAt',
        Date.now().toString(),
      );
      await redis.expire(progKey, 7 * 86400);

      throw error;
    }
  },
  {
    connection: redis,
    concurrency: 2, // Allow some parallelism for Athena queries
  },
);
