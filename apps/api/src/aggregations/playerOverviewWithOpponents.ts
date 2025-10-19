import { ALLOWED_QUEUE_IDS } from '@riftcoach/shared.constants';

export const playerOverviewWithOpponents = (puuid: string, position?: string) => [
  // Match only games with the user
  {
    $match: {
      'info.participants.puuid': puuid,
    },
  },

  // Extract player data and opponent data from each match
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
      // Get direct opponent (same role, different team)
      opponent: {
        $first: {
          $filter: {
            input: '$info.participants',
            as: 'p',
            cond: {
              $and: [
                { $ne: ['$$p.puuid', puuid] },
                { 
                  $ne: [
                    '$$p.teamId', 
                    {
                      $first: {
                        $map: {
                          input: {
                            $filter: {
                              input: '$info.participants',
                              as: 'player',
                              cond: { $eq: ['$$player.puuid', puuid] },
                            },
                          },
                          as: 'player',
                          in: '$$player.teamId',
                        },
                      },
                    },
                  ],
                },
                { 
                  $eq: [
                    '$$p.teamPosition', 
                    {
                      $first: {
                        $map: {
                          input: {
                            $filter: {
                              input: '$info.participants',
                              as: 'player',
                              cond: { $eq: ['$$player.puuid', puuid] },
                            },
                          },
                          as: 'player',
                          in: '$$player.teamPosition',
                        },
                      },
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    },
  },

  // Filter only ranked games
  {
    $match: {
      queueId: { $in: ALLOWED_QUEUE_IDS },
      ...(position && { 'player.teamPosition': position }),
    },
  },

  // Group all matches to calculate overall stats for both player and opponents
  {
    $group: {
      _id: null,
      totalGames: { $sum: 1 },
      wins: {
        $sum: {
          $cond: ['$player.win', 1, 0],
        },
      },
      
      // Player stats
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
      
      // Opponent stats (only count games where opponent exists)
      opponentGames: {
        $sum: {
          $cond: [{ $ne: ['$opponent', null] }, 1, 0],
        },
      },
      opponentTotalKills: {
        $sum: {
          $cond: [{ $ne: ['$opponent', null] }, '$opponent.kills', 0],
        },
      },
      opponentTotalDeaths: {
        $sum: {
          $cond: [{ $ne: ['$opponent', null] }, '$opponent.deaths', 0],
        },
      },
      opponentTotalAssists: {
        $sum: {
          $cond: [{ $ne: ['$opponent', null] }, '$opponent.assists', 0],
        },
      },
      opponentTotalCs: {
        $sum: {
          $cond: [
            { $ne: ['$opponent', null] },
            { $add: ['$opponent.totalMinionsKilled', '$opponent.neutralMinionsKilled'] },
            0,
          ],
        },
      },
      opponentTotalGold: {
        $sum: {
          $cond: [{ $ne: ['$opponent', null] }, '$opponent.goldEarned', 0],
        },
      },
      opponentTotalDamage: {
        $sum: {
          $cond: [{ $ne: ['$opponent', null] }, '$opponent.totalDamageDealtToChampions', 0],
        },
      },
      opponentTotalVisionScore: {
        $sum: {
          $cond: [{ $ne: ['$opponent', null] }, '$opponent.visionScore', 0],
        },
      },
      opponentGameDuration: {
        $sum: {
          $cond: [{ $ne: ['$opponent', null] }, '$gameDuration', 0],
        },
      },
      
      // Achievements
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
      
      // Player averages
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
      
      // Opponent averages
      opponentAvgKda: {
        $round: [
          {
            $cond: [
              { $or: [{ $eq: ['$opponentGames', 0] }, { $eq: ['$opponentTotalDeaths', 0] }] },
              0,
              {
                $divide: [
                  { $add: ['$opponentTotalKills', '$opponentTotalAssists'] },
                  '$opponentTotalDeaths',
                ],
              },
            ],
          },
          2,
        ],
      },
      opponentAvgKills: {
        $round: [
          {
            $cond: [
              { $eq: ['$opponentGames', 0] },
              0,
              { $divide: ['$opponentTotalKills', '$opponentGames'] },
            ],
          },
          1,
        ],
      },
      opponentAvgDeaths: {
        $round: [
          {
            $cond: [
              { $eq: ['$opponentGames', 0] },
              0,
              { $divide: ['$opponentTotalDeaths', '$opponentGames'] },
            ],
          },
          1,
        ],
      },
      opponentAvgAssists: {
        $round: [
          {
            $cond: [
              { $eq: ['$opponentGames', 0] },
              0,
              { $divide: ['$opponentTotalAssists', '$opponentGames'] },
            ],
          },
          1,
        ],
      },
      opponentAvgCsPerMin: {
        $round: [
          {
            $cond: [
              { $eq: ['$opponentGameDuration', 0] },
              0,
              {
                $divide: ['$opponentTotalCs', { $divide: ['$opponentGameDuration', 60] }],
              },
            ],
          },
          1,
        ],
      },
      opponentAvgGoldPerMin: {
        $round: [
          {
            $cond: [
              { $eq: ['$opponentGameDuration', 0] },
              0,
              {
                $divide: ['$opponentTotalGold', { $divide: ['$opponentGameDuration', 60] }],
              },
            ],
          },
          0,
        ],
      },
      opponentAvgDamagePerMin: {
        $round: [
          {
            $cond: [
              { $eq: ['$opponentGameDuration', 0] },
              0,
              {
                $divide: ['$opponentTotalDamage', { $divide: ['$opponentGameDuration', 60] }],
              },
            ],
          },
          0,
        ],
      },
      opponentAvgVisionPerMin: {
        $round: [
          {
            $cond: [
              { $eq: ['$opponentGameDuration', 0] },
              0,
              {
                $divide: [
                  '$opponentTotalVisionScore',
                  { $divide: ['$opponentGameDuration', 60] },
                ],
              },
            ],
          },
          2,
        ],
      },
      
      // Keep existing data structure
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

  // Create spider chart data with relative values in a separate stage
  {
    $addFields: {
      spiderChartData: [
        {
          metric: 'KDA',
          player: {
            $cond: [
              { $eq: [{ $add: ['$avgKda', '$opponentAvgKda'] }, 0] },
              50,
              {
                $multiply: [
                  { $divide: ['$avgKda', { $add: ['$avgKda', '$opponentAvgKda'] }] },
                  100
                ]
              }
            ]
          },
          opponent: {
            $cond: [
              { $eq: [{ $add: ['$avgKda', '$opponentAvgKda'] }, 0] },
              50,
              {
                $multiply: [
                  { $divide: ['$opponentAvgKda', { $add: ['$avgKda', '$opponentAvgKda'] }] },
                  100
                ]
              }
            ]
          },
          playerActual: '$avgKda',
          opponentActual: '$opponentAvgKda',
          fullMark: 100,
        },
        {
          metric: 'CS/min',
          player: {
            $cond: [
              { $eq: [{ $add: ['$avgCsPerMin', '$opponentAvgCsPerMin'] }, 0] },
              50,
              {
                $multiply: [
                  { $divide: ['$avgCsPerMin', { $add: ['$avgCsPerMin', '$opponentAvgCsPerMin'] }] },
                  100
                ]
              }
            ]
          },
          opponent: {
            $cond: [
              { $eq: [{ $add: ['$avgCsPerMin', '$opponentAvgCsPerMin'] }, 0] },
              50,
              {
                $multiply: [
                  { $divide: ['$opponentAvgCsPerMin', { $add: ['$avgCsPerMin', '$opponentAvgCsPerMin'] }] },
                  100
                ]
              }
            ]
          },
          playerActual: '$avgCsPerMin',
          opponentActual: '$opponentAvgCsPerMin',
          fullMark: 100,
        },
        {
          metric: 'Gold/min',
          player: {
            $cond: [
              { $eq: [{ $add: ['$avgGoldPerMin', '$opponentAvgGoldPerMin'] }, 0] },
              50,
              {
                $multiply: [
                  { $divide: ['$avgGoldPerMin', { $add: ['$avgGoldPerMin', '$opponentAvgGoldPerMin'] }] },
                  100
                ]
              }
            ]
          },
          opponent: {
            $cond: [
              { $eq: [{ $add: ['$avgGoldPerMin', '$opponentAvgGoldPerMin'] }, 0] },
              50,
              {
                $multiply: [
                  { $divide: ['$opponentAvgGoldPerMin', { $add: ['$avgGoldPerMin', '$opponentAvgGoldPerMin'] }] },
                  100
                ]
              }
            ]
          },
          playerActual: '$avgGoldPerMin',
          opponentActual: '$opponentAvgGoldPerMin',
          fullMark: 100,
        },
        {
          metric: 'Damage/min',
          player: {
            $cond: [
              { $eq: [{ $add: ['$avgDamagePerMin', '$opponentAvgDamagePerMin'] }, 0] },
              50,
              {
                $multiply: [
                  { $divide: ['$avgDamagePerMin', { $add: ['$avgDamagePerMin', '$opponentAvgDamagePerMin'] }] },
                  100
                ]
              }
            ]
          },
          opponent: {
            $cond: [
              { $eq: [{ $add: ['$avgDamagePerMin', '$opponentAvgDamagePerMin'] }, 0] },
              50,
              {
                $multiply: [
                  { $divide: ['$opponentAvgDamagePerMin', { $add: ['$avgDamagePerMin', '$opponentAvgDamagePerMin'] }] },
                  100
                ]
              }
            ]
          },
          playerActual: '$avgDamagePerMin',
          opponentActual: '$opponentAvgDamagePerMin',
          fullMark: 100,
        },
        {
          metric: 'Vision/min',
          player: {
            $cond: [
              { $eq: [{ $add: ['$avgVisionPerMin', '$opponentAvgVisionPerMin'] }, 0] },
              50,
              {
                $multiply: [
                  { $divide: ['$avgVisionPerMin', { $add: ['$avgVisionPerMin', '$opponentAvgVisionPerMin'] }] },
                  100
                ]
              }
            ]
          },
          opponent: {
            $cond: [
              { $eq: [{ $add: ['$avgVisionPerMin', '$opponentAvgVisionPerMin'] }, 0] },
              50,
              {
                $multiply: [
                  { $divide: ['$opponentAvgVisionPerMin', { $add: ['$avgVisionPerMin', '$opponentAvgVisionPerMin'] }] },
                  100
                ]
              }
            ]
          },
          playerActual: '$avgVisionPerMin',
          opponentActual: '$opponentAvgVisionPerMin',
          fullMark: 100,
        },
        {
          metric: 'Kills/game',
          player: {
            $cond: [
              { $eq: [{ $add: ['$avgKills', '$opponentAvgKills'] }, 0] },
              50,
              {
                $multiply: [
                  { $divide: ['$avgKills', { $add: ['$avgKills', '$opponentAvgKills'] }] },
                  100
                ]
              }
            ]
          },
          opponent: {
            $cond: [
              { $eq: [{ $add: ['$avgKills', '$opponentAvgKills'] }, 0] },
              50,
              {
                $multiply: [
                  { $divide: ['$opponentAvgKills', { $add: ['$avgKills', '$opponentAvgKills'] }] },
                  100
                ]
              }
            ]
          },
          playerActual: '$avgKills',
          opponentActual: '$opponentAvgKills',
          fullMark: 100,
        },
      ],
    },
  },

  // Round the spider chart values
  {
    $addFields: {
      spiderChartData: {
        $map: {
          input: '$spiderChartData',
          as: 'item',
          in: {
            metric: '$$item.metric',
            player: { $round: ['$$item.player', 2] },
            opponent: { $round: ['$$item.opponent', 2] },
            playerActual: { $round: ['$$item.playerActual', 2] },
            opponentActual: { $round: ['$$item.opponentActual', 2] },
            fullMark: '$$item.fullMark'
          }
        }
      }
    },
  },
];