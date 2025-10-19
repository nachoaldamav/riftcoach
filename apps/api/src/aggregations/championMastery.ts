import { ALLOWED_QUEUE_IDS } from '@riftcoach/shared.constants';

export const championMastery = (puuid: string, limit = 5) => [
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

  // Filter only ranked games
  {
    $match: {
      queueId: { $in: ALLOWED_QUEUE_IDS },
    },
  },

  // Group by champion
  {
    $group: {
      _id: {
        championId: '$player.championId',
        championName: '$player.championName',
      },
      gamesPlayed: { $sum: 1 },
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
      totalDamage: { $sum: '$player.totalDamageDealtToChampions' },
      totalGold: { $sum: '$player.goldEarned' },
      totalVisionScore: { $sum: '$player.visionScore' },
      pentaKills: { $sum: '$player.pentaKills' },
      quadraKills: { $sum: '$player.quadraKills' },
      tripleKills: { $sum: '$player.tripleKills' },
      doubleKills: { $sum: '$player.doubleKills' },
      largestKillingSpree: { $max: '$player.largestKillingSpree' },
      lastPlayed: { $max: '$gameCreation' },
    },
  },

  // Calculate champion statistics
  {
    $project: {
      _id: 0,
      championId: '$_id.championId',
      championName: '$_id.championName',
      gamesPlayed: 1,
      wins: 1,
      losses: { $subtract: ['$gamesPlayed', '$wins'] },
      winRate: {
        $round: [
          {
            $multiply: [{ $divide: ['$wins', '$gamesPlayed'] }, 100],
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
        $round: [{ $divide: ['$totalKills', '$gamesPlayed'] }, 1],
      },
      avgDeaths: {
        $round: [{ $divide: ['$totalDeaths', '$gamesPlayed'] }, 1],
      },
      avgAssists: {
        $round: [{ $divide: ['$totalAssists', '$gamesPlayed'] }, 1],
      },
      avgCs: {
        $round: [{ $divide: ['$totalCs', '$gamesPlayed'] }, 0],
      },
      avgDamage: {
        $round: [{ $divide: ['$totalDamage', '$gamesPlayed'] }, 0],
      },
      avgGold: {
        $round: [{ $divide: ['$totalGold', '$gamesPlayed'] }, 0],
      },
      avgVisionScore: {
        $round: [{ $divide: ['$totalVisionScore', '$gamesPlayed'] }, 1],
      },
      multikills: {
        pentaKills: '$pentaKills',
        quadraKills: '$quadraKills',
        tripleKills: '$tripleKills',
        doubleKills: '$doubleKills',
      },
      largestKillingSpree: 1,
      lastPlayed: 1,
      masteryScore: {
        // Custom mastery score based on games played, win rate, and KDA
        $round: [
          {
            $multiply: [
              '$gamesPlayed',
              {
                $add: [
                  { $divide: ['$wins', '$gamesPlayed'] }, // Win rate factor
                  {
                    $divide: [
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
                      10, // KDA factor (normalized)
                    ],
                  },
                ],
              },
            ],
          },
          2,
        ],
      },
    },
  },

  // Sort by mastery score (games played * performance)
  { $sort: { masteryScore: -1 } },

  // Limit results
  { $limit: limit },
];
