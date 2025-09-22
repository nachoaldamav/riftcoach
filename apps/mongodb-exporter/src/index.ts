import { MongoClient, type WithId } from "mongodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { createGzip } from "node:zlib";
import pLimit from "p-limit";
import PQueue from "p-queue";
import consola from "consola";
import chalk from "chalk";
import {
  S3_PREFIX,
  patchBucket,
  isAllowedQueue,
  ALLOWED_QUEUE_ID_SET,
} from "@riftcoach/shared.constants";
import { type Match, type MatchTimeline } from "@riftcoach/shared.lol-types";
import { pathToFileURL } from "node:url";
import { config } from "dotenv";
import { RiotAPI } from "@fightmegg/riot-api";

config();

// ---------- ENV ----------
const MONGO_URI = process.env.MONGO_URI!;
const RAW_S3_BUCKET = normalizeBucket(process.env.S3_BUCKET!);
const AWS_REGION = process.env.AWS_REGION || "eu-west-1"; // set to your bucket region
const DB_NAME = process.env.MONGO_DB || "rift-tracker";
const MATCHES_COLLECTION = process.env.MATCHES_COLLECTION || "matches";
const TIMELINES_COLLECTION =
  process.env.TIMELINES_COLLECTION || "matches_timeline";
const CONCURRENCY = Number(process.env.EXPORT_CONCURRENCY || 20); // Increased from 5 to 10

// Riot API env
const RIOT_API_KEY = process.env.RIOT_API_KEY!;
const RIOT_REGION = process.env.RIOT_REGION || "europe";
const RIOT_CONCURRENCY = Number(process.env.RIOT_CONCURRENCY || 20);
const RIOT_MAX_RETRIES = Number(process.env.RIOT_MAX_RETRIES || 5);

// ---------- Types ----------
type ExportFilters = {
  season?: number;
  patchBucket?: string; // "15.18"
  queues?: number[]; // if omitted, exporter will default to ALLOWED_QUEUE_IDS
  sinceUpdatedAt?: string; // ISO datetime
};

// ---------- S3 client ----------
const s3 = new S3Client({ region: AWS_REGION });

// ---------- Riot API client ----------
const riotAPI = new RiotAPI(RIOT_API_KEY);

const riotLimit = pLimit(RIOT_CONCURRENCY);

// Create separate queues for matches and timelines to decouple processing
const matchQueue = new PQueue({ concurrency: CONCURRENCY });
const timelineQueue = new PQueue({ concurrency: RIOT_CONCURRENCY });

// ---------- S3 key builders ----------
const keyMatch = (
  season: number | null | undefined,
  pb: string,
  queue: number | null | undefined,
  matchId: string
) =>
  `${S3_PREFIX.RAW_MATCHES}/season=${season ?? 0}/patch=${pb}/queue=${
    queue ?? 0
  }/matchId=${matchId}.jsonl.gz`;

const keyTimeline = (
  season: number | null | undefined,
  pb: string,
  queue: number | null | undefined,
  matchId: string
) =>
  `${S3_PREFIX.RAW_TIMELINES}/season=${season ?? 0}/patch=${pb}/queue=${
    queue ?? 0
  }/matchId=${matchId}.jsonl.gz`;

// ---------- helpers ----------
function normalizeBucket(raw: string) {
  const s = raw.trim();
  if (s.startsWith("s3://")) return s.slice(5).replace(/\/+.*/, "");
  return s.replace(/\/+$/, "");
}

const gzLine = (obj: unknown) =>
  new Promise<Buffer>((resolve, reject) => {
    const gz = createGzip();
    const chunks: Uint8Array[] = [];
    gz.on("data", (c) => chunks.push(c));
    gz.on("end", () => resolve(Buffer.concat(chunks)));
    gz.on("error", reject);
    gz.end(Buffer.from(JSON.stringify(obj) + "\n"));
  });

async function putObject(Key: string, Body: Buffer) {
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: RAW_S3_BUCKET,
        Key,
        Body,
        ContentType: "application/json",
        ContentEncoding: "gzip",
      })
    );
  } catch (e) {
    consola.error(
      chalk.red("❌ S3 Upload Failed:"),
      chalk.yellow(`bucket=${RAW_S3_BUCKET}`),
      chalk.yellow(`key=${Key}`),
      chalk.red(String(e))
    );
    throw e;
  }
}

// Keep Bronze as raw as possible; just add a few top-level fields for partitions.
// NOTE: we store the **bucketed** patch in `patch` so folder becomes patch=<bucket>
function normalizeMatch(doc: WithId<Match>) {
  const season = new Date(doc.info.gameCreation).getUTCFullYear();
  const queue = doc.info.queueId;
  const patchB = patchBucket(doc.info.gameVersion);
  const matchId = doc.metadata.matchId;

  return {
    matchId,
    season,
    patch: patchB, // already bucketed ("15.xx") — used for S3 partition
    queue,
    info: doc.info ?? null,
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
  };
}

function normalizeTimeline(doc: WithId<MatchTimeline>) {
  const matchId = doc.metadata.matchId;
  return {
    matchId,
    frames: doc.info.frames ?? [],
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    source: "mongo" as const,
  };
}

// Riot API fetch: returns { frames: [...] } or null if not found
async function fetchTimelineFromRiotAPI(matchId: string) {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      return await riotLimit(async () => {
        const timeline = await riotAPI.matchV5.getMatchTimelineById({
          cluster: RIOT_REGION as any,
          matchId: matchId,
        });

        if (!timeline) return null;

        // Accept both { info: { frames: [...] } } or { frames: [...] }
        const frames = timeline.info?.frames;
        if (!Array.isArray(frames)) return null;

        return {
          matchId,
          frames,
          schemaVersion: 1,
          exportedAt: new Date().toISOString(),
          source: "riot-api" as const,
        };
      });
    } catch (e: any) {
      const msg = String(e?.message || e);
      const isRetryable =
        /ECONNRESET|ETIMEDOUT|fetch failed|NetworkError|502|503|504|429/.test(
          msg
        );
      if (attempt <= RIOT_MAX_RETRIES && isRetryable) {
        const backoff = Math.min(10_000, 250 * 2 ** (attempt - 1));
        consola.warn(
          chalk.yellow("⚠️  Riot API retry:"),
          chalk.cyan(`matchId=${matchId}`),
          chalk.gray(`attempt=${attempt}/${RIOT_MAX_RETRIES}`),
          chalk.gray(`backoff=${backoff}ms`),
          chalk.red(msg)
        );
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      // if API returns 404 in message, treat as missing
      if (/404/.test(msg)) {
        consola.debug(
          chalk.gray("🔍 Timeline not found in Riot API:"),
          chalk.cyan(`matchId=${matchId}`)
        );
        return null;
      }
      consola.error(
        chalk.red("❌ Riot API fetch failed:"),
        chalk.cyan(`matchId=${matchId}`),
        chalk.gray(`attempt=${attempt}/${RIOT_MAX_RETRIES}`),
        chalk.red(msg)
      );
      throw e;
    }
  }
}

// ---------- main ----------
export async function exportMongoToS3(filters: ExportFilters = {}) {
  if (!MONGO_URI) throw new Error("Missing env: MONGO_URI");
  if (!RAW_S3_BUCKET) throw new Error("Missing/invalid env: S3_BUCKET");

  // Startup logging with configuration
  consola.start(chalk.cyan("🚀 Starting MongoDB to S3 export"));
  consola.info(chalk.blue("Configuration:"));
  consola.info(`  ${chalk.gray("•")} Database: ${chalk.yellow(DB_NAME)}`);
  consola.info(
    `  ${chalk.gray("•")} S3 Bucket: ${chalk.yellow(RAW_S3_BUCKET)}`
  );
  consola.info(`  ${chalk.gray("•")} AWS Region: ${chalk.yellow(AWS_REGION)}`);
  consola.info(
    `  ${chalk.gray("•")} Concurrency: ${chalk.yellow(CONCURRENCY)}`
  );
  consola.info(
    `  ${chalk.gray("•")} Riot API Concurrency: ${chalk.yellow(
      RIOT_CONCURRENCY
    )}`
  );
  consola.info(
    `  ${chalk.gray("•")} Riot API Max Retries: ${chalk.yellow(
      RIOT_MAX_RETRIES
    )}`
  );

  if (Object.keys(filters).length > 0) {
    consola.info(chalk.blue("Filters:"));
    if (filters.season)
      consola.info(
        `  ${chalk.gray("•")} Season: ${chalk.yellow(filters.season)}`
      );
    if (filters.patchBucket)
      consola.info(
        `  ${chalk.gray("•")} Patch: ${chalk.yellow(filters.patchBucket)}`
      );
    if (filters.queues?.length)
      consola.info(
        `  ${chalk.gray("•")} Queues: ${chalk.yellow(
          filters.queues.join(", ")
        )}`
      );
    if (filters.sinceUpdatedAt)
      consola.info(
        `  ${chalk.gray("•")} Since: ${chalk.yellow(filters.sinceUpdatedAt)}`
      );
  }

  consola.info(chalk.blue("🔌 Connecting to MongoDB..."));
  const client = await MongoClient.connect(MONGO_URI);
  const db = client.db(DB_NAME);
  const matchesCol = db.collection<Match>(MATCHES_COLLECTION);
  const timelinesCol = db.collection<MatchTimeline>(TIMELINES_COLLECTION);
  consola.success(chalk.green("✅ Connected to MongoDB"));

  // Build Mongo filter
  const q: any = {};
  if (filters.season !== undefined) {
    // Filter by year of gameCreation (UTC)
    const startOfYear = Date.UTC(filters.season, 0, 1);
    const startOfNextYear = Date.UTC(filters.season + 1, 0, 1);
    q["info.gameCreation"] = { $gte: startOfYear, $lt: startOfNextYear };
  }
  if (filters.patchBucket) {
    // Filter where gameVersion starts with the bucket (e.g., ^15\.18)
    q["info.gameVersion"] = new RegExp(
      `^${filters.patchBucket.replace(".", "\\.")}(\\.|$)`,
      "i"
    );
  }
  if (filters.queues?.length) q["info.queueId"] = { $in: filters.queues };
  else q["info.queueId"] = { $in: Array.from(ALLOWED_QUEUE_ID_SET) };
  if (filters.sinceUpdatedAt)
    q.updatedAt = { $gte: new Date(filters.sinceUpdatedAt) };

  consola.info(chalk.blue("🔍 Building MongoDB query..."));
  consola.info(chalk.gray("Query:"), chalk.dim(JSON.stringify(q, null, 2)));

  const limit = pLimit(CONCURRENCY);
  let n = 0,
    failed = 0;
  const errSamples: string[] = [];
  const startTime = Date.now();

  consola.info(
    chalk.blue("📊 Starting export with decoupled queue architecture...")
  );
  consola.info(
    chalk.gray("Configuration:"),
    chalk.cyan(`match_concurrency=${CONCURRENCY}`),
    chalk.cyan(`timeline_concurrency=${RIOT_CONCURRENCY}`)
  );
  const cursor = matchesCol.find(q, {
    batchSize: 100,
    sort: {
      "info.gameCreation": -1,
    },
    projection: {
      "metadata.matchId": 1,
    },
  });

  // Memory-efficient batch processing: store only match IDs, not full objects
  const BATCH_SIZE = 100; // Reduced for memory efficiency - process smaller batches more frequently
  let matchIdBatch: string[] = [];

  // Separate match processing function - only handles match data
  const processMatch = async (matchId: string) => {
    return matchQueue.add(async () => {
      try {
        // Fetch match data just-in-time to minimize memory usage
        const doc = await matchesCol.findOne({ "metadata.matchId": matchId });
        if (!doc) return null;

        consola.info(chalk.cyan(`🔄 Processing match: ${matchId}`));

        const m = normalizeMatch(doc);

        // honor constants for allowed queues even if DB contains more
        if (typeof m.queue === "number" && !isAllowedQueue(m.queue)) {
          return null;
        }

        const pb = m.patch; // already bucketed
        const matchKey = keyMatch(m.season, pb, m.queue, m.matchId);

        // Process match data immediately and release from memory
        const body = await gzLine(m);
        await putObject(matchKey, body);

        // Return match metadata for timeline processing
        return {
          matchId: m.matchId,
          season: m.season,
          patch: pb,
          queue: m.queue,
        };
      } catch (e: any) {
        failed++;
        if (errSamples.length < 10) {
          errSamples.push(`${matchId}: ${e?.message ?? String(e)}`);
        }
        return null;
      }
    });
  };

  // Separate timeline processing function - runs independently
  const processTimeline = async (matchMetadata: {
    matchId: string;
    season: number | null | undefined;
    patch: string;
    queue: number | null | undefined;
  }) => {
    return timelineQueue.add(async () => {
      try {
        const { matchId, season, patch, queue } = matchMetadata;

        // Try Mongo timeline first - direct query to avoid keeping data in memory
        const tl = await timelinesCol.findOne({
          "metadata.matchId": matchId,
        });

        if (tl) {
          consola.info(chalk.cyan(`🔄 Found timeline for match: ${matchId}`));
          const t = normalizeTimeline(tl);
          const timelineKey = keyTimeline(season, patch, queue, matchId);
          const bodyTl = await gzLine(t);
          await putObject(timelineKey, bodyTl);
          // Timeline data is processed and released immediately
        } else {
          consola.info(
            chalk.cyan(`🔄 No timeline found in DB for match: ${matchId}`)
          );
          // Fetch via Riot API - data is processed immediately without storing
          const riotTl = await fetchTimelineFromRiotAPI(matchId);
          if (riotTl?.frames?.length) {
            consola.info(
              chalk.cyan(`🔄 Found timeline via Riot API for match: ${matchId}`)
            );
            const timelineKey = keyTimeline(season, patch, queue, matchId);
            const bodyTl = await gzLine(riotTl);
            await putObject(timelineKey, bodyTl);
            // Riot API timeline data is processed and released immediately
          }
        }
      } catch (e: any) {
        consola.error(
          chalk.red(
            `❌ Timeline processing failed for ${matchMetadata.matchId}: ${
              e?.message ?? String(e)
            }`
          )
        );
      }
    });
  };

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    if (!doc) break;

    // Store only the match ID, not the full document
    const matchId = doc.metadata?.matchId;
    if (matchId) {
      matchIdBatch.push(matchId);
    }

    n++;

    // Process batch when it reaches BATCH_SIZE or every 1000 items for progress
    if (matchIdBatch.length >= BATCH_SIZE || n % 1000 === 0) {
      if (matchIdBatch.length > 0) {
        const batchStartTime = Date.now();

        // Process match IDs in parallel with decoupled timeline processing
        const processingTasks = matchIdBatch.map(async (matchId) => {
          const matchMetadata = await processMatch(matchId);
          // If match processing succeeded, enqueue timeline processing independently
          if (matchMetadata) {
            processTimeline(matchMetadata); // Fire and forget - runs in separate queue
          }
        });
        await Promise.all(processingTasks);

        const batchDuration = Date.now() - batchStartTime;

        consola.debug(
          chalk.gray("⚡ Batch processed:"),
          chalk.cyan(`size=${matchIdBatch.length}`),
          chalk.gray(`duration=${batchDuration}ms`),
          chalk.gray(
            `rate=${(matchIdBatch.length / (batchDuration / 1000)).toFixed(
              1
            )}/s`
          )
        );

        matchIdBatch = []; // Clear the batch to free memory

        // Enhanced garbage collection hints for memory optimization
        if (global.gc) {
          global.gc();
        }

        // Additional memory pressure relief
        if (typeof global.gc === "undefined") {
          // Suggest running with --expose-gc for better memory management
          if (n === 1000) {
            // Only log once
            consola.debug(
              chalk.yellow(
                "💡 Tip: Run with --expose-gc flag for better memory management"
              )
            );
          }
        }
      }

      if (n % 1000 === 0) {
        const elapsed = Date.now() - startTime;
        const rate = n / (elapsed / 1000);
        const successRate = (((n - failed) / n) * 100).toFixed(1);

        // Memory usage monitoring
        const memUsage = process.memoryUsage();
        const memUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
        const memTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);

        // Queue status monitoring for decoupled processing
        const matchQueueStatus = `${matchQueue.pending}/${matchQueue.size}`;
        const timelineQueueStatus = `${timelineQueue.pending}/${timelineQueue.size}`;

        consola.info(
          chalk.green("📈 Progress:"),
          chalk.cyan(`processed=${n}`),
          chalk.yellow(`failed=${failed}`),
          chalk.green(`success=${successRate}%`),
          chalk.gray(`rate=${rate.toFixed(1)}/s`),
          chalk.gray(`elapsed=${(elapsed / 1000).toFixed(1)}s`),
          chalk.magenta(`mem=${memUsedMB}/${memTotalMB}MB`),
          chalk.blue(`match_q=${matchQueueStatus}`),
          chalk.blue(`timeline_q=${timelineQueueStatus}`)
        );
      }
    }
  }

  // Process any remaining items in the final batch
  if (matchIdBatch.length > 0) {
    const finalBatchStartTime = Date.now();
    const finalProcessingTasks = matchIdBatch.map(async (matchId) => {
      const matchMetadata = await processMatch(matchId);
      // If match processing succeeded, enqueue timeline processing independently
      if (matchMetadata) {
        processTimeline(matchMetadata); // Fire and forget - runs in separate queue
      }
    });
    await Promise.all(finalProcessingTasks);
    const finalBatchDuration = Date.now() - finalBatchStartTime;

    consola.debug(
      chalk.gray("⚡ Final batch processed:"),
      chalk.cyan(`size=${matchIdBatch.length}`),
      chalk.gray(`duration=${finalBatchDuration}ms`)
    );
  }

  const totalDuration = Date.now() - startTime;
  const avgRate = n / (totalDuration / 1000);
  const successRate = (((n - failed) / n) * 100).toFixed(1);

  // Wait for all timeline processing to complete
  consola.info(chalk.blue("⏳ Waiting for timeline queue to complete..."));
  await timelineQueue.onIdle();

  const finalDuration = Date.now() - startTime;
  const finalAvgRate = n / (finalDuration / 1000);

  consola.success(
    chalk.green("✅ Export completed!"),
    chalk.cyan(`total=${n}`),
    chalk.yellow(`failed=${failed}`),
    chalk.green(`success=${successRate}%`),
    chalk.gray(`avg_rate=${finalAvgRate.toFixed(1)}/s`),
    chalk.gray(`total_time=${(finalDuration / 1000).toFixed(1)}s`)
  );

  // Queue statistics
  consola.info(
    chalk.blue("📊 Queue Statistics:"),
    chalk.gray(`match_queue_size=${matchQueue.size}`),
    chalk.gray(`timeline_queue_size=${timelineQueue.size}`),
    chalk.gray(`match_queue_pending=${matchQueue.pending}`),
    chalk.gray(`timeline_queue_pending=${timelineQueue.pending}`)
  );
  if (failed) {
    consola.warn(
      chalk.yellow("⚠️  Some exports failed:"),
      chalk.red(`count=${failed}`),
      chalk.gray("Sample errors:")
    );
    errSamples.forEach((sample, i) => {
      consola.warn(chalk.gray(`  ${i + 1}.`), chalk.red(sample));
    });
  }

  await client.close();
  consola.info(chalk.blue("🔌 MongoDB connection closed"));
}

// CLI (ESM-safe)
const isDirectRun =
  typeof process !== "undefined" &&
  process.argv?.[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  // simple arg parsing
  const args = new Map<string, string>();
  for (const a of process.argv.slice(2)) {
    const [k, v] = a.startsWith("--") ? a.slice(2).split("=") : [a, ""];
    if (k) args.set(k, v ?? "");
  }

  const filters: ExportFilters = {
    season: args.has("season") ? Number(args.get("season")) : undefined,
    patchBucket: args.get("patch"),
    queues: args.has("queues")
      ? args
          .get("queues")!
          .split(",")
          .map((x) => Number(x.trim()))
      : undefined,
    sinceUpdatedAt: args.get("since"),
  };

  exportMongoToS3(filters).catch((err) => {
    consola.error(
      chalk.red("💥 Export failed with error:"),
      chalk.gray(err?.stack || err?.message || String(err))
    );
    process.exit(1);
  });
}
