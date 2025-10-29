import consola from 'consola';
import type { Document } from 'mongodb';
import { ALLOWED_QUEUE_IDS } from '@riftcoach/shared.constants';

/**
 * Optimized aggregation pipeline for champion role percentiles
 * 
 * Performance optimizations applied:
 * 1. Replaced complex $objectToArray + $filter with direct $getField access
 * 2. Combined multiple $set stages into single operations
 * 3. Added index hints for better query planning
 * 4. Moved participant unwinding before projection to reduce memory usage
 * 5. Simplified timeline data extraction using direct field access
 * 6. Pre-calculated per-minute metrics to avoid repeated calculations
 */
export const cohortChampionRolePercentilesAggregation = (params: {
  championName: string;
  role: string;
  startTs?: number;
  endTs?: number;
  winsOnly?: boolean;
  sampleLimit?: number; // default 500
  sortDesc?: boolean; // true -> newest first
}): Document[] => {
  const sampleLimit =
    typeof params.sampleLimit === 'number' ? params.sampleLimit : 500;
  const sortDirection = params.sortDesc === false ? 1 : -1;

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

  // ── Optimized pushdown: combine time + participant predicates using $elemMatch ─────
  const firstMatch: Document = {
    'info.participants': {
      $elemMatch: {
        ...(params.winsOnly ? { win: true } : {}),
        championName: params.championName,
        teamPosition: { $in: roleAliases },
      },
    },
    // Add queue filter early for better index usage
    'info.queueId': { $in: ALLOWED_QUEUE_IDS },
  };
  if (typeof params.startTs === 'number' && typeof params.endTs === 'number') {
    firstMatch['info.gameCreation'] = { $gte: params.startTs, $lt: params.endTs };
  }

  const pipeline: Document[] = [
    { $match: firstMatch },

    // Unwind and filter participants early to reduce document size
    { $unwind: '$info.participants' },
    {
      $match: {
        ...(params.winsOnly ? { 'info.participants.win': true } : {}),
        'info.participants.championName': params.championName,
        'info.participants.teamPosition': { $in: roleAliases },
      },
    },

    // Sort + Limit early (covered by compound index if created)
    { $sort: { 'info.gameCreation': sortDirection } },
    { $limit: sampleLimit },

    // Project only needed fields early to reduce memory usage
    {
      $project: {
        _id: 0,
        matchId: '$metadata.matchId',
        participantId: '$info.participants.participantId',
        gameCreation: '$info.gameCreation',
        gameDuration: '$info.gameDuration',
        participant: '$info.participants',
      },
    },

    // ── Optimized lookup with simplified timeline extraction ───────────────
    {
      $lookup: {
        from: 'timelines',
        let: {
          matchId: '$matchId',
          participantId: '$participantId',
        },
        pipeline: [
          { $match: { $expr: { $eq: ['$metadata.matchId', '$$matchId'] } } },
          // Use direct array access instead of complex $let expressions
          {
            $project: {
              _id: 0,
              // Direct field access using computed field paths
              snap10: {
                $let: {
                  vars: {
                    frame10: { $arrayElemAt: ['$info.frames', 10] },
                    pIdStr: { $toString: '$$participantId' },
                  },
                  in: {
                    $let: {
                      vars: {
                        participantFrame: {
                          $getField: {
                            field: '$$pIdStr',
                            input: { $ifNull: ['$$frame10.participantFrames', {}] },
                          },
                        },
                      },
                      in: {
                        gold: { $ifNull: ['$$participantFrame.totalGold', 0] },
                        cs: {
                          $add: [
                            { $ifNull: ['$$participantFrame.minionsKilled', 0] },
                            { $ifNull: ['$$participantFrame.jungleMinionsKilled', 0] },
                          ],
                        },
                      },
                    },
                  },
                },
              },
              snap15: {
                $let: {
                  vars: {
                    frame15: { $arrayElemAt: ['$info.frames', 15] },
                    pIdStr: { $toString: '$$participantId' },
                  },
                  in: {
                    $let: {
                      vars: {
                        participantFrame: {
                          $getField: {
                            field: '$$pIdStr',
                            input: { $ifNull: ['$$frame15.participantFrames', {}] },
                          },
                        },
                      },
                      in: {
                        gold: { $ifNull: ['$$participantFrame.totalGold', 0] },
                        cs: {
                          $add: [
                            { $ifNull: ['$$participantFrame.minionsKilled', 0] },
                            { $ifNull: ['$$participantFrame.jungleMinionsKilled', 0] },
                          ],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        ],
        as: 'timelineData',
      },
    },
    
    // Flatten timeline data
    {
      $set: {
        timeline: {
          $ifNull: [
            { $first: '$timelineData' },
            { snap10: { gold: 0, cs: 0 }, snap15: { gold: 0, cs: 0 } },
          ],
        },
      },
    },
    { $unset: 'timelineData' },

    // ── scalar metrics ──────────────────────────────────────────────────────
    {
      $set: {
        role: {
          $switch: {
            branches: [
              {
                case: { $eq: ['$participant.teamPosition', 'TOP'] },
                then: 'TOP',
              },
              {
                case: { $eq: ['$participant.teamPosition', 'JUNGLE'] },
                then: 'JUNGLE',
              },
              {
                case: {
                  $in: ['$participant.teamPosition', ['MIDDLE', 'MID']],
                },
                then: 'MIDDLE',
              },
              {
                case: {
                  $in: [
                    '$participant.teamPosition',
                    ['BOTTOM', 'ADC', 'BOT'],
                  ],
                },
                then: 'BOTTOM',
              },
              {
                case: {
                  $in: [
                    '$participant.teamPosition',
                    ['UTILITY', 'SUPPORT', 'SUP'],
                  ],
                },
                then: 'UTILITY',
              },
            ],
            default: 'UNKNOWN',
          },
        },
        _gameDurationMin: {
          $max: [1, { $divide: [{ $ifNull: ['$gameDuration', 0] }, 60] }],
        },
        // Pre-calculate per-minute metrics to avoid repeated calculations
        dpm: {
          $divide: [
            { $ifNull: ['$participant.totalDamageDealtToChampions', 0] },
            { $max: [1, { $divide: [{ $ifNull: ['$gameDuration', 0] }, 60] }] },
          ],
        },
        dtpm: {
          $divide: [
            { $ifNull: ['$participant.totalDamageTaken', 0] },
            { $max: [1, { $divide: [{ $ifNull: ['$gameDuration', 0] }, 60] }] },
          ],
        },
        kpm: {
          $divide: [
            { $ifNull: ['$participant.kills', 0] },
            { $max: [1, { $divide: [{ $ifNull: ['$gameDuration', 0] }, 60] }] },
          ],
        },
        apm: {
          $divide: [
            { $ifNull: ['$participant.assists', 0] },
            { $max: [1, { $divide: [{ $ifNull: ['$gameDuration', 0] }, 60] }] },
          ],
        },
        deathsPerMin: {
          $divide: [
            { $ifNull: ['$participant.deaths', 0] },
            { $max: [1, { $divide: [{ $ifNull: ['$gameDuration', 0] }, 60] }] },
          ],
        },
        goldAt10: '$timeline.snap10.gold',
        csAt10: '$timeline.snap10.cs',
        goldAt15: '$timeline.snap15.gold',
        csAt15: '$timeline.snap15.cs',
        cs: {
          $add: [
            { $ifNull: ['$participant.totalMinionsKilled', 0] },
            { $ifNull: ['$participant.neutralMinionsKilled', 0] },
          ],
        },
      },
    },

    // ── group & percentile accumulators (no arrays) ────────────────────────
    {
      $group: {
        _id: { champ: '$participant.championName', role: '$role' },

        // p50
        p50_kills: {
          $percentile: {
            input: '$participant.kills',
            p: [0.5],
            method: 'approximate',
          },
        },
        p50_deaths: {
          $percentile: {
            input: '$participant.deaths',
            p: [0.5],
            method: 'approximate',
          },
        },
        p50_assists: {
          $percentile: {
            input: '$participant.assists',
            p: [0.5],
            method: 'approximate',
          },
        },
        p50_cs: {
          $percentile: { input: '$cs', p: [0.5], method: 'approximate' },
        },
        p50_goldEarned: {
          $percentile: {
            input: '$participant.goldEarned',
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

        // p75
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

        // p90
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

        // p95
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
      },
    },

    // format accumulator arrays (each is [value]) to scalars
    {
      $project: {
        _id: 0,
        championName: '$_id.champ',
        role: '$_id.role',
        percentiles: {
          p50: {
            kills: { $arrayElemAt: ['$p50_kills', 0] },
            deaths: { $arrayElemAt: ['$p50_deaths', 0] },
            assists: { $arrayElemAt: ['$p50_assists', 0] },
            cs: { $arrayElemAt: ['$p50_cs', 0] },
            goldEarned: { $arrayElemAt: ['$p50_goldEarned', 0] },
            goldAt10: { $arrayElemAt: ['$p50_goldAt10', 0] },
            csAt10: { $arrayElemAt: ['$p50_csAt10', 0] },
            goldAt15: { $arrayElemAt: ['$p50_goldAt15', 0] },
            csAt15: { $arrayElemAt: ['$p50_csAt15', 0] },
            dpm: { $arrayElemAt: ['$p50_dpm', 0] },
            dtpm: { $arrayElemAt: ['$p50_dtpm', 0] },
            kpm: { $arrayElemAt: ['$p50_kpm', 0] },
            apm: { $arrayElemAt: ['$p50_apm', 0] },
            deathsPerMin: { $arrayElemAt: ['$p50_dpmDeaths', 0] },
          },
          p75: {
            kills: { $arrayElemAt: ['$p75_kills', 0] },
            deaths: { $arrayElemAt: ['$p75_deaths', 0] },
            assists: { $arrayElemAt: ['$p75_assists', 0] },
            cs: { $arrayElemAt: ['$p75_cs', 0] },
            goldEarned: { $arrayElemAt: ['$p75_goldEarned', 0] },
            goldAt10: { $arrayElemAt: ['$p75_goldAt10', 0] },
            csAt10: { $arrayElemAt: ['$p75_csAt10', 0] },
            goldAt15: { $arrayElemAt: ['$p75_goldAt15', 0] },
            csAt15: { $arrayElemAt: ['$p75_csAt15', 0] },
            dpm: { $arrayElemAt: ['$p75_dpm', 0] },
            dtpm: { $arrayElemAt: ['$p75_dtpm', 0] },
            kpm: { $arrayElemAt: ['$p75_kpm', 0] },
            apm: { $arrayElemAt: ['$p75_apm', 0] },
            deathsPerMin: { $arrayElemAt: ['$p75_dpmDeaths', 0] },
          },
          p90: {
            kills: { $arrayElemAt: ['$p90_kills', 0] },
            deaths: { $arrayElemAt: ['$p90_deaths', 0] },
            assists: { $arrayElemAt: ['$p90_assists', 0] },
            cs: { $arrayElemAt: ['$p90_cs', 0] },
            goldEarned: { $arrayElemAt: ['$p90_goldEarned', 0] },
            goldAt10: { $arrayElemAt: ['$p90_goldAt10', 0] },
            csAt10: { $arrayElemAt: ['$p90_csAt10', 0] },
            goldAt15: { $arrayElemAt: ['$p90_goldAt15', 0] },
            csAt15: { $arrayElemAt: ['$p90_csAt15', 0] },
            dpm: { $arrayElemAt: ['$p90_dpm', 0] },
            dtpm: { $arrayElemAt: ['$p90_dtpm', 0] },
            kpm: { $arrayElemAt: ['$p90_kpm', 0] },
            apm: { $arrayElemAt: ['$p90_apm', 0] },
            deathsPerMin: { $arrayElemAt: ['$p90_dpmDeaths', 0] },
          },
          p95: {
            kills: { $arrayElemAt: ['$p95_kills', 0] },
            deaths: { $arrayElemAt: ['$p95_deaths', 0] },
            assists: { $arrayElemAt: ['$p95_assists', 0] },
            cs: { $arrayElemAt: ['$p95_cs', 0] },
            goldEarned: { $arrayElemAt: ['$p95_goldEarned', 0] },
            goldAt10: { $arrayElemAt: ['$p95_goldAt10', 0] },
            csAt10: { $arrayElemAt: ['$p95_csAt10', 0] },
            goldAt15: { $arrayElemAt: ['$p95_goldAt15', 0] },
            csAt15: { $arrayElemAt: ['$p95_csAt15', 0] },
            dpm: { $arrayElemAt: ['$p95_dpm', 0] },
            dtpm: { $arrayElemAt: ['$p95_dtpm', 0] },
            kpm: { $arrayElemAt: ['$p95_kpm', 0] },
            apm: { $arrayElemAt: ['$p95_apm', 0] },
            deathsPerMin: { $arrayElemAt: ['$p95_dpmDeaths', 0] },
          },
        },
      },
    },

    { $sort: { championName: 1, role: 1 } },
  ];

  return pipeline;
};

/**
 * Aggregation options for optimal performance
 */
export const cohortChampionRolePercentilesOptions = {
  allowDiskUse: true, // Allow using disk for large datasets
  maxTimeMS: 30000, // 30 second timeout
  // Use the comprehensive compound index that includes all query fields
  hint: { 'info.participants.championName': 1, 'info.participants.teamPosition': 1, 'info.gameCreation': 1, 'info.participants.win': 1, 'info.gameDuration': 1, 'info.queueId': 1 },
};
