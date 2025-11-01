import type { Document } from 'mongodb';
import { ALLOWED_QUEUE_IDS } from '@riftcoach/shared.constants';

export const bulkCohortChampionRolePercentilesAggregation = (params: {
  championRoles: Array<{ championName: string; role: string }>;
  winsOnly?: boolean;
  year?: number;
  sampleLimit?: number;
  sortDesc?: boolean;
  completedItemIds?: number[];
}): Document[] => {
  const {
    championRoles,
    winsOnly = false,
    year,
    sampleLimit = 500,
    sortDesc = true,
    completedItemIds = [],
  } = params;
  
  if (championRoles.length === 0) {
    return [];
  }

  // Build match conditions for all champion-role combinations
  const championRoleConditions = championRoles.map(({ championName, role }) => {
    // Normalize role → alias list
    const upper = (s: string) => s.toUpperCase();
    const roleAliases: string[] = (() => {
      const R = upper(role);
      switch (R) {
        case 'BOTTOM':
        case 'BOT':
        case 'ADC':
          return ['BOTTOM', 'BOT', 'ADC'];
        case 'UTILITY':
        case 'SUPPORT':
          return ['UTILITY', 'SUPPORT'];
        case 'MIDDLE':
        case 'MID':
          return ['MIDDLE', 'MID'];
        default:
          return [R];
      }
    })();

    return {
      $and: [
        { 'info.participants.championName': championName },
        {
          $or: [
            { 'info.participants.teamPosition': { $in: roleAliases } },
            { 'info.participants.lane': { $in: roleAliases } },
          ],
        },
        ...(winsOnly ? [{ 'info.participants.win': true }] : []),
      ],
    };
  });

  // Build the match stage
  const matchStage: Document = {
    $or: championRoleConditions,
    'info.queueId': { $in: ALLOWED_QUEUE_IDS },
  };

  // Add year filter if specified
  if (year) {
    const startOfYear = new Date(`${year}-01-01T00:00:00.000Z`).getTime();
    const endOfYear = new Date(`${year + 1}-01-01T00:00:00.000Z`).getTime();
    matchStage['info.gameCreation'] = {
      $gte: startOfYear,
      $lt: endOfYear,
    };
  }

  const sortDirection = sortDesc ? -1 : 1;

  const itemPurchaseCondition = completedItemIds.length
    ? {
        $and: [
          { $eq: ['$$e.type', 'ITEM_PURCHASED'] },
          { $in: ['$$e.itemId', completedItemIds] },
          { $gte: [{ $ifNull: ['$$e.timestamp', -1] }, 0] },
        ],
      }
    : false;

  return [
    // 1) Match documents that contain any of our champion-role combinations
    { $match: matchStage },

    // 2) Early projection to reduce document size
    {
      $project: {
        _id: 0,
        'info.gameCreation': 1,
        'info.gameDuration': 1,
        'info.participants': 1,
        'info.queueId': 1,
      },
    },

    // 3) Sort by game creation for consistent sampling
    { $sort: { 'info.gameCreation': sortDirection } },

    // 4) Unwind participants to work with individual participant records
    { $unwind: '$info.participants' },

    // 5) Filter to only the participants we care about and add role normalization
    {
      $match: {
        $expr: {
          $or: championRoles.map(({ championName, role }) => {
            const upper = (s: string) => s.toUpperCase();
            const roleAliases: string[] = (() => {
              const R = upper(role);
              switch (R) {
                case 'BOTTOM':
                case 'BOT':
                case 'ADC':
                  return ['BOTTOM', 'BOT', 'ADC'];
                case 'UTILITY':
                case 'SUPPORT':
                  return ['UTILITY', 'SUPPORT'];
                case 'MIDDLE':
                case 'MID':
                  return ['MIDDLE', 'MID'];
                default:
                  return [R];
              }
            })();

            return {
              $and: [
                { $eq: ['$info.participants.championName', championName] },
                {
                  $or: [
                    { $in: [{ $toUpper: { $ifNull: ['$info.participants.teamPosition', ''] } }, roleAliases] },
                    { $in: [{ $toUpper: { $ifNull: ['$info.participants.lane', ''] } }, roleAliases] },
                  ],
                },
                ...(winsOnly ? [{ $eq: ['$info.participants.win', true] }] : []),
              ],
            };
          }),
        },
      },
    },

    // 6) Add normalized role field for grouping
    {
      $addFields: {
        normalizedRole: {
          $switch: {
            branches: championRoles.map(({ championName, role }) => {
              const upper = (s: string) => s.toUpperCase();
              const roleAliases: string[] = (() => {
                const R = upper(role);
                switch (R) {
                  case 'BOTTOM':
                  case 'BOT':
                  case 'ADC':
                    return ['BOTTOM', 'BOT', 'ADC'];
                  case 'UTILITY':
                  case 'SUPPORT':
                    return ['UTILITY', 'SUPPORT'];
                  case 'MIDDLE':
                  case 'MID':
                    return ['MIDDLE', 'MID'];
                  default:
                    return [R];
                }
              })();

              return {
                case: {
                  $and: [
                    { $eq: ['$info.participants.championName', championName] },
                    {
                      $or: [
                        { $in: [{ $toUpper: { $ifNull: ['$info.participants.teamPosition', ''] } }, roleAliases] },
                        { $in: [{ $toUpper: { $ifNull: ['$info.participants.lane', ''] } }, roleAliases] },
                      ],
                    },
                  ],
                },
                then: role,
              };
            }),
            default: 'UNKNOWN',
          },
        },
      },
    },

    // 7) Add a rank field for sampling within each champion-role group
    {
      $setWindowFields: {
        partitionBy: {
          championName: '$info.participants.championName',
          role: '$normalizedRole',
        },
        sortBy: { 'info.gameCreation': sortDirection },
        output: {
          rank: { $rank: {} },
        },
      },
    },

    // 8) Apply sample limit early to reduce memory usage
    {
      $match: {
        rank: { $lte: sampleLimit },
      },
    },

    // 9) Lookup timeline data for minute 10 and 15 snapshots
    {
      $lookup: {
        from: 'timelines',
        let: {
          matchId: '$metadata.matchId',
        },
        as: 'timeline',
        pipeline: [
          { $match: { $expr: { $eq: ['$metadata.matchId', '$$matchId'] } } },
          { $project: { _id: 0, frames: '$info.frames' } },
          {
            $project: {
              f10: { $ifNull: [{ $arrayElemAt: ['$frames', 10] }, null] },
              f15: { $ifNull: [{ $arrayElemAt: ['$frames', 15] }, null] },
              events: {
                $let: {
                  vars: {
                    all: {
                      $reduce: {
                        input: {
                          $map: {
                            input: '$frames',
                            as: 'fr',
                            in: { $ifNull: ['$$fr.events', []] },
                          },
                        },
                        initialValue: [],
                        in: { $concatArrays: ['$$value', '$$this'] },
                      },
                    },
                  },
                  in: {
                    $filter: {
                      input: '$$all',
                      as: 'e',
                      cond: itemPurchaseCondition,
                    },
                  },
                },
              },
            },
          },
          { $project: { f10: 1, f15: 1, events: 1 } },
        ],
      },
    },

    // 10) Extract participant snapshots from timeline frames
    {
      $addFields: {
        participantId: '$info.participants.participantId',
        goldAt10: {
          $let: {
            vars: {
              frame10: { $arrayElemAt: ['$timeline.f10', 0] },
            },
            in: {
              $arrayElemAt: [
                {
                  $map: {
                    input: {
                      $objectToArray: {
                        $ifNull: ['$$frame10.participantFrames', {}],
                      },
                    },
                    as: 'pf',
                    in: {
                      $cond: [
                        { $eq: [{ $toInt: '$$pf.k' }, '$participantId'] },
                        '$$pf.v.totalGold',
                        null,
                      ],
                    },
                  },
                },
                0,
              ],
            },
          },
        },
        csAt10: {
          $let: {
            vars: {
              frame10: { $arrayElemAt: ['$timeline.f10', 0] },
            },
            in: {
              $arrayElemAt: [
                {
                  $map: {
                    input: {
                      $objectToArray: {
                        $ifNull: ['$$frame10.participantFrames', {}],
                      },
                    },
                    as: 'pf',
                    in: {
                      $cond: [
                        { $eq: [{ $toInt: '$$pf.k' }, '$participantId'] },
                        {
                          $add: [
                            '$$pf.v.minionsKilled',
                            '$$pf.v.jungleMinionsKilled',
                          ],
                        },
                        null,
                      ],
                    },
                  },
                },
                0,
              ],
            },
          },
        },
        goldAt15: {
          $let: {
            vars: {
              frame15: { $arrayElemAt: ['$timeline.f15', 0] },
            },
            in: {
              $arrayElemAt: [
                {
                  $map: {
                    input: {
                      $objectToArray: {
                        $ifNull: ['$$frame15.participantFrames', {}],
                      },
                    },
                    as: 'pf',
                    in: {
                      $cond: [
                        { $eq: [{ $toInt: '$$pf.k' }, '$participantId'] },
                        '$$pf.v.totalGold',
                        null,
                      ],
                    },
                  },
                },
                0,
              ],
            },
          },
        },
        csAt15: {
          $let: {
            vars: {
              frame15: { $arrayElemAt: ['$timeline.f15', 0] },
            },
            in: {
              $arrayElemAt: [
                {
                  $map: {
                    input: {
                      $objectToArray: {
                        $ifNull: ['$$frame15.participantFrames', {}],
                      },
                    },
                    as: 'pf',
                    in: {
                      $cond: [
                        { $eq: [{ $toInt: '$$pf.k' }, '$participantId'] },
                        {
                          $add: [
                            '$$pf.v.minionsKilled',
                            '$$pf.v.jungleMinionsKilled',
                          ],
                        },
                        null,
                      ],
                    },
                  },
                },
                0,
              ],
            },
          },
        },
      },
    },

    // 11) Compute first completed item time in seconds
    {
      $set: {
        _firstCompletedItemSeconds: completedItemIds.length
          ? {
              $let: {
                vars: {
                  purchases: {
                    $filter: {
                      input: {
                        $ifNull: [{ $first: '$timeline.events' }, []],
                      },
                      as: 'ev',
                      cond: {
                        $and: [
                          { $eq: ['$$ev.type', 'ITEM_PURCHASED'] },
                          { $eq: ['$$ev.participantId', '$participantId'] },
                          { $in: ['$$ev.itemId', completedItemIds] },
                          { $gte: [{ $ifNull: ['$$ev.timestamp', -1] }, 0] },
                        ],
                      },
                    },
                  },
                },
                in: {
                  $let: {
                    vars: {
                      earliest: {
                        $reduce: {
                          input: '$$purchases',
                          initialValue: null,
                          in: {
                            $let: {
                              vars: {
                                ts: { $ifNull: ['$$this.timestamp', null] },
                              },
                              in: {
                                $cond: [
                                  {
                                    $or: [
                                      { $eq: ['$$value', null] },
                                      {
                                        $and: [
                                          { $ne: ['$$ts', null] },
                                          { $lt: ['$$ts', '$$value'] },
                                        ],
                                      },
                                    ],
                                  },
                                  '$$ts',
                                  '$$value',
                                ],
                              },
                            },
                          },
                        },
                      },
                    },
                    in: {
                      $cond: [
                        {
                          $and: [
                            { $ne: ['$$earliest', null] },
                            {
                              $in: [
                                { $type: '$$earliest' },
                                ['double', 'int', 'long', 'decimal'],
                              ],
                            },
                          ],
                        },
                        { $divide: ['$$earliest', 1000] },
                        null,
                      ],
                    },
                  },
                },
              },
            }
          : null,
      },
    },

    // 12) Drop timeline payload (no longer needed)
    { $project: { timeline: 0 } },

    // 13) Calculate per-minute rates
    {
      $addFields: {
        gameDurationMin: { $divide: ['$info.gameDuration', 60] },
        dpm: {
          $divide: [
            '$info.participants.totalDamageDealtToChampions',
            { $divide: ['$info.gameDuration', 60] },
          ],
        },
        dtpm: {
          $divide: [
            '$info.participants.totalDamageTaken',
            { $divide: ['$info.gameDuration', 60] },
          ],
        },
        kpm: {
          $divide: [
            '$info.participants.kills',
            { $divide: ['$info.gameDuration', 60] },
          ],
        },
        apm: {
          $divide: [
            '$info.participants.assists',
            { $divide: ['$info.gameDuration', 60] },
          ],
        },
        deathsPerMin: {
          $divide: [
            '$info.participants.deaths',
            { $divide: ['$info.gameDuration', 60] },
          ],
        },
        cspm: {
          $divide: [
            {
              $add: [
                { $ifNull: ['$info.participants.totalMinionsKilled', 0] },
                { $ifNull: ['$info.participants.neutralMinionsKilled', 0] },
              ],
            },
            { $max: [1, { $divide: ['$info.gameDuration', 60] }] },
          ],
        },
        cs: {
          $add: [
            { $ifNull: ['$info.participants.totalMinionsKilled', 0] },
            { $ifNull: ['$info.participants.neutralMinionsKilled', 0] },
          ],
        },
      },
    },

    // 14) Group by champion-role and calculate percentiles
    {
      $group: {
        _id: {
          championName: '$info.participants.championName',
          role: '$normalizedRole',
        },

        // p50 percentiles
        p50_kills: {
          $percentile: {
            input: '$info.participants.kills',
            p: [0.5],
            method: 'approximate',
          },
        },
        p50_deaths: {
          $percentile: {
            input: '$info.participants.deaths',
            p: [0.5],
            method: 'approximate',
          },
        },
        p50_assists: {
          $percentile: {
            input: '$info.participants.assists',
            p: [0.5],
            method: 'approximate',
          },
        },
        p50_cs: {
          $percentile: { input: '$cs', p: [0.5], method: 'approximate' },
        },
        p50_goldEarned: {
          $percentile: {
            input: '$info.participants.goldEarned',
            p: [0.5],
            method: 'approximate',
          },
        },
        p50_goldAt10: {
          $percentile: { input: '$goldAt10', p: [0.5], method: 'approximate' },
        },
        p50_csAt10: {
          $percentile: { input: '$csAt10', p: [0.5], method: 'approximate' },
        },
        p50_goldAt15: {
          $percentile: { input: '$goldAt15', p: [0.5], method: 'approximate' },
        },
        p50_csAt15: {
          $percentile: { input: '$csAt15', p: [0.5], method: 'approximate' },
        },
        p50_dpm: {
          $percentile: { input: '$dpm', p: [0.5], method: 'approximate' },
        },
        p50_dtpm: {
          $percentile: { input: '$dtpm', p: [0.5], method: 'approximate' },
        },
        p50_kpm: {
          $percentile: { input: '$kpm', p: [0.5], method: 'approximate' },
        },
        p50_apm: {
          $percentile: { input: '$apm', p: [0.5], method: 'approximate' },
        },
        p50_dpmDeaths: {
          $percentile: {
            input: '$deathsPerMin',
            p: [0.5],
            method: 'approximate',
          },
        },
        p50_cspm: {
          $percentile: { input: '$cspm', p: [0.5], method: 'approximate' },
        },
        p50_firstItemCompletionTime: {
          $percentile: {
            input: '$_firstCompletedItemSeconds',
            p: [0.5],
            method: 'approximate',
          },
        },

        // p75 percentiles
        p75_kills: {
          $percentile: {
            input: '$info.participants.kills',
            p: [0.75],
            method: 'approximate',
          },
        },
        p75_deaths: {
          $percentile: {
            input: '$info.participants.deaths',
            p: [0.75],
            method: 'approximate',
          },
        },
        p75_assists: {
          $percentile: {
            input: '$info.participants.assists',
            p: [0.75],
            method: 'approximate',
          },
        },
        p75_cs: {
          $percentile: { input: '$cs', p: [0.75], method: 'approximate' },
        },
        p75_goldEarned: {
          $percentile: {
            input: '$info.participants.goldEarned',
            p: [0.75],
            method: 'approximate',
          },
        },
        p75_goldAt10: {
          $percentile: { input: '$goldAt10', p: [0.75], method: 'approximate' },
        },
        p75_csAt10: {
          $percentile: { input: '$csAt10', p: [0.75], method: 'approximate' },
        },
        p75_goldAt15: {
          $percentile: { input: '$goldAt15', p: [0.75], method: 'approximate' },
        },
        p75_csAt15: {
          $percentile: { input: '$csAt15', p: [0.75], method: 'approximate' },
        },
        p75_dpm: {
          $percentile: { input: '$dpm', p: [0.75], method: 'approximate' },
        },
        p75_dtpm: {
          $percentile: { input: '$dtpm', p: [0.75], method: 'approximate' },
        },
        p75_kpm: {
          $percentile: { input: '$kpm', p: [0.75], method: 'approximate' },
        },
        p75_apm: {
          $percentile: { input: '$apm', p: [0.75], method: 'approximate' },
        },
        p75_dpmDeaths: {
          $percentile: {
            input: '$deathsPerMin',
            p: [0.75],
            method: 'approximate',
          },
        },
        p75_cspm: {
          $percentile: { input: '$cspm', p: [0.75], method: 'approximate' },
        },
        p75_firstItemCompletionTime: {
          $percentile: {
            input: '$_firstCompletedItemSeconds',
            p: [0.75],
            method: 'approximate',
          },
        },

        // p90 percentiles
        p90_kills: {
          $percentile: {
            input: '$info.participants.kills',
            p: [0.9],
            method: 'approximate',
          },
        },
        p90_deaths: {
          $percentile: {
            input: '$info.participants.deaths',
            p: [0.9],
            method: 'approximate',
          },
        },
        p90_assists: {
          $percentile: {
            input: '$info.participants.assists',
            p: [0.9],
            method: 'approximate',
          },
        },
        p90_cs: {
          $percentile: { input: '$cs', p: [0.9], method: 'approximate' },
        },
        p90_goldEarned: {
          $percentile: {
            input: '$info.participants.goldEarned',
            p: [0.9],
            method: 'approximate',
          },
        },
        p90_goldAt10: {
          $percentile: { input: '$goldAt10', p: [0.9], method: 'approximate' },
        },
        p90_csAt10: {
          $percentile: { input: '$csAt10', p: [0.9], method: 'approximate' },
        },
        p90_goldAt15: {
          $percentile: { input: '$goldAt15', p: [0.9], method: 'approximate' },
        },
        p90_csAt15: {
          $percentile: { input: '$csAt15', p: [0.9], method: 'approximate' },
        },
        p90_dpm: {
          $percentile: { input: '$dpm', p: [0.9], method: 'approximate' },
        },
        p90_dtpm: {
          $percentile: { input: '$dtpm', p: [0.9], method: 'approximate' },
        },
        p90_kpm: {
          $percentile: { input: '$kpm', p: [0.9], method: 'approximate' },
        },
        p90_apm: {
          $percentile: { input: '$apm', p: [0.9], method: 'approximate' },
        },
        p90_dpmDeaths: {
          $percentile: {
            input: '$deathsPerMin',
            p: [0.9],
            method: 'approximate',
          },
        },
        p90_cspm: {
          $percentile: { input: '$cspm', p: [0.9], method: 'approximate' },
        },
        p90_firstItemCompletionTime: {
          $percentile: {
            input: '$_firstCompletedItemSeconds',
            p: [0.9],
            method: 'approximate',
          },
        },

        // p95 percentiles
        p95_kills: {
          $percentile: {
            input: '$info.participants.kills',
            p: [0.95],
            method: 'approximate',
          },
        },
        p95_deaths: {
          $percentile: {
            input: '$info.participants.deaths',
            p: [0.95],
            method: 'approximate',
          },
        },
        p95_assists: {
          $percentile: {
            input: '$info.participants.assists',
            p: [0.95],
            method: 'approximate',
          },
        },
        p95_cs: {
          $percentile: { input: '$cs', p: [0.95], method: 'approximate' },
        },
        p95_goldEarned: {
          $percentile: {
            input: '$info.participants.goldEarned',
            p: [0.95],
            method: 'approximate',
          },
        },
        p95_goldAt10: {
          $percentile: { input: '$goldAt10', p: [0.95], method: 'approximate' },
        },
        p95_csAt10: {
          $percentile: { input: '$csAt10', p: [0.95], method: 'approximate' },
        },
        p95_goldAt15: {
          $percentile: { input: '$goldAt15', p: [0.95], method: 'approximate' },
        },
        p95_csAt15: {
          $percentile: { input: '$csAt15', p: [0.95], method: 'approximate' },
        },
        p95_dpm: {
          $percentile: { input: '$dpm', p: [0.95], method: 'approximate' },
        },
        p95_dtpm: {
          $percentile: { input: '$dtpm', p: [0.95], method: 'approximate' },
        },
        p95_kpm: {
          $percentile: { input: '$kpm', p: [0.95], method: 'approximate' },
        },
        p95_apm: {
          $percentile: { input: '$apm', p: [0.95], method: 'approximate' },
        },
        p95_dpmDeaths: {
          $percentile: {
            input: '$deathsPerMin',
            p: [0.95],
            method: 'approximate',
          },
        },
        p95_cspm: {
          $percentile: { input: '$cspm', p: [0.95], method: 'approximate' },
        },
        p95_firstItemCompletionTime: {
          $percentile: {
            input: '$_firstCompletedItemSeconds',
            p: [0.95],
            method: 'approximate',
          },
        },
      },
    },

    // 15) Final projection to match expected output format
    {
      $project: {
        _id: 0,
        championName: '$_id.championName',
        role: '$_id.role',
        percentiles: {
          p50: {
            kills: { $arrayElemAt: ['$p50_kills', 0] },
            deaths: { $arrayElemAt: ['$p50_deaths', 0] },
            assists: { $arrayElemAt: ['$p50_assists', 0] },
            cs: { $arrayElemAt: ['$p50_cs', 0] },
            cspm: { $arrayElemAt: ['$p50_cspm', 0] },
            goldEarned: { $arrayElemAt: ['$p50_goldEarned', 0] },
            goldAt10: { $arrayElemAt: ['$p50_goldAt10', 0] },
            csAt10: { $arrayElemAt: ['$p50_csAt10', 0] },
            goldAt15: { $arrayElemAt: ['$p50_goldAt15', 0] },
            csAt15: { $arrayElemAt: ['$p50_csAt15', 0] },
            dpm: { $arrayElemAt: ['$p50_dpm', 0] },
            dtpm: { $arrayElemAt: ['$p50_dtpm', 0] },
            kpm: { $arrayElemAt: ['$p50_kpm', 0] },
            apm: { $arrayElemAt: ['$p50_apm', 0] },
            dpmDeaths: { $arrayElemAt: ['$p50_dpmDeaths', 0] },
            firstItemCompletionTime: {
              $arrayElemAt: ['$p50_firstItemCompletionTime', 0],
            },
          },
          p75: {
            kills: { $arrayElemAt: ['$p75_kills', 0] },
            deaths: { $arrayElemAt: ['$p75_deaths', 0] },
            assists: { $arrayElemAt: ['$p75_assists', 0] },
            cs: { $arrayElemAt: ['$p75_cs', 0] },
            cspm: { $arrayElemAt: ['$p75_cspm', 0] },
            goldEarned: { $arrayElemAt: ['$p75_goldEarned', 0] },
            goldAt10: { $arrayElemAt: ['$p75_goldAt10', 0] },
            csAt10: { $arrayElemAt: ['$p75_csAt10', 0] },
            goldAt15: { $arrayElemAt: ['$p75_goldAt15', 0] },
            csAt15: { $arrayElemAt: ['$p75_csAt15', 0] },
            dpm: { $arrayElemAt: ['$p75_dpm', 0] },
            dtpm: { $arrayElemAt: ['$p75_dtpm', 0] },
            kpm: { $arrayElemAt: ['$p75_kpm', 0] },
            apm: { $arrayElemAt: ['$p75_apm', 0] },
            dpmDeaths: { $arrayElemAt: ['$p75_dpmDeaths', 0] },
            firstItemCompletionTime: {
              $arrayElemAt: ['$p75_firstItemCompletionTime', 0],
            },
          },
          p90: {
            kills: { $arrayElemAt: ['$p90_kills', 0] },
            deaths: { $arrayElemAt: ['$p90_deaths', 0] },
            assists: { $arrayElemAt: ['$p90_assists', 0] },
            cs: { $arrayElemAt: ['$p90_cs', 0] },
            cspm: { $arrayElemAt: ['$p90_cspm', 0] },
            goldEarned: { $arrayElemAt: ['$p90_goldEarned', 0] },
            goldAt10: { $arrayElemAt: ['$p90_goldAt10', 0] },
            csAt10: { $arrayElemAt: ['$p90_csAt10', 0] },
            goldAt15: { $arrayElemAt: ['$p90_goldAt15', 0] },
            csAt15: { $arrayElemAt: ['$p90_csAt15', 0] },
            dpm: { $arrayElemAt: ['$p90_dpm', 0] },
            dtpm: { $arrayElemAt: ['$p90_dtpm', 0] },
            kpm: { $arrayElemAt: ['$p90_kpm', 0] },
            apm: { $arrayElemAt: ['$p90_apm', 0] },
            dpmDeaths: { $arrayElemAt: ['$p90_dpmDeaths', 0] },
            firstItemCompletionTime: {
              $arrayElemAt: ['$p90_firstItemCompletionTime', 0],
            },
          },
          p95: {
            kills: { $arrayElemAt: ['$p95_kills', 0] },
            deaths: { $arrayElemAt: ['$p95_deaths', 0] },
            assists: { $arrayElemAt: ['$p95_assists', 0] },
            cs: { $arrayElemAt: ['$p95_cs', 0] },
            cspm: { $arrayElemAt: ['$p95_cspm', 0] },
            goldEarned: { $arrayElemAt: ['$p95_goldEarned', 0] },
            goldAt10: { $arrayElemAt: ['$p95_goldAt10', 0] },
            csAt10: { $arrayElemAt: ['$p95_csAt10', 0] },
            goldAt15: { $arrayElemAt: ['$p95_goldAt15', 0] },
            csAt15: { $arrayElemAt: ['$p95_csAt15', 0] },
            dpm: { $arrayElemAt: ['$p95_dpm', 0] },
            dtpm: { $arrayElemAt: ['$p95_dtpm', 0] },
            kpm: { $arrayElemAt: ['$p95_kpm', 0] },
            apm: { $arrayElemAt: ['$p95_apm', 0] },
            dpmDeaths: { $arrayElemAt: ['$p95_dpmDeaths', 0] },
            firstItemCompletionTime: {
              $arrayElemAt: ['$p95_firstItemCompletionTime', 0],
            },
          },
        },
      },
    },
  ];
};