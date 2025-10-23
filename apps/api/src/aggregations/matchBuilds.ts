import type { Document } from 'mongodb';

export const getMatchBuilds = ({
  matchId,
  puuid,
}: {
  matchId: string;
  puuid: string;
}): Document[] => [
  // 1) Target match
  { $match: { 'metadata.matchId': matchId } },

  // 2) Join timeline (for item purchase timestamps)
  {
    $lookup: {
      from: 'timelines',
      localField: 'metadata.matchId',
      foreignField: 'metadata.matchId',
      as: 'timelineInfo',
    },
  },
  { $unwind: '$timelineInfo' },

  // 3) Compute active player + flatten all frame events
  {
    $addFields: {
      activePlayer: {
        $first: {
          $filter: {
            input: '$info.participants',
            as: 'p',
            cond: {
              $eq: ['$$p.puuid', puuid],
            },
          },
        },
      },
      all_events: {
        $reduce: {
          input: '$timelineInfo.info.frames',
          initialValue: [],
          in: { $concatArrays: ['$$value', '$$this.events'] },
        },
      },
    },
  },

  // 4) Split teams (allies include the active player)
  {
    $addFields: {
      alliesSrc: {
        $filter: {
          input: '$info.participants',
          as: 'p',
          cond: { $eq: ['$$p.teamId', '$activePlayer.teamId'] },
        },
      },
      enemiesSrc: {
        $filter: {
          input: '$info.participants',
          as: 'p',
          cond: { $ne: ['$$p.teamId', '$activePlayer.teamId'] },
        },
      },
    },
  },

  // 5) Final simplified shape
  {
    $project: {
      _id: 0,

      // Match metadata
      gameVersion: '$info.gameVersion',
      gameMode: '$info.gameMode',
      gameDuration: '$info.gameDuration',
      gameCreation: '$info.gameCreation',

      allies: {
        $map: {
          input: '$alliesSrc',
          as: 'pl',
          in: {
            isActive: { $eq: ['$$pl.puuid', '$activePlayer.puuid'] },
            championName: '$$pl.championName',
            role: {
              $let: {
                vars: {
                  tp: { $toUpper: { $ifNull: ['$$pl.teamPosition', ''] } },
                  lane: { $toUpper: { $ifNull: ['$$pl.lane', ''] } },
                  r: { $toUpper: { $ifNull: ['$$pl.role', ''] } },
                },
                in: {
                  $switch: {
                    branches: [
                      {
                        case: {
                          $in: ['$$tp', ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY']],
                        },
                        then: '$$tp',
                      },
                      {
                        case: { $and: [{ $eq: ['$$lane', 'BOTTOM_LANE'] }, { $eq: ['$$r', 'DUO_CARRY'] }] },
                        then: 'BOTTOM',
                      },
                      {
                        case: { $and: [{ $eq: ['$$lane', 'BOTTOM_LANE'] }, { $eq: ['$$r', 'DUO_SUPPORT'] }] },
                        then: 'UTILITY',
                      },
                      {
                        case: { $or: [{ $eq: ['$$r', 'JUNGLE'] }, { $eq: ['$$lane', 'JUNGLE'] }] },
                        then: 'JUNGLE',
                      },
                      { case: { $eq: ['$$lane', 'TOP_LANE'] }, then: 'TOP' },
                      { case: { $eq: ['$$lane', 'MIDDLE_LANE'] }, then: 'MIDDLE' },
                    ],
                    default: 'UNKNOWN',
                  },
                },
              },
            },

            // Damage dealt composition (%)
            damageTypes: {
              physicalPercent: {
                $round: [
                  {
                    $multiply: [
                      {
                        $divide: [
                          '$$pl.physicalDamageDealtToChampions',
                          { $max: [1, '$$pl.totalDamageDealtToChampions'] },
                        ],
                      },
                      100,
                    ],
                  },
                  2,
                ],
              },
              magicPercent: {
                $round: [
                  {
                    $multiply: [
                      {
                        $divide: [
                          '$$pl.magicDamageDealtToChampions',
                          { $max: [1, '$$pl.totalDamageDealtToChampions'] },
                        ],
                      },
                      100,
                    ],
                  },
                  2,
                ],
              },
              truePercent: {
                $round: [
                  {
                    $multiply: [
                      {
                        $divide: [
                          '$$pl.trueDamageDealtToChampions',
                          { $max: [1, '$$pl.totalDamageDealtToChampions'] },
                        ],
                      },
                      100,
                    ],
                  },
                  2,
                ],
              },
            },

            // Damage taken composition (%)
            damageTakenTypes: {
              physicalPercent: {
                $round: [
                  {
                    $multiply: [
                      {
                        $divide: [
                          '$$pl.physicalDamageTaken',
                          { $max: [1, '$$pl.totalDamageTaken'] },
                        ],
                      },
                      100,
                    ],
                  },
                  2,
                ],
              },
              magicPercent: {
                $round: [
                  {
                    $multiply: [
                      {
                        $divide: [
                          '$$pl.magicDamageTaken',
                          { $max: [1, '$$pl.totalDamageTaken'] },
                        ],
                      },
                      100,
                    ],
                  },
                  2,
                ],
              },
              truePercent: {
                $round: [
                  {
                    $multiply: [
                      {
                        $divide: [
                          '$$pl.trueDamageTaken',
                          { $max: [1, '$$pl.totalDamageTaken'] },
                        ],
                      },
                      100,
                    ],
                  },
                  2,
                ],
              },
            },

            // Final build — only last purchase timestamp for each final item
            finalBuild: {
              $let: {
                vars: {
                  finalItemIds: {
                    $filter: {
                      input: [
                        '$$pl.item0',
                        '$$pl.item1',
                        '$$pl.item2',
                        '$$pl.item3',
                        '$$pl.item4',
                        '$$pl.item5',
                      ],
                      as: 'it',
                      cond: { $gt: ['$$it', 0] },
                    },
                  },
                  eventsForP: {
                    $filter: {
                      input: '$all_events',
                      as: 'e',
                      cond: {
                        $and: [
                          { $eq: ['$$e.type', 'ITEM_PURCHASED'] },
                          { $eq: ['$$e.participantId', '$$pl.participantId'] },
                        ],
                      },
                    },
                  },
                },
                in: {
                  $arrayToObject: {
                    $map: {
                      input: '$$finalItemIds',
                      as: 'fid',
                      in: {
                        k: { $toString: '$$fid' },
                        v: {
                          $let: {
                            vars: {
                              purchasesOfItem: {
                                $filter: {
                                  input: '$$eventsForP',
                                  as: 'pe',
                                  cond: { $eq: ['$$pe.itemId', '$$fid'] },
                                },
                              },
                            },
                            in: {
                              $cond: [
                                { $gt: [{ $size: '$$purchasesOfItem' }, 0] },
                                {
                                  $reduce: {
                                    input: '$$purchasesOfItem',
                                    initialValue: -1,
                                    in: {
                                      $cond: [
                                        {
                                          $gt: ['$$this.timestamp', '$$value'],
                                        },
                                        '$$this.timestamp',
                                        '$$value',
                                      ],
                                    },
                                  },
                                },
                                null,
                              ],
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },

            stats: {
              // CC dealt to enemy champions (Riot: "timeCCingOthers")
              timeCCingOthers: '$$pl.timeCCingOthers',
              totalHeal: '$$pl.totalHeal',

              totalDamageDealtToChampions: '$$pl.totalDamageDealtToChampions',
              trueDamageDealtToChampions: '$$pl.trueDamageDealtToChampions',
              physicalDamageDealtToChampions:
                '$$pl.physicalDamageDealtToChampions',
              magicDamageDealtToChampions: '$$pl.magicDamageDealtToChampions',

              totalDamageTaken: '$$pl.totalDamageTaken',
              physicalDamageTaken: '$$pl.physicalDamageTaken',
              magicDamageTaken: '$$pl.magicDamageTaken',
              trueDamageTaken: '$$pl.trueDamageTaken',

              damageSelfMitigated: '$$pl.damageSelfMitigated',
            },

            // Player performance metrics
            puuid: '$$pl.puuid',
            kills: '$$pl.kills',
            deaths: '$$pl.deaths',
            assists: '$$pl.assists',
            goldEarned: '$$pl.goldEarned',
            totalDamageDealt: '$$pl.totalDamageDealt',
            win: '$$pl.win',

            // Individual item slots
            item0: '$$pl.item0',
            item1: '$$pl.item1',
            item2: '$$pl.item2',
            item3: '$$pl.item3',
            item4: '$$pl.item4',
            item5: '$$pl.item5',
          },
        },
      },

      enemies: {
        $map: {
          input: '$enemiesSrc',
          as: 'pl',
          in: {
            isActive: false,
            championName: '$$pl.championName',
            role: {
              $let: {
                vars: {
                  tp: { $toUpper: { $ifNull: ['$$pl.teamPosition', ''] } },
                  lane: { $toUpper: { $ifNull: ['$$pl.lane', ''] } },
                  r: { $toUpper: { $ifNull: ['$$pl.role', ''] } },
                },
                in: {
                  $switch: {
                    branches: [
                      {
                        case: {
                          $in: ['$$tp', ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY']],
                        },
                        then: '$$tp',
                      },
                      {
                        case: { $and: [{ $eq: ['$$lane', 'BOTTOM_LANE'] }, { $eq: ['$$r', 'DUO_CARRY'] }] },
                        then: 'BOTTOM',
                      },
                      {
                        case: { $and: [{ $eq: ['$$lane', 'BOTTOM_LANE'] }, { $eq: ['$$r', 'DUO_SUPPORT'] }] },
                        then: 'UTILITY',
                      },
                      {
                        case: { $or: [{ $eq: ['$$r', 'JUNGLE'] }, { $eq: ['$$lane', 'JUNGLE'] }] },
                        then: 'JUNGLE',
                      },
                      { case: { $eq: ['$$lane', 'TOP_LANE'] }, then: 'TOP' },
                      { case: { $eq: ['$$lane', 'MIDDLE_LANE'] }, then: 'MIDDLE' },
                    ],
                    default: 'UNKNOWN',
                  },
                },
              },
            },

            damageTypes: {
              physicalPercent: {
                $round: [
                  {
                    $multiply: [
                      {
                        $divide: [
                          '$$pl.physicalDamageDealtToChampions',
                          { $max: [1, '$$pl.totalDamageDealtToChampions'] },
                        ],
                      },
                      100,
                    ],
                  },
                  2,
                ],
              },
              magicPercent: {
                $round: [
                  {
                    $multiply: [
                      {
                        $divide: [
                          '$$pl.magicDamageDealtToChampions',
                          { $max: [1, '$$pl.totalDamageDealtToChampions'] },
                        ],
                      },
                      100,
                    ],
                  },
                  2,
                ],
              },
              truePercent: {
                $round: [
                  {
                    $multiply: [
                      {
                        $divide: [
                          '$$pl.trueDamageDealtToChampions',
                          { $max: [1, '$$pl.totalDamageDealtToChampions'] },
                        ],
                      },
                      100,
                    ],
                  },
                  2,
                ],
              },
            },

            damageTakenTypes: {
              physicalPercent: {
                $round: [
                  {
                    $multiply: [
                      {
                        $divide: [
                          '$$pl.physicalDamageTaken',
                          { $max: [1, '$$pl.totalDamageTaken'] },
                        ],
                      },
                      100,
                    ],
                  },
                  2,
                ],
              },
              magicPercent: {
                $round: [
                  {
                    $multiply: [
                      {
                        $divide: [
                          '$$pl.magicDamageTaken',
                          { $max: [1, '$$pl.totalDamageTaken'] },
                        ],
                      },
                      100,
                    ],
                  },
                  2,
                ],
              },
              truePercent: {
                $round: [
                  {
                    $multiply: [
                      {
                        $divide: [
                          '$$pl.trueDamageTaken',
                          { $max: [1, '$$pl.totalDamageTaken'] },
                        ],
                      },
                      100,
                    ],
                  },
                  2,
                ],
              },
            },

            finalBuild: {
              $let: {
                vars: {
                  finalItemIds: {
                    $filter: {
                      input: [
                        '$$pl.item0',
                        '$$pl.item1',
                        '$$pl.item2',
                        '$$pl.item3',
                        '$$pl.item4',
                        '$$pl.item5',
                      ],
                      as: 'it',
                      cond: { $gt: ['$$it', 0] },
                    },
                  },
                  eventsForP: {
                    $filter: {
                      input: '$all_events',
                      as: 'e',
                      cond: {
                        $and: [
                          { $eq: ['$$e.type', 'ITEM_PURCHASED'] },
                          { $eq: ['$$e.participantId', '$$pl.participantId'] },
                        ],
                      },
                    },
                  },
                },
                in: {
                  $arrayToObject: {
                    $map: {
                      input: '$$finalItemIds',
                      as: 'fid',
                      in: {
                        k: { $toString: '$$fid' },
                        v: {
                          $let: {
                            vars: {
                              purchasesOfItem: {
                                $filter: {
                                  input: '$$eventsForP',
                                  as: 'pe',
                                  cond: { $eq: ['$$pe.itemId', '$$fid'] },
                                },
                              },
                            },
                            in: {
                              $cond: [
                                { $gt: [{ $size: '$$purchasesOfItem' }, 0] },
                                {
                                  $reduce: {
                                    input: '$$purchasesOfItem',
                                    initialValue: -1,
                                    in: {
                                      $cond: [
                                        {
                                          $gt: ['$$this.timestamp', '$$value'],
                                        },
                                        '$$this.timestamp',
                                        '$$value',
                                      ],
                                    },
                                  },
                                },
                                null,
                              ],
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },

            stats: {
              timeCCingOthers: '$$pl.timeCCingOthers',
              totalHeal: '$$pl.totalHeal',

              totalDamageDealtToChampions: '$$pl.totalDamageDealtToChampions',
              trueDamageDealtToChampions: '$$pl.trueDamageDealtToChampions',
              physicalDamageDealtToChampions:
                '$$pl.physicalDamageDealtToChampions',
              magicDamageDealtToChampions: '$$pl.magicDamageDealtToChampions',

              totalDamageTaken: '$$pl.totalDamageTaken',
              physicalDamageTaken: '$$pl.physicalDamageTaken',
              magicDamageTaken: '$$pl.magicDamageTaken',
              trueDamageTaken: '$$pl.trueDamageTaken',

              damageSelfMitigated: '$$pl.damageSelfMitigated',
            },

            // Player performance metrics
            puuid: '$$pl.puuid',
            kills: '$$pl.kills',
            deaths: '$$pl.deaths',
            assists: '$$pl.assists',
            goldEarned: '$$pl.goldEarned',
            totalDamageDealt: '$$pl.totalDamageDealt',
            win: '$$pl.win',

            // Individual item slots
            item0: '$$pl.item0',
            item1: '$$pl.item1',
            item2: '$$pl.item2',
            item3: '$$pl.item3',
            item4: '$$pl.item4',
            item5: '$$pl.item5',
          },
        },
      },
    },
  },
];
