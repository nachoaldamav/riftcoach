import { promisify } from 'node:util';
import { gunzipSync, gzip as gzipCallback } from 'node:zlib';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import chalk from 'chalk';
import { consola } from 'consola';
import { s3Client } from '../clients/s3.js';
import type { CacheMetadata, CachedData } from './types.js';

const gzip = promisify(gzipCallback);

// S3 bucket for caching
const CACHE_BUCKET = process.env.S3_BUCKET || 'riftcoach';
const CACHE_TTL_HOURS = 24; // 1 day TTL

export function getCacheKey(
  type: 'player-stats' | 'ai-results',
  puuid: string,
  scope?: string,
): string {
  const scopeStr = scope || 'default';
  return `cache/${type}/puuid=${puuid}/scope=${scopeStr}/data.json.gz`;
}

export function isExpired(expiresAt: string): boolean {
  return new Date() > new Date(expiresAt);
}

export async function getCachedData<T>(cacheKey: string): Promise<T | null> {
  try {
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: CACHE_BUCKET,
        Key: cacheKey,
      }),
    );

    if (!response.Body) {
      return null;
    }

    const buffer = Buffer.from(await response.Body.transformToByteArray());
    const decompressed = gunzipSync(buffer);
    const cached: CachedData<T> = JSON.parse(decompressed.toString('utf8'));

    if (isExpired(cached.metadata.expiresAt)) {
      consola.debug(chalk.gray(`Cache expired for key: ${cacheKey}`));
      return null;
    }

    consola.debug(chalk.green(`Cache hit for key: ${cacheKey}`));
    return cached.data;
  } catch (error: unknown) {
    const err = error as Error;
    if (err.name === 'NoSuchKey') {
      consola.debug(chalk.gray(`Cache miss for key: ${cacheKey}`));
      return null;
    }
    consola.warn(chalk.yellow(`Failed to get cached data: ${err.message}`));
    return null;
  }
}

export async function setCachedData<T>(
  cacheKey: string,
  data: T,
): Promise<void> {
  try {
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + CACHE_TTL_HOURS * 60 * 60 * 1000,
    );

    const cachedData: CachedData<T> = {
      data,
      metadata: {
        cachedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        version: '1.0.0',
      },
    };

    const jsonString = JSON.stringify(cachedData);
    const compressed = await gzip(jsonString);

    await s3Client.send(
      new PutObjectCommand({
        Bucket: CACHE_BUCKET,
        Key: cacheKey,
        Body: compressed,
        ContentType: 'application/json',
        ContentEncoding: 'gzip',
        Metadata: {
          'cache-version': '1.0.0',
          'cached-at': now.toISOString(),
          'expires-at': expiresAt.toISOString(),
        },
      }),
    );

    consola.debug(chalk.blue(`Cached data for key: ${cacheKey}`));
  } catch (error: unknown) {
    const err = error as Error;
    consola.warn(chalk.yellow(`Failed to cache data: ${err.message}`));
  }
}
