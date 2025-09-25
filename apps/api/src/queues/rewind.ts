// src/queues/rewind.ts
import { Queue, Worker } from "bullmq";
import { redis } from "../clients/redis.js";
import ms from "ms";
import { listQ } from "./scan.js"; // your listQ from the code you pasted
import { consola } from "consola";
import chalk from "chalk";
import { ALLOWED_QUEUE_IDS } from "@riftcoach/shared.constants";

export const rewindQ = new Queue("rewind", {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
  },
});

const PROG = (id: string) => `rc:rewind:prog:${id}`;
const OPEN_PAGES = (id: string) => `rc:rewind:openPages:${id}`;
const OPEN_FETCH = (id: string) => `rc:rewind:openFetch:${id}`;

export function makeRewindJobId(scope: string, region: string, puuid: string) {
  return `${scope}:${region}:${puuid}`;
}

// Encode job ID for use as BullMQ custom ID (base64 encoding to avoid conflicts)
export function encodeJobId(jobId: string): string {
  return Buffer.from(jobId, "utf8").toString("base64");
}

// Decode job ID back to original format
export function decodeJobId(encodedJobId: string): string {
  return Buffer.from(encodedJobId, "base64").toString("utf8");
}

// Orchestrator: enqueue first pages for 420 & 440 and initialize progress
export const worker = new Worker(
  rewindQ.name,
  async (job) => {
    const {
      region,
      puuid,
      season,
      queues = ALLOWED_QUEUE_IDS,
    } = job.data as {
      region: "europe" | "americas" | "asia" | "sea";
      puuid: string;
      season: number;
      queues?: number[];
    };

    consola.info(chalk.blue(`🎯 [${job.id}] Starting rewind orchestration`));
    consola.info(
      chalk.cyan(
        `📊 Region: ${region}, PUUID: ${puuid}, Season: ${season}, Queues: [${queues.join(
          ", "
        )}]`
      )
    );

    // init progress hash + open counters
    await redis.hset(PROG(job.id!), {
      state: "listing",
      pagesDone_420: "0",
      pagesDone_440: "0",
      idsFound: "0",
      matchesFetched: "0",
      timelinesFetched: "0",
      startedAt: Date.now().toString(),
      updatedAt: Date.now().toString(),
    });
    await redis.expire(PROG(job.id!), 7 * 86400);
    await redis.set(OPEN_PAGES(job.id!), "0", "EX", 7 * 86400);
    await redis.set(OPEN_FETCH(job.id!), "0", "EX", 7 * 86400);

    consola.success(
      chalk.green(`✅ [${job.id}] Progress tracking initialized`)
    );

    // enqueue first list page per queue (dedup by jobId)
    for (const q of queues) {
      const listJobId = encodeJobId(`${region}:${puuid}:${q}:start=0`);
      
      // Check if list job already exists and clean it up if completed/failed
      const existingListJob = await listQ.getJob(listJobId);
      if (existingListJob) {
        const state = await existingListJob.getState();
        if (state === "completed" || state === "failed") {
          consola.info(
            chalk.blue(`🧹 Cleaning up ${state} list job for queue ${q}`)
          );
          await existingListJob.remove();
        } else {
          consola.warn(
            chalk.yellow(`⚠️ List job for queue ${q} already exists in state: ${state}`)
          );
          continue; // Skip this queue if job is still active
        }
      }

      await redis.incr(OPEN_PAGES(job.id!));
      await listQ.add(
        "scan:list",
        {
          region,
          puuid,
          step: "getMatchList",
          opts: { start: 0, season, queue: q, rootId: job.id! },
        },
        { jobId: listJobId }
      );
      consola.info(
        chalk.yellow(`📋 [${job.id}] Enqueued list job for queue ${q}`)
      );
    }

    consola.success(
      chalk.green(
        `🚀 [${job.id}] Orchestration complete - ${queues.length} list jobs enqueued`
      )
    );

    // Orchestrator exits fast; `/status` will read the progress hash.
    return { ok: true };
  },
  { connection: redis, limiter: { duration: ms("1s"), max: 10 } }
);
