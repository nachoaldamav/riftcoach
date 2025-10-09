import { setTimeout as sleep } from 'node:timers/promises';
import type { RiotAPITypes } from '@fightmegg/riot-api';
import Bottleneck from 'bottleneck';

/** Routing regions for Account/Match-V5 */
export type Region = 'europe' | 'americas' | 'asia' | 'sea';

/** Platform shards you’ll see in matchIds (EUW1_..., NA1_..., KR_..., etc.) */
export type Platform =
  | 'euw1'
  | 'eun1'
  | 'tr1'
  | 'ru'
  | 'na1'
  | 'br1'
  | 'la1'
  | 'la2'
  | 'oc1'
  | 'kr'
  | 'jp1'
  | 'ph2'
  | 'sg2'
  | 'th2'
  | 'tw2'
  | 'vn2';

const BASE: Record<Region, string> = {
  europe: 'https://europe.api.riotgames.com',
  americas: 'https://americas.api.riotgames.com',
  asia: 'https://asia.api.riotgames.com',
  sea: 'https://sea.api.riotgames.com',
};

function parseRetryAfterMs(h: Headers, fallback = 3000) {
  const ra = h.get('retry-after');
  if (!ra) return fallback;
  const n = Number(ra);
  if (Number.isFinite(n)) return Math.min(60_000, Math.max(1000, n * 1000)); // 1..60s
  return fallback;
}
const jitter = (ms: number) =>
  Math.round(ms * (1 + (Math.random() - 0.5) * 0.2)); // ±10%

type Window = { limit: number; intervalMs: number };

export interface RiotClientOptions {
  apiKey: string;

  // Per-request timeout (ms) + retry policy (only 429/5xx)
  timeoutMs?: number;
  maxRetries?: number;

  // Optional UA header
  userAgent?: string;

  // Concurrency per routing region
  concurrent?: number;

  // Dual-window rate limits (per routing region)
  // Defaults are for DEV apps: 20/1s and 100/120s.
  shortWindow?: Window; // e.g. { limit: 20, intervalMs: 1000 }
  longWindow?: Window; // e.g. { limit: 100, intervalMs: 120_000 }

  // Optional: tune min spacing; by default we derive from windows
  minTimeMsOverride?: number;
}

export class RiotClient {
  private apiKey: string;
  private timeoutMs: number;
  private maxRetries: number;
  private userAgent?: string;

  // One COMPOSITE limiter per routing region: short window chained to long window.
  private limiters: Record<Region, Bottleneck>;

  constructor(opts: RiotClientOptions) {
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxRetries = Math.max(0, opts.maxRetries ?? 6);
    this.userAgent = opts.userAgent;

    const concurrent = Math.max(1, opts.concurrent ?? 4);

    // Windows (defaults: DEV app)
    const short: Window = opts.shortWindow ?? { limit: 20, intervalMs: 1000 };
    const long: Window = opts.longWindow ?? { limit: 100, intervalMs: 120_000 };

    const minTimeShort = Math.max(0, Math.ceil(short.intervalMs / short.limit));
    const minTimeLong = Math.max(0, Math.ceil(long.intervalMs / long.limit));
    const minTimeMs =
      opts.minTimeMsOverride ?? Math.max(1, Math.min(minTimeShort, 50)); // keep bursts smoothed

    const mkDualLimiter = () => {
      // Fast bucket (e.g., 20/1s or 500/10s)
      const fast = new Bottleneck({
        reservoir: short.limit,
        reservoirRefreshAmount: short.limit,
        reservoirRefreshInterval: short.intervalMs,
        maxConcurrent: concurrent,
        minTime: minTimeMs,
      });

      // Slow bucket (e.g., 100/120s or 30k/600s)
      const slow = new Bottleneck({
        reservoir: long.limit,
        reservoirRefreshAmount: long.limit,
        reservoirRefreshInterval: long.intervalMs,
        // Concurrency on the slow bucket can be same or higher; same is safe.
        maxConcurrent: concurrent,
        // minTime here is irrelevant-ish because the reservoir dominates,
        // but we keep a tiny spacing to avoid micro-bursts when the long bucket refills.
        minTime: Math.max(1, Math.min(minTimeLong, 50)),
      });

      // Every job scheduled on `fast` must also be accepted by `slow`.
      fast.chain(slow);
      return fast;
    };

    this.limiters = {
      europe: mkDualLimiter(),
      americas: mkDualLimiter(),
      asia: mkDualLimiter(),
      sea: mkDualLimiter(),
    };
  }

  // ---------- helpers ----------

  platformToRegion(platform: Platform): Region {
    const p = platform.toLowerCase() as Platform;
    if (['euw1', 'eun1', 'tr1', 'ru'].includes(p)) return 'europe';
    if (['na1', 'br1', 'la1', 'la2', 'oc1'].includes(p)) return 'americas';
    if (['kr', 'jp1'].includes(p)) return 'asia';
    return 'sea';
  }

  regionFromMatchId(matchId: string): Region {
    const [shard] = (matchId || '').split('_');
    return this.platformToRegion(shard.toLowerCase() as Platform);
  }

  private buildUrl(
    base: string,
    pathname: string,
    params?: Record<string, unknown>,
  ) {
    const u = new URL(pathname, base.endsWith('/') ? base : base + '/');
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        u.searchParams.set(k, String(v));
      }
    }
    return u.toString();
  }

  private async fetchJson<T = unknown>(
    url: string,
    init: RequestInit,
  ): Promise<T> {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        ...init,
        signal: ctrl.signal,
        headers: {
          'X-Riot-Token': this.apiKey,
          Accept: 'application/json',
          ...(this.userAgent ? { 'User-Agent': this.userAgent } : {}),
          ...(init.headers || {}),
        },
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err: any = new Error(
          `HTTP ${res.status} ${res.statusText} – ${body.slice(0, 300)}`,
        );
        err.status = res.status;
        err.headers = Object.fromEntries(res.headers.entries());
        err.retryAfterMs = parseRetryAfterMs(res.headers);
        throw err;
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(to);
    }
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await fn();
      } catch (e: any) {
        const status = Number(e?.status);
        const retryable = status === 429 || (status >= 500 && status < 600);
        if (!retryable || attempt >= this.maxRetries) throw e;

        if (status === 429) {
          console.warn(
            `⚠️  Rate limit hit (429) - retrying in ${e?.retryAfterMs ?? 3000}ms (attempt ${attempt + 1}/${this.maxRetries + 1})`,
          );
        }
        const base = e?.retryAfterMs ?? 3000;
        const backoff = jitter(base * Math.pow(2, attempt));
        await sleep(backoff);
        attempt++;
      }
    }
  }

  private schedule<T>(region: Region, task: () => Promise<T>): Promise<T> {
    return this.limiters[region].schedule(task);
  }

  // ---------- API methods ----------

  getAccountByRiotId(region: Region, gameName: string, tagLine: string) {
    const url = this.buildUrl(
      BASE[region],
      `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
    );
    return this.schedule<RiotAPITypes.Account.AccountDTO>(region, () =>
      this.withRetry(() => this.fetchJson(url, { method: 'GET' })),
    );
  }

  getIdsByPuuid(
    region: Region,
    puuid: string,
    params: {
      start?: number;
      count?: number;
      queue?: number;
      startTime?: number;
      endTime?: number;
    } = {},
  ) {
    const url = this.buildUrl(
      BASE[region],
      `/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids`,
      params,
    );
    return this.schedule<string[]>(region, () =>
      this.withRetry(() => this.fetchJson<string[]>(url, { method: 'GET' })),
    );
  }

  getMatchById(regionOrMatchId: Region | string, maybeMatchId?: string) {
    const region: Region = maybeMatchId
      ? (regionOrMatchId as Region)
      : this.regionFromMatchId(regionOrMatchId as string);
    const matchId = maybeMatchId ?? (regionOrMatchId as string);
    const url = this.buildUrl(
      BASE[region],
      `/lol/match/v5/matches/${encodeURIComponent(matchId)}`,
    );
    return this.schedule<RiotAPITypes.MatchV5.MatchDTO>(region, () =>
      this.withRetry(() => this.fetchJson(url, { method: 'GET' })),
    );
  }

  async getTimeline(regionOrMatchId: Region | string, maybeMatchId?: string) {
    const region: Region = maybeMatchId
      ? (regionOrMatchId as Region)
      : this.regionFromMatchId(regionOrMatchId as string);
    const matchId = maybeMatchId ?? (regionOrMatchId as string);
    const url = this.buildUrl(
      BASE[region],
      `/lol/match/v5/matches/${encodeURIComponent(matchId)}/timeline`,
    );
    try {
      return await this.schedule<RiotAPITypes.MatchV5.MatchTimelineDTO>(
        region,
        () => this.withRetry(() => this.fetchJson(url, { method: 'GET' })),
      );
    } catch (e: any) {
      if (Number(e?.status) === 404) return null;
      throw e;
    }
  }

  async getPlatform(puuid: string, region: Region) {
    const url = this.buildUrl(
      BASE[region],
      `/riot/account/v1/region/by-game/lol/by-puuid/${encodeURIComponent(puuid)}`,
    );
    return this.schedule<{ puuid: string; game: 'lol'; region: Platform }>(
      region,
      () => this.withRetry(() => this.fetchJson(url, { method: 'GET' })),
    );
  }

  async summonerByPuuid(platform: Platform, puuid: string) {
    const region = this.platformToRegion(platform);
    const url = this.buildUrl(
      `https://${platform}.api.riotgames.com`,
      `/lol/summoner/v4/summoners/by-puuid/${encodeURIComponent(puuid)}`,
    );
    return this.schedule<RiotAPITypes.Summoner.SummonerDTO>(region, () =>
      this.withRetry(() => this.fetchJson(url, { method: 'GET' })),
    );
  }

  async accountByPuuid(platform: Platform, puuid: string) {
    const region = this.platformToRegion(platform);
    const url = this.buildUrl(
      `https://${region}.api.riotgames.com`,
      `/riot/account/v1/accounts/by-puuid/${encodeURIComponent(puuid)}`,
    );
    return this.schedule<RiotAPITypes.Account.AccountDTO>(region, () =>
      this.withRetry(() => this.fetchJson(url, { method: 'GET' })),
    );
  }

  async stop() {
    await Promise.all(
      Object.values(this.limiters).map((l) =>
        l.stop({ dropWaitingJobs: false }),
      ),
    );
  }
}

// ---------- Instances ----------

// DEV app defaults: 20/1s & 100/2m
export const riot = new RiotClient({
  apiKey: process.env.RIOT_API_KEY ?? '',
  concurrent: 10,
  timeoutMs: 15_000,
  maxRetries: 6,
  // shortWindow: { limit: 20, intervalMs: 1000 },         // default
  // longWindow:  { limit: 100, intervalMs: 120_000 },     // default
});
