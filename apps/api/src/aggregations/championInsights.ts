import { ALLOWED_QUEUE_IDS } from '@riftcoach/shared.constants';

export const championInsights = (puuid: string) => [
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
      gameMode: '$info.gameMode',
      gameType: '$info.gameType',
      player: {
        $first: {
          $filter: {
            input: '$info.participants',
            as: 'p',
            cond: { $eq: ['$$p.puuid', puuid] },
          },
        },
      },
      // Get team data for context
      team: {
        $first: {
          $filter: {
            input: '$info.teams',
            as: 't',
            cond: { 
              $eq: [
                '$$t.teamId', 
                {
                  $first: {
                    $map: {
                      input: {
                        $filter: {
                          input: '$info.participants',
                          as: 'p',
                          cond: { $eq: ['$$p.puuid', puuid] },
                        },
                      },
                      as: 'player',
                      in: '$$player.teamId',
                    },
                  },
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
    },
  },

  // Add calculated fields for each match
  {
    $addFields: {
      kda: {
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
      csPerMin: {
        $divide: [
          { $add: ['$player.totalMinionsKilled', '$player.neutralMinionsKilled'] },
          { $divide: ['$gameDuration', 60] },
        ],
      },
      goldPerMin: {
        $divide: ['$player.goldEarned', { $divide: ['$gameDuration', 60] }],
      },
      damagePerMin: {
        $divide: [
          '$player.totalDamageDealtToChampions',
          { $divide: ['$gameDuration', 60] },
        ],
      },
      visionPerMin: {
        $divide: ['$player.visionScore', { $divide: ['$gameDuration', 60] }],
      },
      killParticipation: {
        $cond: [
          { $eq: ['$team.objectives.champion.kills', 0] },
          0,
          {
            $multiply: [
              {
                $divide: [
                  { $add: ['$player.kills', '$player.assists'] },
                  '$team.objectives.champion.kills',
                ],
              },
              100,
            ],
          },
        ],
      },
      isRecent: {
        $gte: [
          '$gameCreation',
          { $subtract: [new Date().getTime(), 30 * 24 * 60 * 60 * 1000] }, // Last 30 days
        ],
      },
    },
  },

  // Group by champion to get comprehensive stats
  {
    $group: {
      _id: {
        championId: '$player.championId',
        championName: '$player.championName',
      },
      // Basic stats
      totalGames: { $sum: 1 },
      wins: { $sum: { $cond: ['$player.win', 1, 0] } },
      recentGames: { $sum: { $cond: ['$isRecent', 1, 0] } },
      recentWins: { 
        $sum: { 
          $cond: [
            { $and: ['$isRecent', '$player.win'] }, 
            1, 
            0
          ] 
        } 
      },
      
      // Performance metrics
      avgKda: { $avg: '$kda' },
      avgKills: { $avg: '$player.kills' },
      avgDeaths: { $avg: '$player.deaths' },
      avgAssists: { $avg: '$player.assists' },
      avgCsPerMin: { $avg: '$csPerMin' },
      avgGoldPerMin: { $avg: '$goldPerMin' },
      avgDamagePerMin: { $avg: '$damagePerMin' },
      avgVisionPerMin: { $avg: '$visionPerMin' },
      avgKillParticipation: { $avg: '$killParticipation' },
      
      // Consistency metrics
      kdaVariance: { $stdDevPop: '$kda' },
      csVariance: { $stdDevPop: '$csPerMin' },
      damageVariance: { $stdDevPop: '$damagePerMin' },
      
      // Peak performance
      bestKda: { $max: '$kda' },
      bestCsPerMin: { $max: '$csPerMin' },
      bestDamagePerMin: { $max: '$damagePerMin' },
      bestKillParticipation: { $max: '$killParticipation' },
      
      // Multikills and achievements
      pentaKills: { $sum: '$player.pentaKills' },
      quadraKills: { $sum: '$player.quadraKills' },
      tripleKills: { $sum: '$player.tripleKills' },
      doubleKills: { $sum: '$player.doubleKills' },
      soloKills: { $sum: '$player.soloKills' },
      largestKillingSpree: { $max: '$player.largestKillingSpree' },
      
      // Game context
      avgGameDuration: { $avg: '$gameDuration' },
      lastPlayed: { $max: '$gameCreation' },
      firstPlayed: { $min: '$gameCreation' },
      
      // Role and position data
      roles: { $addToSet: '$player.teamPosition' },
      lanes: { $addToSet: '$player.lane' },
      
      // Recent performance trend
      recentKda: {
        $avg: {
          $cond: ['$isRecent', '$kda', null],
        },
      },
      recentCsPerMin: {
        $avg: {
          $cond: ['$isRecent', '$csPerMin', null],
        },
      },
      recentDamagePerMin: {
        $avg: {
          $cond: ['$isRecent', '$damagePerMin', null],
        },
      },
    },
  },

  // Calculate final metrics and insights data
  {
    $project: {
      _id: 0,
      championId: '$_id.championId',
      championName: '$_id.championName',
      
      // Basic performance
      totalGames: 1,
      wins: 1,
      losses: { $subtract: ['$totalGames', '$wins'] },
      winRate: {
        $round: [
          { $multiply: [{ $divide: ['$wins', '$totalGames'] }, 100] },
          1,
        ],
      },
      
      // Recent performance
      recentGames: 1,
      recentWins: 1,
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
      
      // Performance metrics (rounded)
      avgKda: { $round: ['$avgKda', 2] },
      avgKills: { $round: ['$avgKills', 1] },
      avgDeaths: { $round: ['$avgDeaths', 1] },
      avgAssists: { $round: ['$avgAssists', 1] },
      avgCsPerMin: { $round: ['$avgCsPerMin', 1] },
      avgGoldPerMin: { $round: ['$avgGoldPerMin', 0] },
      avgDamagePerMin: { $round: ['$avgDamagePerMin', 0] },
      avgVisionPerMin: { $round: ['$avgVisionPerMin', 2] },
      avgKillParticipation: { $round: ['$avgKillParticipation', 1] },
      
      // Consistency scores (lower variance = more consistent)
      consistencyScore: {
        $round: [
          {
            $cond: [
              { $lt: ['$totalGames', 3] }, // Need at least 3 games for meaningful consistency
              50, // Default score for insufficient data
              {
                $subtract: [
                  100,
                  {
                    $multiply: [
                      {
                        $add: [
                          { 
                            $cond: [
                              { $or: [{ $eq: ['$kdaVariance', null] }, { $eq: ['$kdaVariance', 0] }] },
                              0,
                              { $divide: [{ $ifNull: ['$kdaVariance', 0] }, { $max: ['$avgKda', 1] }] }
                            ]
                          },
                          { 
                            $cond: [
                              { $or: [{ $eq: ['$csVariance', null] }, { $eq: ['$csVariance', 0] }] },
                              0,
                              { $divide: [{ $ifNull: ['$csVariance', 0] }, { $max: ['$avgCsPerMin', 1] }] }
                            ]
                          },
                          { 
                            $cond: [
                              { $or: [{ $eq: ['$damageVariance', null] }, { $eq: ['$damageVariance', 0] }] },
                              0,
                              { $divide: [{ $ifNull: ['$damageVariance', 0] }, { $max: ['$avgDamagePerMin', 1] }] }
                            ]
                          },
                        ],
                      },
                      10, // Scale factor
                    ],
                  },
                ],
              },
            ],
          },
          1,
        ],
      },
      
      // Peak performance
      bestKda: { $round: ['$bestKda', 2] },
      bestCsPerMin: { $round: ['$bestCsPerMin', 1] },
      bestDamagePerMin: { $round: ['$bestDamagePerMin', 0] },
      bestKillParticipation: { $round: ['$bestKillParticipation', 1] },
      
      // Achievements
      multikills: {
        pentaKills: '$pentaKills',
        quadraKills: '$quadraKills',
        tripleKills: '$tripleKills',
        doubleKills: '$doubleKills',
      },
      soloKills: 1,
      largestKillingSpree: 1,
      
      // Trends (compare recent vs overall)
      performanceTrend: {
        kdaTrend: {
          $round: [
            {
              $cond: [
                { 
                  $or: [
                    { $eq: ['$recentKda', null] }, 
                    { $eq: ['$avgKda', 0] },
                    { $eq: ['$recentGames', 0] },
                    { $lt: ['$totalGames', 3] }
                  ]
                },
                0, // No trend data available
                {
                  $multiply: [
                    { $divide: [{ $subtract: [{ $ifNull: ['$recentKda', '$avgKda'] }, '$avgKda'] }, '$avgKda'] },
                    100,
                  ],
                },
              ],
            },
            1,
          ],
        },
        csTrend: {
          $round: [
            {
              $cond: [
                { 
                  $or: [
                    { $eq: ['$recentCsPerMin', null] }, 
                    { $eq: ['$avgCsPerMin', 0] },
                    { $eq: ['$recentGames', 0] },
                    { $lt: ['$totalGames', 3] }
                  ]
                },
                0, // No trend data available
                {
                  $multiply: [
                    { $divide: [{ $subtract: [{ $ifNull: ['$recentCsPerMin', '$avgCsPerMin'] }, '$avgCsPerMin'] }, '$avgCsPerMin'] },
                    100,
                  ],
                },
              ],
            },
            1,
          ],
        },
        damageTrend: {
          $round: [
            {
              $cond: [
                { 
                  $or: [
                    { $eq: ['$recentDamagePerMin', null] }, 
                    { $eq: ['$avgDamagePerMin', 0] },
                    { $eq: ['$recentGames', 0] },
                    { $lt: ['$totalGames', 3] }
                  ]
                },
                0, // No trend data available
                {
                  $multiply: [
                    { $divide: [{ $subtract: [{ $ifNull: ['$recentDamagePerMin', '$avgDamagePerMin'] }, '$avgDamagePerMin'] }, '$avgDamagePerMin'] },
                    100,
                  ],
                },
              ],
            },
            1,
          ],
        },
      },
      
      // Context
      avgGameDuration: { $round: [{ $divide: ['$avgGameDuration', 60] }, 1] }, // Convert to minutes
      lastPlayed: 1,
      firstPlayed: 1,
      daysSinceLastPlayed: {
        $round: [
          { $divide: [{ $subtract: [new Date().getTime(), '$lastPlayed'] }, 86400000] },
          0,
        ],
      },
      roles: 1,
      lanes: 1,
      
      // Overall mastery score for AI context
      masteryScore: {
        $round: [
          {
            $multiply: [
              '$totalGames',
              {
                $add: [
                  { $divide: ['$wins', '$totalGames'] }, // Win rate factor
                  { $divide: ['$avgKda', 10] }, // KDA factor (normalized)
                  { $divide: ['$avgKillParticipation', 100] }, // KP factor
                ],
              },
            ],
          },
          2,
        ],
      },
    },
  },

  // Sort by mastery score (most played and successful champions first)
  { $sort: { masteryScore: -1 } },

  // Limit to top 10 champions for AI analysis
  { $limit: 10 },
];