import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { createGzip, gunzipSync } from "node:zlib";
import PQueue from "p-queue";
import consola from "consola";
import chalk from "chalk";
import { S3_PREFIX, patchBucket } from "@riftcoach/shared.constants";
import {
  PlatformId,
  regionToCluster,
  RiotAPI,
  RiotAPITypes,
} from "@fightmegg/riot-api";

// ---------- ENV ----------
const RAW_S3_BUCKET = normalizeBucket(process.env.S3_BUCKET!);
const AWS_REGION = process.env.AWS_REGION || "eu-west-1";
const RIOT_API_KEY = process.env.RIOT_API_KEY!;
const PRO_ACCOUNTS_PREFIX = process.env.PRO_ACCOUNTS_PREFIX!; // eg: "ref/pro_accounts/season=2025/"
const ONLY_MODE = (process.env.ONLY || "both") as
  | "matches"
  | "timelines"
  | "both";
const QUEUES = (process.env.QUEUES || "420,440")
  .split(",")
  .map((x) => Number(x.trim()));

// ---------- clients ----------
const s3 = new S3Client({ region: AWS_REGION });
const riot = new RiotAPI(RIOT_API_KEY, {});

// Rate limiting queues for Riot API
const riotQueue = new PQueue({
  concurrency: 1,
  interval: 1000, // 1 second
  intervalCap: 10, // 100 requests per second (Riot API allows up to 100/sec for personal keys)
});

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
  await s3.send(
    new PutObjectCommand({
      Bucket: RAW_S3_BUCKET,
      Key,
      Body,
      ContentType: "application/json",
      ContentEncoding: "gzip",
    })
  );
}

function keyMatch(season: number, pb: string, queue: number, matchId: string) {
  return `${S3_PREFIX.RAW_MATCHES}/season=${season}/patch=${pb}/queue=${queue}/matchId=${matchId}.jsonl.gz`;
}

function keyTimeline(
  season: number,
  pb: string,
  queue: number,
  matchId: string
) {
  return `${S3_PREFIX.RAW_TIMELINES}/season=${season}/patch=${pb}/queue=${queue}/matchId=${matchId}.jsonl.gz`;
}

function platformToRegional(p: string): "europe" | "americas" | "asia" | "sea" {
  const x = p.toLowerCase();
  if (["euw1", "eun1", "tr1", "ru"].includes(x)) return "europe";
  if (["na1", "br1", "la1", "la2", "oc1"].includes(x)) return "americas";
  if (["kr", "jp1"].includes(x)) return "asia";
  return "sea";
}

function seasonStartUnix(year: number) {
  return Math.floor(Date.UTC(year, 0, 1) / 1000);
}

// Read pro accounts (your nested players JSONL) and flatten accounts
type FlatAcc = {
  player: string;
  team: string;
  role: string;
  platform: string;
  gameName: string;
  tagLine: string;
  puuid?: string;
};

async function* iterProAccounts(): AsyncGenerator<FlatAcc> {
  try {
    const list = await s3.send(
      new ListObjectsV2Command({
        Bucket: RAW_S3_BUCKET,
        Prefix: PRO_ACCOUNTS_PREFIX,
      })
    );

    for (const obj of list.Contents ?? []) {
      if (!obj.Key?.endsWith(".jsonl.gz")) continue;

      try {
        consola.info(`Processing pro accounts file: ${obj.Key}`);
        const got = await s3.send(
          new GetObjectCommand({ Bucket: RAW_S3_BUCKET, Key: obj.Key })
        );

        if (!got.Body) {
          consola.warn(`No body found for S3 object: ${obj.Key}`);
          continue;
        }

        // Handle the stream properly
        let buf: Buffer;
        try {
          buf = Buffer.from(await got.Body.transformToByteArray());
        } catch (streamError: any) {
          consola.error(
            `Failed to read stream for ${obj.Key}:`,
            streamError?.message ?? String(streamError)
          );
          continue;
        }

        let raw: string;
        try {
          raw = gunzipSync(buf).toString("utf8");
        } catch (gzipError: any) {
          consola.error(
            `Failed to decompress ${obj.Key}:`,
            gzipError?.message ?? String(gzipError)
          );
          continue;
        }

        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;

          try {
            const row = JSON.parse(line);
            for (const acc of row.accounts ?? []) {
              yield {
                player: row.player,
                team: row.team,
                role: row.role,
                platform: acc.platform,
                gameName: acc.gameName,
                tagLine: acc.tagLine,
                puuid: acc.puuid,
              };
            }
          } catch (jsonError: any) {
            consola.error(
              `Failed to parse JSON line in ${obj.Key}:`,
              jsonError?.message ?? String(jsonError)
            );
            consola.error(`Problematic line: ${line.substring(0, 100)}...`);
            continue;
          }
        }
      } catch (fileError: any) {
        consola.error(
          `Failed to process file ${obj.Key}:`,
          fileError?.message ?? String(fileError)
        );
        continue;
      }
    }
  } catch (listError: any) {
    consola.error(
      `Failed to list S3 objects with prefix ${PRO_ACCOUNTS_PREFIX}:`,
      listError?.message ?? String(listError)
    );
    throw listError;
  }
}

// ---------- main ----------
export const handler = async () => {
  try {
    const season = Number(process.env.SEASON || 2025);
    const seasonStart = seasonStartUnix(season);

    consola.start(chalk.cyan("🎯 Pro exporter starting"));
    consola.info(`Bucket: ${RAW_S3_BUCKET}`);
    consola.info(
      `Only: ${ONLY_MODE} | Queues: ${QUEUES.join(",")} | Season: ${season}`
    );

    /**
     * List of matches with matchId as key and the value is an array of PUUIDs
     * This avoids fetching the same match more than once if more than one pro
     * was in that match.
     */
    const matchesMap = new Map<string, string[]>();

    try {
      for await (const acc of iterProAccounts()) {
        consola.info(
          `Account: ${acc.gameName}#${acc.tagLine} (${acc.platform})`
        );
        if (!acc.puuid) continue; // unresolved account
        const regional = platformToRegional(acc.platform);

        await riotQueue.add(async () => {
          let start = 0;
          while (true) {
            try {
              consola.info(
                `[${acc.gameName}#${
                  acc.tagLine
                }] Fetching matches (all queues) (page: ${
                  start === 0 ? 1 : start / 100
                })`
              );
              const startTime = Date.now();
              const matches = await riot.matchV5.getIdsByPuuid({
                cluster: regional as any,
                puuid: acc.puuid!,
                params: {
                  start,
                  count: 100,
                  // Remove queue filter to get all matches
                  startTime: seasonStart,
                },
              });
              const endTime = Date.now();
              consola.info(
                `[${acc.gameName}#${acc.tagLine}] Fetched ${
                  matches.length
                } matches in ${(endTime - startTime).toFixed(0)}ms`
              );

              if (!Array.isArray(matches)) continue;
              for (const matchId of matches) {
                matchesMap.set(
                  matchId,
                  (matchesMap.get(matchId) || []).concat(acc.puuid as string)
                );
              }
              if (matches.length < 100) {
                consola.info(
                  `[${acc.gameName}#${
                    acc.tagLine
                  }] Finished fetching matches (total: ${
                    start + matches.length
                  })`
                );
                break;
              } else {
                consola.info(
                  `[${acc.gameName}#${acc.tagLine}] Fetched ${
                    matches.length
                  } matches (total: ${start + matches.length})`
                );
              }
              start += 100;
            } catch (riotError: any) {
              consola.error(
                chalk.red(
                  `❌ Failed to fetch matches for ${acc.gameName}#${acc.tagLine}:`
                ),
                chalk.red(riotError?.message ?? String(riotError))
              );
              // Continue with next account instead of breaking the entire process
              break;
            }
          }
        });
      }
    } catch (accountsError: any) {
      consola.error(
        chalk.red("❌ Failed to process pro accounts:"),
        chalk.red(accountsError?.message ?? String(accountsError))
      );
      throw accountsError;
    }

    consola.info(`Waiting for all matches ID`);
    await riotQueue.onEmpty();
    consola.info(`All matches ID fetched`);

    for await (const [matchId] of matchesMap) {
      const [region] = matchId.split("_");
      const cluster = regionToCluster(
        region?.toLowerCase() as RiotAPITypes.LoLRegion
      ) as
        | PlatformId.EUROPE
        | PlatformId.ASIA
        | PlatformId.SEA
        | PlatformId.AMERICAS;

      await riotQueue.add(async () => {
        try {
          consola.info(`[${matchId}] Fetching match`);
          const m = await riot.matchV5.getMatchById({
            cluster,
            matchId,
          });

          consola.info(`[${matchId}] Fetched match`);

          // Filter matches by queue after fetching
          if (!QUEUES.includes(m.info.queueId)) {
            consola.info(
              `[${matchId}] Skipping match - queue ${
                m.info.queueId
              } not in filter [${QUEUES.join(",")}]`
            );
            return;
          }

          const queue = m.info.queueId;
          const patch = m.info.gameVersion;

          // Normalize match data for S3
          const normalizedMatch = {
            matchId,
            season: new Date(m.info.gameCreation).getUTCFullYear(),
            patch: patchBucket(patch), // bucketed patch version
            queue,
            info: m.info ?? null,
            schemaVersion: 1,
            exportedAt: new Date().toISOString(),
          };

          // Save match to S3
          try {
            const matchKey = keyMatch(
              normalizedMatch.season,
              normalizedMatch.patch,
              normalizedMatch.queue,
              matchId
            );
            const matchBody = await gzLine(normalizedMatch);
            await putObject(matchKey, matchBody);
            consola.info(`[${matchId}] Saved match to S3`);

            // Process timeline directly (no nested queue to avoid deadlock)
            try {
              consola.info(`[${matchId}] Fetching match timeline`);
              const tl = await riot.matchV5.getMatchTimelineById({
                cluster,
                matchId,
              });

              consola.info(`[${matchId}] Fetched match timeline`);

              // Normalize timeline data for S3
              const normalizedTimeline = {
                matchId,
                frames: tl.info?.frames ?? [],
                schemaVersion: 1,
                exportedAt: new Date().toISOString(),
                source: "riot-api" as const,
              };

              // Save timeline to S3
              try {
                const timelineKey = keyTimeline(
                  normalizedMatch.season,
                  normalizedMatch.patch,
                  normalizedMatch.queue,
                  matchId
                );
                const timelineBody = await gzLine(normalizedTimeline);
                await putObject(timelineKey, timelineBody);
                consola.info(`[${matchId}] Saved timeline to S3`);
              } catch (e: any) {
                consola.error(
                  chalk.red(`❌ Failed to save timeline ${matchId} to S3:`),
                  chalk.red(e?.message ?? String(e))
                );
                throw e;
              }
            } catch (timelineError: any) {
              consola.error(
                chalk.red(`❌ Failed to process timeline for ${matchId}:`),
                chalk.red(timelineError?.message ?? String(timelineError))
              );
              throw timelineError;
            }

            consola.info(`[${matchId}] Processed match and timeline`);
          } catch (e: any) {
            consola.error(
              chalk.red(`❌ Failed to save match ${matchId} to S3:`),
              chalk.red(e?.message ?? String(e))
            );
            throw e;
          }
        } catch (matchError: any) {
          consola.error(
            chalk.red(`❌ Failed to process match ${matchId}:`),
            chalk.red(matchError?.message ?? String(matchError))
          );
          throw matchError;
        }
      });

      consola.info(`[${matchId}] Added match to queue`);
    }

    consola.info(`Waiting for all matches to be processed`);
    await riotQueue.onEmpty();

    consola.success(chalk.green("✅ Pro export finished!"));
    return { ok: true };
  } catch (error: any) {
    consola.error(
      chalk.red("❌ Pro exporter failed with error:"),
      chalk.red(error?.message ?? String(error))
    );

    // Log the full error object for debugging
    if (error && typeof error === "object") {
      consola.error("Full error object:", JSON.stringify(error, null, 2));
    }

    // Re-throw to ensure lambda fails properly
    throw error;
  }
};
