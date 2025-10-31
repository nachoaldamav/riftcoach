import type { Document } from 'mongodb';

/**
 * Aggregation: per-player, per-champion, per-role averages + percentiles
 * - Filters matches to the given player's puuid, championName, and normalized role
 * - Computes averages for key metrics
 * - Computes percentiles (p50, p75, p90, p95) for distribution-oriented metrics
 */
export const playerChampRolePercentilesAggregation = (
  puuid: string,
  championName: string,
  role: string,
): Document[] => [
  // 1) Index‑friendly match on participant PUUID
  {
    $match: {
      'info.participants.puuid': puuid,
    },
  },

  // 2) Unwind participants and select this player
  { $unwind: '$info.participants' },
  {
    $match: {
      'info.participants.puuid': puuid,
    },
  },

  // 3) Lookup timeline by matchId for minute snapshots
  {
    $lookup: {
      from: 'timelines',
      localField: 'metadata.matchId',
      foreignField: 'metadata.matchId',
      as: 'tl',
    },
  },

  // 4) Normalize role and helpers
  {
    $set: {
      role: {
        $switch: {
          branches: [
            { case: { $eq: ['$info.participants.teamPosition', 'TOP'] }, then: 'TOP' },
            { case: { $eq: ['$info.participants.teamPosition', 'JUNGLE'] }, then: 'JUNGLE' },
            { case: { $in: ['$info.participants.teamPosition', ['MIDDLE', 'MID']] }, then: 'MIDDLE' },
            { case: { $in: ['$info.participants.teamPosition', ['BOTTOM', 'ADC', 'BOT']] }, then: 'BOTTOM' },
            { case: { $in: ['$info.participants.teamPosition', ['UTILITY', 'SUPPORT', 'SUP']] }, then: 'UTILITY' },
          ],
          default: 'UNKNOWN',
        },
      },
      _frames: {
        $ifNull: [ { $arrayElemAt: ['$tl.info.frames', 0] }, [] ],
      },
      _pId: '$info.participants.participantId',
    },
  },

  // 5) Filter champion+role
  {
    $match: {
      'info.participants.championName': championName,
      role,
    },
  },

  // 6) Extract minute 10 & 15 snapshots
  {
    $set: {
      _at10: {
        $let: {
          vars: {
            f: { $ifNull: [{ $arrayElemAt: ['$_frames', 10] }, {}] },
            p: { $toString: '$_pId' },
          },
          in: {
            $let: {
              vars: {
                pf: {
                  $first: {
                    $filter: {
                      input: { $ifNull: [{ $objectToArray: '$$f.participantFrames' }, []] },
                      as: 'kv',
                      cond: { $eq: ['$$kv.k', '$$p'] },
                    },
                  },
                },
              },
              in: {
                gold: { $ifNull: ['$$pf.v.totalGold', 0] },
                cs: {
                  $add: [
                    { $ifNull: ['$$pf.v.minionsKilled', 0] },
                    { $ifNull: ['$$pf.v.jungleMinionsKilled', 0] },
                  ],
                },
              },
            },
          },
        },
      },
      _at15: {
        $let: {
          vars: {
            f: { $ifNull: [{ $arrayElemAt: ['$_frames', 15] }, {}] },
            p: { $toString: '$_pId' },
          },
          in: {
            $let: {
              vars: {
                pf: {
                  $first: {
                    $filter: {
                      input: { $ifNull: [{ $objectToArray: '$$f.participantFrames' }, []] },
                      as: 'kv',
                      cond: { $eq: ['$$kv.k', '$$p'] },
                    },
                  },
                },
              },
              in: {
                gold: { $ifNull: ['$$pf.v.totalGold', 0] },
                cs: {
                  $add: [
                    { $ifNull: ['$$pf.v.minionsKilled', 0] },
                    { $ifNull: ['$$pf.v.jungleMinionsKilled', 0] },
                  ],
                },
              },
            },
          },
        },
      },
    },
  },

  // 7) Compute per-minute rates
  {
    $set: {
      _gameDurationMin: {
        $max: [
          1,
          { $divide: [{ $ifNull: ['$info.gameDuration', 0] }, 60] },
        ],
      },
    },
  },
  {
    $set: {
      dpm: {
        $divide: [
          { $ifNull: ['$info.participants.totalDamageDealtToChampions', 0] },
          '$_gameDurationMin',
        ],
      },
      dtpm: {
        $divide: [
          { $ifNull: ['$info.participants.totalDamageTaken', 0] },
          '$_gameDurationMin',
        ],
      },
      kpm: {
        $divide: [
          { $ifNull: ['$info.participants.kills', 0] },
          '$_gameDurationMin',
        ],
      },
      apm: {
        $divide: [
          { $ifNull: ['$info.participants.assists', 0] },
          '$_gameDurationMin',
        ],
      },
      deathsPerMin: {
        $divide: [
          { $ifNull: ['$info.participants.deaths', 0] },
          '$_gameDurationMin',
        ],
      },
    },
  },

  // 8) Group to build arrays + averages
  {
    $group: {
      _id: {
        champ: '$info.participants.championName',
        role: '$role',
      },
      totalMatches: { $sum: 1 },
      wins: { $sum: { $cond: ['$info.participants.win', 1, 0] } },

      killsArr: { $push: { $ifNull: ['$info.participants.kills', 0] } },
      deathsArr: { $push: { $ifNull: ['$info.participants.deaths', 0] } },
      assistsArr: { $push: { $ifNull: ['$info.participants.assists', 0] } },
      csArr: {
        $push: {
          $add: [
            { $ifNull: ['$info.participants.totalMinionsKilled', 0] },
            { $ifNull: ['$info.participants.neutralMinionsKilled', 0] },
          ],
        },
      },
      goldEarnedArr: { $push: { $ifNull: ['$info.participants.goldEarned', 0] } },

      goldAt10Arr: { $push: { $ifNull: ['$_at10.gold', 0] } },
      csAt10Arr: { $push: { $ifNull: ['$_at10.cs', 0] } },
      goldAt15Arr: { $push: { $ifNull: ['$_at15.gold', 0] } },
      csAt15Arr: { $push: { $ifNull: ['$_at15.cs', 0] } },

      dpmArr: { $push: { $ifNull: ['$dpm', 0] } },
      dtpmArr: { $push: { $ifNull: ['$dtpm', 0] } },
      kpmArr: { $push: { $ifNull: ['$kpm', 0] } },
      apmArr: { $push: { $ifNull: ['$apm', 0] } },
      deathsPerMinArr: { $push: { $ifNull: ['$deathsPerMin', 0] } },

      avgKills: { $avg: '$info.participants.kills' },
      avgDeaths: { $avg: '$info.participants.deaths' },
      avgAssists: { $avg: '$info.participants.assists' },
      avgGoldEarned: { $avg: '$info.participants.goldEarned' },
      avgCS: {
        $avg: {
          $add: [
            { $ifNull: ['$info.participants.totalMinionsKilled', 0] },
            { $ifNull: ['$info.participants.neutralMinionsKilled', 0] },
          ],
        },
      },
      avgGoldAt10: { $avg: '$_at10.gold' },
      avgCsAt10: { $avg: '$_at10.cs' },
      avgGoldAt15: { $avg: '$_at15.gold' },
      avgCsAt15: { $avg: '$_at15.cs' },
      avgDpm: { $avg: '$dpm' },
      avgDtpm: { $avg: '$dtpm' },
      avgKpm: { $avg: '$kpm' },
      avgApm: { $avg: '$apm' },
      avgDeathsPerMin: { $avg: '$deathsPerMin' },
    },
  },

  // 9) Final projection with percentiles
  {
    $project: {
      _id: 0,
      championName: '$_id.champ',
      role: '$_id.role',
      totalMatches: 1,
      wins: 1,
      losses: { $subtract: ['$totalMatches', '$wins'] },
      winRate: { $cond: [{ $gt: ['$totalMatches', 0] }, { $divide: ['$wins', '$totalMatches'] }, 0] },
      kda: {
        $divide: [
          { $add: ['$avgKills', '$avgAssists'] },
          { $max: [1, '$avgDeaths'] },
        ],
      },

      avgKills: { $round: ['$avgKills', 2] },
      avgDeaths: { $round: ['$avgDeaths', 2] },
      avgAssists: { $round: ['$avgAssists', 2] },
      avgGoldEarned: { $round: ['$avgGoldEarned', 0] },
      avgCS: { $round: ['$avgCS', 1] },
      avgGoldAt10: { $round: ['$avgGoldAt10', 0] },
      avgCsAt10: { $round: ['$avgCsAt10', 1] },
      avgGoldAt15: { $round: ['$avgGoldAt15', 0] },
      avgCsAt15: { $round: ['$avgCsAt15', 1] },
      avgDpm: { $round: ['$avgDpm', 1] },
      avgDtpm: { $round: ['$avgDtpm', 1] },
      avgKpm: { $round: ['$avgKpm', 3] },
      avgApm: { $round: ['$avgApm', 3] },
      avgDeathsPerMin: { $round: ['$avgDeathsPerMin', 3] },

      percentiles: {
        p50: {
          kills: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$killsArr', p: [0.5], method: 'approximate' } }, 0 ] },
              2,
            ],
          },
          deaths: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$deathsArr', p: [0.5], method: 'approximate' } }, 0 ] },
              2,
            ],
          },
          assists: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$assistsArr', p: [0.5], method: 'approximate' } }, 0 ] },
              2,
            ],
          },
          cs: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$csArr', p: [0.5], method: 'approximate' } }, 0 ] },
              1,
            ],
          },
          goldEarned: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$goldEarnedArr', p: [0.5], method: 'approximate' } }, 0 ] },
              0,
            ],
          },
          goldAt10: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$goldAt10Arr', p: [0.5], method: 'approximate' } }, 0 ] },
              0,
            ],
          },
          csAt10: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$csAt10Arr', p: [0.5], method: 'approximate' } }, 0 ] },
              1,
            ],
          },
          goldAt15: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$goldAt15Arr', p: [0.5], method: 'approximate' } }, 0 ] },
              0,
            ],
          },
          csAt15: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$csAt15Arr', p: [0.5], method: 'approximate' } }, 0 ] },
              1,
            ],
          },
          dpm: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$dpmArr', p: [0.5], method: 'approximate' } }, 0 ] },
              1,
            ],
          },
          dtpm: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$dtpmArr', p: [0.5], method: 'approximate' } }, 0 ] },
              1,
            ],
          },
          kpm: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$kpmArr', p: [0.5], method: 'approximate' } }, 0 ] },
              3,
            ],
          },
          apm: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$apmArr', p: [0.5], method: 'approximate' } }, 0 ] },
              3,
            ],
          },
          deathsPerMin: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$deathsPerMinArr', p: [0.5], method: 'approximate' } }, 0 ] },
              3,
            ],
          },
        },
        p75: {
          kills: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$killsArr', p: [0.75], method: 'approximate' } }, 0 ] },
              2,
            ],
          },
          deaths: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$deathsArr', p: [0.75], method: 'approximate' } }, 0 ] },
              2,
            ],
          },
          assists: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$assistsArr', p: [0.75], method: 'approximate' } }, 0 ] },
              2,
            ],
          },
          cs: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$csArr', p: [0.75], method: 'approximate' } }, 0 ] },
              1,
            ],
          },
          goldEarned: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$goldEarnedArr', p: [0.75], method: 'approximate' } }, 0 ] },
              0,
            ],
          },
          goldAt10: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$goldAt10Arr', p: [0.75], method: 'approximate' } }, 0 ] },
              0,
            ],
          },
          csAt10: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$csAt10Arr', p: [0.75], method: 'approximate' } }, 0 ] },
              1,
            ],
          },
          goldAt15: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$goldAt15Arr', p: [0.75], method: 'approximate' } }, 0 ] },
              0,
            ],
          },
          csAt15: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$csAt15Arr', p: [0.75], method: 'approximate' } }, 0 ] },
              1,
            ],
          },
          dpm: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$dpmArr', p: [0.75], method: 'approximate' } }, 0 ] },
              1,
            ],
          },
          dtpm: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$dtpmArr', p: [0.75], method: 'approximate' } }, 0 ] },
              1,
            ],
          },
          kpm: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$kpmArr', p: [0.75], method: 'approximate' } }, 0 ] },
              3,
            ],
          },
          apm: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$apmArr', p: [0.75], method: 'approximate' } }, 0 ] },
              3,
            ],
          },
          deathsPerMin: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$deathsPerMinArr', p: [0.75], method: 'approximate' } }, 0 ] },
              3,
            ],
          },
        },
        p90: {
          kills: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$killsArr', p: [0.9], method: 'approximate' } }, 0 ] },
              2,
            ],
          },
          deaths: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$deathsArr', p: [0.9], method: 'approximate' } }, 0 ] },
              2,
            ],
          },
          assists: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$assistsArr', p: [0.9], method: 'approximate' } }, 0 ] },
              2,
            ],
          },
          cs: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$csArr', p: [0.9], method: 'approximate' } }, 0 ] },
              1,
            ],
          },
          goldEarned: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$goldEarnedArr', p: [0.9], method: 'approximate' } }, 0 ] },
              0,
            ],
          },
          goldAt10: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$goldAt10Arr', p: [0.9], method: 'approximate' } }, 0 ] },
              0,
            ],
          },
          csAt10: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$csAt10Arr', p: [0.9], method: 'approximate' } }, 0 ] },
              1,
            ],
          },
          goldAt15: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$goldAt15Arr', p: [0.9], method: 'approximate' } }, 0 ] },
              0,
            ],
          },
          csAt15: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$csAt15Arr', p: [0.9], method: 'approximate' } }, 0 ] },
              1,
            ],
          },
          dpm: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$dpmArr', p: [0.9], method: 'approximate' } }, 0 ] },
              1,
            ],
          },
          dtpm: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$dtpmArr', p: [0.9], method: 'approximate' } }, 0 ] },
              1,
            ],
          },
          kpm: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$kpmArr', p: [0.9], method: 'approximate' } }, 0 ] },
              3,
            ],
          },
          apm: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$apmArr', p: [0.9], method: 'approximate' } }, 0 ] },
              3,
            ],
          },
          deathsPerMin: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$deathsPerMinArr', p: [0.9], method: 'approximate' } }, 0 ] },
              3,
            ],
          },
        },
        p95: {
          kills: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$killsArr', p: [0.95], method: 'approximate' } }, 0 ] },
              2,
            ],
          },
          deaths: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$deathsArr', p: [0.95], method: 'approximate' } }, 0 ] },
              2,
            ],
          },
          assists: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$assistsArr', p: [0.95], method: 'approximate' } }, 0 ] },
              2,
            ],
          },
          cs: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$csArr', p: [0.95], method: 'approximate' } }, 0 ] },
              1,
            ],
          },
          goldEarned: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$goldEarnedArr', p: [0.95], method: 'approximate' } }, 0 ] },
              0,
            ],
          },
          goldAt10: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$goldAt10Arr', p: [0.95], method: 'approximate' } }, 0 ] },
              0,
            ],
          },
          csAt10: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$csAt10Arr', p: [0.95], method: 'approximate' } }, 0 ] },
              1,
            ],
          },
          goldAt15: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$goldAt15Arr', p: [0.95], method: 'approximate' } }, 0 ] },
              0,
            ],
          },
          csAt15: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$csAt15Arr', p: [0.95], method: 'approximate' } }, 0 ] },
              1,
            ],
          },
          dpm: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$dpmArr', p: [0.95], method: 'approximate' } }, 0 ] },
              1,
            ],
          },
          dtpm: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$dtpmArr', p: [0.95], method: 'approximate' } }, 0 ] },
              1,
            ],
          },
          kpm: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$kpmArr', p: [0.95], method: 'approximate' } }, 0 ] },
              3,
            ],
          },
          apm: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$apmArr', p: [0.95], method: 'approximate' } }, 0 ] },
              3,
            ],
          },
          deathsPerMin: {
            $round: [
              { $arrayElemAt: [ { $percentile: { input: '$deathsPerMinArr', p: [0.95], method: 'approximate' } }, 0 ] },
              3,
            ],
          },
        },
      },
    },
  },

  // 10) Sort for stable ordering (single doc)
  { $sort: { championName: 1, role: 1 } },
];