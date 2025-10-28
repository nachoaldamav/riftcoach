import consola from 'consola';
import type { Document } from 'mongodb';

export const cohortChampionRolePercentilesAggregation = (opts: {
  championName: string;
  role: string;
  startTs?: number;
  endTs?: number;
  winsOnly?: boolean;
  sampleLimit?: number; // default 500
  sortDesc?: boolean; // true -> newest first
}): Document[] => {
  const sampleLimit =
    typeof opts.sampleLimit === 'number' ? opts.sampleLimit : 500;
  const sortDirection = opts.sortDesc === false ? 1 : -1;

  const roleAliases = (() => {
    switch (opts.role) {
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
        return [opts.role];
    }
  })();

  // ── Pushdown: combine time + participant predicates using $elemMatch ─────
  const firstMatch: Document = {
    'info.participants': {
      $elemMatch: {
        ...(opts.winsOnly ? { win: true } : {}),
        championName: opts.championName,
        teamPosition: { $in: roleAliases },
      },
    },
  };
  if (typeof opts.startTs === 'number' && typeof opts.endTs === 'number') {
    firstMatch['info.gameCreation'] = { $gte: opts.startTs, $lt: opts.endTs };
  }

  const pipeline: Document[] = [
    { $match: firstMatch },

    // Unwind and re-check exact participant (guards against other array elems)
    { $unwind: '$info.participants' },
    {
      $match: {
        ...(opts.winsOnly ? { 'info.participants.win': true } : {}),
        'info.participants.championName': opts.championName,
        'info.participants.teamPosition': { $in: roleAliases },
      },
    },

    // Sort + Limit early (covered by compound index if created)
    { $sort: { 'info.gameCreation': sortDirection } },
    { $limit: sampleLimit },

    // ── pull only needed frame snapshots for this participant ───────────────
    {
      $lookup: {
        from: 'timelines',
        let: {
          matchId: '$metadata.matchId',
          pIdStr: { $toString: '$info.participants.participantId' },
        },
        pipeline: [
          { $match: { $expr: { $eq: ['$metadata.matchId', '$$matchId'] } } },
          {
            $project: {
              _id: 0,
              f10: { $ifNull: [{ $arrayElemAt: ['$info.frames', 10] }, null] },
              f15: { $ifNull: [{ $arrayElemAt: ['$info.frames', 15] }, null] },
            },
          },
          {
            $project: {
              snap10: {
                $let: {
                  vars: {
                    kv: {
                      $first: {
                        $filter: {
                          input: {
                            $objectToArray: {
                              $ifNull: ['$f10.participantFrames', {}],
                            },
                          },
                          as: 'kv',
                          cond: { $eq: ['$$kv.k', '$$pIdStr'] },
                        },
                      },
                    },
                  },
                  in: {
                    gold: { $ifNull: ['$$kv.v.totalGold', 0] },
                    cs: {
                      $add: [
                        { $ifNull: ['$$kv.v.minionsKilled', 0] },
                        { $ifNull: ['$$kv.v.jungleMinionsKilled', 0] },
                      ],
                    },
                  },
                },
              },
              snap15: {
                $let: {
                  vars: {
                    kv: {
                      $first: {
                        $filter: {
                          input: {
                            $objectToArray: {
                              $ifNull: ['$f15.participantFrames', {}],
                            },
                          },
                          as: 'kv',
                          cond: { $eq: ['$$kv.k', '$$pIdStr'] },
                        },
                      },
                    },
                  },
                  in: {
                    gold: { $ifNull: ['$$kv.v.totalGold', 0] },
                    cs: {
                      $add: [
                        { $ifNull: ['$$kv.v.minionsKilled', 0] },
                        { $ifNull: ['$$kv.v.jungleMinionsKilled', 0] },
                      ],
                    },
                  },
                },
              },
            },
          },
        ],
        as: 'snap',
      },
    },
    {
      $set: {
        _snap: {
          $ifNull: [
            { $first: '$snap' },
            { snap10: { gold: 0, cs: 0 }, snap15: { gold: 0, cs: 0 } },
          ],
        },
      },
    },
    { $project: { snap: 0 } }, // drop lookup array asap

    // ── scalar metrics ──────────────────────────────────────────────────────
    {
      $set: {
        role: {
          $switch: {
            branches: [
              {
                case: { $eq: ['$info.participants.teamPosition', 'TOP'] },
                then: 'TOP',
              },
              {
                case: { $eq: ['$info.participants.teamPosition', 'JUNGLE'] },
                then: 'JUNGLE',
              },
              {
                case: {
                  $in: ['$info.participants.teamPosition', ['MIDDLE', 'MID']],
                },
                then: 'MIDDLE',
              },
              {
                case: {
                  $in: [
                    '$info.participants.teamPosition',
                    ['BOTTOM', 'ADC', 'BOT'],
                  ],
                },
                then: 'BOTTOM',
              },
              {
                case: {
                  $in: [
                    '$info.participants.teamPosition',
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
          $max: [1, { $divide: [{ $ifNull: ['$info.gameDuration', 0] }, 60] }],
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
        goldAt10: '$_snap.snap10.gold',
        csAt10: '$_snap.snap10.cs',
        goldAt15: '$_snap.snap15.gold',
        csAt15: '$_snap.snap15.cs',
        cs: {
          $add: [
            { $ifNull: ['$info.participants.totalMinionsKilled', 0] },
            { $ifNull: ['$info.participants.neutralMinionsKilled', 0] },
          ],
        },
      },
    },

    // ── group & percentile accumulators (no arrays) ────────────────────────
    {
      $group: {
        _id: { champ: '$info.participants.championName', role: '$role' },

        // p50
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

  consola.debug('cohortChampionRolePercentilesAggregation pipeline', pipeline);

  return pipeline;
};
