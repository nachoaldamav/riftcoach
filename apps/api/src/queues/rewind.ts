import { ALLOWED_QUEUE_IDS } from '@riftcoach/shared.constants';
// src/queues/rewind.ts
import { Queue, Worker } from 'bullmq';
import chalk from 'chalk';
import { consola } from 'consola';
import ms from 'ms';
import { v5 as uuidv5 } from 'uuid';
import { redis } from '../clients/redis.js';
import { listQ } from './scan.js'; // your listQ from the code you pasted

export const rewindQ = new Queue('rewind', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  },
});

export const PROG = (id: string) => `rc:rewind:prog:${id}`;
export const OPEN_PAGES = (id: string) => `rc:rewind:openPages:${id}`;
export const OPEN_FETCH = (id: string) => `rc:rewind:openFetch:${id}`;
export const JOB_MAPPING = (uuid: string) => `rc:rewind:job:${uuid}`;

// UUID v5 namespace for RiftCoach rewind jobs
export const REWIND_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

export function makeRewindJobId(scope: string, region: string, puuid: string) {
  return `${scope}:${region}:${puuid}`;
}

// Generate UUID v5 based on the job data
export function generateJobUUID(
  scope: string,
  region: string,
  puuid: string,
): string {
  const jobData = `${scope}:${region}:${puuid}`;
  return uuidv5(jobData, REWIND_NAMESPACE);
}

// Store job mapping in Redis: UUID -> original job data
export async function storeJobMapping(
  uuid: string,
  scope: string,
  region: string,
  puuid: string,
): Promise<void> {
  const jobData = {
    scope,
    region,
    puuid,
    originalId: makeRewindJobId(scope, region, puuid),
  };
  await redis.setex(JOB_MAPPING(uuid), 7 * 86400, JSON.stringify(jobData));
}

// Retrieve job mapping from Redis
export async function getJobMapping(uuid: string): Promise<{
  scope: string;
  region: string;
  puuid: string;
  originalId: string;
} | null> {
  const data = await redis.get(JOB_MAPPING(uuid));
  return data ? JSON.parse(data) : null;
}

// Check if a user has a pending job by PUUID
export async function findJobByPuuid(puuid: string): Promise<string | null> {
  // We'll need to scan through job mappings to find by PUUID
  // This is a simple implementation - for better performance, consider maintaining a separate PUUID -> UUID mapping
  const keys = await redis.keys('rc:rewind:job:*');
  for (const key of keys) {
    const data = await redis.get(key);
    if (data) {
      const jobData = JSON.parse(data);
      if (jobData.puuid === puuid) {
        return key.replace('rc:rewind:job:', '');
      }
    }
  }
  return null;
}

// Keep these functions for internal job ID encoding in scan queues
// Encode job ID for use as BullMQ custom ID (base64 encoding to avoid conflicts)
export function encodeJobId(jobId: string): string {
  return Buffer.from(jobId, 'utf8').toString('base64');
}

// Decode job ID back to original format
export function decodeJobId(encodedJobId: string): string {
  return Buffer.from(encodedJobId, 'base64').toString('utf8');
}

// Orchestrator: enqueue first pages for 420 & 440 and initialize progress
export const worker = new Worker(
  rewindQ.name,
  async (job) => {
    const {
      scope,
      region,
      puuid,
      season,
      queues = ALLOWED_QUEUE_IDS,
    } = job.data as {
      scope: string;
      region: 'europe' | 'americas' | 'asia' | 'sea';
      puuid: string;
      season: number;
      queues?: number[];
    };

    // Generate UUID for this job and store mapping
    const jobUUID = generateJobUUID(scope, region, puuid);
    await storeJobMapping(jobUUID, scope, region, puuid);

    consola.info(chalk.blue(`🎯 [${jobUUID}] Starting rewind orchestration`));
    consola.info(
      chalk.cyan(
        `📊 Scope: ${scope}, Region: ${region}, PUUID: ${puuid}, Season: ${season}, Queues: [${queues.join(
          ', ',
        )}]`,
      ),
    );

    // init progress hash + open counters using UUID
    await redis.hset(PROG(jobUUID), {
      state: 'listing',
      pagesDone_420: '0',
      pagesDone_440: '0',
      idsFound: '0',
      matchesFetched: '0',
      timelinesFetched: '0',
      startedAt: Date.now().toString(),
      updatedAt: Date.now().toString(),
    });
    await redis.expire(PROG(jobUUID), 7 * 86400);
    await redis.set(OPEN_PAGES(jobUUID), '0', 'EX', 7 * 86400);
    await redis.set(OPEN_FETCH(jobUUID), '0', 'EX', 7 * 86400);

    consola.success(
      chalk.green(`✅ [${jobUUID}] Progress tracking initialized`),
    );

    // enqueue first list page per queue (dedup by jobId)
    for (const q of queues) {
      const listJobId = encodeJobId(`${region}:${puuid}:${q}:start=0`);

      // Check if list job already exists and clean it up if completed/failed
      const existingListJob = await listQ.getJob(listJobId);
      if (existingListJob) {
        const state = await existingListJob.getState();
        if (state === 'completed' || state === 'failed') {
          consola.info(
            chalk.blue(`🧹 Cleaning up ${state} list job for queue ${q}`),
          );
          await existingListJob.remove();
        } else {
          consola.warn(
            chalk.yellow(
              `⚠️ List job for queue ${q} already exists in state: ${state}`,
            ),
          );
          continue; // Skip this queue if job is still active
        }
      }

      await redis.incr(OPEN_PAGES(jobUUID));
      await listQ.add(
        'scan:list',
        {
          region,
          puuid,
          step: 'getMatchList',
          opts: { start: 0, season, queue: q, rootId: jobUUID },
        },
        { jobId: listJobId },
      );
      consola.info(
        chalk.yellow(`📋 [${jobUUID}] Enqueued list job for queue ${q}`),
      );
    }

    consola.success(
      chalk.green(
        `🚀 [${jobUUID}] Orchestration complete - ${queues.length} list jobs enqueued`,
      ),
    );

    // Orchestrator exits fast; `/status` will read the progress hash.
    return { ok: true, uuid: jobUUID };
  },
  { connection: redis, limiter: { duration: ms('1s'), max: 10 } },
);
