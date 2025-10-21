import { ALLOWED_QUEUE_IDS } from '@riftcoach/shared.constants';

export const statsByRolePUUID = (puuid: string) => [
  // CONFIG — self stats only
  { $set: { _enemiesOnly: false } },

  // 1) Only the user's games (INDEXED via info.participants.puuid)
  {
    $match: {
      'info.participants.puuid': puuid,
    },
  },

  // Only allowed queues
  { $match: { 'info.queueId': { $in: ALLOWED_QUEUE_IDS } } },

  // 2) Project only needed fields and calculate game duration in minutes
  {
    $project: {
      _id: 0,
      matchId: '$metadata.matchId',
      gameDuration: { $divide: ['$info.gameDuration', 60] },
      participants: {
        $map: {
          input: '$info.participants',
          as: 'p',
          in: {
            participantId: '$$p.participantId',
            puuid: '$$p.puuid',
            teamId: '$$p.teamId',
            teamPosition: { $ifNull: ['$$p.teamPosition', 'UNKNOWN'] },
            championName: '$$p.championName',
            kills: '$$p.kills',
            deaths: '$$p.deaths',
            assists: '$$p.assists',
            totalMinionsKilled: {
              $add: ['$$p.totalMinionsKilled', '$$p.neutralMinionsKilled'],
            },
            totalDamageDealtToChampions: '$$p.totalDamageDealtToChampions',
            goldEarned: '$$p.goldEarned',
            visionScore: '$$p.visionScore',
            totalDamageTaken: '$$p.totalDamageTaken',
            win: '$$p.win',
          },
        },
      },
    },
  },

  // 3) Extract "me"
  {
    $set: {
      me: {
        $first: {
          $filter: {
            input: '$participants',
            as: 'p',
            cond: { $eq: ['$$p.puuid', puuid] },
          },
        },
      },
    },
  },

  // 4) Keep only standard roles
  {
    $set: {
      myRole: {
        $switch: {
          branches: [
            { case: { $eq: ['$me.teamPosition', 'TOP'] }, then: 'TOP' },
            { case: { $eq: ['$me.teamPosition', 'JUNGLE'] }, then: 'JUNGLE' },
            { case: { $eq: ['$me.teamPosition', 'MIDDLE'] }, then: 'MIDDLE' },
            { case: { $eq: ['$me.teamPosition', 'BOTTOM'] }, then: 'BOTTOM' },
            { case: { $eq: ['$me.teamPosition', 'UTILITY'] }, then: 'UTILITY' },
          ],
          default: 'UNKNOWN',
        },
      },
    },
  },
  {
    $match: {
      myRole: { $in: ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'] },
    },
  },

  // 5) TIMELINE LOOKUP (after reduction = much cheaper)
  {
    $lookup: {
      from: 'timelines',
      localField: 'matchId',
      foreignField: 'metadata.matchId',
      as: 'tl',
    },
  },
  { $unwind: { path: '$tl', preserveNullAndEmptyArrays: true } },

  // 6) Frame extraction helpers + my participant ids
  {
    $set: {
      _frames: {
        $cond: [
          {
            $isArray: {
              $ifNull: [
                { $getField: { input: '$tl.info', field: 'frames' } },
                [],
              ],
            },
          },
          {
            $ifNull: [
              { $getField: { input: '$tl.info', field: 'frames' } },
              [],
            ],
          },
          [],
        ],
      },
      _pidStr: { $toString: '$me.participantId' },
      _pidInt: { $toInt: '$me.participantId' },
    },
  },
  { $set: { _len: { $size: '$_frames' } } },
  {
    $set: {
      frame10: {
        $cond: [
          { $gte: ['$_len', 11] },
          { $arrayElemAt: ['$_frames', 10] },
          null,
        ],
      },
      frame15: {
        $cond: [
          { $gte: ['$_len', 16] },
          { $arrayElemAt: ['$_frames', 15] },
          null,
        ],
      },
      frame20: {
        $cond: [
          { $gte: ['$_len', 21] },
          { $arrayElemAt: ['$_frames', 20] },
          null,
        ],
      },
      frame30: {
        $cond: [
          { $gte: ['$_len', 31] },
          { $arrayElemAt: ['$_frames', 30] },
          null,
        ],
      },
    },
  },

  // 7) Snapshot extraction for ME (participantFrames)
  {
    $set: {
      _pf10: {
        $ifNull: [
          {
            $getField: {
              input: {
                $ifNull: [
                  {
                    $getField: {
                      input: '$frame10',
                      field: 'participantFrames',
                    },
                  },
                  {},
                ],
              },
              field: '$_pidStr',
            },
          },
          {},
        ],
      },
      _pf15: {
        $ifNull: [
          {
            $getField: {
              input: {
                $ifNull: [
                  {
                    $getField: {
                      input: '$frame15',
                      field: 'participantFrames',
                    },
                  },
                  {},
                ],
              },
              field: '$_pidStr',
            },
          },
          {},
        ],
      },
      _pf20: {
        $ifNull: [
          {
            $getField: {
              input: {
                $ifNull: [
                  {
                    $getField: {
                      input: '$frame20',
                      field: 'participantFrames',
                    },
                  },
                  {},
                ],
              },
              field: '$_pidStr',
            },
          },
          {},
        ],
      },
      _pf30: {
        $ifNull: [
          {
            $getField: {
              input: {
                $ifNull: [
                  {
                    $getField: {
                      input: '$frame30',
                      field: 'participantFrames',
                    },
                  },
                  {},
                ],
              },
              field: '$_pidStr',
            },
          },
          {},
        ],
      },
    },
  },
  {
    $set: {
      meAt10: {
        $cond: [
          { $ne: ['$frame10', null] },
          {
            cs: {
              $add: [
                {
                  $ifNull: [
                    { $getField: { input: '$_pf10', field: 'minionsKilled' } },
                    0,
                  ],
                },
                {
                  $ifNull: [
                    {
                      $getField: {
                        input: '$_pf10',
                        field: 'jungleMinionsKilled',
                      },
                    },
                    0,
                  ],
                },
              ],
            },
            gold: {
              $ifNull: [
                { $getField: { input: '$_pf10', field: 'totalGold' } },
                0,
              ],
            },
            xp: {
              $ifNull: [{ $getField: { input: '$_pf10', field: 'xp' } }, 0],
            },
            level: {
              $ifNull: [{ $getField: { input: '$_pf10', field: 'level' } }, 0],
            },
          },
          null,
        ],
      },
      meAt15: {
        $cond: [
          { $ne: ['$frame15', null] },
          {
            cs: {
              $add: [
                {
                  $ifNull: [
                    { $getField: { input: '$_pf15', field: 'minionsKilled' } },
                    0,
                  ],
                },
                {
                  $ifNull: [
                    {
                      $getField: {
                        input: '$_pf15',
                        field: 'jungleMinionsKilled',
                      },
                    },
                    0,
                  ],
                },
              ],
            },
            gold: {
              $ifNull: [
                { $getField: { input: '$_pf15', field: 'totalGold' } },
                0,
              ],
            },
            xp: {
              $ifNull: [{ $getField: { input: '$_pf15', field: 'xp' } }, 0],
            },
            level: {
              $ifNull: [{ $getField: { input: '$_pf15', field: 'level' } }, 0],
            },
          },
          null,
        ],
      },
      meAt20: {
        $cond: [
          { $ne: ['$frame20', null] },
          {
            cs: {
              $add: [
                {
                  $ifNull: [
                    { $getField: { input: '$_pf20', field: 'minionsKilled' } },
                    0,
                  ],
                },
                {
                  $ifNull: [
                    {
                      $getField: {
                        input: '$_pf20',
                        field: 'jungleMinionsKilled',
                      },
                    },
                    0,
                  ],
                },
              ],
            },
            gold: {
              $ifNull: [
                { $getField: { input: '$_pf20', field: 'totalGold' } },
                0,
              ],
            },
            xp: {
              $ifNull: [{ $getField: { input: '$_pf20', field: 'xp' } }, 0],
            },
            level: {
              $ifNull: [{ $getField: { input: '$_pf20', field: 'level' } }, 0],
            },
          },
          null,
        ],
      },
      meAt30: {
        $cond: [
          { $ne: ['$frame30', null] },
          {
            cs: {
              $add: [
                {
                  $ifNull: [
                    { $getField: { input: '$_pf30', field: 'minionsKilled' } },
                    0,
                  ],
                },
                {
                  $ifNull: [
                    {
                      $getField: {
                        input: '$_pf30',
                        field: 'jungleMinionsKilled',
                      },
                    },
                    0,
                  ],
                },
              ],
            },
            gold: {
              $ifNull: [
                { $getField: { input: '$_pf30', field: 'totalGold' } },
                0,
              ],
            },
            xp: {
              $ifNull: [{ $getField: { input: '$_pf30', field: 'xp' } }, 0],
            },
            level: {
              $ifNull: [{ $getField: { input: '$_pf30', field: 'level' } }, 0],
            },
          },
          null,
        ],
      },
    },
  },

  // 8) Flatten events we care about
  {
    $set: {
      _eliteEvents: {
        $filter: {
          input: {
            $reduce: {
              input: '$_frames',
              initialValue: [],
              in: {
                $concatArrays: ['$$value', { $ifNull: ['$$this.events', []] }],
              },
            },
          },
          as: 'e',
          cond: { $eq: ['$$e.type', 'ELITE_MONSTER_KILL'] },
        },
      },
      _buildingEvents: {
        $filter: {
          input: {
            $reduce: {
              input: '$_frames',
              initialValue: [],
              in: {
                $concatArrays: ['$$value', { $ifNull: ['$$this.events', []] }],
              },
            },
          },
          as: 'e',
          cond: { $eq: ['$$e.type', 'BUILDING_KILL'] },
        },
      },
      _plateEvents: {
        $filter: {
          input: {
            $reduce: {
              input: '$_frames',
              initialValue: [],
              in: {
                $concatArrays: ['$$value', { $ifNull: ['$$this.events', []] }],
              },
            },
          },
          as: 'e',
          cond: { $eq: ['$$e.type', 'TURRET_PLATE_DESTROYED'] },
        },
      },
    },
  },

  // 8.1) Compute _oppTeamId in its own stage so it can be used reliably
  { $set: { _oppTeamId: { $cond: [{ $eq: ['$me.teamId', 100] }, 200, 100] } } },

  // 8.2) Split by monster types (team = my team kills),
  // and filter towers/plates where victim team is the OPPOSING team
  {
    $set: {
      _drakes: {
        $filter: {
          input: '$_eliteEvents',
          as: 'e',
          cond: {
            $and: [
              { $eq: ['$$e.killerTeamId', '$me.teamId'] },
              { $eq: ['$$e.monsterType', 'DRAGON'] },
            ],
          },
        },
      },
      _grubs: {
        $filter: {
          input: '$_eliteEvents',
          as: 'e',
          cond: {
            $and: [
              { $eq: ['$$e.killerTeamId', '$me.teamId'] },
              { $in: ['$$e.monsterType', ['VOIDGRUB', 'VOIDGRUBS', 'HORDE']] },
            ],
          },
        },
      },
      _herald: {
        $filter: {
          input: '$_eliteEvents',
          as: 'e',
          cond: {
            $and: [
              { $eq: ['$$e.killerTeamId', '$me.teamId'] },
              { $in: ['$$e.monsterType', ['RIFTHERALD', 'RIFT_HERALD']] },
            ],
          },
        },
      },
      _baron: {
        $filter: {
          input: '$_eliteEvents',
          as: 'e',
          cond: {
            $and: [
              { $eq: ['$$e.killerTeamId', '$me.teamId'] },
              { $in: ['$$e.monsterType', ['BARON_NASHOR', 'NASHOR']] },
            ],
          },
        },
      },
      _atakhan: {
        $filter: {
          input: '$_eliteEvents',
          as: 'e',
          cond: {
            $and: [
              { $eq: ['$$e.killerTeamId', '$me.teamId'] },
              { $eq: ['$$e.monsterType', 'ATAKHAN'] },
            ],
          },
        },
      },
      _towers: {
        $filter: {
          input: '$_buildingEvents',
          as: 'e',
          cond: {
            $and: [
              { $eq: ['$$e.buildingType', 'TOWER_BUILDING'] },
              { $eq: [{ $toInt: '$$e.teamId' }, { $toInt: '$_oppTeamId' }] }, // defender team is the enemy
            ],
          },
        },
      },
      _turretPlates: {
        $filter: {
          input: '$_plateEvents',
          as: 'e',
          cond: { $eq: [{ $toInt: '$$e.teamId' }, { $toInt: '$_oppTeamId' }] }, // plate from enemy turret
        },
      },
    },
  },

  // 8.3) Build per-objective team counts and participation (killer/assists)
  {
    $set: {
      obj: {
        drakes: {
          team: { $size: '$_drakes' },
          part: {
            $size: {
              $filter: {
                input: '$_drakes',
                as: 'e',
                cond: {
                  $in: [
                    '$_pidInt',
                    {
                      $concatArrays: [
                        [{ $ifNull: ['$$e.killerId', -1] }],
                        { $ifNull: ['$$e.assistingParticipantIds', []] },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
        grubs: {
          team: { $size: '$_grubs' },
          part: {
            $size: {
              $filter: {
                input: '$_grubs',
                as: 'e',
                cond: {
                  $in: [
                    '$_pidInt',
                    {
                      $concatArrays: [
                        [{ $ifNull: ['$$e.killerId', -1] }],
                        { $ifNull: ['$$e.assistingParticipantIds', []] },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
        herald: {
          team: { $size: '$_herald' },
          part: {
            $size: {
              $filter: {
                input: '$_herald',
                as: 'e',
                cond: {
                  $in: [
                    '$_pidInt',
                    {
                      $concatArrays: [
                        [{ $ifNull: ['$$e.killerId', -1] }],
                        { $ifNull: ['$$e.assistingParticipantIds', []] },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
        baron: {
          team: { $size: '$_baron' },
          part: {
            $size: {
              $filter: {
                input: '$_baron',
                as: 'e',
                cond: {
                  $in: [
                    '$_pidInt',
                    {
                      $concatArrays: [
                        [{ $ifNull: ['$$e.killerId', -1] }],
                        { $ifNull: ['$$e.assistingParticipantIds', []] },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
        atakhan: {
          team: { $size: '$_atakhan' },
          part: {
            $size: {
              $filter: {
                input: '$_atakhan',
                as: 'e',
                cond: {
                  $in: [
                    '$_pidInt',
                    {
                      $concatArrays: [
                        [{ $ifNull: ['$$e.killerId', -1] }],
                        { $ifNull: ['$$e.assistingParticipantIds', []] },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
        towers: {
          team: { $size: '$_towers' },
          part: {
            $size: {
              $filter: {
                input: '$_towers',
                as: 'e',
                cond: {
                  $in: [
                    '$_pidInt',
                    {
                      $concatArrays: [
                        [{ $toInt: { $ifNull: ['$$e.killerId', -1] } }],
                        { $ifNull: ['$$e.assistingParticipantIds', []] },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
        turretPlates: {
          team: { $size: '$_turretPlates' },
          part: {
            $size: {
              $filter: {
                input: '$_turretPlates',
                as: 'e',
                cond: {
                  $in: [
                    '$_pidInt',
                    {
                      $concatArrays: [
                        [{ $toInt: { $ifNull: ['$$e.killerId', -1] } }],
                        { $ifNull: ['$$e.assistingParticipantIds', []] },
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
  },

  // 9) Aggregate by MY role
  {
    $group: {
      _id: '$myRole',
      position: { $first: '$myRole' },
      rowsCount: { $sum: 1 },
      wins: { $sum: { $cond: ['$me.win', 1, 0] } },

      killsArr: { $push: { $divide: ['$me.kills', '$gameDuration'] } },
      deathsArr: { $push: { $divide: ['$me.deaths', '$gameDuration'] } },
      assistsArr: { $push: { $divide: ['$me.assists', '$gameDuration'] } },
      csArr: {
        $push: { $divide: ['$me.totalMinionsKilled', '$gameDuration'] },
      },
      damageDealtArr: {
        $push: {
          $divide: ['$me.totalDamageDealtToChampions', '$gameDuration'],
        },
      },
      goldArr: { $push: { $divide: ['$me.goldEarned', '$gameDuration'] } },
      visionScoreArr: {
        $push: { $divide: ['$me.visionScore', '$gameDuration'] },
      },
      damageTakenArr: {
        $push: { $divide: ['$me.totalDamageTaken', '$gameDuration'] },
      },

      avgCSAt10: { $avg: '$meAt10.cs' },
      avgGoldAt10: { $avg: '$meAt10.gold' },
      avgXPAt10: { $avg: '$meAt10.xp' },
      avgLevelAt10: { $avg: '$meAt10.level' },

      avgCSAt15: { $avg: '$meAt15.cs' },
      avgGoldAt15: { $avg: '$meAt15.gold' },
      avgXPAt15: { $avg: '$meAt15.xp' },
      avgLevelAt15: { $avg: '$meAt15.level' },

      avgCSAt20: { $avg: '$meAt20.cs' },
      avgGoldAt20: { $avg: '$meAt20.gold' },
      avgXPAt20: { $avg: '$meAt20.xp' },
      avgLevelAt20: { $avg: '$meAt20.level' },

      avgCSAt30: { $avg: '$meAt30.cs' },
      avgGoldAt30: { $avg: '$meAt30.gold' },
      avgXPAt30: { $avg: '$meAt30.xp' },
      avgLevelAt30: { $avg: '$meAt30.level' },

      // objective participation totals
      drakesTeam: { $sum: '$obj.drakes.team' },
      drakesPart: { $sum: '$obj.drakes.part' },
      grubsTeam: { $sum: '$obj.grubs.team' },
      grubsPart: { $sum: '$obj.grubs.part' },
      heraldTeam: { $sum: '$obj.herald.team' },
      heraldPart: { $sum: '$obj.herald.part' },
      baronTeam: { $sum: '$obj.baron.team' },
      baronPart: { $sum: '$obj.baron.part' },
      atakhanTeam: { $sum: '$obj.atakhan.team' },
      atakhanPart: { $sum: '$obj.atakhan.part' },
      towersTeam: { $sum: '$obj.towers.team' },
      towersPart: { $sum: '$obj.towers.part' },
      turretPlatesTeam: { $sum: '$obj.turretPlates.team' },
      turretPlatesPart: { $sum: '$obj.turretPlates.part' },

      myChampions: { $addToSet: '$me.championName' },
    },
  },

  // 10) Final projection
  {
    $project: {
      _id: 0,
      position: 1,
      rowsCount: 1,
      winRate: {
        $round: [{ $multiply: [{ $divide: ['$wins', '$rowsCount'] }, 100] }, 2],
      },

      killsPerMin: { $round: [{ $avg: '$killsArr' }, 2] },
      deathsPerMin: { $round: [{ $avg: '$deathsArr' }, 2] },
      assistsPerMin: { $round: [{ $avg: '$assistsArr' }, 2] },
      csPerMin: { $round: [{ $avg: '$csArr' }, 2] },
      damageDealtPerMin: { $round: [{ $avg: '$damageDealtArr' }, 0] },
      goldPerMin: { $round: [{ $avg: '$goldArr' }, 0] },
      visionScorePerMin: { $round: [{ $avg: '$visionScoreArr' }, 2] },
      damageTakenPerMin: { $round: [{ $avg: '$damageTakenArr' }, 0] },

      percentiles: {
        p50: {
          kills: {
            $round: [
              {
                $arrayElemAt: [
                  {
                    $percentile: {
                      input: '$killsArr',
                      p: [0.5],
                      method: 'approximate',
                    },
                  },
                  0,
                ],
              },
              2,
            ],
          },
          deaths: {
            $round: [
              {
                $arrayElemAt: [
                  {
                    $percentile: {
                      input: '$deathsArr',
                      p: [0.5],
                      method: 'approximate',
                    },
                  },
                  0,
                ],
              },
              2,
            ],
          },
          assists: {
            $round: [
              {
                $arrayElemAt: [
                  {
                    $percentile: {
                      input: '$assistsArr',
                      p: [0.5],
                      method: 'approximate',
                    },
                  },
                  0,
                ],
              },
              2,
            ],
          },
          cs: {
            $round: [
              {
                $arrayElemAt: [
                  {
                    $percentile: {
                      input: '$csArr',
                      p: [0.5],
                      method: 'approximate',
                    },
                  },
                  0,
                ],
              },
              2,
            ],
          },
        },
        p75: {
          kills: {
            $round: [
              {
                $arrayElemAt: [
                  {
                    $percentile: {
                      input: '$killsArr',
                      p: [0.75],
                      method: 'approximate',
                    },
                  },
                  0,
                ],
              },
              2,
            ],
          },
          deaths: {
            $round: [
              {
                $arrayElemAt: [
                  {
                    $percentile: {
                      input: '$deathsArr',
                      p: [0.75],
                      method: 'approximate',
                    },
                  },
                  0,
                ],
              },
              2,
            ],
          },
          assists: {
            $round: [
              {
                $arrayElemAt: [
                  {
                    $percentile: {
                      input: '$assistsArr',
                      p: [0.75],
                      method: 'approximate',
                    },
                  },
                  0,
                ],
              },
              2,
            ],
          },
          cs: {
            $round: [
              {
                $arrayElemAt: [
                  {
                    $percentile: {
                      input: '$csArr',
                      p: [0.75],
                      method: 'approximate',
                    },
                  },
                  0,
                ],
              },
              2,
            ],
          },
        },
        p90: {
          kills: {
            $round: [
              {
                $arrayElemAt: [
                  {
                    $percentile: {
                      input: '$killsArr',
                      p: [0.9],
                      method: 'approximate',
                    },
                  },
                  0,
                ],
              },
              2,
            ],
          },
          deaths: {
            $round: [
              {
                $arrayElemAt: [
                  {
                    $percentile: {
                      input: '$deathsArr',
                      p: [0.9],
                      method: 'approximate',
                    },
                  },
                  0,
                ],
              },
              2,
            ],
          },
          assists: {
            $round: [
              {
                $arrayElemAt: [
                  {
                    $percentile: {
                      input: '$assistsArr',
                      p: [0.9],
                      method: 'approximate',
                    },
                  },
                  0,
                ],
              },
              2,
            ],
          },
          cs: {
            $round: [
              {
                $arrayElemAt: [
                  {
                    $percentile: {
                      input: '$csArr',
                      p: [0.9],
                      method: 'approximate',
                    },
                  },
                  0,
                ],
              },
              2,
            ],
          },
        },
      },

      at10Min: {
        cs: { $ifNull: [{ $round: ['$avgCSAt10', 1] }, 0] },
        gold: { $ifNull: [{ $round: ['$avgGoldAt10', 0] }, 0] },
        xp: { $ifNull: [{ $round: ['$avgXPAt10', 0] }, 0] },
        level: { $ifNull: [{ $round: ['$avgLevelAt10', 1] }, 0] },
      },
      at15Min: {
        cs: { $ifNull: [{ $round: ['$avgCSAt15', 1] }, 0] },
        gold: { $ifNull: [{ $round: ['$avgGoldAt15', 0] }, 0] },
        xp: { $ifNull: [{ $round: ['$avgXPAt15', 0] }, 0] },
        level: { $ifNull: [{ $round: ['$avgLevelAt15', 1] }, 0] },
      },
      at20Min: {
        cs: { $ifNull: [{ $round: ['$avgCSAt20', 1] }, 0] },
        gold: { $ifNull: [{ $round: ['$avgGoldAt20', 0] }, 0] },
        xp: { $ifNull: [{ $round: ['$avgXPAt20', 0] }, 0] },
        level: { $ifNull: [{ $round: ['$avgLevelAt20', 1] }, 0] },
      },
      at30Min: {
        cs: { $ifNull: [{ $round: ['$avgCSAt30', 1] }, 0] },
        gold: { $ifNull: [{ $round: ['$avgGoldAt30', 0] }, 0] },
        xp: { $ifNull: [{ $round: ['$avgXPAt30', 0] }, 0] },
        level: { $ifNull: [{ $round: ['$avgLevelAt30', 1] }, 0] },
      },

      objectiveParticipation: {
        drakes: {
          takes: '$drakesTeam',
          participated: '$drakesPart',
          rate: {
            $cond: [
              { $gt: ['$drakesTeam', 0] },
              {
                $round: [
                  {
                    $multiply: [
                      { $divide: ['$drakesPart', '$drakesTeam'] },
                      100,
                    ],
                  },
                  1,
                ],
              },
              null,
            ],
          },
        },
        grubs: {
          takes: '$grubsTeam',
          participated: '$grubsPart',
          rate: {
            $cond: [
              { $gt: ['$grubsTeam', 0] },
              {
                $round: [
                  {
                    $multiply: [{ $divide: ['$grubsPart', '$grubsTeam'] }, 100],
                  },
                  1,
                ],
              },
              null,
            ],
          },
        },
        herald: {
          takes: '$heraldTeam',
          participated: '$heraldPart',
          rate: {
            $cond: [
              { $gt: ['$heraldTeam', 0] },
              {
                $round: [
                  {
                    $multiply: [
                      { $divide: ['$heraldPart', '$heraldTeam'] },
                      100,
                    ],
                  },
                  1,
                ],
              },
              null,
            ],
          },
        },
        baron: {
          takes: '$baronTeam',
          participated: '$baronPart',
          rate: {
            $cond: [
              { $gt: ['$baronTeam', 0] },
              {
                $round: [
                  {
                    $multiply: [{ $divide: ['$baronPart', '$baronTeam'] }, 100],
                  },
                  1,
                ],
              },
              null,
            ],
          },
        },
        atakhan: {
          takes: '$atakhanTeam',
          participated: '$atakhanPart',
          rate: {
            $cond: [
              { $gt: ['$atakhanTeam', 0] },
              {
                $round: [
                  {
                    $multiply: [
                      { $divide: ['$atakhanPart', '$atakhanTeam'] },
                      100,
                    ],
                  },
                  1,
                ],
              },
              null,
            ],
          },
        },
        towers: {
          takes: '$towersTeam',
          participated: '$towersPart',
          rate: {
            $cond: [
              { $gt: ['$towersTeam', 0] },
              {
                $round: [
                  {
                    $multiply: [
                      { $divide: ['$towersPart', '$towersTeam'] },
                      100,
                    ],
                  },
                  1,
                ],
              },
              null,
            ],
          },
        },
        turretPlates: {
          takes: '$turretPlatesTeam',
          participated: '$turretPlatesPart',
          rate: {
            $cond: [
              { $gt: ['$turretPlatesTeam', 0] },
              {
                $round: [
                  {
                    $multiply: [
                      { $divide: ['$turretPlatesPart', '$turretPlatesTeam'] },
                      100,
                    ],
                  },
                  1,
                ],
              },
              null,
            ],
          },
        },
      },

      myChampions: 1,
    },
  },
];
