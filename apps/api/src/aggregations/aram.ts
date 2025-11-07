import type { Document } from 'mongodb';

const ARAM_QUEUE_IDS = [450];

export const aramStats = (puuid: string, since: number): Document[] => [
  {
    $match: {
      'info.participants.puuid': puuid,
      'info.queueId': { $in: ARAM_QUEUE_IDS },
      'info.gameCreation': { $gte: since },
    },
  },
  {
    $project: {
      gameCreation: '$info.gameCreation',
      gameDuration: { $ifNull: ['$info.gameDuration', 0] },
      player: {
        $first: {
          $filter: {
            input: '$info.participants',
            as: 'p',
            cond: { $eq: ['$$p.puuid', puuid] },
          },
        },
      },
    },
  },
  { $match: { player: { $type: 'object' } } },
  {
    $set: {
      player: {
        win: { $ifNull: ['$player.win', false] },
        kills: { $ifNull: ['$player.kills', 0] },
        deaths: { $ifNull: ['$player.deaths', 0] },
        assists: { $ifNull: ['$player.assists', 0] },
        totalDamageDealt: { $ifNull: ['$player.totalDamageDealtToChampions', 0] },
        totalDamageTaken: { $ifNull: ['$player.totalDamageTaken', 0] },
        damageSelfMitigated: {
          $ifNull: ['$player.damageSelfMitigated', 0],
        },
        goldEarned: { $ifNull: ['$player.goldEarned', 0] },
        timePlayed: {
          $ifNull: [
            {
              $cond: [
                {
                  $and: [
                    { $ne: ['$player.timePlayed', null] },
                    { $gt: ['$player.timePlayed', 0] },
                  ],
                },
                '$player.timePlayed',
                null,
              ],
            },
            { $ifNull: ['$gameDuration', 0] },
          ],
        },
      },
    },
  },
  {
    $group: {
      _id: null,
      totalGames: { $sum: 1 },
      wins: { $sum: { $cond: ['$player.win', 1, 0] } },
      totalKills: { $sum: '$player.kills' },
      totalDeaths: { $sum: '$player.deaths' },
      totalAssists: { $sum: '$player.assists' },
      totalDamageDealt: { $sum: '$player.totalDamageDealt' },
      totalDamageTaken: { $sum: '$player.totalDamageTaken' },
      totalDamageMitigated: { $sum: '$player.damageSelfMitigated' },
      totalGoldEarned: { $sum: '$player.goldEarned' },
      totalTimePlayed: { $sum: '$player.timePlayed' },
      firstGameTimestamp: { $min: '$gameCreation' },
      lastGameTimestamp: { $max: '$gameCreation' },
    },
  },
  {
    $project: {
      _id: 0,
      totalGames: 1,
      wins: 1,
      losses: { $max: [{ $subtract: ['$totalGames', '$wins'] }, 0] },
      winRate: {
        $cond: [
          { $eq: ['$totalGames', 0] },
          0,
          {
            $round: [
              {
                $multiply: [{ $divide: ['$wins', '$totalGames'] }, 100],
              },
              1,
            ],
          },
        ],
      },
      totalKills: 1,
      totalDeaths: 1,
      totalAssists: 1,
      averageKills: {
        $cond: [
          { $eq: ['$totalGames', 0] },
          0,
          { $round: [{ $divide: ['$totalKills', '$totalGames'] }, 2] },
        ],
      },
      averageDeaths: {
        $cond: [
          { $eq: ['$totalGames', 0] },
          0,
          { $round: [{ $divide: ['$totalDeaths', '$totalGames'] }, 2] },
        ],
      },
      averageAssists: {
        $cond: [
          { $eq: ['$totalGames', 0] },
          0,
          { $round: [{ $divide: ['$totalAssists', '$totalGames'] }, 2] },
        ],
      },
      kda: {
        $round: [
          {
            $cond: [
              { $eq: ['$totalDeaths', 0] },
              { $add: ['$totalKills', '$totalAssists'] },
              {
                $divide: [
                  { $add: ['$totalKills', '$totalAssists'] },
                  { $cond: [{ $eq: ['$totalDeaths', 0] }, 1, '$totalDeaths'] },
                ],
              },
            ],
          },
          2,
        ],
      },
      totalDamageDealt: 1,
      averageDamageDealt: {
        $cond: [
          { $eq: ['$totalGames', 0] },
          0,
          { $round: [{ $divide: ['$totalDamageDealt', '$totalGames'] }, 0] },
        ],
      },
      totalDamageTaken: 1,
      averageDamageTaken: {
        $cond: [
          { $eq: ['$totalGames', 0] },
          0,
          { $round: [{ $divide: ['$totalDamageTaken', '$totalGames'] }, 0] },
        ],
      },
      totalDamageMitigated: 1,
      averageDamageMitigated: {
        $cond: [
          { $eq: ['$totalGames', 0] },
          0,
          { $round: [{ $divide: ['$totalDamageMitigated', '$totalGames'] }, 0] },
        ],
      },
      totalDamageTakenAndMitigated: {
        $add: ['$totalDamageTaken', '$totalDamageMitigated'],
      },
      averageDamageTakenAndMitigated: {
        $cond: [
          { $eq: ['$totalGames', 0] },
          0,
          {
            $round: [
              {
                $divide: [
                  {
                    $add: ['$totalDamageTaken', '$totalDamageMitigated'],
                  },
                  '$totalGames',
                ],
              },
              0,
            ],
          },
        ],
      },
      totalGoldEarned: 1,
      averageGoldEarned: {
        $cond: [
          { $eq: ['$totalGames', 0] },
          0,
          { $round: [{ $divide: ['$totalGoldEarned', '$totalGames'] }, 0] },
        ],
      },
      totalTimePlayed: 1,
      averageGameDuration: {
        $cond: [
          { $eq: ['$totalGames', 0] },
          0,
          { $round: [{ $divide: ['$totalTimePlayed', '$totalGames'] }, 0] },
        ],
      },
      averageDamagePerMinute: {
        $cond: [
          { $eq: ['$totalTimePlayed', 0] },
          0,
          {
            $round: [
              {
                $divide: [
                  '$totalDamageDealt',
                  { $divide: ['$totalTimePlayed', 60] },
                ],
              },
              1,
            ],
          },
        ],
      },
      averageGoldPerMinute: {
        $cond: [
          { $eq: ['$totalTimePlayed', 0] },
          0,
          {
            $round: [
              {
                $divide: [
                  '$totalGoldEarned',
                  { $divide: ['$totalTimePlayed', 60] },
                ],
              },
              1,
            ],
          },
        ],
      },
      firstGameTimestamp: 1,
      lastGameTimestamp: 1,
    },
  },
  {
    $addFields: {
      timeframeStart: since,
      timeframeEnd: Date.now(),
    },
  },
];

export const aramMostPlayedChampions = (
  puuid: string,
  since: number,
  limit = 5,
): Document[] => [
  {
    $match: {
      'info.participants.puuid': puuid,
      'info.queueId': { $in: ARAM_QUEUE_IDS },
      'info.gameCreation': { $gte: since },
    },
  },
  {
    $project: {
      gameCreation: '$info.gameCreation',
      gameDuration: { $ifNull: ['$info.gameDuration', 0] },
      player: {
        $first: {
          $filter: {
            input: '$info.participants',
            as: 'p',
            cond: { $eq: ['$$p.puuid', puuid] },
          },
        },
      },
    },
  },
  { $match: { player: { $type: 'object' } } },
  {
    $set: {
      player: {
        championId: '$player.championId',
        championName: '$player.championName',
        win: { $ifNull: ['$player.win', false] },
        kills: { $ifNull: ['$player.kills', 0] },
        deaths: { $ifNull: ['$player.deaths', 0] },
        assists: { $ifNull: ['$player.assists', 0] },
        totalDamageDealt: { $ifNull: ['$player.totalDamageDealtToChampions', 0] },
        totalDamageTaken: { $ifNull: ['$player.totalDamageTaken', 0] },
        damageSelfMitigated: {
          $ifNull: ['$player.damageSelfMitigated', 0],
        },
        goldEarned: { $ifNull: ['$player.goldEarned', 0] },
        timePlayed: {
          $ifNull: [
            {
              $cond: [
                {
                  $and: [
                    { $ne: ['$player.timePlayed', null] },
                    { $gt: ['$player.timePlayed', 0] },
                  ],
                },
                '$player.timePlayed',
                null,
              ],
            },
            { $ifNull: ['$gameDuration', 0] },
          ],
        },
      },
    },
  },
  {
    $group: {
      _id: {
        championId: '$player.championId',
        championName: '$player.championName',
      },
      games: { $sum: 1 },
      wins: { $sum: { $cond: ['$player.win', 1, 0] } },
      totalKills: { $sum: '$player.kills' },
      totalDeaths: { $sum: '$player.deaths' },
      totalAssists: { $sum: '$player.assists' },
      totalDamageDealt: { $sum: '$player.totalDamageDealt' },
      totalDamageTaken: { $sum: '$player.totalDamageTaken' },
      totalDamageMitigated: { $sum: '$player.damageSelfMitigated' },
      totalGoldEarned: { $sum: '$player.goldEarned' },
      totalTimePlayed: { $sum: '$player.timePlayed' },
      lastGameTimestamp: { $max: '$gameCreation' },
    },
  },
  {
    $project: {
      _id: 0,
      championId: '$_id.championId',
      championName: '$_id.championName',
      games: 1,
      wins: 1,
      losses: { $max: [{ $subtract: ['$games', '$wins'] }, 0] },
      winRate: {
        $cond: [
          { $eq: ['$games', 0] },
          0,
          {
            $round: [
              { $multiply: [{ $divide: ['$wins', '$games'] }, 100] },
              1,
            ],
          },
        ],
      },
      avgKills: {
        $cond: [
          { $eq: ['$games', 0] },
          0,
          { $round: [{ $divide: ['$totalKills', '$games'] }, 2] },
        ],
      },
      avgDeaths: {
        $cond: [
          { $eq: ['$games', 0] },
          0,
          { $round: [{ $divide: ['$totalDeaths', '$games'] }, 2] },
        ],
      },
      avgAssists: {
        $cond: [
          { $eq: ['$games', 0] },
          0,
          { $round: [{ $divide: ['$totalAssists', '$games'] }, 2] },
        ],
      },
      avgKda: {
        $round: [
          {
            $cond: [
              { $eq: ['$totalDeaths', 0] },
              { $add: ['$totalKills', '$totalAssists'] },
              {
                $divide: [
                  { $add: ['$totalKills', '$totalAssists'] },
                  { $cond: [{ $eq: ['$totalDeaths', 0] }, 1, '$totalDeaths'] },
                ],
              },
            ],
          },
          2,
        ],
      },
      avgDamageDealt: {
        $cond: [
          { $eq: ['$games', 0] },
          0,
          { $round: [{ $divide: ['$totalDamageDealt', '$games'] }, 0] },
        ],
      },
      avgDamageTakenAndMitigated: {
        $cond: [
          { $eq: ['$games', 0] },
          0,
          {
            $round: [
              {
                $divide: [
                  {
                    $add: ['$totalDamageTaken', '$totalDamageMitigated'],
                  },
                  '$games',
                ],
              },
              0,
            ],
          },
        ],
      },
      avgGoldEarned: {
        $cond: [
          { $eq: ['$games', 0] },
          0,
          { $round: [{ $divide: ['$totalGoldEarned', '$games'] }, 0] },
        ],
      },
      avgDamagePerMinute: {
        $cond: [
          { $eq: ['$totalTimePlayed', 0] },
          0,
          {
            $round: [
              {
                $divide: [
                  '$totalDamageDealt',
                  { $divide: ['$totalTimePlayed', 60] },
                ],
              },
              1,
            ],
          },
        ],
      },
      avgGoldPerMinute: {
        $cond: [
          { $eq: ['$totalTimePlayed', 0] },
          0,
          {
            $round: [
              {
                $divide: [
                  '$totalGoldEarned',
                  { $divide: ['$totalTimePlayed', 60] },
                ],
              },
              1,
            ],
          },
        ],
      },
      lastGameTimestamp: 1,
    },
  },
  { $sort: { games: -1, winRate: -1 } },
  { $limit: limit },
];

export const aramNemesis = (
  puuid: string,
  since: number,
  limit = 5,
): Document[] => [
  {
    $match: {
      'info.participants.puuid': puuid,
      'info.queueId': { $in: ARAM_QUEUE_IDS },
      'info.gameCreation': { $gte: since },
    },
  },
  {
    $project: {
      matchId: '$metadata.matchId',
      participants: '$info.participants',
      gameCreation: '$info.gameCreation',
      player: {
        $first: {
          $filter: {
            input: '$info.participants',
            as: 'p',
            cond: { $eq: ['$$p.puuid', puuid] },
          },
        },
      },
    },
  },
  { $match: { player: { $type: 'object' } } },
  {
    $lookup: {
      from: 'timelines',
      let: {
        matchId: '$matchId',
        participantId: '$player.participantId',
      },
      pipeline: [
        { $match: { $expr: { $eq: ['$metadata.matchId', '$$matchId'] } } },
        { $unwind: '$info.frames' },
        {
          $unwind: {
            path: '$info.frames.events',
            preserveNullAndEmptyArrays: false,
          },
        },
        { $match: { 'info.frames.events.type': 'CHAMPION_KILL' } },
        {
          $match: {
            $expr: {
              $eq: ['$info.frames.events.victimId', '$$participantId'],
            },
          },
        },
        {
          $project: {
            killerId: '$info.frames.events.killerId',
          },
        },
      ],
      as: 'deathEvents',
    },
  },
  { $unwind: '$deathEvents' },
  { $match: { 'deathEvents.killerId': { $gt: 0 } } },
  {
    $set: {
      killer: {
        $first: {
          $filter: {
            input: '$participants',
            as: 'opponent',
            cond: {
              $eq: ['$$opponent.participantId', '$deathEvents.killerId'],
            },
          },
        },
      },
    },
  },
  { $match: { killer: { $type: 'object' } } },
  {
    $group: {
      _id: {
        championId: '$killer.championId',
        championName: '$killer.championName',
      },
      deaths: { $sum: 1 },
    },
  },
  { $sort: { deaths: -1 } },
  {
    $group: {
      _id: null,
      totalDeaths: { $sum: '$deaths' },
      nemeses: {
        $push: {
          championId: '$_id.championId',
          championName: '$_id.championName',
          deaths: '$deaths',
        },
      },
    },
  },
  { $unwind: '$nemeses' },
  {
    $project: {
      _id: 0,
      championId: '$nemeses.championId',
      championName: '$nemeses.championName',
      deaths: '$nemeses.deaths',
      share: {
        $cond: [
          { $eq: ['$totalDeaths', 0] },
          0,
          {
            $round: [
              { $divide: ['$nemeses.deaths', '$totalDeaths'] },
              4,
            ],
          },
        ],
      },
    },
  },
  { $sort: { deaths: -1 } },
  { $limit: limit },
];
