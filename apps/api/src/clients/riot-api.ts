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
  | 'vn2'; // SEA shards

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
  if (Number.isFinite(n)) return Math.min(60_000, Math.max(1000, n * 1000)); // 1s..60s clamp
  return fallback;
}
const jitter = (ms: number) =>
  Math.round(ms * (1 + (Math.random() - 0.5) * 0.2)); // ±10%

export interface RiotClientOptions {
  apiKey: string;

  // Per-request timeout (ms) + retry policy (only 429/5xx)
  timeoutMs?: number;
  maxRetries?: number;

  // Optional UA header
  userAgent?: string;

  // Bottleneck tuning (per routing region)
  perSecond?: number; // default ~18 req/s
  concurrent?: number; // default 4 in-flight per region
}

export class RiotClient {
  private apiKey: string;
  private timeoutMs: number;
  private maxRetries: number;
  private userAgent?: string;

  // One limiter per routing region (local, single-process).
  // If you need cross-process, swap to Bottleneck Redis connection.
  private limiters: Record<Region, Bottleneck>;

  constructor(opts: RiotClientOptions) {
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxRetries = Math.max(0, opts.maxRetries ?? 6);
    this.userAgent = opts.userAgent;

    const perSecond = Math.max(1, opts.perSecond ?? 18);
    const concurrent = Math.max(1, opts.concurrent ?? 4);

    const mkLimiter = () =>
      new Bottleneck({
        // token bucket ~perSecond tokens refilled every second
        reservoir: perSecond,
        reservoirRefreshAmount: perSecond,
        reservoirRefreshInterval: 1000,
        maxConcurrent: concurrent,
        // tiny spacing to avoid bursts
        minTime: Math.ceil(1000 / perSecond),
      });

    this.limiters = {
      europe: mkLimiter(),
      americas: mkLimiter(),
      asia: mkLimiter(),
      sea: mkLimiter(),
    };
  }

  // ---------- helpers ----------

  /** Map platform (euw1, na1, kr, …) to routing region */
  platformToRegion(platform: Platform): Region {
    const p = platform.toLowerCase() as Platform;
    if (['euw1', 'eun1', 'tr1', 'ru'].includes(p)) return 'europe';
    if (['na1', 'br1', 'la1', 'la2', 'oc1'].includes(p)) return 'americas';
    if (['kr', 'jp1'].includes(p)) return 'asia';
    return 'sea'; // ph2, sg2, th2, tw2, vn2
  }

  /** Infer routing region straight from a matchId (EUW1_..., NA1_..., KR_..., etc.) */
  regionFromMatchId(matchId: string): Region {
    const [shard] = (matchId || '').split('_');
    return this.platformToRegion(shard.toLowerCase() as Platform);
  }

  /** Build URL safely with new URL + search params */
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

        const base = e?.retryAfterMs ?? 3000;
        const backoff = jitter(base * Math.pow(2, attempt)); // exp backoff + jitter
        await sleep(backoff);
        attempt++;
      }
    }
  }

  private schedule<T>(region: Region, task: () => Promise<T>): Promise<T> {
    return this.limiters[region].schedule(task);
  }

  // ---------- API methods ----------

  /** Account-V1 by Riot ID (routing region: europe/americas/asia/sea) */
  getAccountByRiotId(region: Region, gameName: string, tagLine: string) {
    const url = this.buildUrl(
      BASE[region],
      `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(
        gameName,
      )}/${encodeURIComponent(tagLine)}`,
    );
    return this.schedule<RiotAPITypes.Account.AccountDTO>(region, () =>
      this.withRetry(() => this.fetchJson(url, { method: 'GET' })),
    );
  }

  /** Match-V5 IDs by PUUID (routing region: europe/americas/asia/sea) */
  getIdsByPuuid(
    region: Region,
    puuid: string,
    params: {
      start?: number;
      count?: number;
      queue?: number;
      startTime?: number; // UNIX seconds
      endTime?: number; // UNIX seconds
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

  /** Match-V5 match detail (routing region inferred or provided) */
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

  /** Match-V5 timeline (returns null on 404) */
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
      if (Number(e?.status) === 404) return null; // legit: some games have no timeline
      throw e;
    }
  }

  async getPlatform(puuid: string, region: Region) {
    const url = this.buildUrl(
      BASE[region],
      `/riot/account/v1/region/by-game/lol/by-puuid/${encodeURIComponent(puuid)}`,
    );

    return this.schedule<{
      puuid: string;
      game: 'lol';
      region: Platform;
    }>(region, () =>
      this.withRetry(() => this.fetchJson(url, { method: 'GET' })),
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

  /** Optional: drain/stop limiters on shutdown */
  async stop() {
    await Promise.all(
      Object.values(this.limiters).map((l) =>
        l.stop({ dropWaitingJobs: false }),
      ),
    );
  }
}

export const riot = new RiotClient({
  apiKey: process.env.RIOT_API_KEY ?? '',
  perSecond: 18, // tokens/sec per routing region
  concurrent: 4, // in-flight per region
  timeoutMs: 15_000,
  maxRetries: 6,
});
