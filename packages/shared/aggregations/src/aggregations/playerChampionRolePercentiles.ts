import { ALLOWED_QUEUE_IDS } from '@riftcoach/shared.constants';
import type { Document } from 'mongodb';

const mapParticipantsToRoles = {
  $arrayToObject: {
    $map: {
      input: '$info.participants',
      as: 'p',
      in: {
        k: { $toString: '$$p.participantId' },
        v: {
          $switch: {
            branches: [
              { case: { $eq: ['$$p.teamPosition', 'TOP'] }, then: 'TOP' },
              { case: { $eq: ['$$p.teamPosition', 'JUNGLE'] }, then: 'JUNGLE' },
              {
                case: { $in: ['$$p.teamPosition', ['MIDDLE', 'MID']] },
                then: 'MIDDLE',
              },
              {
                case: { $in: ['$$p.teamPosition', ['BOTTOM', 'ADC', 'BOT']] },
                then: 'BOTTOM',
              },
              {
                case: {
                  $in: ['$$p.teamPosition', ['UTILITY', 'SUPPORT', 'SUP']],
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
};

const percentileRound = (
  field: string,
  probability: number,
  digits: number,
) => ({
  $round: [
    {
      $arrayElemAt: [
        {
          $percentile: {
            input: `$${field}`,
            p: [probability],
            method: 'approximate',
          },
        },
        0,
      ],
    },
    digits,
  ],
});

const percentileRoundNullable = (
  field: string,
  probability: number,
  digits: number,
) => ({
  $let: {
    vars: { arr: `$${field}` },
    in: {
      $cond: [
        { $gt: [{ $size: '$$arr' }, 0] },
        {
          $round: [
            {
              $arrayElemAt: [
                {
                  $percentile: {
                    input: '$$arr',
                    p: [probability],
                    method: 'approximate',
                  },
                },
                0,
              ],
            },
            digits,
          ],
        },
        null,
      ],
    },
  },
});

/**
 * Lower-is-better helpers: invert -> percentile -> invert back
 */
const percentileRoundLower = (
  field: string,
  probability: number,
  digits: number,
) => ({
  $round: [
    {
      $multiply: [
        -1,
        {
          $arrayElemAt: [
            {
              $percentile: {
                input: {
                  $map: {
                    input: `$${field}`,
                    as: 'v',
                    in: { $multiply: [-1, '$$v'] },
                  },
                },
                p: [probability],
                method: 'approximate',
              },
            },
            0,
          ],
        },
      ],
    },
    digits,
  ],
});

const percentileRoundNullableLower = (
  field: string,
  probability: number,
  digits: number,
) => ({
  $let: {
    vars: { arr: `$${field}` },
    in: {
      $cond: [
        { $gt: [{ $size: '$$arr' }, 0] },
        {
          $round: [
            {
              $multiply: [
                -1,
                {
                  $arrayElemAt: [
                    {
                      $percentile: {
                        input: {
                          $map: {
                            input: '$$arr',
                            as: 'v',
                            in: { $multiply: [-1, '$$v'] },
                          },
                        },
                        p: [probability],
                        method: 'approximate',
                      },
                    },
                    0,
                  ],
                },
              ],
            },
            digits,
          ],
        },
        null,
      ],
    },
  },
});

export const playerChampRolePercentilesAggregation = (
  puuid: string,
  championName: string,
  role: string,
  options?: { completedItemIds?: number[] },
): Document[] => {
  const completedItemIds = options?.completedItemIds ?? [];

  return [
    {
      $match: {
        'info.participants.puuid': puuid,
        'info.queueId': { $in: ALLOWED_QUEUE_IDS }, // align with cohort filters
      },
    },
    {
      $set: {
        participantIdMap: mapParticipantsToRoles,
      },
    },
    { $unwind: '$info.participants' },
    {
      $match: {
        'info.participants.puuid': puuid,
        'info.participants.championName': championName,
      },
    },
    {
      $set: {
        playerRole: {
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
        playerParticipantId: '$info.participants.participantId',
      },
    },
    { $match: { playerRole: role } },
    {
      $lookup: {
        from: 'timelines',
        let: {
          matchId: '$metadata.matchId',
          pId: '$playerParticipantId',
        },
        pipeline: [
          { $match: { $expr: { $eq: ['$metadata.matchId', '$$matchId'] } } },
          {
            $project: {
              _id: 0,
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
              allEvents: {
                $reduce: {
                  input: { $ifNull: ['$info.frames', []] },
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
              earlyDeaths: {
                $filter: {
                  input: '$allEvents',
                  as: 'e',
                  cond: {
                    $and: [
                      { $eq: ['$$e.type', 'CHAMPION_KILL'] },
                      { $eq: ['$$e.victimId', '$$pId'] },
                      { $lt: ['$$e.timestamp', 900000] },
                      { $gt: ['$$e.killerId', 0] },
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
        as: 'timeline',
      },
    },
    {
      $set: {
        timeline: {
          $ifNull: [
            { $first: '$timeline' },
            {
              goldAt10: 0,
              csAt10: 0,
              goldAt15: 0,
              csAt15: 0,
              objectives: [],
              earlyDeaths: [],
              items: [],
            },
          ],
        },
      },
    },
    {
      $set: {
        gameDurationMin: {
          $max: [1, { $divide: [{ $ifNull: ['$info.gameDuration', 0] }, 60] }],
        },
        role: '$playerRole',
        championName: '$info.participants.championName',
        kills: { $ifNull: ['$info.participants.kills', 0] },
        deaths: { $ifNull: ['$info.participants.deaths', 0] },
        assists: { $ifNull: ['$info.participants.assists', 0] },
        cs: {
          $add: [
            { $ifNull: ['$info.participants.totalMinionsKilled', 0] },
            { $ifNull: ['$info.participants.neutralMinionsKilled', 0] },
          ],
        },
        goldEarned: { $ifNull: ['$info.participants.goldEarned', 0] },
        goldAt10: '$timeline.goldAt10',
        csAt10: '$timeline.csAt10',
        goldAt15: '$timeline.goldAt15',
        csAt15: '$timeline.csAt15',
        firstItemCompletionTime: {
          $cond: [
            { $gt: [{ $size: { $ifNull: ['$timeline.items', []] } }, 0] },
            {
              $divide: [
                {
                  $min: {
                    $map: {
                      input: '$timeline.items',
                      as: 'item',
                      in: '$$item.timestamp',
                    },
                  },
                },
                1000, // seconds since game start
              ],
            },
            null,
          ],
        },
        objectiveParticipationPct: {
          $let: {
            vars: {
              objectives: '$timeline.objectives',
            },
            in: {
              $let: {
                vars: {
                  total: { $size: { $ifNull: ['$$objectives', []] } },
                  involved: {
                    $size: {
                      $filter: {
                        input: { $ifNull: ['$$objectives', []] },
                        as: 'o',
                        cond: {
                          $or: [
                            { $eq: ['$$o.killerId', '$playerParticipantId'] },
                            {
                              $in: [
                                '$playerParticipantId',
                                {
                                  $ifNull: ['$$o.assistingParticipantIds', []],
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
                    { $gt: ['$$total', 0] },
                    { $divide: ['$$involved', '$$total'] },
                    null,
                  ],
                },
              },
            },
          },
        },
        win: { $cond: ['$info.participants.win', 1, 0] },
      },
    },
    {
      $set: {
        cspm: { $divide: ['$cs', '$gameDurationMin'] },
        dpm: {
          $divide: [
            { $ifNull: ['$info.participants.totalDamageDealtToChampions', 0] },
            '$gameDurationMin',
          ],
        },
        dtpm: {
          $divide: [
            { $ifNull: ['$info.participants.totalDamageTaken', 0] },
            '$gameDurationMin',
          ],
        },
        kpm: {
          $divide: [
            { $ifNull: ['$info.participants.kills', 0] },
            '$gameDurationMin',
          ],
        },
        apm: {
          $divide: [
            { $ifNull: ['$info.participants.assists', 0] },
            '$gameDurationMin',
          ],
        },
        deathsPerMin: {
          $divide: [
            { $ifNull: ['$info.participants.deaths', 0] },
            '$gameDurationMin',
          ],
        },
        earlyGankDeathRate: {
          $cond: [
            { $eq: ['$role', 'JUNGLE'] },
            null,
            {
              $size: {
                $filter: {
                  input: '$timeline.earlyDeaths',
                  as: 'death',
                  cond: {
                    $let: {
                      vars: {
                        killerRole: {
                          $getField: {
                            field: { $toString: '$$death.killerId' },
                            input: '$participantIdMap',
                          },
                        },
                        assistRoles: {
                          $map: {
                            input: {
                              $ifNull: ['$$death.assistingParticipantIds', []],
                            },
                            as: 'assistId',
                            in: {
                              $getField: {
                                field: { $toString: '$$assistId' },
                                input: '$participantIdMap',
                              },
                            },
                          },
                        },
                      },
                      in: {
                        $gt: [
                          {
                            $size: {
                              $filter: {
                                input: {
                                  $concatArrays: [
                                    [{ $ifNull: ['$$killerRole', null] }],
                                    '$$assistRoles',
                                  ],
                                },
                                as: 'attackerRole',
                                cond: {
                                  $and: [
                                    { $ne: ['$$attackerRole', null] },
                                    { $ne: ['$$attackerRole', 'UNKNOWN'] },
                                    {
                                      $not: {
                                        $or: [
                                          { $eq: ['$$attackerRole', '$role'] },
                                          {
                                            $and: [
                                              {
                                                $in: [
                                                  '$role',
                                                  ['BOTTOM', 'UTILITY'],
                                                ],
                                              },
                                              {
                                                $in: [
                                                  '$$attackerRole',
                                                  ['BOTTOM', 'UTILITY'],
                                                ],
                                              },
                                            ],
                                          },
                                        ],
                                      },
                                    },
                                  ],
                                },
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
            },
          ],
        },
      },
    },
    {
      $project: {
        participantIdMap: 0,
        timeline: 0,
        playerParticipantId: 0,
        playerRole: 0,
      },
    },
    {
      $group: {
        _id: {
          champ: '$championName',
          role: '$role',
        },
        totalMatches: { $sum: 1 },
        wins: { $sum: '$win' },
        killsArr: { $push: '$kills' },
        deathsArr: { $push: '$deaths' },
        assistsArr: { $push: '$assists' },
        csArr: { $push: '$cs' },
        cspmArr: { $push: '$cspm' },
        goldEarnedArr: { $push: '$goldEarned' },
        goldAt10Arr: { $push: '$goldAt10' },
        csAt10Arr: { $push: '$csAt10' },
        goldAt15Arr: { $push: '$goldAt15' },
        csAt15Arr: { $push: '$csAt15' },
        dpmArr: { $push: '$dpm' },
        dtpmArr: { $push: '$dtpm' },
        kpmArr: { $push: '$kpm' },
        apmArr: { $push: '$apm' },
        deathsPerMinArr: { $push: '$deathsPerMin' },
        firstItemCompletionArr: { $push: '$firstItemCompletionTime' },
        objectiveParticipationArr: { $push: '$objectiveParticipationPct' },
        earlyGankDeathRateArr: { $push: '$earlyGankDeathRate' },
        avgKills: { $avg: '$kills' },
        avgDeaths: { $avg: '$deaths' },
        avgAssists: { $avg: '$assists' },
        avgGoldEarned: { $avg: '$goldEarned' },
        avgCS: { $avg: '$cs' },
        avgCspm: { $avg: '$cspm' },
        avgGoldAt10: { $avg: '$goldAt10' },
        avgCsAt10: { $avg: '$csAt10' },
        avgGoldAt15: { $avg: '$goldAt15' },
        avgCsAt15: { $avg: '$csAt15' },
        avgDpm: { $avg: '$dpm' },
        avgDtpm: { $avg: '$dtpm' },
        avgKpm: { $avg: '$kpm' },
        avgApm: { $avg: '$apm' },
        avgDeathsPerMin: { $avg: '$deathsPerMin' },
        avgObjectiveParticipationPct: { $avg: '$objectiveParticipationPct' },
        avgEarlyGankDeathRate: { $avg: '$earlyGankDeathRate' },
        avgFirstItemCompletionTime: { $avg: '$firstItemCompletionTime' },
      },
    },
    {
      $set: {
        _firstItemCompletionArr: {
          $filter: {
            input: '$firstItemCompletionArr',
            as: 'val',
            cond: {
              $and: [
                { $ne: ['$$val', null] },
                {
                  $in: [
                    { $type: '$$val' },
                    ['double', 'int', 'long', 'decimal'],
                  ],
                },
              ],
            },
          },
        },
        _objectiveParticipationArr: {
          $filter: {
            input: '$objectiveParticipationArr',
            as: 'val',
            cond: { $ne: ['$$val', null] },
          },
        },
        _earlyGankDeathRateArr: {
          $filter: {
            input: '$earlyGankDeathRateArr',
            as: 'val',
            cond: { $ne: ['$$val', null] },
          },
        },
      },
    },
    {
      $project: {
        _id: 0,
        championName: '$_id.champ',
        role: '$_id.role',
        totalMatches: 1,
        wins: 1,
        losses: { $subtract: ['$totalMatches', '$wins'] },
        winRate: {
          $cond: [
            { $gt: ['$totalMatches', 0] },
            { $divide: ['$wins', '$totalMatches'] },
            0,
          ],
        },
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
        avgCspm: { $round: ['$avgCspm', 3] },
        avgGoldAt10: { $round: ['$avgGoldAt10', 0] },
        avgCsAt10: { $round: ['$avgCsAt10', 1] },
        avgGoldAt15: { $round: ['$avgGoldAt15', 0] },
        avgCsAt15: { $round: ['$avgCsAt15', 1] },
        avgDpm: { $round: ['$avgDpm', 1] },
        avgDtpm: { $round: ['$avgDtpm', 1] },
        avgKpm: { $round: ['$avgKpm', 3] },
        avgApm: { $round: ['$avgApm', 3] },
        avgDeathsPerMin: { $round: ['$avgDeathsPerMin', 3] },
        avgObjectiveParticipationPct: {
          $cond: [
            { $ne: ['$avgObjectiveParticipationPct', null] },
            { $round: ['$avgObjectiveParticipationPct', 3] },
            null,
          ],
        },
        avgEarlyGankDeathRate: {
          $cond: [
            { $ne: ['$avgEarlyGankDeathRate', null] },
            { $round: ['$avgEarlyGankDeathRate', 2] },
            null,
          ],
        },
        avgFirstItemCompletionTime: {
          $cond: [
            { $ne: ['$avgFirstItemCompletionTime', null] },
            { $round: ['$avgFirstItemCompletionTime', 2] },
            null,
          ],
        },
        percentiles: {
          p50: {
            kills: percentileRound('killsArr', 0.5, 2),
            deaths: percentileRoundLower('deathsArr', 0.5, 2),
            assists: percentileRound('assistsArr', 0.5, 2),
            cs: percentileRound('csArr', 0.5, 1),
            cspm: percentileRound('cspmArr', 0.5, 3),
            goldEarned: percentileRound('goldEarnedArr', 0.5, 0),
            goldAt10: percentileRound('goldAt10Arr', 0.5, 0),
            csAt10: percentileRound('csAt10Arr', 0.5, 1),
            goldAt15: percentileRound('goldAt15Arr', 0.5, 0),
            csAt15: percentileRound('csAt15Arr', 0.5, 1),
            dpm: percentileRound('dpmArr', 0.5, 1),
            dtpm: percentileRoundLower('dtpmArr', 0.5, 1),
            kpm: percentileRound('kpmArr', 0.5, 3),
            apm: percentileRound('apmArr', 0.5, 3),
            deathsPerMin: percentileRoundLower('deathsPerMinArr', 0.5, 3),
            firstItemCompletionTime: percentileRoundNullableLower(
              '_firstItemCompletionArr',
              0.5,
              2,
            ),
            objectiveParticipationPct: percentileRoundNullable(
              '_objectiveParticipationArr',
              0.5,
              3,
            ),
            earlyGankDeathRate: percentileRoundNullableLower(
              '_earlyGankDeathRateArr',
              0.5,
              2,
            ),
          },
          p75: {
            kills: percentileRound('killsArr', 0.75, 2),
            deaths: percentileRoundLower('deathsArr', 0.75, 2),
            assists: percentileRound('assistsArr', 0.75, 2),
            cs: percentileRound('csArr', 0.75, 1),
            cspm: percentileRound('cspmArr', 0.75, 3),
            goldEarned: percentileRound('goldEarnedArr', 0.75, 0),
            goldAt10: percentileRound('goldAt10Arr', 0.75, 0),
            csAt10: percentileRound('csAt10Arr', 0.75, 1),
            goldAt15: percentileRound('goldAt15Arr', 0.75, 0),
            csAt15: percentileRound('csAt15Arr', 0.75, 1),
            dpm: percentileRound('dpmArr', 0.75, 1),
            dtpm: percentileRoundLower('dtpmArr', 0.75, 1),
            kpm: percentileRound('kpmArr', 0.75, 3),
            apm: percentileRound('apmArr', 0.75, 3),
            deathsPerMin: percentileRoundLower('deathsPerMinArr', 0.75, 3),
            firstItemCompletionTime: percentileRoundNullableLower(
              '_firstItemCompletionArr',
              0.75,
              2,
            ),
            objectiveParticipationPct: percentileRoundNullable(
              '_objectiveParticipationArr',
              0.75,
              3,
            ),
            earlyGankDeathRate: percentileRoundNullableLower(
              '_earlyGankDeathRateArr',
              0.75,
              2,
            ),
          },
          p90: {
            kills: percentileRound('killsArr', 0.9, 2),
            deaths: percentileRoundLower('deathsArr', 0.9, 2),
            assists: percentileRound('assistsArr', 0.9, 2),
            cs: percentileRound('csArr', 0.9, 1),
            cspm: percentileRound('cspmArr', 0.9, 3),
            goldEarned: percentileRound('goldEarnedArr', 0.9, 0),
            goldAt10: percentileRound('goldAt10Arr', 0.9, 0),
            csAt10: percentileRound('csAt10Arr', 0.9, 1),
            goldAt15: percentileRound('goldAt15Arr', 0.9, 0),
            csAt15: percentileRound('csAt15Arr', 0.9, 1),
            dpm: percentileRound('dpmArr', 0.9, 1),
            dtpm: percentileRoundLower('dtpmArr', 0.9, 1),
            kpm: percentileRound('kpmArr', 0.9, 3),
            apm: percentileRound('apmArr', 0.9, 3),
            deathsPerMin: percentileRoundLower('deathsPerMinArr', 0.9, 3),
            firstItemCompletionTime: percentileRoundNullableLower(
              '_firstItemCompletionArr',
              0.9,
              2,
            ),
            objectiveParticipationPct: percentileRoundNullable(
              '_objectiveParticipationArr',
              0.9,
              3,
            ),
            earlyGankDeathRate: percentileRoundNullableLower(
              '_earlyGankDeathRateArr',
              0.9,
              2,
            ),
          },
          p95: {
            kills: percentileRound('killsArr', 0.95, 2),
            deaths: percentileRoundLower('deathsArr', 0.95, 2),
            assists: percentileRound('assistsArr', 0.95, 2),
            cs: percentileRound('csArr', 0.95, 1),
            cspm: percentileRound('cspmArr', 0.95, 3),
            goldEarned: percentileRound('goldEarnedArr', 0.95, 0),
            goldAt10: percentileRound('goldAt10Arr', 0.95, 0),
            csAt10: percentileRound('csAt10Arr', 0.95, 1),
            goldAt15: percentileRound('goldAt15Arr', 0.95, 0),
            csAt15: percentileRound('csAt15Arr', 0.95, 1),
            dpm: percentileRound('dpmArr', 0.95, 1),
            dtpm: percentileRoundLower('dtpmArr', 0.95, 1),
            kpm: percentileRound('kpmArr', 0.95, 3),
            apm: percentileRound('apmArr', 0.95, 3),
            deathsPerMin: percentileRoundLower('deathsPerMinArr', 0.95, 3),
            firstItemCompletionTime: percentileRoundNullableLower(
              '_firstItemCompletionArr',
              0.95,
              2,
            ),
            objectiveParticipationPct: percentileRoundNullable(
              '_objectiveParticipationArr',
              0.95,
              3,
            ),
            earlyGankDeathRate: percentileRoundNullableLower(
              '_earlyGankDeathRateArr',
              0.95,
              2,
            ),
          },
        },
      },
    },
    { $sort: { role: 1 } },
  ];
};
