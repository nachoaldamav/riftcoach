import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { createGzip } from "node:zlib";
import pLimit from "p-limit";
import PQueue from "p-queue";
import consola from "consola";
import chalk from "chalk";
import {
  PlatformId,
  regionToCluster,
  RiotAPI,
  RiotAPITypes,
} from "@fightmegg/riot-api";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "dotenv";

config();

// ---------- ENV ----------
const RAW_S3_BUCKET = normalizeBucket(process.env.S3_BUCKET!);
const AWS_REGION = process.env.AWS_REGION || "eu-west-1";
const CONCURRENCY = Number(process.env.EXPORT_CONCURRENCY || 10);

// Riot API env
const RIOT_API_KEY = process.env.RIOT_API_KEY!;
const RIOT_REGION = process.env.RIOT_REGION || "europe";
const RIOT_CONCURRENCY = Number(process.env.RIOT_CONCURRENCY || 20);
const RIOT_MAX_RETRIES = Number(process.env.RIOT_MAX_RETRIES || 5);

// ---------- Types ----------
type ProAccount = {
  kind: "riotId";
  gameName: string;
  tagLine: string;
  platform: string;
};

type ProPlayer = {
  player: string;
  team: string;
  role: string;
  accounts: ProAccount[];
};

type ProPlayerWithPUUID = {
  player: string;
  team: string;
  role: string;
  accounts: (ProAccount & { puuid?: string })[];
};

type ExportFilters = {
  season?: number;
  fetchPUUIDs?: boolean;
};

// ---------- S3 client ----------
const s3 = new S3Client({ region: AWS_REGION });

// ---------- Riot API client ----------
const riotAPI = new RiotAPI(RIOT_API_KEY);
const riotLimit = pLimit(RIOT_CONCURRENCY);

// Create queue for processing
const exportQueue = new PQueue({ concurrency: CONCURRENCY });

// ---------- S3 key builder ----------
const keyProAccounts = (season: number, league: string, team: string) =>
  `ref/pro_accounts/season=${season}/league=${league}/team=${team}/pro_accounts.jsonl.gz`;

// ---------- helpers ----------
function normalizeBucket(raw: string) {
  const s = raw.trim();
  if (s.startsWith("s3://")) return s.slice(5).replace(/\/+.*/, "");
  return s.replace(/\/+$/, "");
}

function normalizeTeamName(teamName: string): string {
  // Replace spaces and special characters with underscores for S3 key compatibility
  return teamName
    .replace(/[^a-zA-Z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
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
      ContentType: "application/json", // ✅ JSON file
      ContentEncoding: "gzip", // ✅ gzipped
    })
  );
  consola.success(`Uploaded: ${chalk.cyan(Key)}`);
}

async function fetchPUUID(
  gameName: string,
  tagLine: string,
  region: string
): Promise<string | null> {
  return riotLimit(async () => {
    let retries = 0;
    while (retries < RIOT_MAX_RETRIES) {
      try {
        const cluster = regionToCluster(region as RiotAPITypes.LoLRegion);
        consola.info(
          `Fetching PUUID for ${gameName}#${tagLine} in region ${cluster} (${region.toUpperCase()})`
        );
        const account = await riotAPI.account.getByRiotId({
          gameName,
          tagLine,
          region: cluster as
            | PlatformId.EUROPE
            | PlatformId.ASIA
            | PlatformId.AMERICAS
            | PlatformId.ESPORTS,
        });
        consola.success(
          `Fetched PUUID for ${gameName}#${tagLine}: ${account.puuid.slice(
            0,
            8
          )}...${account.puuid.slice(-8)}`
        );
        return account.puuid;
      } catch (error: any) {
        retries++;
        if (error?.status === 404) {
          consola.warn(`Account not found: ${gameName}#${tagLine}`);
          return null;
        }
        if (error?.status === 429) {
          const retryAfter = error?.headers?.["retry-after"] || 1;
          consola.warn(
            `Rate limited, waiting ${retryAfter}s for ${gameName}#${tagLine}`
          );
          await new Promise((resolve) =>
            setTimeout(resolve, retryAfter * 1000)
          );
          continue;
        }
        if (retries >= RIOT_MAX_RETRIES) {
          consola.error(
            `Failed to fetch PUUID for ${gameName}#${tagLine} after ${RIOT_MAX_RETRIES} retries:`,
            error
          );
          return null;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 * retries));
      }
    }
    return null;
  });
}

async function processPlayerAccounts(
  player: ProPlayer,
  fetchPUUIDs: boolean
): Promise<ProPlayerWithPUUID> {
  consola.info(
    `Processing player ${player.player} with ${player.accounts.length} accounts`
  );
  const processedAccounts = await Promise.all(
    player.accounts.map(async (account) => {
      if (fetchPUUIDs) {
        const puuid = await fetchPUUID(
          account.gameName,
          account.tagLine,
          account.platform
        );
        return { ...account, puuid: puuid || undefined };
      }
      return account;
    })
  );

  return {
    ...player,
    accounts: processedAccounts,
  };
}

function loadProPlayersData(filePath: string): ProPlayer[] {
  try {
    const data = readFileSync(filePath, "utf-8");
    return JSON.parse(data) as ProPlayer[];
  } catch (error) {
    consola.error(`Failed to load data from ${filePath}:`, error);
    throw error;
  }
}

function groupPlayersByTeam(
  players: ProPlayerWithPUUID[]
): Map<string, ProPlayerWithPUUID[]> {
  const teamMap = new Map<string, ProPlayerWithPUUID[]>();

  for (const player of players) {
    const team = player.team;
    if (!teamMap.has(team)) {
      teamMap.set(team, []);
    }
    teamMap.get(team)!.push(player);
  }

  return teamMap;
}

async function gzipBuffer(buf: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const gz = createGzip();
    const chunks: Buffer[] = [];
    gz.on("data", (c) => chunks.push(c as Buffer));
    gz.on("end", () => resolve(Buffer.concat(chunks)));
    gz.on("error", reject);
    gz.end(buf);
  });
}

async function exportTeamData(
  team: string,
  players: ProPlayerWithPUUID[],
  season: number,
  league: string
) {
  const normalizedTeamName = normalizeTeamName(team);
  const key = keyProAccounts(season, league, normalizedTeamName);

  // one JSON object per line: { player, role, accounts:[...] }
  const body = players.map((p) => JSON.stringify(p)).join("\n") + "\n";
  const gz = await gzipBuffer(Buffer.from(body));

  await putObject(key, gz);
  consola.info(`Exported ${players.length} players for ${team} → ${key}`);
}

export async function exportProAccountsToS3(
  filters: ExportFilters = {}
): Promise<void> {
  const { season = 2025, fetchPUUIDs = true } = filters;

  consola.start("Starting pro accounts export...");

  // Get current directory
  const currentDir = new URL(".", import.meta.url).pathname;
  const lckPath = join(currentDir, "..", "lck.json");
  const lecPath = join(currentDir, "..", "lec.json");

  try {
    // Load data from both files
    const lckPlayers = loadProPlayersData(lckPath);
    const lecPlayers = loadProPlayersData(lecPath);

    consola.info(
      `Loaded ${lckPlayers.length} LCK players and ${lecPlayers.length} LEC players`
    );

    // Process players (fetch PUUIDs if requested)
    const processLCK = async () => {
      const processed = await Promise.all(
        lckPlayers.map((player) => processPlayerAccounts(player, fetchPUUIDs))
      );
      return { league: "LCK", players: processed };
    };

    const processLEC = async () => {
      const processed = await Promise.all(
        lecPlayers.map((player) => processPlayerAccounts(player, fetchPUUIDs))
      );
      return { league: "LEC", players: processed };
    };

    // Process both leagues concurrently
    const [lckResult, lecResult] = await Promise.all([
      processLCK(),
      processLEC(),
    ]);

    // Group players by team and export
    const exportTasks: Promise<void>[] = [];

    for (const { league, players } of [lckResult, lecResult]) {
      const teamMap = groupPlayersByTeam(players);

      for (const [team, teamPlayers] of teamMap) {
        exportTasks.push(
          exportQueue.add(() =>
            exportTeamData(team, teamPlayers, season, league)
          )
        );
      }
    }

    // Wait for all exports to complete
    await Promise.all(exportTasks);

    const totalTeams = [
      ...groupPlayersByTeam(lckResult.players).keys(),
      ...groupPlayersByTeam(lecResult.players).keys(),
    ].length;
    const totalPlayers = lckResult.players.length + lecResult.players.length;

    consola.success(`✅ Export completed successfully!`);
    consola.info(
      `📊 Exported ${totalPlayers} players across ${totalTeams} teams`
    );
    consola.info(
      `🏆 Leagues: LCK (${lckResult.players.length} players), LEC (${lecResult.players.length} players)`
    );
  } catch (error) {
    consola.error("Export failed:", error);
    throw error;
  }
}

// ---------- CLI ----------
const isDirectRun =
  typeof process !== "undefined" &&
  process.argv?.[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const args = process.argv.slice(2);
  const season = args.find((arg) => arg.startsWith("--season="))?.split("=")[1];
  const fetchPUUIDs = !args.includes("--no-puuids");

  const filters: ExportFilters = {
    season: season ? Number(season) : 2025,
    fetchPUUIDs,
  };

  consola.info("Starting export with filters:", filters);

  exportProAccountsToS3(filters)
    .then(() => {
      consola.success("Export completed successfully!");
      process.exit(0);
    })
    .catch((error) => {
      consola.error("Export failed:", error);
      process.exit(1);
    });
}
