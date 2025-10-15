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
import ms from 'ms';
import { v5 } from 'uuid';
import z from 'zod';
import { enemyStatsByRolePUUID } from '../../aggregations/enemyStatsByRolePUUID.js';
import { statsByRolePUUID } from '../../aggregations/statsByRolePUUID.js';
import { redis } from '../../clients/redis.js';

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
  await redis.set(`rewind:${rewindId}:matches`, 0);
  await redis.set(`rewind:${rewindId}:listing`, 1);
  await redis.set(`rewind:${rewindId}:total`, 0);
  await redis.set(`rewind:${rewindId}:status`, 'listing');
  await redis.set(`rewind:${rewindId}:processed`, 0);

  consola.info(chalk.blue(`Rewind ${rewindId} started`));

  queues[c.var.cluster].add(
    `list-matches-${c.var.account.puuid}-0`,
    {
      type: 'list-matches',
      puuid: c.var.account.puuid,
      start: 0,
      rewindId,
      region: c.var.region,
    },
    {
      delay: ms('1s'),
    },
  );

  return c.json({
    rewindId,
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

  return c.json({
    rewindId,
    matches: Number(matches),
    listing: Number(listing),
    total: Number(total),
    processed: Number(processed),
    status,
  });
});

app.get('/:region/:tagName/:tagLine/stats', accountMiddleware, async (c) => {
  const account = c.var.account;
  const [myStats, enemyStats] = await Promise.all([
    collections.matches.aggregate(statsByRolePUUID(account.puuid)).toArray(),
    collections.matches
      .aggregate(enemyStatsByRolePUUID(account.puuid))
      .toArray(),
  ]);

  return c.json({
    myStats,
    enemyStats,
  });
});

export { app };
