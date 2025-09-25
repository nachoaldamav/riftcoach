import { Queue, Worker } from "bullmq";
import {
  PlatformId,
  type RiotAPITypes,
  regionToCluster,
} from "@fightmegg/riot-api";
import { redis } from "../clients/redis.js";
import { riotAPI } from "../clients/riot.js";
import ms from "ms";
import { createS3Uploaders } from "../utils/upload.js";
import { patchBucket } from "@riftcoach/shared.constants";
import { consola } from "consola";
import chalk from "chalk";
import { encodeJobId } from "./rewind.js";
import { getMatch, getMatchTimeline } from "../queries/get-match.js";

const { uploadMatch, uploadTimeline } = createS3Uploaders({
  bucket: process.env.S3_BUCKET!,
});

export const listQ = new Queue("scan-list", {
  connection: redis,
  defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 1000 },
});
export const fetchQ = new Queue("scan-fetch", {
  connection: redis,
  defaultJobOptions: { removeOnComplete: 10000, removeOnFail: 10000 },
});

interface BaseWorkerParams {
  region: RiotAPITypes.LoLRegion;
  puuid: string;
  step: "getMatchList" | "getMatch";
  opts: Record<string, unknown>;
}

interface GetMatchListWorkerParams extends BaseWorkerParams {
  step: "getMatchList";
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
  step: "getMatch";
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
        `📋 Listing matches - Queue: ${queue}, Start: ${start}, Season: ${season}`
      )
    );

    const startSec = Math.floor(Date.UTC(season, 0, 1) / 1000);

    let ids: string[] = [];
    try {
      consola.info(chalk.yellow(`🔍 Fetching match IDs from Riot API...`));
      ids = await riotAPI.matchV5.getIdsByPuuid({
        cluster: region as
          | PlatformId.EUROPE
          | PlatformId.ASIA
          | PlatformId.SEA
          | PlatformId.AMERICAS,
        puuid,
        params: {
          start,
          count: 100,
          queue,
          startTime: startSec,
        },
      });
      consola.success(chalk.green(`✅ Found ${ids.length} match IDs`));
    } catch (e: any) {
      if (String(e?.status) === "429") {
        consola.warn(
          chalk.yellow(
            `⚠️ Rate limited - retry after: ${e?.headers?.["retry-after"]}s`
          )
        );
        await job.updateProgress({ retryAfter: e?.headers?.["retry-after"] });
        throw e;
      }
      consola.error(chalk.red(`❌ Error fetching match IDs:`), e);
      throw e;
    }

    const progKey = `rc:rewind:prog:${rootId}`;
    await Promise.all([
      redis.hincrby(progKey, `pagesDone_${queue}`, 1),
      redis.hincrby(progKey, "idsFound", ids.length),
      redis.hset(progKey, "updatedAt", Date.now().toString()),
      redis.expire(progKey, 7 * 86400),
    ]);

    consola.info(
      chalk.cyan(`📊 Updated progress - Queue ${queue} page completed`)
    );

    // stream matches into fetchQ (dedup by jobId = matchId)
    const fetchJobs = [];
    for (const matchId of ids) {
      // Check if fetch job already exists and clean it up if completed/failed
      const existingFetchJob = await fetchQ.getJob(matchId);
      if (existingFetchJob) {
        const state = await existingFetchJob.getState();
        if (state === "completed" || state === "failed") {
          consola.info(
            chalk.blue(`🧹 Cleaning up ${state} fetch job for match ${matchId}`)
          );
          await existingFetchJob.remove();
        } else {
          consola.warn(
            chalk.yellow(
              `⚠️ Fetch job for match ${matchId} already exists in state: ${state}`
            )
          );
          continue; // Skip this match if job is still active
        }
      }

      await redis.incr(`rc:rewind:openFetch:${rootId}`);
      fetchJobs.push(
        fetchQ.add(
          "scan:fetch",
          { region, puuid, opts: { matchId, rootId } },
          { jobId: matchId }
        )
      );
    }

    await Promise.all(fetchJobs);

    consola.success(chalk.green(`🚀 Enqueued ${ids.length} fetch jobs`));

    // next page if needed
    if (ids.length === 100) {
      const nextJobId = encodeJobId(
        `${region}:${puuid}:${queue}:start=${start + 100}`
      );

      // Check if next page job already exists and clean it up if completed/failed
      const existingNextJob = await listQ.getJob(nextJobId);
      if (existingNextJob) {
        const state = await existingNextJob.getState();
        if (state === "completed" || state === "failed") {
          consola.info(
            chalk.blue(
              `🧹 Cleaning up ${state} next page job for queue ${queue}`
            )
          );
          await existingNextJob.remove();
        } else {
          consola.warn(
            chalk.yellow(
              `⚠️ Next page job for queue ${queue} already exists in state: ${state}`
            )
          );
          // Don't schedule duplicate job
          return;
        }
      }

      await redis.incr(`rc:rewind:openPages:${rootId}`);
      await listQ.add(
        "scan-list",
        {
          region,
          puuid,
          step: "getMatchList",
          opts: { start: start + 100, season, queue, rootId },
        },
        {
          jobId: nextJobId,
        }
      );
      consola.info(
        chalk.yellow(
          `📋 Enqueued next page - Queue: ${queue}, Start: ${start + 100}`
        )
      );
    } else {
      consola.info(
        chalk.blue(
          `🏁 Last page for queue ${queue} - found ${ids.length} matches`
        )
      );
    }

    const left = await redis.decr(`rc:rewind:openPages:${rootId}`);
    if (ids.length === 100) {
      // you scheduled the next page above; counter will be incremented there
    } else {
      // if no more pages & no fetches left, mark ready
      const openFetch =
        Number(await redis.get(`rc:rewind:openFetch:${rootId}`)) || 0;
      if (left <= 0 && openFetch === 0) {
        await redis.hset(progKey, {
          state: "ready",
          updatedAt: Date.now().toString(),
        });
        consola.success(
          chalk.green(`🎯 All listing complete - marked as ready!`)
        );
      } else {
        consola.info(
          chalk.cyan(`📈 Pages left: ${left}, Fetches pending: ${openFetch}`)
        );
      }
    }
  },
  {
    connection: redis,
    concurrency: 1,
    limiter: { duration: ms("2m"), max: 1 },
  }
);

export const fetchWorker = new Worker<GetMatchWorkerParams>(
  fetchQ.name,
  async (job) => {
    const { matchId, rootId } = job.data.opts;

    consola.info(chalk.blue(`🎮 Fetching match: ${matchId}`));

    const progKey = `rc:rewind:prog:${rootId}`;
    const openFetchKey = `rc:rewind:openFetch:${rootId}`;
    const [shard] = matchId.split("_");
    const cluster = regionToCluster(
      shard.toLowerCase() as RiotAPITypes.LoLRegion
    ) as
      | PlatformId.EUROPE
      | PlatformId.ASIA
      | PlatformId.SEA
      | PlatformId.AMERICAS;

    try {
      consola.info(
        chalk.yellow(`🔍 Fetching match data and timeline from Riot API...`)
      );
      const m = await getMatch(matchId, cluster);

      consola.info(chalk.blue(`🔎 Fetched match data`));

      // Wait one second
      await new Promise((resolve) => setTimeout(resolve, 2_000));

      consola.info(chalk.blue(`🔎 Fetching match timeline`));

      const t = await getMatchTimeline(matchId, cluster);

      consola.info(chalk.blue(`🔎 Fetched match timeline`));

      consola.success(chalk.green(`✅ Retrieved match data for ${matchId}`));

      consola.info(chalk.cyan(`☁️ Uploading match to S3...`));
      await uploadMatch({
        matchId,
        info: m.info,
        source: "riot-api",
      });

      const season = new Date(m.info.gameCreation).getUTCFullYear();
      const pb = patchBucket(m.info.gameVersion);
      const queue = m.info.queueId;

      consola.info(chalk.cyan(`☁️ Uploading timeline to S3...`));
      await uploadTimeline({
        matchId,
        frames: t.info.frames,
        season,
        patchBucket: pb,
        queue,
        source: "riot-api",
      });

      consola.success(
        chalk.green(
          `📤 Successfully uploaded ${matchId} - Queue: ${queue}, Patch: ${m.info.gameVersion}`
        )
      );

      // bump counters
      await redis.hincrby(progKey, "matchesFetched", 1);
      if (t?.info?.frames?.length) {
        await redis.hincrby(progKey, "timelinesFetched", 1);
        consola.info(
          chalk.cyan(`📊 Updated counters - Match & timeline processed`)
        );
      } else {
        consola.warn(
          chalk.yellow(`⚠️ No timeline frames found for ${matchId}`)
        );
        consola.info(
          chalk.cyan(`📊 Updated counters - Match processed (no timeline)`)
        );
      }
      await redis.hset(progKey, "updatedAt", Date.now().toString());
      await redis.expire(progKey, 7 * 86400);

      // decrement open fetch and maybe mark ready
      const left = await redis.decr(openFetchKey);
      const openPages =
        Number(await redis.get(`rc:rewind:openPages:${rootId}`)) || 0;
      if (left <= 0 && openPages === 0) {
        await redis.hset(progKey, {
          state: "ready",
          updatedAt: Date.now().toString(),
        });
        consola.success(
          chalk.green(`🎯 All fetching complete - marked as ready!`)
        );
      } else {
        consola.info(
          chalk.cyan(`📈 Fetches left: ${left}, Pages pending: ${openPages}`)
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
    concurrency: 1, // parallel fetch jobs
    limiter: { duration: ms("1s"), max: 1 },
  }
);
