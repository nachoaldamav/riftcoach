import { ALLOWED_QUEUE_IDS } from '@riftcoach/shared.constants';
import type { Document } from 'mongodb';

/**
 * Optimized: pushdown + slim docs + targeted $lookup with pre-filtered events.
 * - Uses $elemMatch to prune by participant before $unwind.
 * - Early $project to keep only the fields we actually read.
 * - $lookup returns only frames[10], frames[15], and filtered events (<= 15m kills + all elite monsters),
 *   so we avoid reducing huge arrays in the main pipeline.
 */
export const playerChampRoleStatsAggregation = (puuid: string): Document[] => [
  // 1) Index‑friendly predicate pushdown (participant + queue)
  {
    $match: {
      'info.participants': { $elemMatch: { puuid } },
      'info.queueId': { $in: ALLOWED_QUEUE_IDS },
    },
  },

  // 2) Read only what's needed to compute metrics
  {
    $project: {
      _id: 0,
      'info.participants': 1,
      'info.gameCreation': 1,
      'info.gameDuration': 1,
      'info.queueId': 1,
      'metadata.matchId': 1,
    },
  },

  // 3) Keep full participants (for team shares) + unwind just this player
  { $set: { _allParticipants: '$info.participants' } },
  { $unwind: '$info.participants' },
  { $match: { 'info.participants.puuid': puuid } },

  // 4) Targeted timeline pull: only frames 10/15 and the events we care about
  {
    $lookup: {
      from: 'timelines',
      let: { matchId: '$metadata.matchId' },
      pipeline: [
        { $match: { $expr: { $eq: ['$metadata.matchId', '$$matchId'] } } },
        // Keep frames array only while we derive f10, f15 and filtered events
        {
          $project: {
            _id: 0,
            frames: '$info.frames',
          },
        },
        // Derive f10/f15 and filtered events in the lookup pipeline (cheaper here)
        {
          $project: {
            f10: { $ifNull: [{ $arrayElemAt: ['$frames', 10] }, null] },
            f15: { $ifNull: [{ $arrayElemAt: ['$frames', 15] }, null] },
            // Flatten all frame.events and keep only what the outer pipeline needs
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
                    cond: {
                      $or: [
                        // Early kills (< 15 min)
                        {
                          $and: [
                            { $eq: ['$$e.type', 'CHAMPION_KILL'] },
                            {
                              $lt: [{ $ifNull: ['$$e.timestamp', 0] }, 900000],
                            },
                            { $gt: [{ $ifNull: ['$$e.killerId', 0] }, 0] },
                            { $ne: [{ $type: '$$e.position' }, 'missing'] },
                          ],
                        },
                        // All elite monster kills (for objective participation)
                        {
                          $and: [
                            { $eq: ['$$e.type', 'ELITE_MONSTER_KILL'] },
                            {
                              $in: [
                                { $ifNull: ['$$e.monsterType', ''] },
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
                      ],
                    },
                  },
                },
              },
            },
          },
        },
        // Finally project only the small pieces we need out of the lookup
        {
          $project: {
            f10: 1,
            f15: 1,
            events: 1,
          },
        },
      ],
      as: 'snap',
    },
  },

  // 5) Materialize snapshots/events and drop big arrays ASAP
  {
    $set: {
      _snap: {
        $ifNull: [{ $first: '$snap' }, { f10: null, f15: null, events: [] }],
      },
    },
  },
  { $project: { snap: 0 } },

  // 6) Role + participant helpers
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
      _pId: '$info.participants.participantId',
    },
  },

  // 7) Extract minute 10 & 15 for this participant (from lookup's f10/f15)
  {
    $set: {
      _at10: {
        $let: {
          vars: {
            pf: {
              $first: {
                $filter: {
                  input: {
                    $objectToArray: {
                      $ifNull: ['$_snap.f10.participantFrames', {}],
                    },
                  },
                  as: 'kv',
                  cond: { $eq: ['$$kv.k', { $toString: '$_pId' }] },
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
      _at15: {
        $let: {
          vars: {
            pf: {
              $first: {
                $filter: {
                  input: {
                    $objectToArray: {
                      $ifNull: ['$_snap.f15.participantFrames', {}],
                    },
                  },
                  as: 'kv',
                  cond: { $eq: ['$$kv.k', { $toString: '$_pId' }] },
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
      _events: { $ifNull: ['$_snap.events', []] },
    },
  },

  // 8) Early gank candidates are already filtered in lookup; just map → flags
  {
    $set: {
      _gankFlags: {
        $map: {
          input: {
            $filter: {
              input: '$_events',
              as: 'e',
              cond: { $eq: ['$$e.type', 'CHAMPION_KILL'] },
            },
          },
          as: 'ev',
          in: {
            $let: {
              vars: {
                x: { $ifNull: ['$$ev.position.x', -1] },
                y: { $ifNull: ['$$ev.position.y', -1] },
                killer: {
                  $first: {
                    $filter: {
                      input: '$_allParticipants',
                      as: 'pp',
                      cond: { $eq: ['$$pp.participantId', '$$ev.killerId'] },
                    },
                  },
                },
              },
              in: {
                // Simple fast zoning (keep your richer constants if you prefer)
                zone: {
                  $switch: {
                    branches: [
                      {
                        case: {
                          $lte: [
                            {
                              $abs: {
                                $subtract: [{ $add: ['$$x', '$$y'] }, 15000],
                              },
                            },
                            1200,
                          ],
                        },
                        then: 'RIVER',
                      },
                      {
                        case: {
                          $lte: [{ $abs: { $subtract: ['$$x', '$$y'] } }, 1200],
                        },
                        then: 'LANE_MID',
                      },
                      {
                        case: { $gt: [{ $subtract: ['$$y', '$$x'] }, 2500] },
                        then: 'LANE_TOP',
                      },
                      {
                        case: { $gt: [{ $subtract: ['$$x', '$$y'] }, 2500] },
                        then: 'LANE_BOTTOM',
                      },
                    ],
                    default: 'JUNGLE',
                  },
                },
                killerRole: {
                  $switch: {
                    branches: [
                      {
                        case: {
                          $eq: [
                            { $ifNull: ['$$killer.teamPosition', ''] },
                            'TOP',
                          ],
                        },
                        then: 'TOP',
                      },
                      {
                        case: {
                          $eq: [
                            { $ifNull: ['$$killer.teamPosition', ''] },
                            'JUNGLE',
                          ],
                        },
                        then: 'JUNGLE',
                      },
                      {
                        case: {
                          $in: [
                            { $ifNull: ['$$killer.teamPosition', ''] },
                            ['MIDDLE', 'MID'],
                          ],
                        },
                        then: 'MIDDLE',
                      },
                      {
                        case: {
                          $in: [
                            { $ifNull: ['$$killer.teamPosition', ''] },
                            ['BOTTOM', 'ADC', 'BOT'],
                          ],
                        },
                        then: 'BOTTOM',
                      },
                      {
                        case: {
                          $in: [
                            { $ifNull: ['$$killer.teamPosition', ''] },
                            ['UTILITY', 'SUPPORT', 'SUP'],
                          ],
                        },
                        then: 'UTILITY',
                      },
                    ],
                    default: 'UNKNOWN',
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    $set: {
      earlyGankDeathSmart: {
        $cond: [
          { $eq: ['$role', 'JUNGLE'] },
          null,
          {
            $cond: [
              {
                $anyElementTrue: {
                  $map: {
                    input: '$_gankFlags',
                    as: 'g',
                    in: {
                      $and: [
                        {
                          $in: [
                            '$$g.zone',
                            ['LANE_TOP', 'LANE_MID', 'LANE_BOTTOM'],
                          ],
                        },
                        {
                          $or: [
                            { $eq: ['$$g.killerRole', 'JUNGLE'] },
                            { $ne: ['$$g.killerRole', '$role'] },
                          ],
                        },
                      ],
                    },
                  },
                },
              },
              1,
              0,
            ],
          },
        ],
      },
    },
  },

  // 9) Per‑minute rates + shares (reuse pre-projected arrays)
  {
    $set: {
      _gameDurationMin: {
        $max: [1, { $divide: [{ $ifNull: ['$info.gameDuration', 0] }, 60] }],
      },
      dpm: {
        $divide: [
          { $ifNull: ['$info.participants.totalDamageDealtToChampions', 0] },
          {
            $max: [
              1,
              { $divide: [{ $ifNull: ['$info.gameDuration', 0] }, 60] },
            ],
          },
        ],
      },
      dtpm: {
        $divide: [
          { $ifNull: ['$info.participants.totalDamageTaken', 0] },
          {
            $max: [
              1,
              { $divide: [{ $ifNull: ['$info.gameDuration', 0] }, 60] },
            ],
          },
        ],
      },
      kpm: {
        $divide: [
          { $ifNull: ['$info.participants.kills', 0] },
          {
            $max: [
              1,
              { $divide: [{ $ifNull: ['$info.gameDuration', 0] }, 60] },
            ],
          },
        ],
      },
      deathsPerMin: {
        $divide: [
          { $ifNull: ['$info.participants.deaths', 0] },
          {
            $max: [
              1,
              { $divide: [{ $ifNull: ['$info.gameDuration', 0] }, 60] },
            ],
          },
        ],
      },
      apm: {
        $divide: [
          { $ifNull: ['$info.participants.assists', 0] },
          {
            $max: [
              1,
              { $divide: [{ $ifNull: ['$info.gameDuration', 0] }, 60] },
            ],
          },
        ],
      },
      damageShare: {
        $let: {
          vars: {
            myTeamId: '$info.participants.teamId',
            myDmg: {
              $ifNull: ['$info.participants.totalDamageDealtToChampions', 0],
            },
            teamTotal: {
              $sum: {
                $map: {
                  input: {
                    $filter: {
                      input: '$_allParticipants',
                      as: 'pp',
                      cond: {
                        $eq: ['$$pp.teamId', '$info.participants.teamId'],
                      },
                    },
                  },
                  as: 'pp2',
                  in: { $ifNull: ['$$pp2.totalDamageDealtToChampions', 0] },
                },
              },
            },
          },
          in: {
            $cond: [
              { $gt: ['$$teamTotal', 0] },
              { $divide: ['$$myDmg', '$$teamTotal'] },
              null,
            ],
          },
        },
      },
      damageTakenShare: {
        $let: {
          vars: {
            myTeamId: '$info.participants.teamId',
            myTaken: { $ifNull: ['$info.participants.totalDamageTaken', 0] },
            teamTotal: {
              $sum: {
                $map: {
                  input: {
                    $filter: {
                      input: '$_allParticipants',
                      as: 'pp',
                      cond: {
                        $eq: ['$$pp.teamId', '$info.participants.teamId'],
                      },
                    },
                  },
                  as: 'pp2',
                  in: { $ifNull: ['$$pp2.totalDamageTaken', 0] },
                },
              },
            },
          },
          in: {
            $cond: [
              { $gt: ['$$teamTotal', 0] },
              { $divide: ['$$myTaken', '$$teamTotal'] },
              null,
            ],
          },
        },
      },
      objectiveParticipationPct: {
        $let: {
          vars: {
            myTeam: '$info.participants.teamId',
            evs: '$_events',
            pId: '$_pId',
          },
          in: {
            $let: {
              vars: {
                teamEpic: {
                  $size: {
                    $filter: {
                      input: '$$evs',
                      as: 'e',
                      cond: {
                        $and: [
                          { $eq: ['$$e.type', 'ELITE_MONSTER_KILL'] },
                          { $gt: [{ $ifNull: ['$$e.killerId', 0] }, 0] },
                        ],
                      },
                    },
                  },
                },
                myInvolved: {
                  $size: {
                    $filter: {
                      input: '$$evs',
                      as: 'e',
                      cond: {
                        $and: [
                          { $eq: ['$$e.type', 'ELITE_MONSTER_KILL'] },
                          {
                            $or: [
                              { $eq: ['$$e.killerId', '$$pId'] },
                              {
                                $in: [
                                  '$$pId',
                                  {
                                    $ifNull: [
                                      '$$e.assistingParticipantIds',
                                      [],
                                    ],
                                  },
                                ],
                              },
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
                  { $gt: ['$$teamEpic', 0] },
                  { $divide: ['$$myInvolved', '$$teamEpic'] },
                  null,
                ],
              },
            },
          },
        },
      },
    },
  },

  // 10) Group by champion + role
  {
    $group: {
      _id: { champ: '$info.participants.championName', role: '$role' },
      totalMatches: { $sum: 1 },
      wins: { $sum: { $cond: ['$info.participants.win', 1, 0] } },
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
      avgDeathsPerMin: { $avg: '$deathsPerMin' },
      avgApm: { $avg: '$apm' },
      avgDamageShare: { $avg: '$damageShare' },
      avgDamageTakenShare: { $avg: '$damageTakenShare' },
      avgObjectiveParticipationPct: { $avg: '$objectiveParticipationPct' },
      earlyGankDeathRateSmart: { $avg: '$earlyGankDeathSmart' },
    },
  },

  // 11) Final projection
  {
    $project: {
      _id: 0,
      championName: '$_id.champ',
      role: '$_id.role',
      totalMatches: 1,
      wins: 1,
      losses: { $subtract: ['$totalMatches', '$wins'] },
      winRate: { $divide: ['$wins', '$totalMatches'] },
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
      avgDeathsPerMin: { $round: ['$avgDeathsPerMin', 3] },
      avgApm: { $round: ['$avgApm', 3] },
      avgDamageShare: { $round: ['$avgDamageShare', 3] },
      avgDamageTakenShare: { $round: ['$avgDamageTakenShare', 3] },
      avgObjectiveParticipationPct: {
        $round: ['$avgObjectiveParticipationPct', 3],
      },
      earlyGankDeathRateSmart: { $round: ['$earlyGankDeathRateSmart', 3] },
    },
  },

  // 12) Sort by volume, then role
  { $sort: { totalMatches: -1, championName: 1, role: 1 } },
];
