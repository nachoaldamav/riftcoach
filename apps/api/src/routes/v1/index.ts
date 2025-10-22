import {
  PlatformId,
  type RiotAPITypes,
  regionToCluster,
} from '@fightmegg/riot-api';
import { collections } from '@riftcoach/clients.mongodb';
import { type Platform, type Region, riot } from '@riftcoach/clients.riot';
import { queues } from '@riftcoach/queues';
import chalk from 'chalk';
import consola from 'consola';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import ms from 'ms';
import { v5 } from 'uuid';
import z from 'zod';
import { championInsights } from '../../aggregations/championInsights.js';
import { championMastery } from '../../aggregations/championMastery.js';
import { enemyStatsByRolePUUID } from '../../aggregations/enemyStatsByRolePUUID.js';
import { playerChampsByRole } from '../../aggregations/playerChampsByRole.js';
import { playerHeatmap } from '../../aggregations/playerHeatmap.js';
import { playerOverviewWithOpponents } from '../../aggregations/playerOverviewWithOpponents.js';
import { recentMatches } from '../../aggregations/recentMatches.js';
import { statsByRolePUUID } from '../../aggregations/statsByRolePUUID.js';
import { redis } from '../../clients/redis.js';
import { generateChampionInsights } from '../../services/champion-insights.js';
import { matchDetailsNode } from '../../services/match-details.js';
import { generateMatchInsights } from '../../services/match-insights.js';
import {
  buildBadgesPromptFromStats,
  computeRoleWeights,
  invokeBadgesModel,
  normalizeBadgesResponse,
} from '../../services/player-badges.js';
import compareRoleStats from '../../utils/compare-role-stats.js';
import {
  getItemMap,
  inferPatchFromGameVersion,
  pickItemMeta,
  resolveItemNames,
} from '../../utils/ddragon-items.js';
import { deriveSynergy } from '../../utils/synergy.js';

const UUID_NAMESPACE = '76ac778b-c771-4136-8637-44c5faa11286';

const accountMiddleware = createMiddleware<{
  Variables: {
    region: RiotAPITypes.LoLRegion;
    cluster: RiotAPITypes.Cluster;
    account: RiotAPITypes.Account.AccountDTO;
    summoner: RiotAPITypes.Summoner.SummonerDTO;
    internalId: string;
  };
}>(async (c, next) => {
  const tagName = c.req.param('tagName');
  const tagLine = c.req.param('tagLine');
  const accountCacheKey = `cache:accounts:${tagName}:${tagLine}:${c.var.region}`;

  if (!tagName || !tagLine) {
    return c.json(
      {
        message: 'Tag name and tag line are required',
      },
      400,
    );
  }

  let account: RiotAPITypes.Account.AccountDTO | null = null;

  const cachedAccountExists = await redis.exists(accountCacheKey);

  if (cachedAccountExists) {
    const cachedAccount = await redis.get(accountCacheKey);
    if (cachedAccount) {
      account = JSON.parse(cachedAccount);
    } else {
      account = await riot
        .getAccountByRiotId(c.var.cluster as Region, tagName, tagLine)
        .catch((error) => {
          console.error(error);
          return null;
        });
    }
  } else {
    account = await riot
      .getAccountByRiotId(c.var.cluster as Region, tagName, tagLine)
      .catch((error) => {
        console.error(error);
        return null;
      });
  }

  if (!account) {
    return c.json(
      {
        message: 'Account not found',
      },
      404,
    );
  }

  c.set('account', account);

  if (!cachedAccountExists) {
    await redis.set(accountCacheKey, JSON.stringify(account), 'EX', ms('1h'));
  }

  let summoner: RiotAPITypes.Summoner.SummonerDTO | null = null;

  const summonerCacheKey = `cache:summoners:${account.puuid}:${c.var.region}`;

  const cachedSummoner = await redis.get(summonerCacheKey);
  if (cachedSummoner) {
    summoner = JSON.parse(cachedSummoner);
  } else {
    summoner = await riot
      .summonerByPuuid(c.var.region as Platform, account.puuid)
      .catch((error) => {
        console.error(error);
        return null;
      });

    if (summoner) {
      await redis.set(
        summonerCacheKey,
        JSON.stringify(summoner),
        'EX',
        ms('1h'),
      );
    }
  }

  if (!summoner) {
    return c.json(
      {
        message: 'Summoner not found',
      },
      404,
    );
  }

  c.set('summoner', summoner);
  c.set('internalId', v5(account.puuid, UUID_NAMESPACE));
  await next();
});

const app = new Hono<{
  Variables: {
    region: RiotAPITypes.LoLRegion;
    cluster: RiotAPITypes.Cluster;
    account: RiotAPITypes.Account.AccountDTO;
    summoner: RiotAPITypes.Summoner.SummonerDTO;
    internalId: string;
  };
}>();

const regionSchema = z.object({
  region: z.enum([
    PlatformId.BR1,
    PlatformId.EUNE1,
    PlatformId.EUW1,
    PlatformId.JP1,
    PlatformId.KR,
    PlatformId.LA1,
    PlatformId.LA2,
    PlatformId.NA1,
    PlatformId.ME1,
    PlatformId.OC1,
    PlatformId.RU,
    PlatformId.TR1,
    PlatformId.PH2,
    PlatformId.SG2,
    PlatformId.TH2,
    PlatformId.TW2,
    PlatformId.VN2,
  ]),
});

app.use(
  '/:region/*',
  createMiddleware(async (c, next) => {
    const region = c.req.param('region')?.toLowerCase() as
      | RiotAPITypes.LoLRegion
      | undefined;

    if (!region) {
      return c.json(
        {
          message: 'Region is required',
        },
        400,
      );
    }

    const result = regionSchema.safeParse({ region });

    if (!result.success) {
      return c.json(
        {
          message: 'Invalid region',
        },
        400,
      );
    }

    c.set('region', region);
    c.set('cluster', regionToCluster(region));
    await next();
  }),
);

app.get('/:region/:tagName/:tagLine', accountMiddleware, async (c) => {
  const summoner = c.var.summoner;
  return c.json({
    ...summoner,
    id: c.var.internalId,
  });
});

app.post('/:region/:tagName/:tagLine/rewind', accountMiddleware, async (c) => {
  const rewindId = c.var.internalId;
  const { force } = c.req.query();
  const isForceRefresh = force === 'true';

  // Check if player has been scanned before
  const lastScanKey = `rewind:${rewindId}:last_scan`;
  const lastScanTimestamp = await redis.get(lastScanKey);

  let startTimestamp = 0;
  let scanType = 'full';

  if (lastScanTimestamp && !isForceRefresh) {
    // Player has been scanned before, do partial scan
    scanType = 'partial';
    startTimestamp = Number(lastScanTimestamp);
    consola.info(
      chalk.yellow(
        `Partial scan for ${rewindId} from ${new Date(startTimestamp).toISOString()}`,
      ),
    );
  } else if (isForceRefresh) {
    consola.info(chalk.blue(`Force refresh requested for ${rewindId}`));
  } else {
    consola.info(chalk.blue(`Full scan for new player ${rewindId}`));
  }

  await redis.set(`rewind:${rewindId}:matches`, 0);
  await redis.set(`rewind:${rewindId}:listing`, 1);
  await redis.set(`rewind:${rewindId}:total`, 0);
  await redis.set(`rewind:${rewindId}:status`, 'listing');
  await redis.set(`rewind:${rewindId}:processed`, 0);
  await redis.set(`rewind:${rewindId}:scan_type`, scanType);

  consola.info(chalk.blue(`Rewind ${rewindId} started (${scanType} scan)`));

  queues[c.var.cluster].add(
    `list-matches-${c.var.account.puuid}-0`,
    {
      type: 'list-matches',
      puuid: c.var.account.puuid,
      start: 0,
      rewindId,
      region: c.var.region,
      startTimestamp,
      scanType: scanType as 'full' | 'partial' | undefined,
    },
    {
      delay: ms('1s'),
    },
  );

  // Add to visual queue (sorted by enqueue time)
  await redis.zadd(`rewind:queue:${c.var.cluster}`, Date.now(), rewindId);

  return c.json({
    rewindId,
    scanType,
    startTimestamp: startTimestamp > 0 ? startTimestamp : null,
  });
});

app.get('/:region/:tagName/:tagLine/rewind', accountMiddleware, async (c) => {
  const rewindId = c.var.internalId;
  const [matches, listing, status, total, processed] = await Promise.all([
    redis.get(`rewind:${rewindId}:matches`),
    redis.get(`rewind:${rewindId}:listing`),
    redis.get(`rewind:${rewindId}:status`),
    redis.get(`rewind:${rewindId}:total`),
    redis.get(`rewind:${rewindId}:processed`),
  ]);
  // Visual position from Redis zset (cluster-scoped)
  const queueKey = `rewind:queue:${c.var.cluster}`;
  const rank = await redis.zrank(queueKey, rewindId);
  const position = rank !== null ? Number(rank) + 1 : null;

  return c.json({
    rewindId,
    matches: Number(matches),
    listing: Number(listing),
    total: Number(total),
    processed: Number(processed),
    status,
    position,
  });
});

app.get('/:region/:tagName/:tagLine/badges', accountMiddleware, async (c) => {
  const account = c.var.account;
  const statsCacheKey = `cache:stats:${c.var.internalId}`;
  const aiCacheKey = `cache:ai-badges:${c.var.internalId}`;

  // Return cached AI badges if available
  const cachedAI = await redis.get(aiCacheKey);
  if (cachedAI) {
    try {
      const parsed = JSON.parse(cachedAI);
      const normalized = normalizeBadgesResponse(parsed);
      return c.json(normalized);
    } catch {
      // ignore and recompute
    }
  }

  // Load stats from cache or compute
  let myStats: Array<Record<string, unknown>> | null = null;
  let enemyStats: Array<Record<string, unknown>> | null = null;
  const cachedStats = await redis.get(statsCacheKey);
  if (cachedStats) {
    try {
      const parsed = JSON.parse(cachedStats);
      if (Array.isArray(parsed.myStats) && Array.isArray(parsed.enemyStats)) {
        myStats = parsed.myStats as Array<Record<string, unknown>>;
        enemyStats = parsed.enemyStats as Array<Record<string, unknown>>;
      }
    } catch {
      // fall through to recompute
    }
  }

  if (!myStats || !enemyStats) {
    const stats = await Promise.all([
      collections.matches.aggregate(statsByRolePUUID(account.puuid)).toArray(),
      collections.matches
        .aggregate(enemyStatsByRolePUUID(account.puuid))
        .toArray(),
    ]);
    myStats = stats[0] as Array<Record<string, unknown>>;
    enemyStats = stats[1] as Array<Record<string, unknown>>;
    await redis.set(
      statsCacheKey,
      JSON.stringify({ myStats, enemyStats }),
      'EX',
      ms('1d'),
    );
  }

  // Guard against missing stats before invoking AI
  if (!myStats || !enemyStats) {
    return c.json({ message: 'Failed to compute player/opponent stats' }, 500);
  }

  // Build prompt and invoke Bedrock
  try {
    const prompt = buildBadgesPromptFromStats(myStats, enemyStats);
    consola.info(
      chalk.blue(
        `Generating AI badges for ${account.gameName}#${account.tagLine}`,
      ),
    );
    const aiJson = await invokeBadgesModel(prompt);
    let normalized = normalizeBadgesResponse(aiJson);
    // Correct any AI text that mislabels the most-weighted role
    const pr = computeRoleWeights(myStats).primaryRole;
    if (pr) {
      const mr = String(pr);
      const fixText = (txt?: string): string => {
        if (!txt) return '';
        return txt
          .replace(
            /most[-\s]weighted role[:,]?\s*[A-Za-z ]+/gi,
            `most-weighted role, ${mr}`,
          )
          .replace(/primary role[:,]?\s*[A-Za-z ]+/gi, `primary role, ${mr}`)
          .replace(
            /most[-\s]played role[:,]?\s*[A-Za-z ]+/gi,
            `most-played role, ${mr}`,
          );
      };
      normalized = {
        badges: normalized.badges.map((b) => ({
          title: b.title,
          description: fixText(b.description),
          reason: fixText(b.reason),
          polarity: b.polarity || 'neutral',
        })),
      };
    }

    // Return AI-generated badges without post-filtering
    await redis.set(aiCacheKey, JSON.stringify(normalized), 'EX', ms('12h'));
    return c.json(normalized);
  } catch (err) {
    consola.error(chalk.red('Failed to generate AI badges via Bedrock'), err);
    // As a fallback, return the structural comparison (non-AI), but keep JSON shape similar
    const comparisons = compareRoleStats(myStats, enemyStats);
    // Helper to flatten numeric diffs for reason strings
    function flattenNumericDiffs(
      obj: Record<string, unknown>,
      prefix = '',
    ): Array<{ path: string; diff: number }> {
      const out: Array<{ path: string; diff: number }> = [];
      for (const [key, val] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (typeof val === 'number' && Number.isFinite(val)) {
          out.push({ path, diff: val });
        } else if (val && typeof val === 'object' && !Array.isArray(val)) {
          out.push(
            ...flattenNumericDiffs(val as Record<string, unknown>, path),
          );
        }
      }
      return out;
    }
    function formatDiff(d: number): string {
      const sign = d > 0 ? '+' : '';
      return `${sign}${Math.round(d * 100) / 100}`;
    }
    function buildRoleReason(
      role: string,
      stats: Record<string, unknown>,
      limit = 3,
    ): string {
      const diffs = flattenNumericDiffs(stats);
      if (diffs.length === 0) return `role=${role}: no numeric diffs available`;
      diffs.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
      const top = diffs
        .slice(0, limit)
        .map((d) => `${formatDiff(d.diff)} ${d.path}`);
      return `role=${role}: ${top.join(', ')}`;
    }
    // Determine standout and improvement roles
    let topPos: {
      role: string;
      sum: number;
      stats: Record<string, unknown>;
    } | null = null;
    let topNeg: {
      role: string;
      sum: number;
      stats: Record<string, unknown>;
    } | null = null;
    for (const cmp of comparisons) {
      const diffs = flattenNumericDiffs(cmp.stats);
      const sum = diffs.reduce((acc, d) => acc + d.diff, 0);
      if (!topPos || sum > topPos.sum)
        topPos = {
          role: cmp.position,
          sum,
          stats: cmp.stats as Record<string, unknown>,
        };
      if (!topNeg || sum < topNeg.sum)
        topNeg = {
          role: cmp.position,
          sum,
          stats: cmp.stats as Record<string, unknown>,
        };
    }
    const badges: Array<{
      title: string;
      description: string;
      reason: string;
      polarity: 'good' | 'bad' | 'neutral';
    }> = [];
    if (topPos) {
      badges.push({
        title: `Standout Role: ${topPos.role}`,
        description:
          'Largest positive diffs versus lane opponents across key metrics',
        reason: buildRoleReason(topPos.role, topPos.stats),
        polarity: 'good',
      });
    }
    if (topNeg && (!topPos || topNeg.role !== topPos.role)) {
      badges.push({
        title: `Improvement Role: ${topNeg.role}`,
        description:
          'Largest negative diffs versus lane opponents indicate improvement opportunities',
        reason: buildRoleReason(topNeg.role, topNeg.stats),
        polarity: 'bad',
      });
    }
    if (badges.length === 0) {
      badges.push({
        title: 'Role Comparison Available',
        description:
          'AI generation failed; returning numerical role comparison overview',
        reason: 'No diffs detected to highlight',
        polarity: 'neutral',
      });
    }
    return c.json({ badges });
  }
});

app.get(
  '/:region/:tagName/:tagLine/champions',
  accountMiddleware,
  async (c) => {
    const puuid = c.var.account.puuid;
    const champs = await collections.matches
      .aggregate(playerChampsByRole(puuid))
      .toArray();
    return c.json(champs);
  },
);

app.get('/:region/:tagName/:tagLine/heatmap', accountMiddleware, async (c) => {
  const puuid = c.var.account.puuid;
  const { role, championId, mode } = c.req.query();
  if (!role) {
    throw new HTTPException(400, { message: 'role is required', cause: role });
  }
  const aggregation = playerHeatmap({
    puuid,
    role: role.toUpperCase() || 'BOTTOM',
    championId: championId ? Number(championId) : null,
    mode: mode as 'kills' | 'deaths' | undefined,
  });
  const heatmap = await collections.matches
    .aggregate(aggregation, {
      allowDiskUse: true,
    })
    .toArray();
  return c.json(heatmap);
});

app.get('/:region/:tagName/:tagLine/overview', accountMiddleware, async (c) => {
  const puuid = c.var.account.puuid;
  const { position } = c.req.query();
  const cacheKey = `cache:overview:${c.var.internalId}:${position || 'all'}`;

  const cached = await redis.get(cacheKey);
  if (cached) {
    return c.json(JSON.parse(cached));
  }

  const overview = await collections.matches
    .aggregate(playerOverviewWithOpponents(puuid, position?.toUpperCase()))
    .toArray();

  const result = overview[0] || null;
  await redis.set(cacheKey, JSON.stringify(result), 'EX', ms('1h'));
  return c.json(result);
});

app.get(
  '/:region/:tagName/:tagLine/recent-matches',
  accountMiddleware,
  async (c) => {
    const puuid = c.var.account.puuid;
    const { limit } = c.req.query();
    const matchLimit = limit ? Number(limit) : 10;

    const cacheKey = `cache:recent-matches:${c.var.internalId}:${matchLimit}`;

    const cached = await redis.get(cacheKey);
    if (cached) {
      return c.json(JSON.parse(cached));
    }

    const matches = await collections.matches
      .aggregate(recentMatches(puuid, matchLimit))
      .toArray();

    await redis.set(cacheKey, JSON.stringify(matches), 'EX', ms('10m'));
    return c.json(matches);
  },
);

app.get(
  '/:region/:tagName/:tagLine/champion-insights',
  accountMiddleware,
  async (c) => {
    const puuid = c.var.account.puuid;

    const cacheKey = `cache:champion-insights:${c.var.internalId}`;

    const cached = await redis.get(cacheKey);
    if (cached) {
      return c.json(JSON.parse(cached));
    }

    const insights = (await collections.matches
      .aggregate(championInsights(puuid))
      .toArray()) as Array<{
      championId: number;
      championName: string;
      totalGames: number;
      winRate: number;
      recentWinRate: number;
      avgKda: number;
      consistencyScore: number;
      performanceTrend: unknown;
      roles: string[];
      daysSinceLastPlayed: number;
    }>;

    // Filter out champions with insufficient data or invalid values
    const validInsights = insights.filter((champion) => {
      // Require at least 3 games for meaningful insights
      if (champion.totalGames < 3) return false;

      // Filter out champions with invalid or NaN values
      if (
        Number.isNaN(champion.winRate) ||
        Number.isNaN(champion.avgKda) ||
        Number.isNaN(champion.consistencyScore) ||
        champion.winRate < 0 ||
        champion.winRate > 100 ||
        champion.avgKda < 0 ||
        champion.consistencyScore < 0 ||
        champion.consistencyScore > 100
      ) {
        return false;
      }

      return true;
    });

    // Generate AI insights using AWS Bedrock
    let aiInsights = null;
    if (validInsights.length > 0) {
      try {
        aiInsights = await generateChampionInsights(validInsights);
      } catch (error) {
        consola.error('Error generating AI insights:', error);
        // Continue without AI insights if generation fails
      }
    }

    const result = {
      championData: validInsights,
      aiInsights: aiInsights || {
        summary: 'Unable to generate AI insights at this time.',
        trends: [],
        recommendations: [],
        confidence: 0,
      },
    };

    await redis.set(cacheKey, JSON.stringify(result), 'EX', ms('30m'));
    return c.json(result);
  },
);

app.get(
  '/:region/:tagName/:tagLine/champion-mastery',
  accountMiddleware,
  async (c) => {
    const puuid = c.var.account.puuid;
    const { limit } = c.req.query();
    const champLimit = limit ? Number(limit) : 5;

    const cacheKey = `cache:champion-mastery:v2:${c.var.internalId}:${champLimit}`;

    const cached = await redis.get(cacheKey);
    if (cached) {
      return c.json(JSON.parse(cached));
    }

    const mastery = await collections.matches
      .aggregate(championMastery(puuid, champLimit))
      .toArray();

    await redis.set(cacheKey, JSON.stringify(mastery), 'EX', ms('1h'));
    return c.json(mastery);
  },
);

app.get(
  '/:region/:tagName/:tagLine/match/:matchId',
  accountMiddleware,
  async (c) => {
    const puuid = c.var.account.puuid;
    const { matchId } = c.req.param();

    consola.debug('[match-details-route] using node strategy', {
      matchId,
      puuid,
    });
    const nodeResult = await matchDetailsNode(puuid, matchId);
    if (!nodeResult) {
      throw new HTTPException(404, { message: 'Match not found' });
    }
    return c.json(nodeResult);
  },
);

app.get(
  '/:region/:tagName/:tagLine/match/:matchId/match',
  accountMiddleware,
  async (c) => {
    const { matchId } = c.req.param();
    const match = await collections.matches.findOne({
      'metadata.matchId': matchId,
    });
    if (!match) {
      throw new HTTPException(404, { message: 'Match not found' });
    }
    return c.json(match);
  },
);

app.get(
  '/:region/:tagName/:tagLine/match/:matchId/timeline',
  accountMiddleware,
  async (c) => {
    const { matchId } = c.req.param();
    const timeline = await collections.timelines.findOne({
      'metadata.matchId': matchId,
    });
    if (!timeline) {
      throw new HTTPException(404, { message: 'Match not found' });
    }
    return c.json(timeline);
  },
);

app.get(
  '/:region/:tagName/:tagLine/match/:matchId/insights',
  accountMiddleware,
  async (c) => {
    const { matchId } = c.req.param();
    const {
      modelId = 'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
      locale = 'en',
      force = 'false',
    } = c.req.query();
    const puuid = c.var.account.puuid;

    const cacheKey = `cache:ai:insights:${c.var.internalId}:${matchId}:${modelId}:${locale}`;

    if (force !== 'true') {
      const cached = await redis.get(cacheKey);
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          return c.json(parsed);
        } catch {
          // ignore cache parse errors
        }
      }
    }

    consola.debug(chalk.blue('[match-insights-route] fetching match details'), {
      matchId,
      puuid,
    });
    const details = await matchDetailsNode(puuid, matchId);
    if (!details) {
      throw new HTTPException(404, {
        message: 'Match not found or queue not allowed',
      });
    }

    // Enrich with item names/meta and duo synergy
    try {
      const d = details as Record<string, unknown>;
      const gameVersion =
        typeof d.gameVersion === 'string' ? d.gameVersion : null;
      const patch = inferPatchFromGameVersion(gameVersion);
      const itemsMap = await getItemMap(patch);

      type SB = {
        teamId: number;
        teamPosition: string;
        championName: string;
        finalItems?: Array<number | null | undefined>;
      };
      type PBMinimal = {
        participantId: number;
        puuid: string;
        summonerName: string;
        teamId: number;
        teamPosition: string;
        championId: number;
        championName: string;
        win?: boolean;
        items?: Array<number | null | undefined>;
      };

      const subject: SB | null =
        d.subject && typeof d.subject === 'object' ? (d.subject as SB) : null;
      const opponent: SB | null =
        d.opponent && typeof d.opponent === 'object'
          ? (d.opponent as SB)
          : null;
      const participantsBasic: PBMinimal[] = Array.isArray(d.participantsBasic)
        ? (d.participantsBasic as PBMinimal[])
        : [];

      const subjectFinalItemIds: Array<number | null | undefined> =
        Array.isArray(subject?.finalItems)
          ? (subject?.finalItems as Array<number | null | undefined>)
          : [];
      const opponentFinalItemIds: Array<number | null | undefined> =
        Array.isArray(opponent?.finalItems)
          ? (opponent?.finalItems as Array<number | null | undefined>)
          : [];

      const enrichedCtx = {
        ...details,
        items: {
          patch,
          subjectFinalItemIds,
          subjectFinalItemNames: resolveItemNames(
            subjectFinalItemIds,
            itemsMap,
          ),
          subjectFinalItemMeta: pickItemMeta(subjectFinalItemIds, itemsMap),
          opponentFinalItemIds,
          opponentFinalItemNames: resolveItemNames(
            opponentFinalItemIds,
            itemsMap,
          ),
          opponentFinalItemMeta: pickItemMeta(opponentFinalItemIds, itemsMap),
        },
        synergy: deriveSynergy(
          {
            teamId: subject?.teamId ?? 0,
            teamPosition: subject?.teamPosition ?? 'UNKNOWN',
            championName: subject?.championName ?? '',
          },
          participantsBasic,
        ),
      };

      const insights = await generateMatchInsights(enrichedCtx, {
        modelId,
        locale,
      });
      await redis.set(cacheKey, JSON.stringify(insights), 'EX', ms('12h'));
      return c.json(insights);
    } catch (err) {
      consola.warn(
        '[match-insights-route] enrichment failed, falling back',
        err,
      );
      const insights = await generateMatchInsights(details, {
        modelId,
        locale,
      });
      await redis.set(cacheKey, JSON.stringify(insights), 'EX', ms('12h'));
      return c.json(insights);
    }
  },
);

export { app };
