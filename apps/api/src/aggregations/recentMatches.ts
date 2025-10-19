import { ALLOWED_QUEUE_IDS } from '@riftcoach/shared.constants';

export const recentMatches = (puuid: string, limit = 10) => [
  // Match only games with the user
  {
    $match: {
      'info.participants.puuid': puuid,
    },
  },

  // Only allowed queues
  { $match: { 'info.queueId': { $in: ALLOWED_QUEUE_IDS } } },

  // Project essential match data
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

  // Extract player data
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

  // Add opponent data (same role, different team)
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

  // Calculate KDA and performance metrics
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
            $divide: ['$player.goldEarned', { $divide: ['$gameDuration', 60] }],
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

  // Final projection
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
        teamPosition: '$player.teamPosition',
        kills: '$player.kills',
        deaths: '$player.deaths',
        assists: '$player.assists',
        cs: '$player.totalMinionsKilled',
        gold: '$player.goldEarned',
        damage: '$player.totalDamageDealtToChampions',
        visionScore: '$player.visionScore',
        win: '$player.win',
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
      kda: 1,
      csPerMin: 1,
      goldPerMin: 1,
      damagePerMin: 1,
      visionPerMin: 1,
    },
  },

  // Sort by most recent
  { $sort: { gameCreation: -1 } },

  // Limit results
  { $limit: limit },
];
