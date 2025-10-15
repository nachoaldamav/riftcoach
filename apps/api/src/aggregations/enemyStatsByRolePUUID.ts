export const enemyStatsByRolePUUID = (puuid: string) => [
  // CONFIG — default to enemies only so we have exactly 5 roles per match
  {
    $set: { _enemiesOnly: false },
  },

  // 1) Only the user's games (INDEXED via info.participants.puuid)
  {
    $match: {
      'info.participants.puuid': puuid,
    },
  },

  // 2) Project only needed fields and calculate game duration in minutes
  {
    $project: {
      _id: 0,
      matchId: '$metadata.matchId',
      gameDuration: {
        $divide: ['$info.gameDuration', 60],
      },
      participants: {
        $map: {
          input: '$info.participants',
          as: 'p',
          in: {
            participantId: '$$p.participantId',
            puuid: '$$p.puuid',
            teamId: '$$p.teamId',
            teamPosition: {
              $ifNull: ['$$p.teamPosition', 'UNKNOWN'],
            },
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

  // 3) Split out "me" and "others"
  {
    $set: {
      me: {
        $first: {
          $filter: {
            input: '$participants',
            as: 'p',
            cond: {
              $eq: ['$$p.puuid', puuid],
            },
          },
        },
      },
    },
  },
  {
    $set: {
      others: {
        $filter: {
          input: '$participants',
          as: 'p',
          cond: {
            $and: [
              { $ne: ['$$p.puuid', '$me.puuid'] },
              {
                $cond: [
                  '$_enemiesOnly',
                  {
                    $ne: ['$$p.teamId', '$me.teamId'],
                  },
                  true,
                ],
              },
            ],
          },
        },
      },
    },
  },

  // 4) One document per "other" player
  { $unwind: '$others' },

  // 5) Normalize + keep standard roles only
  {
    $set: {
      otherRole: {
        $switch: {
          branches: [
            {
              case: {
                $eq: ['$others.teamPosition', 'TOP'],
              },
              then: 'TOP',
            },
            {
              case: {
                $eq: ['$others.teamPosition', 'JUNGLE'],
              },
              then: 'JUNGLE',
            },
            {
              case: {
                $eq: ['$others.teamPosition', 'MIDDLE'],
              },
              then: 'MIDDLE',
            },
            {
              case: {
                $eq: ['$others.teamPosition', 'BOTTOM'],
              },
              then: 'BOTTOM',
            },
            {
              case: {
                $eq: ['$others.teamPosition', 'UTILITY'],
              },
              then: 'UTILITY',
            },
          ],
          default: 'UNKNOWN',
        },
      },
    },
  },
  {
    $match: {
      otherRole: {
        $in: ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'],
      },
    },
  },

  // 6) Deduplicate: keep at most one opponent per (matchId, role)
  {
    $group: {
      _id: {
        matchId: '$matchId',
        role: '$otherRole',
      },
      doc: { $first: '$$ROOT' },
    },
  },
  { $replaceRoot: { newRoot: '$doc' } },

  // 7) Keep only matches that have ALL 5 roles (so counts are equal across roles)
  {
    $group: {
      _id: '$matchId',
      roles: { $addToSet: '$otherRole' },
      docs: { $push: '$$ROOT' },
    },
  },
  {
    $match: {
      $expr: { $eq: [{ $size: '$roles' }, 5] },
    },
  },
  { $unwind: '$docs' },
  { $replaceRoot: { newRoot: '$docs' } },

  // 8) TIMELINE LOOKUP (after reduction = much cheaper)
  {
    $lookup: {
      from: 'timelines',
      localField: 'matchId',
      foreignField: 'metadata.matchId',
      as: 'tl',
    },
  },
  {
    $unwind: {
      path: '$tl',
      preserveNullAndEmptyArrays: true,
    },
  },

  // 9) Frame extraction helpers
  {
    $set: {
      _frames: {
        $cond: [
          {
            $isArray: {
              $ifNull: [
                {
                  $getField: {
                    input: '$tl.info',
                    field: 'frames',
                  },
                },
                [],
              ],
            },
          },
          {
            $ifNull: [
              {
                $getField: {
                  input: '$tl.info',
                  field: 'frames',
                },
              },
              [],
            ],
          },
          [],
        ],
      },
    },
  },
  { $set: { _len: { $size: '$_frames' } } },
  {
    $set: {
      frame10: {
        $cond: [
          { $gte: ['_len', 11] },
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

  // 10) Snapshot extraction for THIS opponent (others.participantId)
  {
    $set: {
      _pidStr: {
        $toString: '$others.participantId',
      },
    },
  },
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

  // 10.1) Flatten events and filter ELITE_MONSTER_KILL for the opponent's team
  {
    $set: {
      _pidInt: {
        $toInt: '$others.participantId',
      },
      _eliteEvents: {
        $filter: {
          input: {
            $reduce: {
              input: '$_frames',
              initialValue: [],
              in: {
                $concatArrays: [
                  '$$value',
                  {
                    $ifNull: ['$$this.events', []],
                  },
                ],
              },
            },
          },
          as: 'e',
          cond: {
            $eq: ['$$e.type', 'ELITE_MONSTER_KILL'],
          },
        },
      },
    },
  },

  // 10.2) Slice by monster type (only events taken by the opponent's team)
  {
    $set: {
      _drakes: {
        $filter: {
          input: '$_eliteEvents',
          as: 'e',
          cond: {
            $and: [
              {
                $eq: ['$$e.killerTeamId', '$others.teamId'],
              },
              {
                $eq: ['$$e.monsterType', 'DRAGON'],
              },
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
              {
                $eq: ['$$e.killerTeamId', '$others.teamId'],
              },
              {
                $in: ['$$e.monsterType', ['VOIDGRUB', 'VOIDGRUBS', 'HORDE']],
              },
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
              {
                $eq: ['$$e.killerTeamId', '$others.teamId'],
              },
              {
                $in: ['$$e.monsterType', ['RIFTHERALD', 'RIFT_HERALD']],
              },
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
              {
                $eq: ['$$e.killerTeamId', '$others.teamId'],
              },
              {
                $in: ['$$e.monsterType', ['BARON_NASHOR', 'NASHOR']],
              },
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
              {
                $eq: ['$$e.killerTeamId', '$others.teamId'],
              },
              {
                $eq: ['$$e.monsterType', 'ATAKHAN'],
              },
            ],
          },
        },
      },
    },
  },

  // 10.3) Per-type team takes and player participation counts
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
                        [
                          {
                            $ifNull: ['$$e.killerId', -1],
                          },
                        ],
                        {
                          $ifNull: ['$$e.assistingParticipantIds', []],
                        },
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
                        [
                          {
                            $ifNull: ['$$e.killerId', -1],
                          },
                        ],
                        {
                          $ifNull: ['$$e.assistingParticipantIds', []],
                        },
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
                        [
                          {
                            $ifNull: ['$$e.killerId', -1],
                          },
                        ],
                        {
                          $ifNull: ['$$e.assistingParticipantIds', []],
                        },
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
                        [
                          {
                            $ifNull: ['$$e.killerId', -1],
                          },
                        ],
                        {
                          $ifNull: ['$$e.assistingParticipantIds', []],
                        },
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
                        [
                          {
                            $ifNull: ['$$e.killerId', -1],
                          },
                        ],
                        {
                          $ifNull: ['$$e.assistingParticipantIds', []],
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
  },

  // Compute atX snapshots
  {
    $set: {
      otherAt10: {
        $cond: [
          { $ne: ['$frame10', null] },
          {
            cs: {
              $add: [
                {
                  $ifNull: [
                    {
                      $getField: {
                        input: '$_pf10',
                        field: 'minionsKilled',
                      },
                    },
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
                {
                  $getField: {
                    input: '$_pf10',
                    field: 'totalGold',
                  },
                },
                0,
              ],
            },
            xp: {
              $ifNull: [
                {
                  $getField: {
                    input: '$_pf10',
                    field: 'xp',
                  },
                },
                0,
              ],
            },
            level: {
              $ifNull: [
                {
                  $getField: {
                    input: '$_pf10',
                    field: 'level',
                  },
                },
                0,
              ],
            },
          },
          null,
        ],
      },
      otherAt15: {
        $cond: [
          { $ne: ['$frame15', null] },
          {
            cs: {
              $add: [
                {
                  $ifNull: [
                    {
                      $getField: {
                        input: '$_pf15',
                        field: 'minionsKilled',
                      },
                    },
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
                {
                  $getField: {
                    input: '$_pf15',
                    field: 'totalGold',
                  },
                },
                0,
              ],
            },
            xp: {
              $ifNull: [
                {
                  $getField: {
                    input: '$_pf15',
                    field: 'xp',
                  },
                },
                0,
              ],
            },
            level: {
              $ifNull: [
                {
                  $getField: {
                    input: '$_pf15',
                    field: 'level',
                  },
                },
                0,
              ],
            },
          },
          null,
        ],
      },
      otherAt20: {
        $cond: [
          { $ne: ['$frame20', null] },
          {
            cs: {
              $add: [
                {
                  $ifNull: [
                    {
                      $getField: {
                        input: '$_pf20',
                        field: 'minionsKilled',
                      },
                    },
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
                {
                  $getField: {
                    input: '$_pf20',
                    field: 'totalGold',
                  },
                },
                0,
              ],
            },
            xp: {
              $ifNull: [
                {
                  $getField: {
                    input: '$_pf20',
                    field: 'xp',
                  },
                },
                0,
              ],
            },
            level: {
              $ifNull: [
                {
                  $getField: {
                    input: '$_pf20',
                    field: 'level',
                  },
                },
                0,
              ],
            },
          },
          null,
        ],
      },
      otherAt30: {
        $cond: [
          { $ne: ['$frame30', null] },
          {
            cs: {
              $add: [
                {
                  $ifNull: [
                    {
                      $getField: {
                        input: '$_pf30',
                        field: 'minionsKilled',
                      },
                    },
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
                {
                  $getField: {
                    input: '$_pf30',
                    field: 'totalGold',
                  },
                },
                0,
              ],
            },
            xp: {
              $ifNull: [
                {
                  $getField: {
                    input: '$_pf30',
                    field: 'xp',
                  },
                },
                0,
              ],
            },
            level: {
              $ifNull: [
                {
                  $getField: {
                    input: '$_pf30',
                    field: 'level',
                  },
                },
                0,
              ],
            },
          },
          null,
        ],
      },
    },
  },

  // 11) Aggregate by the OPPONENT'S ROLE
  {
    $group: {
      _id: '$otherRole',
      position: { $first: '$otherRole' },
      rowsCount: { $sum: 1 },
      wins: {
        $sum: { $cond: ['$others.win', 1, 0] },
      },

      // per-minute arrays for percentiles/averages
      killsArr: {
        $push: {
          $divide: ['$others.kills', '$gameDuration'],
        },
      },
      deathsArr: {
        $push: {
          $divide: ['$others.deaths', '$gameDuration'],
        },
      },
      assistsArr: {
        $push: {
          $divide: ['$others.assists', '$gameDuration'],
        },
      },
      csArr: {
        $push: {
          $divide: ['$others.totalMinionsKilled', '$gameDuration'],
        },
      },
      damageDealtArr: {
        $push: {
          $divide: ['$others.totalDamageDealtToChampions', '$gameDuration'],
        },
      },
      goldArr: {
        $push: {
          $divide: ['$others.goldEarned', '$gameDuration'],
        },
      },
      visionScoreArr: {
        $push: {
          $divide: ['$others.visionScore', '$gameDuration'],
        },
      },
      damageTakenArr: {
        $push: {
          $divide: ['$others.totalDamageTaken', '$gameDuration'],
        },
      },

      // atXmin stats averages
      avgCSAt10: { $avg: '$otherAt10.cs' },
      avgGoldAt10: { $avg: '$otherAt10.gold' },
      avgXPAt10: { $avg: '$otherAt10.xp' },
      avgLevelAt10: { $avg: '$otherAt10.level' },

      avgCSAt15: { $avg: '$otherAt15.cs' },
      avgGoldAt15: { $avg: '$otherAt15.gold' },
      avgXPAt15: { $avg: '$otherAt15.xp' },
      avgLevelAt15: { $avg: '$otherAt15.level' },

      avgCSAt20: { $avg: '$otherAt20.cs' },
      avgGoldAt20: { $avg: '$otherAt20.gold' },
      avgXPAt20: { $avg: '$otherAt20.xp' },
      avgLevelAt20: { $avg: '$otherAt20.level' },

      avgCSAt30: { $avg: '$otherAt30.cs' },
      avgGoldAt30: { $avg: '$otherAt30.gold' },
      avgXPAt30: { $avg: '$otherAt30.xp' },
      avgLevelAt30: { $avg: '$otherAt30.level' },

      // NEW: objective participation totals
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

      otherChampions: {
        $addToSet: '$others.championName',
      },
    },
  },

  // 12) Final projection with per-minute, percentiles, cleaned atXmin, and objectiveParticipation
  {
    $project: {
      _id: 0,
      position: 1,
      rowsCount: 1,
      winRate: {
        $round: [
          {
            $multiply: [
              {
                $divide: ['$wins', '$rowsCount'],
              },
              100,
            ],
          },
          2,
        ],
      },

      killsPerMin: {
        $round: [{ $avg: '$killsArr' }, 2],
      },
      deathsPerMin: {
        $round: [{ $avg: '$deathsArr' }, 2],
      },
      assistsPerMin: {
        $round: [{ $avg: '$assistsArr' }, 2],
      },
      csPerMin: {
        $round: [{ $avg: '$csArr' }, 2],
      },
      damageDealtPerMin: {
        $round: [{ $avg: '$damageDealtArr' }, 0],
      },
      goldPerMin: {
        $round: [{ $avg: '$goldArr' }, 0],
      },
      visionScorePerMin: {
        $round: [{ $avg: '$visionScoreArr' }, 2],
      },
      damageTakenPerMin: {
        $round: [{ $avg: '$damageTakenArr' }, 0],
      },

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
        cs: {
          $ifNull: [{ $round: ['$avgCSAt10', 1] }, 0],
        },
        gold: {
          $ifNull: [{ $round: ['$avgGoldAt10', 0] }, 0],
        },
        xp: {
          $ifNull: [{ $round: ['$avgXPAt10', 0] }, 0],
        },
        level: {
          $ifNull: [{ $round: ['$avgLevelAt10', 1] }, 0],
        },
      },
      at15Min: {
        cs: {
          $ifNull: [{ $round: ['$avgCSAt15', 1] }, 0],
        },
        gold: {
          $ifNull: [{ $round: ['$avgGoldAt15', 0] }, 0],
        },
        xp: {
          $ifNull: [{ $round: ['$avgXPAt15', 0] }, 0],
        },
        level: {
          $ifNull: [{ $round: ['$avgLevelAt15', 1] }, 0],
        },
      },
      at20Min: {
        cs: {
          $ifNull: [{ $round: ['$avgCSAt20', 1] }, 0],
        },
        gold: {
          $ifNull: [{ $round: ['$avgGoldAt20', 0] }, 0],
        },
        xp: {
          $ifNull: [{ $round: ['$avgXPAt20', 0] }, 0],
        },
        level: {
          $ifNull: [{ $round: ['$avgLevelAt20', 1] }, 0],
        },
      },
      at30Min: {
        cs: {
          $ifNull: [{ $round: ['$avgCSAt30', 1] }, 0],
        },
        gold: {
          $ifNull: [{ $round: ['$avgGoldAt30', 0] }, 0],
        },
        xp: {
          $ifNull: [{ $round: ['$avgXPAt30', 0] }, 0],
        },
        level: {
          $ifNull: [{ $round: ['$avgLevelAt30', 1] }, 0],
        },
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
                      {
                        $divide: ['$drakesPart', '$drakesTeam'],
                      },
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
                    $multiply: [
                      {
                        $divide: ['$grubsPart', '$grubsTeam'],
                      },
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
                      {
                        $divide: ['$heraldPart', '$heraldTeam'],
                      },
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
                    $multiply: [
                      {
                        $divide: ['$baronPart', '$baronTeam'],
                      },
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
                      {
                        $divide: ['$atakhanPart', '$atakhanTeam'],
                      },
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

      otherChampions: 1,
    },
  },
];
