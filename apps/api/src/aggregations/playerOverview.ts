import { ALLOWED_QUEUE_IDS } from '@riftcoach/shared.constants';

export const playerOverview = (puuid: string) => [
  // Match only games with the user
  {
    $match: {
      'info.participants.puuid': puuid,
    },
  },

  // Extract player data from each match
  {
    $project: {
      _id: 0,
      gameCreation: '$info.gameCreation',
      gameDuration: '$info.gameDuration',
      queueId: '$info.queueId',
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

  // Filter only ranked games (queueId 420 for Solo/Duo, 440 for Flex)
  {
    $match: {
      queueId: { $in: ALLOWED_QUEUE_IDS },
    },
  },

  // Group all matches to calculate overall stats
  {
    $group: {
      _id: null,
      totalGames: { $sum: 1 },
      wins: {
        $sum: {
          $cond: ['$player.win', 1, 0],
        },
      },
      totalKills: { $sum: '$player.kills' },
      totalDeaths: { $sum: '$player.deaths' },
      totalAssists: { $sum: '$player.assists' },
      totalCs: {
        $sum: {
          $add: ['$player.totalMinionsKilled', '$player.neutralMinionsKilled'],
        },
      },
      totalGold: { $sum: '$player.goldEarned' },
      totalDamage: { $sum: '$player.totalDamageDealtToChampions' },
      totalVisionScore: { $sum: '$player.visionScore' },
      totalGameDuration: { $sum: '$gameDuration' },
      firstBloodKills: {
        $sum: {
          $cond: ['$player.firstBloodKill', 1, 0],
        },
      },
      pentaKills: { $sum: '$player.pentaKills' },
      quadraKills: { $sum: '$player.quadraKills' },
      tripleKills: { $sum: '$player.tripleKills' },
      doubleKills: { $sum: '$player.doubleKills' },
      soloKills: { $sum: '$player.soloKills' },
      largestKillingSpree: { $max: '$player.largestKillingSpree' },
      largestMultiKill: { $max: '$player.largestMultiKill' },
    },
  },

  // Calculate derived statistics
  {
    $project: {
      _id: 0,
      totalGames: 1,
      wins: 1,
      losses: { $subtract: ['$totalGames', '$wins'] },
      winRate: {
        $round: [
          {
            $multiply: [{ $divide: ['$wins', '$totalGames'] }, 100],
          },
          1,
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
                  '$totalDeaths',
                ],
              },
            ],
          },
          2,
        ],
      },
      avgKills: {
        $round: [{ $divide: ['$totalKills', '$totalGames'] }, 1],
      },
      avgDeaths: {
        $round: [{ $divide: ['$totalDeaths', '$totalGames'] }, 1],
      },
      avgAssists: {
        $round: [{ $divide: ['$totalAssists', '$totalGames'] }, 1],
      },
      avgCsPerMin: {
        $round: [
          {
            $divide: ['$totalCs', { $divide: ['$totalGameDuration', 60] }],
          },
          1,
        ],
      },
      avgGoldPerMin: {
        $round: [
          {
            $divide: ['$totalGold', { $divide: ['$totalGameDuration', 60] }],
          },
          0,
        ],
      },
      avgDamagePerMin: {
        $round: [
          {
            $divide: ['$totalDamage', { $divide: ['$totalGameDuration', 60] }],
          },
          0,
        ],
      },
      avgVisionPerMin: {
        $round: [
          {
            $divide: [
              '$totalVisionScore',
              { $divide: ['$totalGameDuration', 60] },
            ],
          },
          2,
        ],
      },
      avgGameDuration: {
        $round: [{ $divide: ['$totalGameDuration', '$totalGames'] }, 0],
      },
      multikills: {
        pentaKills: '$pentaKills',
        quadraKills: '$quadraKills',
        tripleKills: '$tripleKills',
        doubleKills: '$doubleKills',
      },
      achievements: {
        firstBloodKills: '$firstBloodKills',
        soloKills: '$soloKills',
        largestKillingSpree: '$largestKillingSpree',
        largestMultiKill: '$largestMultiKill',
      },
    },
  },
];
