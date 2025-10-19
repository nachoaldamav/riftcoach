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

  // Filter only allowed queues
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
      // Recency counters (last 30 days)
      recentGames: {
        $sum: {
          $cond: [
            {
              $gte: [
                '$gameCreation',
                { $subtract: [new Date().getTime(), 30 * 24 * 60 * 60 * 1000] },
              ],
            },
            1,
            0,
          ],
        },
      },
      recentWins: {
        $sum: {
          $cond: [
            {
              $and: [
                {
                  $gte: [
                    '$gameCreation',
                    {
                      $subtract: [
                        new Date().getTime(),
                        30 * 24 * 60 * 60 * 1000,
                      ],
                    },
                  ],
                },
                '$player.win',
              ],
            },
            1,
            0,
          ],
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
      // Expose recency counters
      recentGames: 1,
      recentWins: 1,
      losses: { $subtract: ['$gamesPlayed', '$wins'] },
      winRate: {
        $round: [
          {
            $multiply: [{ $divide: ['$wins', '$gamesPlayed'] }, 100],
          },
          1,
        ],
      },
      // Recent win rate percentage
      recentWinRate: {
        $round: [
          {
            $cond: [
              { $eq: ['$recentGames', 0] },
              0,
              { $multiply: [{ $divide: ['$recentWins', '$recentGames'] }, 100] },
            ],
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
      // Days since last played
      daysSinceLastPlayed: {
        $round: [
          {
            $divide: [
              { $subtract: [new Date().getTime(), '$lastPlayed'] },
              86400000,
            ],
          },
          0,
        ],
      },
      // Enhanced mastery score:
      // sqrt(games) * (winRate + KDA/10 + bounded trend) * recency * multikill
      masteryScore: {
        $round: [
          {
            $multiply: [
              // volume smoothing
              { $sqrt: '$gamesPlayed' },
              // performance core (win rate + normalized KDA + trend bonus)
              {
                $add: [
                  { $divide: ['$wins', '$gamesPlayed'] },
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
                      10,
                    ],
                  },
                  // recent trend bonus bounded to [-0.05, 0.05]
                  {
                    $cond: [
                      { $eq: ['$recentGames', 0] },
                      0,
                      {
                        $max: [
                          -0.05,
                          {
                            $min: [
                              0.05,
                              {
                                $subtract: [
                                  { $divide: ['$recentWins', '$recentGames'] },
                                  { $divide: ['$wins', '$gamesPlayed'] },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
              // recency weight: favors recently played, floors at 0.6
              {
                $max: [
                  0.6,
                  {
                    $divide: [
                      30,
                      {
                        $add: [
                          30,
                          {
                            $divide: [
                              { $subtract: [new Date().getTime(), '$lastPlayed'] },
                              86400000,
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
              // multikill factor capped at +0.3
              {
                $min: [
                  1.3,
                  {
                    $add: [
                      1,
                      {
                        $cond: [
                          { $eq: ['$gamesPlayed', 0] },
                          0,
                          {
                            $divide: [
                              {
                                $add: [
                                  { $multiply: ['$pentaKills', 3] },
                                  { $multiply: ['$quadraKills', 2] },
                                  '$tripleKills',
                                  { $multiply: ['$doubleKills', 0.5] },
                                ],
                              },
                              '$gamesPlayed',
                            ],
                          },
                        ],
                      },
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

  // Sort by mastery score (games played * performance * recency)
  { $sort: { masteryScore: -1 } },

  // Limit results
  { $limit: limit },
];
