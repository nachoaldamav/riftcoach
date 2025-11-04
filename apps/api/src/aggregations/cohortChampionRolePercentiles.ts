import { ALLOWED_QUEUE_IDS } from '@riftcoach/shared.constants';
import type { Document } from 'mongodb';

export const cohortChampionRolePercentilesAggregation = (params: {
  championName: string;
  role: string;
  startTs?: number;
  endTs?: number;
  winsOnly?: boolean;
  sampleLimit?: number;
  sortDesc?: boolean;
  completedItemIds?: number[];
}): Document[] => {
  const sampleLimit = params.sampleLimit ?? 500;
  const sortDirection = params.sortDesc === false ? 1 : -1;
  const completedItemIds = params.completedItemIds ?? [];

  const roleAliases = (() => {
    switch (params.role) {
      case 'TOP':
        return ['TOP'];
      case 'JUNGLE':
        return ['JUNGLE'];
      case 'MIDDLE':
        return ['MIDDLE', 'MID'];
      case 'BOTTOM':
        return ['BOTTOM', 'ADC', 'BOT'];
      case 'UTILITY':
        return ['UTILITY', 'SUPPORT', 'SUP'];
      default:
        return [params.role];
    }
  })();

  const firstMatch: Document = {
    'info.queueId': { $in: ALLOWED_QUEUE_IDS },
    'info.participants': {
      $elemMatch: {
        championName: params.championName,
        teamPosition: { $in: roleAliases },
      },
    },
  };

  if (typeof params.startTs === 'number' && typeof params.endTs === 'number') {
    firstMatch['info.gameCreation'] = {
      $gte: params.startTs,
      $lt: params.endTs,
    };
  }

  const pipeline: Document[] = [
    { $match: firstMatch },
    { $sort: { 'info.gameCreation': sortDirection } },

    // Project early but keep what we need
    {
      $project: {
        matchId: '$metadata.matchId',
        gameCreation: '$info.gameCreation',
        gameDuration: '$info.gameDuration',
        participants: '$info.participants',
        // Extract participant IDs map ONCE, before unwinding
        participantIdMap: {
          $arrayToObject: {
            $map: {
              input: '$info.participants',
              as: 'p',
              in: {
                k: { $toString: '$$p.participantId' },
                v: '$$p.teamPosition',
              },
            },
          },
        },
      },
    },

    { $unwind: '$participants' },

    {
      $match: {
        'participants.championName': params.championName,
        'participants.teamPosition': { $in: roleAliases },
        ...(params.winsOnly ? { 'participants.win': true } : {}),
      },
    },

    { $limit: sampleLimit },

    // Simplified timeline lookup with minimal processing
    {
      $lookup: {
        from: 'timelines',
        let: {
          matchId: '$matchId',
          pId: '$participants.participantId',
        },
        pipeline: [
          { $match: { $expr: { $eq: ['$metadata.matchId', '$$matchId'] } } },
          {
            $project: {
              _id: 0,
              // Get frames 10 and 15 directly
              pf10: {
                $getField: {
                  field: { $toString: '$$pId' },
                  input: {
                    $getField: {
                      field: 'participantFrames',
                      input: { $arrayElemAt: ['$info.frames', 10] },
                    },
                  },
                },
              },
              pf15: {
                $getField: {
                  field: { $toString: '$$pId' },
                  input: {
                    $getField: {
                      field: 'participantFrames',
                      input: { $arrayElemAt: ['$info.frames', 15] },
                    },
                  },
                },
              },
              // Get all events up to 15 minutes in one go
              allEvents: {
                $reduce: {
                  input: { $slice: ['$info.frames', 15] },
                  initialValue: [],
                  in: {
                    $concatArrays: [
                      '$$value',
                      { $ifNull: ['$$this.events', []] },
                    ],
                  },
                },
              },
            },
          },
          {
            $project: {
              goldAt10: { $ifNull: ['$pf10.totalGold', 0] },
              csAt10: {
                $add: [
                  { $ifNull: ['$pf10.minionsKilled', 0] },
                  { $ifNull: ['$pf10.jungleMinionsKilled', 0] },
                ],
              },
              goldAt15: { $ifNull: ['$pf15.totalGold', 0] },
              csAt15: {
                $add: [
                  { $ifNull: ['$pf15.minionsKilled', 0] },
                  { $ifNull: ['$pf15.jungleMinionsKilled', 0] },
                ],
              },
              // Separate events by type for easier processing
              kills: {
                $filter: {
                  input: '$allEvents',
                  as: 'e',
                  cond: {
                    $and: [
                      { $eq: ['$$e.type', 'CHAMPION_KILL'] },
                      { $lt: ['$$e.timestamp', 900000] },
                      { $gt: ['$$e.killerId', 0] },
                    ],
                  },
                },
              },
              objectives: {
                $filter: {
                  input: '$allEvents',
                  as: 'e',
                  cond: {
                    $and: [
                      { $eq: ['$$e.type', 'ELITE_MONSTER_KILL'] },
                      {
                        $in: [
                          '$$e.monsterType',
                          [
                            'DRAGON',
                            'RIFTHERALD',
                            'BARON_NASHOR',
                            'HORDE',
                            'ATAKHAN',
                          ],
                        ],
                      },
                    ],
                  },
                },
              },
              ...(completedItemIds.length > 0
                ? {
                    items: {
                      $filter: {
                        input: '$allEvents',
                        as: 'e',
                        cond: {
                          $and: [
                            { $eq: ['$$e.type', 'ITEM_PURCHASED'] },
                            // Ensure we only consider items purchased by the current participant
                            { $eq: ['$$e.participantId', '$$pId'] },
                            { $in: ['$$e.itemId', completedItemIds] },
                            { $gte: ['$$e.timestamp', 0] },
                          ],
                        },
                      },
                    },
                  }
                : {}),
            },
          },
        ],
        as: 'tl',
      },
    },

    {
      $set: {
        tl: {
          $ifNull: [
            { $first: '$tl' },
            {
              goldAt10: 0,
              csAt10: 0,
              goldAt15: 0,
              csAt15: 0,
              kills: [],
              objectives: [],
              items: [],
            },
          ],
        },
        gameDurationMin: { $max: [1, { $divide: ['$gameDuration', 60] }] },
      },
    },

    // Calculate all metrics
    {
      $set: {
        role: {
          $switch: {
            branches: [
              {
                case: { $eq: ['$participants.teamPosition', 'TOP'] },
                then: 'TOP',
              },
              {
                case: { $eq: ['$participants.teamPosition', 'JUNGLE'] },
                then: 'JUNGLE',
              },
              {
                case: {
                  $in: ['$participants.teamPosition', ['MIDDLE', 'MID']],
                },
                then: 'MIDDLE',
              },
              {
                case: {
                  $in: ['$participants.teamPosition', ['BOTTOM', 'ADC', 'BOT']],
                },
                then: 'BOTTOM',
              },
              {
                case: {
                  $in: [
                    '$participants.teamPosition',
                    ['UTILITY', 'SUPPORT', 'SUP'],
                  ],
                },
                then: 'UTILITY',
              },
            ],
            default: 'UNKNOWN',
          },
        },
        kills: '$participants.kills',
        deaths: '$participants.deaths',
        assists: '$participants.assists',
        cs: {
          $add: [
            '$participants.totalMinionsKilled',
            '$participants.neutralMinionsKilled',
          ],
        },
        goldEarned: '$participants.goldEarned',
        goldAt10: '$tl.goldAt10',
        csAt10: '$tl.csAt10',
        goldAt15: '$tl.goldAt15',
        csAt15: '$tl.csAt15',
        dpm: {
          $divide: [
            '$participants.totalDamageDealtToChampions',
            '$gameDurationMin',
          ],
        },
        dtpm: {
          $divide: ['$participants.totalDamageTaken', '$gameDurationMin'],
        },
        kpm: { $divide: ['$participants.kills', '$gameDurationMin'] },
        apm: { $divide: ['$participants.assists', '$gameDurationMin'] },
        deathsPerMin: { $divide: ['$participants.deaths', '$gameDurationMin'] },
        cspm: {
          $divide: [
            {
              $add: [
                '$participants.totalMinionsKilled',
                '$participants.neutralMinionsKilled',
              ],
            },
            '$gameDurationMin',
          ],
        },
        firstItemCompletionTime: {
          $cond: [
            { $gt: [{ $size: { $ifNull: ['$tl.items', []] } }, 0] },
            {
              $divide: [
                {
                  $min: {
                    $map: { input: '$tl.items', as: 'i', in: '$$i.timestamp' },
                  },
                },
                1000,
              ],
            },
            null,
          ],
        },
        objectiveParticipationPct: {
          $let: {
            vars: {
              total: { $size: '$tl.objectives' },
              involved: {
                $size: {
                  $filter: {
                    input: '$tl.objectives',
                    as: 'o',
                    cond: {
                      $or: [
                        {
                          $eq: ['$$o.killerId', '$participants.participantId'],
                        },
                        {
                          $in: [
                            '$participants.participantId',
                            { $ifNull: ['$$o.assistingParticipantIds', []] },
                          ],
                        },
                      ],
                    },
                  },
                },
              },
            },
            in: {
              $cond: [
                { $gt: ['$$total', 0] },
                { $divide: ['$$involved', '$$total'] },
                null,
              ],
            },
          },
        },
        earlyGankDeathRate: {
          $cond: [
            { $eq: ['$participants.teamPosition', 'JUNGLE'] },
            null,
            {
              $cond: [
                {
                  $gt: [
                    {
                      $size: {
                        $filter: {
                          input: '$tl.kills',
                          as: 'k',
                          cond: {
                            $let: {
                              vars: {
                                killerRole: {
                                  $getField: {
                                    field: { $toString: '$$k.killerId' },
                                    input: '$participantIdMap',
                                  },
                                },
                              },
                              in: {
                                $or: [
                                  { $eq: ['$$killerRole', 'JUNGLE'] },
                                  {
                                    $ne: [
                                      '$$killerRole',
                                      '$participants.teamPosition',
                                    ],
                                  },
                                ],
                              },
                            },
                          },
                        },
                      },
                    },
                    0,
                  ],
                },
                1,
                0,
              ],
            },
          ],
        },
      },
    },

    // Project only what's needed for grouping
    {
      $project: {
        role: 1,
        kills: 1,
        deaths: 1,
        assists: 1,
        cs: 1,
        cspm: 1,
        goldEarned: 1,
        goldAt10: 1,
        csAt10: 1,
        goldAt15: 1,
        csAt15: 1,
        dpm: 1,
        dtpm: 1,
        kpm: 1,
        apm: 1,
        deathsPerMin: 1,
        firstItemCompletionTime: 1,
        objectiveParticipationPct: 1,
        earlyGankDeathRate: 1,
      },
    },

    // Single percentile calculation per metric
    {
      $group: {
        _id: '$role',
        kills_pct: {
          $percentile: {
            input: '$kills',
            p: [0.5, 0.75, 0.9, 0.95],
            method: 'approximate',
          },
        },
        deaths_pct: {
          $percentile: {
            input: '$deaths',
            p: [0.5, 0.75, 0.9, 0.95],
            method: 'approximate',
          },
        },
        assists_pct: {
          $percentile: {
            input: '$assists',
            p: [0.5, 0.75, 0.9, 0.95],
            method: 'approximate',
          },
        },
        cs_pct: {
          $percentile: {
            input: '$cs',
            p: [0.5, 0.75, 0.9, 0.95],
            method: 'approximate',
          },
        },
        cspm_pct: {
          $percentile: {
            input: '$cspm',
            p: [0.5, 0.75, 0.9, 0.95],
            method: 'approximate',
          },
        },
        goldEarned_pct: {
          $percentile: {
            input: '$goldEarned',
            p: [0.5, 0.75, 0.9, 0.95],
            method: 'approximate',
          },
        },
        goldAt10_pct: {
          $percentile: {
            input: '$goldAt10',
            p: [0.5, 0.75, 0.9, 0.95],
            method: 'approximate',
          },
        },
        csAt10_pct: {
          $percentile: {
            input: '$csAt10',
            p: [0.5, 0.75, 0.9, 0.95],
            method: 'approximate',
          },
        },
        goldAt15_pct: {
          $percentile: {
            input: '$goldAt15',
            p: [0.5, 0.75, 0.9, 0.95],
            method: 'approximate',
          },
        },
        csAt15_pct: {
          $percentile: {
            input: '$csAt15',
            p: [0.5, 0.75, 0.9, 0.95],
            method: 'approximate',
          },
        },
        dpm_pct: {
          $percentile: {
            input: '$dpm',
            p: [0.5, 0.75, 0.9, 0.95],
            method: 'approximate',
          },
        },
        dtpm_pct: {
          $percentile: {
            input: '$dtpm',
            p: [0.5, 0.75, 0.9, 0.95],
            method: 'approximate',
          },
        },
        kpm_pct: {
          $percentile: {
            input: '$kpm',
            p: [0.5, 0.75, 0.9, 0.95],
            method: 'approximate',
          },
        },
        apm_pct: {
          $percentile: {
            input: '$apm',
            p: [0.5, 0.75, 0.9, 0.95],
            method: 'approximate',
          },
        },
        deathsPerMin_pct: {
          $percentile: {
            input: '$deathsPerMin',
            p: [0.5, 0.75, 0.9, 0.95],
            method: 'approximate',
          },
        },
        firstItemCompletionTime_pct: {
          $percentile: {
            input: '$firstItemCompletionTime',
            p: [0.5, 0.75, 0.9, 0.95],
            method: 'approximate',
          },
        },
        objectiveParticipationPct_pct: {
          $percentile: {
            input: '$objectiveParticipationPct',
            p: [0.5, 0.75, 0.9, 0.95],
            method: 'approximate',
          },
        },
        earlyGankDeathRate_pct: {
          $percentile: {
            input: '$earlyGankDeathRate',
            p: [0.5, 0.75, 0.9, 0.95],
            method: 'approximate',
          },
        },
      },
    },

    // Format output (unchanged)
    {
      $project: {
        _id: 0,
        championName: params.championName,
        role: '$_id',
        percentiles: {
          p50: {
            kills: { $arrayElemAt: ['$kills_pct', 0] },
            deaths: { $arrayElemAt: ['$deaths_pct', 0] },
            assists: { $arrayElemAt: ['$assists_pct', 0] },
            cs: { $arrayElemAt: ['$cs_pct', 0] },
            cspm: { $arrayElemAt: ['$cspm_pct', 0] },
            goldEarned: { $arrayElemAt: ['$goldEarned_pct', 0] },
            goldAt10: { $arrayElemAt: ['$goldAt10_pct', 0] },
            csAt10: { $arrayElemAt: ['$csAt10_pct', 0] },
            goldAt15: { $arrayElemAt: ['$goldAt15_pct', 0] },
            csAt15: { $arrayElemAt: ['$csAt15_pct', 0] },
            dpm: { $arrayElemAt: ['$dpm_pct', 0] },
            dtpm: { $arrayElemAt: ['$dtpm_pct', 0] },
            kpm: { $arrayElemAt: ['$kpm_pct', 0] },
            apm: { $arrayElemAt: ['$apm_pct', 0] },
            deathsPerMin: { $arrayElemAt: ['$deathsPerMin_pct', 0] },
            firstItemCompletionTime: {
              $arrayElemAt: ['$firstItemCompletionTime_pct', 0],
            },
            objectiveParticipationPct: {
              $arrayElemAt: ['$objectiveParticipationPct_pct', 0],
            },
            earlyGankDeathRate: {
              $arrayElemAt: ['$earlyGankDeathRate_pct', 0],
            },
          },
          p75: {
            kills: { $arrayElemAt: ['$kills_pct', 1] },
            deaths: { $arrayElemAt: ['$deaths_pct', 1] },
            assists: { $arrayElemAt: ['$assists_pct', 1] },
            cs: { $arrayElemAt: ['$cs_pct', 1] },
            cspm: { $arrayElemAt: ['$cspm_pct', 1] },
            goldEarned: { $arrayElemAt: ['$goldEarned_pct', 1] },
            goldAt10: { $arrayElemAt: ['$goldAt10_pct', 1] },
            csAt10: { $arrayElemAt: ['$csAt10_pct', 1] },
            goldAt15: { $arrayElemAt: ['$goldAt15_pct', 1] },
            csAt15: { $arrayElemAt: ['$csAt15_pct', 1] },
            dpm: { $arrayElemAt: ['$dpm_pct', 1] },
            dtpm: { $arrayElemAt: ['$dtpm_pct', 1] },
            kpm: { $arrayElemAt: ['$kpm_pct', 1] },
            apm: { $arrayElemAt: ['$apm_pct', 1] },
            deathsPerMin: { $arrayElemAt: ['$deathsPerMin_pct', 1] },
            firstItemCompletionTime: {
              $arrayElemAt: ['$firstItemCompletionTime_pct', 1],
            },
            objectiveParticipationPct: {
              $arrayElemAt: ['$objectiveParticipationPct_pct', 1],
            },
            earlyGankDeathRate: {
              $arrayElemAt: ['$earlyGankDeathRate_pct', 1],
            },
          },
          p90: {
            kills: { $arrayElemAt: ['$kills_pct', 2] },
            deaths: { $arrayElemAt: ['$deaths_pct', 2] },
            assists: { $arrayElemAt: ['$assists_pct', 2] },
            cs: { $arrayElemAt: ['$cs_pct', 2] },
            cspm: { $arrayElemAt: ['$cspm_pct', 2] },
            goldEarned: { $arrayElemAt: ['$goldEarned_pct', 2] },
            goldAt10: { $arrayElemAt: ['$goldAt10_pct', 2] },
            csAt10: { $arrayElemAt: ['$csAt10_pct', 2] },
            goldAt15: { $arrayElemAt: ['$goldAt15_pct', 2] },
            csAt15: { $arrayElemAt: ['$csAt15_pct', 2] },
            dpm: { $arrayElemAt: ['$dpm_pct', 2] },
            dtpm: { $arrayElemAt: ['$dtpm_pct', 2] },
            kpm: { $arrayElemAt: ['$kpm_pct', 2] },
            apm: { $arrayElemAt: ['$apm_pct', 2] },
            deathsPerMin: { $arrayElemAt: ['$deathsPerMin_pct', 2] },
            firstItemCompletionTime: {
              $arrayElemAt: ['$firstItemCompletionTime_pct', 2],
            },
            objectiveParticipationPct: {
              $arrayElemAt: ['$objectiveParticipationPct_pct', 2],
            },
            earlyGankDeathRate: {
              $arrayElemAt: ['$earlyGankDeathRate_pct', 2],
            },
          },
          p95: {
            kills: { $arrayElemAt: ['$kills_pct', 3] },
            deaths: { $arrayElemAt: ['$deaths_pct', 3] },
            assists: { $arrayElemAt: ['$assists_pct', 3] },
            cs: { $arrayElemAt: ['$cs_pct', 3] },
            cspm: { $arrayElemAt: ['$cspm_pct', 3] },
            goldEarned: { $arrayElemAt: ['$goldEarned_pct', 3] },
            goldAt10: { $arrayElemAt: ['$goldAt10_pct', 3] },
            csAt10: { $arrayElemAt: ['$csAt10_pct', 3] },
            goldAt15: { $arrayElemAt: ['$goldAt15_pct', 3] },
            csAt15: { $arrayElemAt: ['$csAt15_pct', 3] },
            dpm: { $arrayElemAt: ['$dpm_pct', 3] },
            dtpm: { $arrayElemAt: ['$dtpm_pct', 3] },
            kpm: { $arrayElemAt: ['$kpm_pct', 3] },
            apm: { $arrayElemAt: ['$apm_pct', 3] },
            deathsPerMin: { $arrayElemAt: ['$deathsPerMin_pct', 3] },
            firstItemCompletionTime: {
              $arrayElemAt: ['$firstItemCompletionTime_pct', 3],
            },
            objectiveParticipationPct: {
              $arrayElemAt: ['$objectiveParticipationPct_pct', 3],
            },
            earlyGankDeathRate: {
              $arrayElemAt: ['$earlyGankDeathRate_pct', 3],
            },
          },
        },
      },
    },

    { $sort: { role: 1 } },
  ];

  return pipeline;
};

export const cohortChampionRolePercentilesOptions = {
  allowDiskUse: true,
  maxTimeMS: 60_000,
};
