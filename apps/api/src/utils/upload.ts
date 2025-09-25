import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { createGzip } from "node:zlib";
import {
  S3_PREFIX,
  patchBucket as toPatchBucket,
} from "@riftcoach/shared.constants";
import type { RiotAPITypes } from "@fightmegg/riot-api";

type MatchInfo = RiotAPITypes.MatchV5.MatchInfoDTO;
type TimelineFrame = RiotAPITypes.MatchV5.FrameDTO;

export type SourceTag = "riot-api" | "mongo" | "other";

export type UploadersConfig = {
  bucket: string; // "riftcoach"
  region?: string; // defaults to process.env.AWS_REGION
  s3?: S3Client; // inject if you already have a client
};

function gzLine(obj: unknown): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const gz = createGzip();
    const chunks: Buffer[] = [];
    gz.on("data", (c) => chunks.push(c as Buffer));
    gz.on("end", () => resolve(Buffer.concat(chunks)));
    gz.on("error", reject);
    const line = Buffer.from(JSON.stringify(obj) + "\n");
    gz.end(line);
  });
}

function keyMatch(
  season: number,
  patchBucket: string,
  queue: number,
  matchId: string
) {
  return `${S3_PREFIX.RAW_MATCHES}/season=${season}/patch=${patchBucket}/queue=${queue}/matchId=${matchId}.jsonl.gz`;
}
function keyTimeline(
  season: number,
  patchBucket: string,
  queue: number,
  matchId: string
) {
  return `${S3_PREFIX.RAW_TIMELINES}/season=${season}/patch=${patchBucket}/queue=${queue}/matchId=${matchId}.jsonl.gz`;
}

export function createS3Uploaders(cfg: UploadersConfig) {
  const s3 =
    cfg.s3 ??
    new S3Client({
      region: cfg.region || process.env.AWS_REGION || "eu-west-1",
    });
  const Bucket = cfg.bucket;

  /**
   * Upload a single match to the Bronze path. Derives season/patch/queue from info.
   */
  async function uploadMatch(params: {
    matchId: string;
    info: MatchInfo;
    source?: SourceTag;
    extra?: Record<string, unknown>; // optional: anything else you want to stash
  }): Promise<{ key: string }> {
    const { matchId, info, source = "riot-api", extra } = params;

    const season = new Date(info.gameCreation ?? Date.now()).getUTCFullYear();
    const patchBucket = toPatchBucket(String(info.gameVersion ?? ""));
    const queue = Number(info.queueId ?? 0);

    const out = {
      matchId,
      season,
      patch: patchBucket,
      queue,
      info: info ?? null,
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      source,
      ...(extra ?? {}),
    };

    const Key = keyMatch(season, patchBucket, queue, matchId);
    const Body = await gzLine(out);
    await s3.send(
      new PutObjectCommand({
        Bucket,
        Key,
        Body,
        ContentType: "application/json",
        ContentEncoding: "gzip",
      })
    );
    return { key: Key };
  }

  /**
   * Upload a single timeline to the Bronze path.
   * You must pass the meta (season/patchBucket/queue) explicitly.
   */
  async function uploadTimeline(params: {
    matchId: string;
    frames: TimelineFrame[];
    season: number;
    patchBucket: string; // e.g. "15.18"
    queue: number; // 420/440/...
    source?: SourceTag;
    extra?: Record<string, unknown>;
  }): Promise<{ key: string }> {
    const {
      matchId,
      frames,
      season,
      patchBucket,
      queue,
      source = "riot-api",
      extra,
    } = params;

    const out = {
      matchId,
      frames: Array.isArray(frames) ? frames : [],
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      source,
      ...(extra ?? {}),
    };

    const Key = keyTimeline(season, patchBucket, queue, matchId);
    const Body = await gzLine(out);
    await s3.send(
      new PutObjectCommand({
        Bucket,
        Key,
        Body,
        ContentType: "application/json",
        ContentEncoding: "gzip",
      })
    );
    return { key: Key };
  }

  return { uploadMatch, uploadTimeline };
}
