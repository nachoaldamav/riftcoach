import {
  DDragon,
  PlatformId,
  type RiotAPITypes,
  regionToCluster,
} from '@fightmegg/riot-api';
import { collections } from '@riftcoach/clients.mongodb';
import { type Platform, type Region, riot } from '@riftcoach/clients.riot';
import { queues } from '@riftcoach/queues';
import { ALLOWED_QUEUE_IDS, ROLES } from '@riftcoach/shared.constants';
import chalk from 'chalk';
import consola from 'consola';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import type { Document } from 'mongodb';
import ms from 'ms';
import { v5 } from 'uuid';
import z from 'zod';
import { championInsights } from '../../aggregations/championInsights.js';
import { championMastery } from '../../aggregations/championMastery.js';
import { enemyStatsByRolePUUID } from '../../aggregations/enemyStatsByRolePUUID.js';
import { getMatchBuilds } from '../../aggregations/matchBuilds.js';
import { playerChampRoleStatsAggregation } from '../../aggregations/playerChampRoleStats.js';
import { playerChampRolePercentilesAggregation } from '../../aggregations/playerChampionRolePercentiles.js';
import { playerChampsByRole } from '../../aggregations/playerChampsByRole.js';
import { playerHeatmap } from '../../aggregations/playerHeatmap.js';
import { playerOverviewWithOpponents } from '../../aggregations/playerOverviewWithOpponents.js';
import { recentMatches } from '../../aggregations/recentMatches.js';
import { statsByRolePUUID } from '../../aggregations/statsByRolePUUID.js';
import { redis } from '../../clients/redis.js';
import { generateBuildSuggestions } from '../../services/builds.js';
import { generateChampionInsights } from '../../services/champion-insights.js';
import { fetchCohortPercentiles } from '../../services/champion-role-algo.js';
import { generateChampionRoleInsights } from '../../services/champion-role-insights.js';
import type { PlayerPercentilesDoc } from '../../services/champion-role-insights.js';
import { generateChampionRoleAIScores } from '../../services/champion-role-score.js';
import type { ChampionRoleStats } from '../../services/champion-role-score.js';
import { teams } from '../../services/competitive.js';
import { matchDetailsNode } from '../../services/match-details.js';
import { generateMatchInsights } from '../../services/match-insights.js';
import {
  buildBadgesPromptFromStats,
  computeRoleWeights,
  invokeBadgesModel,
  normalizeBadgesResponse,
} from '../../services/player-badges.js';
import { renderShareCard } from '../../services/share-card.js';
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

app.get('/builds-order', async (c) => {
  const champion = c.req.query('champion');
  const role = c.req.query('role');
  const maxOrder = Number(c.req.query('maxOrder') ?? 6);

  // Optional filters (no early LIMIT; only selective filtering to keep index usage)
  const winFilter = c.req.query('win'); // 'true' | 'false' | undefined
  const queueId = c.req.query('queueId')
    ? Number(c.req.query('queueId'))
    : undefined; // e.g., 420
  const minDuration = Number(c.req.query('minDuration') ?? 600); // seconds
  const maxDuration = Number(c.req.query('maxDuration') ?? 4800); // seconds
  const sortDirection = (c.req.query('sort') ?? 'desc') === 'asc' ? 1 : -1; // gameCreation order

  if (!champion || !role) {
    return c.json({ message: 'Champion and role are required' }, 400);
  }

  // ────────────────────────────────────────────────────────────────────────
  // 1) Build COMPLETED ITEM ID list from DDragon (reuse user's logic)
  // ────────────────────────────────────────────────────────────────────────
  const ddragon = new DDragon();
  const itemsRaw = await ddragon.items();

  type Item = RiotAPITypes.DDragon.DDragonItemDTO & { id: string };

  const items: Item[] = Object.entries(itemsRaw.data).map(([id, item]) => ({
    ...(item as RiotAPITypes.DDragon.DDragonItemDTO),
    id,
  }));

  function isCompletedItem(item: RiotAPITypes.DDragon.DDragonItemDTO) {
    if (!item.from?.length) return false;
    const consumed = (item as { consumed?: boolean }).consumed;
    if (consumed) return false;
    if (item.tags?.includes('Boots')) {
      return (item.depth ?? 0) >= 2;
    }
    const isCompleted = (item.depth ?? 0) >= 3 || !item.into?.length;
    consola.debug(
      `${item.name} isCompleted: ${isCompleted} (depth: ${item.depth})`,
    );
    return isCompleted;
  }

  // Optional: drop Ornn upgrades
  // const isOrnn = (i: Item) => i.tags?.includes('OrnnItem');

  const completedItemIds: number[] = items
    .filter((i) => isCompletedItem(i /*) && !isOrnn(i)*/))
    .map((i) => Number(i.id));

  if (!completedItemIds.length) {
    return c.json(
      { message: 'No completed items were detected from DDragon.' },
      500,
    );
  }

  // Prepare DDragon item metadata map for UI enrichment
  const itemMeta = new Map<number, { name: string; icon?: string }>(
    items.map((i) => [
      Number(i.id),
      { name: i.name, icon: (i.image as { full?: string } | undefined)?.full },
    ]),
  );

  // ────────────────────────────────────────────────────────────────────────
  // 2) Aggregation: No early limit. Early $match stays selective and indexed.
  //    Heavy frames→events expansion happens inside a lookup pipeline per match
  //    and is narrowed to this participant + completed items + first N items.
  // ────────────────────────────────────────────────────────────────────────

  const matches = collections.matches;

  const earlyMatch: Document = {
    'info.participants': {
      $elemMatch: {
        championName: champion,
        teamPosition: role,
      },
    },
    'info.gameDuration': { $gte: minDuration, $lte: maxDuration },
  };
  if (queueId !== undefined) earlyMatch['info.queueId'] = queueId;
  if (winFilter === 'true' || winFilter === 'false') {
    earlyMatch['info.participants.win'] = winFilter === 'true';
  }

  const pipeline: Document[] = [
    { $match: earlyMatch },

    // Sort by gameCreation (newest first by default) but DO NOT LIMIT
    { $sort: { 'info.gameCreation': sortDirection } },

    // Only keep fields we need + isolate the participant
    {
      $project: {
        metadata: 1,
        'info.gameCreation': 1,
        participant: {
          $first: {
            $filter: {
              input: '$info.participants',
              as: 'p',
              cond: {
                $and: [
                  { $eq: ['$$p.championName', champion] },
                  { $eq: ['$$p.teamPosition', role] },
                ],
              },
            },
          },
        },
      },
    },
    { $match: { participant: { $type: 'object' } } },
    { $limit: 5000 }, // first N matches

    // Tight pipeline lookup to shrink event fan-out per match
    {
      $lookup: {
        from: 'timelines',
        let: { mid: '$metadata.matchId', pid: '$participant.participantId' },
        pipeline: [
          { $match: { $expr: { $eq: ['$metadata.matchId', '$$mid'] } } },
          {
            $project: {
              events: {
                $reduce: {
                  input: '$info.frames',
                  initialValue: [],
                  in: { $concatArrays: ['$$value', '$$this.events'] },
                },
              },
            },
          },
          { $unwind: '$events' },
          {
            $match: {
              'events.type': 'ITEM_PURCHASED',
              $expr: { $eq: ['$events.participantId', '$$pid'] },
              'events.itemId': { $in: completedItemIds },
            },
          },
          {
            $project: {
              _id: 0,
              ts: '$events.timestamp',
              itemId: '$events.itemId',
            },
          },
          { $sort: { ts: 1 } },
          { $limit: maxOrder }, // first N completed items per match
        ],
        as: 'build',
      },
    },
    { $match: { build: { $ne: [] } } },

    // Deduplicate sell/rebuy of same item (keep earliest)
    {
      $addFields: {
        build: {
          $reduce: {
            input: '$build',
            initialValue: { seen: [], out: [] },
            in: {
              seen: {
                $cond: [
                  { $in: ['$$this.itemId', '$$value.seen'] },
                  '$$value.seen',
                  { $concatArrays: ['$$value.seen', ['$$this.itemId']] },
                ],
              },
              out: {
                $cond: [
                  { $in: ['$$this.itemId', '$$value.seen'] },
                  '$$value.out',
                  { $concatArrays: ['$$value.out', ['$$this']] },
                ],
              },
            },
          },
        },
      },
    },
    { $set: { build: '$build.out' } },

    // Unwind with order index
    { $unwind: { path: '$build', includeArrayIndex: 'order' } },

    // Aggregate counts per (champ, role, order, item)
    {
      $group: {
        _id: {
          champion: '$participant.championName',
          role: '$participant.teamPosition',
          order: '$order',
          itemId: '$build.itemId',
        },
        games: { $sum: 1 },
        wins: { $sum: { $cond: ['$participant.win', 1, 0] } },
      },
    },

    // Totals per column for pickrate
    {
      $group: {
        _id: {
          champion: '$_id.champion',
          role: '$_id.role',
          order: '$_id.order',
        },
        totalGames: { $sum: '$games' },
        items: {
          $push: { itemId: '$_id.itemId', games: '$games', wins: '$wins' },
        },
      },
    },

    // Compute winrate/pickrate and sort items by pickrate
    {
      $project: {
        _id: 0,
        champion: '$_id.champion',
        role: '$_id.role',
        order: { $add: ['$_id.order', 1] }, // 1-based column number
        items: {
          $map: {
            input: '$items',
            as: 'i',
            in: {
              itemId: '$$i.itemId',
              games: '$$i.games',
              winrate: {
                $cond: [
                  { $gt: ['$$i.games', 0] },
                  { $divide: ['$$i.wins', '$$i.games'] },
                  0,
                ],
              },
              pickrate: {
                $cond: [
                  { $gt: ['$totalGames', 0] },
                  { $divide: ['$$i.games', '$totalGames'] },
                  0,
                ],
              },
            },
          },
        },
      },
    },
    {
      $set: {
        items: { $sortArray: { input: '$items', sortBy: { pickrate: -1 } } },
      },
    },
    { $sort: { order: 1 } },
  ];

  const rows = await matches
    .aggregate<{
      champion: string;
      role: string;
      order: {
        $numberLong: string;
      };
      items: Array<{
        itemId: number;
        games: number;
        winrate: number;
        pickrate: number;
      }>;
    }>(pipeline, { allowDiskUse: true })
    .toArray();

  // Enrich items with names/icons for UI convenience
  const columns = rows.map((r) => ({
    order: r.order,
    items: r.items.map((x) => ({
      ...x,
      name: itemMeta.get(x.itemId)?.name ?? String(x.itemId),
      icon: itemMeta.get(x.itemId)?.icon ?? null,
    })),
  }));

  return c.json({ champion, role, columns });
});

// Esports teams listing (no region required)
app.get('/esports/teams', async (c) => {
  return c.json(teams);
});

// Check if a summoner is a pro-player (no region required)
// Usage: GET /v1/esports/pro-check?name=<summonerName>&tag=<summonerTag>
// Returns: { isPro: boolean, team?: string, position?: string, slug?: string, name?: string, image?: string }
app.get('/esports/pro-check', async (c) => {
  const name = c.req.query('name');
  const tag = c.req.query('tag');

  if (!name || !tag) {
    return c.json({ message: 'name and tag are required' }, 400);
  }

  const normalize = (v: string) => {
    try {
      return decodeURIComponent(v).trim().toLowerCase();
    } catch {
      return v.trim().toLowerCase();
    }
  };

  const nName = normalize(name);
  const nTag = normalize(tag);

  for (const team of teams) {
    for (const player of team.players) {
      const pName = normalize(player.summonerName);
      const pTag = normalize(player.summonerTag);
      if (pName === nName && pTag === nTag) {
        return c.json({
          isPro: true,
          team: team.team,
          position: player.position,
          slug: team.slug,
          name: player.name,
          image: player.image,
        });
      }
    }
  }

  return c.json({ isPro: false });
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

// Champion-role stats endpoint with pagination and AI score
app.get(
  '/:region/:tagName/:tagLine/champions-stats',
  accountMiddleware,
  async (c) => {
    const account = c.var.account;
    const page = Math.max(1, Number(c.req.query('page') ?? 1));
    const pageSize = Math.min(
      50,
      Math.max(1, Number(c.req.query('pageSize') ?? 10)),
    );
    const skip = (page - 1) * pageSize;

    // Base aggregation returns champion-role stats grouped by champion and normalized role
    const fullAgg = playerChampRoleStatsAggregation(account.puuid);

    // Count total distinct champion-role rows with a $facet to avoid re-running aggregation twice
    const facetPipeline = [
      ...fullAgg,
      {
        $facet: {
          data: [{ $skip: skip }, { $limit: pageSize }],
          meta: [{ $count: 'total' }],
        },
      },
    ];

    const cursor = collections.matches.aggregate<{
      data: ChampionRoleStats[];
      meta: Array<{ total: number }>;
    }>(facetPipeline, { allowDiskUse: true });
    const [facet] = await cursor.toArray();
    const rows: ChampionRoleStats[] = Array.isArray(facet?.data)
      ? (facet.data as ChampionRoleStats[])
      : [];
    const total: number =
      typeof facet?.meta?.[0]?.total === 'number' ? facet.meta[0].total : 0;

    const data = rows.map((r, i) => ({
      ...r,
      aiScore: null,
    }));

    return c.json({
      page,
      pageSize,
      total,
      data,
    });
  },
);

// Single champion-role AI scoring endpoint
app.get(
  '/:region/:tagName/:tagLine/champions/:championName/:role',
  accountMiddleware,
  async (c) => {
    const account = c.var.account;
    const championName = c.req.param('championName');
    const role = c.req.param('role');

    // Fetch player's champion-role stats and select the requested entry
    const statsAgg = playerChampRoleStatsAggregation(account.puuid);
    const aggCursor = collections.matches.aggregate<ChampionRoleStats>(
      statsAgg,
      { allowDiskUse: true },
    );
    const allStats = await aggCursor.toArray();
    const target = allStats.find(
      (d) => d.championName === championName && d.role === role,
    );

    if (!target) {
      return c.json(
        { message: 'Champion-role stats not found for player' },
        404,
      );
    }

    // Defer to AI scoring service for single champion-role
    const [cohort, aiScores, playerPercentilesDocs] = await Promise.all([
      fetchCohortPercentiles(championName, role),
      generateChampionRoleAIScores(account.puuid, [target]),
      collections.matches
        .aggregate<PlayerPercentilesDoc>(
          playerChampRolePercentilesAggregation(
            account.puuid,
            championName,
            role,
          ),
          { allowDiskUse: true },
        )
        .toArray(),
    ]);
    const ai = aiScores[0] ?? null;
    const playerPercentiles = playerPercentilesDocs?.[0] ?? null;
    const insights = await generateChampionRoleInsights(
      target,
      cohort,
      playerPercentiles,
    );

    return c.json({
      championName,
      role,
      aiScore: ai?.aiScore ?? null,
      reasoning: ai?.reasoning ?? undefined,
      stats: target,
      cohort,
      playerPercentiles,
      insights,
    });
  },
);

// Server-side share card rendering
app.post(
  '/:region/:tagName/:tagLine/share-card',
  accountMiddleware,
  async (c) => {
    try {
      const payload = await c.req.json();
      const shareCardSchema = z.object({
        playerName: z.string(),
        tagLine: z.string(),
        profileIconUrl: z.string().url(),
        backgroundUrl: z.string().url(),
        champion: z.object({
          name: z.string(),
          games: z.number(),
          winRate: z.number(),
          kda: z.number(),
          splashUrl: z.string().url(),
        }),
        metrics: z.array(
          z.object({
            label: z.string(),
            player: z.number(),
            cohort: z.number(),
            suffix: z.string().optional(),
          }),
        ),
        badges: z.array(z.string()).optional(),
      });
      const parsed = shareCardSchema.safeParse(payload);
      if (!parsed.success) {
        return c.json(
          { message: 'Invalid payload', errors: parsed.error.flatten() },
          400,
        );
      }
      const pngData = await renderShareCard(parsed.data);
      // Build a standalone ArrayBuffer to avoid SharedArrayBuffer union types
      const ab = new ArrayBuffer(pngData.byteLength);
      new Uint8Array(ab).set(pngData);
      return new Response(ab, {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'no-store',
        },
      });
    } catch (err) {
      consola.error(err);
      throw new HTTPException(500, { message: 'Failed to render share card' });
    }
  },
);

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

  const overview = await collections.matches
    .aggregate(playerOverviewWithOpponents(puuid, position?.toUpperCase()))
    .toArray();

  const result = overview[0] || null;
  return c.json(result);
});

app.get(
  '/:region/:tagName/:tagLine/recent-matches',
  accountMiddleware,
  async (c) => {
    const puuid = c.var.account.puuid;
    const { limit } = c.req.query();
    const matchLimit = limit ? Number(limit) : 10;

    const matches = await collections.matches
      .aggregate(recentMatches(puuid, matchLimit))
      .toArray();

    return c.json(matches);
  },
);

app.get(
  '/:region/:tagName/:tagLine/champion-insights',
  accountMiddleware,
  async (c) => {
    const puuid = c.var.account.puuid;

    const cacheKey = `cache:champion-insights:${c.var.internalId}:v2`;

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

    if (aiInsights)
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

interface Player {
  isActive: boolean;
  championName: string;
  role: string;
  puuid: string;
  kills: number;
  deaths: number;
  assists: number;
  goldEarned: number;
  totalDamageDealt: number;
  win: boolean;
  item0: number;
  item1: number;
  item2: number;
  item3: number;
  item4: number;
  item5: number;
  damageTypes: {
    physicalPercent: number;
    magicPercent: number;
    truePercent: number;
  };
  damageTakenTypes: {
    physicalPercent: number;
    magicPercent: number;
    truePercent: number;
  };
  finalBuild: Record<string, number | undefined>;
  stats: {
    timeCCingOthers: number;
    totalHeal: number;
    totalDamageDealtToChampions: number;
    trueDamageDealtToChampions: number;
    physicalDamageDealtToChampions: number;
    magicDamageDealtToChampions: number;
    totalDamageTaken: number;
    physicalDamageTaken: number;
    magicDamageTaken: number;
    trueDamageTaken: number;
    damageSelfMitigated: number;
  };
}

type MatchBuilds = {
  gameVersion: string;
  gameMode: string;
  gameDuration: number;
  gameCreation: number;
  allies: Player[];
  enemies: Player[];
};

app.get(
  '/:region/:tagName/:tagLine/match/:matchId/builds',
  accountMiddleware,
  async (c) => {
    const { matchId } = c.req.param();
    const puuid = c.var.account.puuid;
    const force = c.req.query('force') === 'true';

    const cacheKey = `cache:match-builds:${matchId}:${puuid}:v6`;

    try {
      const cached = await redis.get(cacheKey);
      if (cached && !force) {
        return c.json(JSON.parse(cached) as MatchBuilds);
      }
    } catch (err) {
      consola.warn('[match-builds-route] redis get failed', err);
    }

    // Get match builds data
    const match = (await collections.matches
      .aggregate(
        getMatchBuilds({
          matchId,
          puuid,
        }),
      )
      .next()) as MatchBuilds | null;

    if (!match) {
      throw new HTTPException(404, { message: 'Match not found' });
    }

    // Find subject participant
    const subjectParticipant = match.allies.find((p) => p.puuid === puuid);
    if (!subjectParticipant) {
      throw new HTTPException(404, { message: 'Player not found in match' });
    }

    // Use the builds service to generate suggestions
    const itemSuggestions = await generateBuildSuggestions(
      match,
      subjectParticipant,
    );

    // Cache the result
    try {
      await redis.set(
        cacheKey,
        JSON.stringify(itemSuggestions),
        'EX',
        ms('365d'),
      );
    } catch (err) {
      consola.warn('[match-builds-route] redis set failed', err);
    }

    return c.json(itemSuggestions);
  },
);

app.get('/:region/:tagName/:tagLine/matches', accountMiddleware, async (c) => {
  const puuid = c.var.account.puuid;

  const qQueue = c.req.query('queue');
  const qChampion = c.req.query('champion');
  const qRole = c.req.query('role');
  const qLimit = c.req.query('limit');
  const qOffset = c.req.query('offset');

  const limit = qLimit ? Math.min(Math.max(Number(qLimit), 1), 100) : 20;
  const offset = qOffset ? Math.max(Number(qOffset), 0) : 0;

  const parseNums = (s?: string): number[] => {
    if (!s) return [];
    return s
      .split(',')
      .map((x) => Number(x.trim()))
      .filter((n) => Number.isFinite(n));
  };

  const requestedQueues = parseNums(qQueue);
  const queueIds =
    requestedQueues.length > 0
      ? requestedQueues
      : Array.from(ALLOWED_QUEUE_IDS as readonly number[]);

  let championId: number | null = null;
  let championName: string | null = null;
  if (qChampion) {
    const num = Number(qChampion);
    if (Number.isFinite(num)) championId = num;
    else championName = qChampion;
  }

  const role = qRole ? qRole.toUpperCase() : null;
  const roleValid = !!role && (ROLES as readonly string[]).includes(role);

  const preMatch: Record<string, unknown> = {
    'info.participants.puuid': puuid,
    'info.queueId': { $in: queueIds },
  };

  if (championId !== null || championName || roleValid) {
    const elem: Record<string, unknown> = { puuid };
    if (championId !== null) elem.championId = championId;
    if (championName) elem.championName = championName;
    if (roleValid) elem.teamPosition = role;
    preMatch['info.participants'] = { $elemMatch: elem };
  }

  const basePipeline: Record<string, unknown>[] = [
    { $match: preMatch },
    {
      $project: {
        _id: 0,
        matchId: '$metadata.matchId',
        gameCreation: '$info.gameCreation',
        gameDuration: '$info.gameDuration',
        gameMode: '$info.gameMode',
        queueId: '$info.queueId',
        participants: {
          $map: {
            input: '$info.participants',
            as: 'p',
            in: {
              puuid: '$$p.puuid',
              championId: '$$p.championId',
              championName: '$$p.championName',
              teamId: '$$p.teamId',
              teamPosition: { $ifNull: ['$$p.teamPosition', 'UNKNOWN'] },
              kills: '$$p.kills',
              deaths: '$$p.deaths',
              assists: '$$p.assists',
              totalMinionsKilled: {
                $add: ['$$p.totalMinionsKilled', '$$p.neutralMinionsKilled'],
              },
              goldEarned: '$$p.goldEarned',
              totalDamageDealtToChampions: '$$p.totalDamageDealtToChampions',
              visionScore: '$$p.visionScore',
              win: '$$p.win',
              // Spells
              summoner1Id: '$$p.summoner1Id',
              summoner2Id: '$$p.summoner2Id',
              // Runes (primary/sub styles and keystone)
              perkPrimaryStyle: {
                $let: {
                  vars: { style0: { $arrayElemAt: ['$$p.perks.styles', 0] } },
                  in: '$$style0.style',
                },
              },
              perkSubStyle: {
                $let: {
                  vars: { style1: { $arrayElemAt: ['$$p.perks.styles', 1] } },
                  in: '$$style1.style',
                },
              },
              perkKeystone: {
                $let: {
                  vars: {
                    style0: { $arrayElemAt: ['$$p.perks.styles', 0] },
                  },
                  in: {
                    $let: {
                      vars: {
                        selections: { $ifNull: ['$$style0.selections', []] },
                      },
                      in: {
                        $let: {
                          vars: {
                            sel0: { $arrayElemAt: ['$$selections', 0] },
                          },
                          in: '$$sel0.perk',
                        },
                      },
                    },
                  },
                },
              },
              // Names for team lists
              summonerName: '$$p.summonerName',
              riotIdGameName: '$$p.riotIdGameName',
              riotIdTagline: '$$p.riotIdTagline',
              // Items
              item0: '$$p.item0',
              item1: '$$p.item1',
              item2: '$$p.item2',
              item3: '$$p.item3',
              item4: '$$p.item4',
              item5: '$$p.item5',
              item6: '$$p.item6',
            },
          },
        },
      },
    },
    {
      $set: {
        player: {
          $first: {
            $filter: {
              input: '$participants',
              as: 'p',
              cond: { $eq: ['$$p.puuid', puuid] },
            },
          },
        },
      },
    },
  ];

  if (roleValid || championId !== null || championName) {
    const postFilter: Record<string, unknown> = {};
    if (roleValid) postFilter['player.teamPosition'] = role;
    if (championId !== null) postFilter['player.championId'] = championId;
    if (championName) postFilter['player.championName'] = championName;
    basePipeline.push({ $match: postFilter });
  }

  basePipeline.push(
    {
      $set: {
        opponent: {
          $first: {
            $filter: {
              input: '$participants',
              as: 'p',
              cond: {
                $and: [
                  { $ne: ['$$p.puuid', puuid] },
                  { $ne: ['$$p.teamId', '$player.teamId'] },
                  { $eq: ['$$p.teamPosition', '$player.teamPosition'] },
                ],
              },
            },
          },
        },
      },
    },
    {
      $set: {
        kda: {
          $round: [
            {
              $cond: [
                { $eq: ['$player.deaths', 0] },
                { $add: ['$player.kills', '$player.assists'] },
                {
                  $divide: [
                    { $add: ['$player.kills', '$player.assists'] },
                    '$player.deaths',
                  ],
                },
              ],
            },
            2,
          ],
        },
        csPerMin: {
          $round: [
            {
              $divide: [
                '$player.totalMinionsKilled',
                { $divide: ['$gameDuration', 60] },
              ],
            },
            1,
          ],
        },
        goldPerMin: {
          $round: [
            {
              $divide: [
                '$player.goldEarned',
                { $divide: ['$gameDuration', 60] },
              ],
            },
            0,
          ],
        },
        damagePerMin: {
          $round: [
            {
              $divide: [
                '$player.totalDamageDealtToChampions',
                { $divide: ['$gameDuration', 60] },
              ],
            },
            0,
          ],
        },
        visionPerMin: {
          $round: [
            {
              $divide: [
                '$player.visionScore',
                { $divide: ['$gameDuration', 60] },
              ],
            },
            2,
          ],
        },
      },
    },
    {
      $project: {
        matchId: 1,
        gameCreation: 1,
        gameDuration: 1,
        gameMode: 1,
        queueId: 1,
        player: {
          championId: '$player.championId',
          championName: '$player.championName',
          summonerName: '$player.summonerName',
          riotIdGameName: '$player.riotIdGameName',
          riotIdTagline: '$player.riotIdTagline',
          teamPosition: '$player.teamPosition',
          kills: '$player.kills',
          deaths: '$player.deaths',
          assists: '$player.assists',
          cs: '$player.totalMinionsKilled',
          gold: '$player.goldEarned',
          damage: '$player.totalDamageDealtToChampions',
          visionScore: '$player.visionScore',
          win: '$player.win',
          spells: {
            s1: '$player.summoner1Id',
            s2: '$player.summoner2Id',
          },
          runes: {
            primaryStyle: '$player.perkPrimaryStyle',
            subStyle: '$player.perkSubStyle',
            keystone: '$player.perkKeystone',
          },
          items: [
            '$player.item0',
            '$player.item1',
            '$player.item2',
            '$player.item3',
            '$player.item4',
            '$player.item5',
            '$player.item6',
          ],
        },
        opponent: {
          championId: '$opponent.championId',
          championName: '$opponent.championName',
          kills: '$opponent.kills',
          deaths: '$opponent.deaths',
          assists: '$opponent.assists',
        },
        allies: {
          $map: {
            input: {
              $filter: {
                input: '$participants',
                as: 'p',
                cond: { $eq: ['$$p.teamId', '$player.teamId'] },
              },
            },
            as: 'a',
            in: {
              championId: '$$a.championId',
              championName: '$$a.championName',
              summonerName: '$$a.summonerName',
              riotIdGameName: '$$a.riotIdGameName',
              riotIdTagline: '$$a.riotIdTagline',
            },
          },
        },
        enemies: {
          $map: {
            input: {
              $filter: {
                input: '$participants',
                as: 'p',
                cond: { $ne: ['$$p.teamId', '$player.teamId'] },
              },
            },
            as: 'e',
            in: {
              championId: '$$e.championId',
              championName: '$$e.championName',
              summonerName: '$$e.summonerName',
              riotIdGameName: '$$e.riotIdGameName',
              riotIdTagline: '$$e.riotIdTagline',
            },
          },
        },
        kda: 1,
        csPerMin: 1,
        goldPerMin: 1,
        damagePerMin: 1,
        visionPerMin: 1,
      },
    },
    { $sort: { gameCreation: -1 } },
    { $skip: offset },
    { $limit: limit },
  );

  const [results, countDoc] = await Promise.all([
    collections.matches
      .aggregate(basePipeline, { allowDiskUse: true, maxTimeMS: 20_000 })
      .toArray(),
    collections.matches
      .aggregate([{ $match: preMatch }, { $count: 'total' }], {
        allowDiskUse: true,
        maxTimeMS: 20_000,
      })
      .toArray(),
  ]);

  const total = (countDoc[0]?.total ?? 0) as number;
  return c.json({
    total,
    limit,
    offset,
    results,
    hasMore: offset + results.length < total,
  });
});

export { app };
