import { ALLOWED_QUEUE_IDS } from '@riftcoach/shared.constants';
import type { Document } from 'mongodb';

const ROLE_SYNONYMS: Record<string, string[]> = {
  TOP: ['TOP'],
  JUNGLE: ['JUNGLE'],
  MIDDLE: ['MIDDLE', 'MID'],
  BOTTOM: ['BOTTOM', 'ADC', 'BOT'],
  UTILITY: ['UTILITY', 'SUPPORT', 'SUP'],
  UNKNOWN: [],
};

const normalizeRoleExpression: Document = {
  $switch: {
    branches: [
      { case: { $in: ['$$role', ['TOP']] }, then: 'TOP' },
      { case: { $in: ['$$role', ['JUNGLE']] }, then: 'JUNGLE' },
      { case: { $in: ['$$role', ['MIDDLE', 'MID']] }, then: 'MIDDLE' },
      {
        case: { $in: ['$$role', ['BOTTOM', 'ADC', 'BOT']] },
        then: 'BOTTOM',
      },
      {
        case: { $in: ['$$role', ['UTILITY', 'SUPPORT', 'SUP']] },
        then: 'UTILITY',
      },
    ],
    default: 'UNKNOWN',
  },
};

export const playerChampionProgressAggregation = (
  puuid: string,
  championName: string,
  normalizedRole: string,
  options?: { limit?: number; before?: number; since?: number },
): Document[] => {
  const limit = Math.max(1, Math.min(options?.limit ?? 20, 50));
  const before = options?.before;
  const since = options?.since;
  const role = normalizedRole.toUpperCase();
  const synonyms = ROLE_SYNONYMS[role] ?? [];

  const pipeline: Document[] = [
    {
      $match: {
        'info.participants': {
          $elemMatch: {
            puuid,
            championName,
          },
        },
        'info.queueId': { $in: ALLOWED_QUEUE_IDS },
      },
    },
    {
      $project: {
        _id: 0,
        matchId: '$metadata.matchId',
        gameCreation: '$info.gameCreation',
        gameEndTimestamp: '$info.gameEndTimestamp',
        gameDuration: '$info.gameDuration',
        queueId: '$info.queueId',
        participants: '$info.participants',
      },
    },
  ];

  if (typeof before === 'number' && Number.isFinite(before)) {
    pipeline.push({
      $match: {
        gameCreation: { $lte: before },
      },
    });
  }

  if (typeof since === 'number' && Number.isFinite(since)) {
    pipeline.push({
      $match: {
        gameCreation: { $gte: since },
      },
    });
  }

  pipeline.push(
    {
      $set: {
        participants: {
          $map: {
            input: '$participants',
            as: 'p',
            in: {
              puuid: '$$p.puuid',
              championName: '$$p.championName',
              teamId: '$$p.teamId',
              kills: { $ifNull: ['$$p.kills', 0] },
              deaths: { $ifNull: ['$$p.deaths', 0] },
              assists: { $ifNull: ['$$p.assists', 0] },
              cs: {
                $add: [
                  { $ifNull: ['$$p.totalMinionsKilled', 0] },
                  { $ifNull: ['$$p.neutralMinionsKilled', 0] },
                ],
              },
              goldEarned: { $ifNull: ['$$p.goldEarned', 0] },
              damageDealt: { $ifNull: ['$$p.totalDamageDealtToChampions', 0] },
              visionScore: { $ifNull: ['$$p.visionScore', 0] },
              win: { $ifNull: ['$$p.win', false] },
              rawRole: {
                $let: {
                  vars: {
                    teamPosition: {
                      $toUpper: { $ifNull: ['$$p.teamPosition', ''] },
                    },
                    individualPosition: {
                      $toUpper: { $ifNull: ['$$p.individualPosition', ''] },
                    },
                  },
                  in: {
                    $cond: [
                      { $ne: ['$$teamPosition', ''] },
                      '$$teamPosition',
                      '$$individualPosition',
                    ],
                  },
                },
              },
            },
          },
        },
      },
    },
    {
      $set: {
        participants: {
          $map: {
            input: '$participants',
            as: 'p',
            in: {
              puuid: '$$p.puuid',
              championName: '$$p.championName',
              teamId: '$$p.teamId',
              kills: '$$p.kills',
              deaths: '$$p.deaths',
              assists: '$$p.assists',
              cs: '$$p.cs',
              goldEarned: '$$p.goldEarned',
              damageDealt: '$$p.damageDealt',
              visionScore: '$$p.visionScore',
              win: '$$p.win',
              rawRole: '$$p.rawRole',
              normalizedRole: {
                $let: {
                  vars: { role: '$$p.rawRole' },
                  in: normalizeRoleExpression,
                },
              },
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
              cond: {
                $and: [
                  { $eq: ['$$p.puuid', puuid] },
                  { $eq: ['$$p.championName', championName] },
                  {
                    $cond: [
                      { $gt: [{ $size: { $literal: synonyms } }, 0] },
                      { $in: ['$$p.rawRole', { $literal: synonyms }] },
                      { $eq: ['$$p.normalizedRole', role] },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    },
    { $match: { player: { $ne: null } } },
    { $sort: { gameCreation: -1 } },
    { $limit: limit },
    { $sort: { gameCreation: 1 } },
    {
      $set: {
        csPerMin: {
          $cond: [
            { $gt: ['$gameDuration', 0] },
            { $divide: ['$player.cs', { $divide: ['$gameDuration', 60] }] },
            null,
          ],
        },
        damagePerMin: {
          $cond: [
            { $gt: ['$gameDuration', 0] },
            {
              $divide: [
                '$player.damageDealt',
                { $divide: ['$gameDuration', 60] },
              ],
            },
            null,
          ],
        },
        goldPerMin: {
          $cond: [
            { $gt: ['$gameDuration', 0] },
            {
              $divide: [
                '$player.goldEarned',
                { $divide: ['$gameDuration', 60] },
              ],
            },
            null,
          ],
        },
        visionPerMin: {
          $cond: [
            { $gt: ['$gameDuration', 0] },
            {
              $divide: [
                '$player.visionScore',
                { $divide: ['$gameDuration', 60] },
              ],
            },
            null,
          ],
        },
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
        killParticipation: {
          $let: {
            vars: {
              teamKills: {
                $sum: {
                  $map: {
                    input: {
                      $filter: {
                        input: '$participants',
                        as: 'ally',
                        cond: { $eq: ['$$ally.teamId', '$player.teamId'] },
                      },
                    },
                    as: 'ally',
                    in: '$$ally.kills',
                  },
                },
              },
            },
            in: {
              $cond: [
                { $gt: ['$$teamKills', 0] },
                {
                  $divide: [
                    { $add: ['$player.kills', '$player.assists'] },
                    '$$teamKills',
                  ],
                },
                null,
              ],
            },
          },
        },
      },
    },
    {
      $project: {
        matchId: 1,
        gameCreation: 1,
        gameEndTimestamp: 1,
        gameDuration: 1,
        queueId: 1,
        championName: '$player.championName',
        role: '$player.normalizedRole',
        win: '$player.win',
        kills: '$player.kills',
        deaths: '$player.deaths',
        assists: '$player.assists',
        csPerMin: {
          $cond: [
            { $ne: ['$csPerMin', null] },
            { $round: ['$csPerMin', 2] },
            null,
          ],
        },
        damagePerMin: {
          $cond: [
            { $ne: ['$damagePerMin', null] },
            { $round: ['$damagePerMin', 0] },
            null,
          ],
        },
        goldPerMin: {
          $cond: [
            { $ne: ['$goldPerMin', null] },
            { $round: ['$goldPerMin', 0] },
            null,
          ],
        },
        visionPerMin: {
          $cond: [
            { $ne: ['$visionPerMin', null] },
            { $round: ['$visionPerMin', 2] },
            null,
          ],
        },
        killParticipation: {
          $cond: [
            { $ne: ['$killParticipation', null] },
            { $round: ['$killParticipation', 3] },
            null,
          ],
        },
        kda: 1,
      },
    },
  );

  return pipeline;
};
