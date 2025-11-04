import {
  DDragon,
  type RiotAPITypes,
  regionToCluster,
} from '@fightmegg/riot-api';
import { client, collections } from '@riftcoach/clients.mongodb';
import { type Region, riot } from '@riftcoach/clients.riot';
import {
  ALLOWED_QUEUE_IDS,
  DDRAGON_DEFAULT_PATCH,
  ROLES,
} from '@riftcoach/shared.constants';
import { type Job, Queue, Worker, type WorkerOptions } from 'bullmq';
import chalk from 'chalk';
import { consola } from 'consola';
import type { Document } from 'mongodb';
// @ts-ignore
import ms from 'ms';
import { connection } from './clients/redis.js';

const ddragon = new DDragon();

// Helper to keep BullMQ jobIds/name free of forbidden characters (e.g., ':')
const safeIdPart = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '-');

// ---- Cohort helpers -------------------------------------------------------
// Minimal DDragon champion list fetcher (cached in Redis)
async function getChampionNames(
  patch = DDRAGON_DEFAULT_PATCH,
): Promise<string[]> {
  const data = await ddragon.champion.all({
    version: patch,
  });
  const names = Object.values(data.data)
    .map((c) => c.id)
    .filter((n): n is string => typeof n === 'string' && n.length > 0)
    .sort();

  return names;
}

// Completed item ids for first completion time metric (cached in-memory)
let cachedCompletedItemIds: number[] | null = null;
let cachedCompletedItemIdsTs = 0;
const COMPLETED_ITEMS_TTL_MS = 60 * 60 * 1000; // 1h
async function getCompletedItemIds(): Promise<number[]> {
  if (
    Array.isArray(cachedCompletedItemIds) &&
    cachedCompletedItemIds.length > 0 &&
    Date.now() - cachedCompletedItemIdsTs < COMPLETED_ITEMS_TTL_MS
  ) {
    return cachedCompletedItemIds;
  }
  const data = await ddragon.items();
  function isCompleted(
    it: RiotAPITypes.DDragon.DDragonItemWrapperDTO['data'],
  ): boolean {
    if (!Array.isArray(it?.from) || it.from.length === 0) return false;
    if (it?.consumed) return false;
    const depth = Number(it?.depth ?? 0) || 0;
    if (Array.isArray(it?.tags) && it.tags.includes('Boots')) {
      return depth >= 2;
    }
    return depth >= 3 || !Array.isArray(it?.into) || it.into.length === 0;
  }
  cachedCompletedItemIds = Object.entries(data)
    .filter(([, it]) => isCompleted(it))
    .map(([id]) => Number(id))
    .filter((n) => Number.isFinite(n));
  cachedCompletedItemIdsTs = Date.now();
  return cachedCompletedItemIds;
}

// Cohort percentiles pipeline (mirrors apps/api aggregation)
export type CohortPercentilesDoc = {
  championName: string;
  role: string;
  percentiles: {
    p50: Record<string, number | null>;
    p75: Record<string, number | null>;
    p90: Record<string, number | null>;
    p95: Record<string, number | null>;
  };
};

type CohortPercentilesRecord = CohortPercentilesDoc & {
  year: number;
  patch?: string;
  updatedAt: number;
};

const cohortChampionRolePercentilesAggregation = (params: {
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

    {
      $project: {
        matchId: '$metadata.matchId',
        gameCreation: '$info.gameCreation',
        gameDuration: '$info.gameDuration',
        participants: '$info.participants',
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
        deathsPerMin: {
          $divide: ['$participants.deaths', '$gameDurationMin'],
        },
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
                    $map: {
                      input: '$tl.items',
                      as: 'i',
                      in: '$$i.timestamp',
                    },
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

    {
      $project: {
        role: 1,
        puuid: '$participants.puuid', // Added puuid
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

    // NEW: Group by player to get per-player averages
    {
      $group: {
        _id: {
          role: '$role',
          puuid: '$puuid',
        },
        kills: { $avg: '$kills' },
        deaths: { $avg: '$deaths' },
        assists: { $avg: '$assists' },
        cs: { $avg: '$cs' },
        cspm: { $avg: '$cspm' },
        goldEarned: { $avg: '$goldEarned' },
        goldAt10: { $avg: '$goldAt10' },
        csAt10: { $avg: '$csAt10' },
        goldAt15: { $avg: '$goldAt15' },
        csAt15: { $avg: '$csAt15' },
        dpm: { $avg: '$dpm' },
        dtpm: { $avg: '$dtpm' },
        kpm: { $avg: '$kpm' },
        apm: { $avg: '$apm' },
        deathsPerMin: { $avg: '$deathsPerMin' },
        firstItemCompletionTime: { $avg: '$firstItemCompletionTime' },
        objectiveParticipationPct: { $avg: '$objectiveParticipationPct' },
        earlyGankDeathRate: { $avg: '$earlyGankDeathRate' },
        matchCount: { $sum: 1 },
      },
    },

    // Simplify role for final grouping
    {
      $set: {
        role: '$_id.role',
      },
    },

    // Filter out players with null firstItemCompletionTime before calculating percentiles
    {
      $match: {
        firstItemCompletionTime: { $ne: null }
      }
    },

    // Calculate percentiles on player averages
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

const cohortAggOptions = { allowDiskUse: true, maxTimeMS: 60_000 } as const;

const priorities = {
  'list-matches': 100,
  'fetch-timeline': 500,
  'fetch-match': 1000,
};

interface BaseJobOptions {
  type: string;
  rewindId?: string;
}

interface ListMatchesJobOptions extends BaseJobOptions {
  type: 'list-matches';
  puuid: string;
  start: number;
  region: RiotAPITypes.LoLRegion;
  startTimestamp?: number;
  scanType?: 'full' | 'partial';
}

interface FetchMatchJobOptions extends BaseJobOptions {
  type: 'fetch-match';
  matchId: string;
  region: RiotAPITypes.LoLRegion;
}

interface FetchTimelineJobOptions extends BaseJobOptions {
  type: 'fetch-timeline';
  matchId: string;
  region: RiotAPITypes.LoLRegion;
}

type MergedJobOptions =
  | ListMatchesJobOptions
  | FetchMatchJobOptions
  | FetchTimelineJobOptions;

export const queues: Record<RiotAPITypes.Cluster, Queue<MergedJobOptions>> = {
  americas: new Queue<MergedJobOptions>('americas', { connection }),
  europe: new Queue<MergedJobOptions>('europe', { connection }),
  asia: new Queue<MergedJobOptions>('asia', { connection }),
  sea: new Queue<MergedJobOptions>('sea', { connection }),
  esports: new Queue<MergedJobOptions>('esports', { connection }),
};

const workerFn = async (job: Job<MergedJobOptions>) => {
  const { type, rewindId } = job.data;
  switch (type) {
    case 'list-matches': {
      const { puuid, start, region, startTimestamp, scanType } = job.data;
      consola.info(
        chalk.greenBright(
          `Listing matches for ${puuid} (${scanType || 'full'} scan)`,
        ),
      );

      const requestOptions: {
        start: number;
        count: number;
        startTime?: number;
      } = {
        start,
        count: 100,
      };

      // For partial scans, add startTime filter
      if (scanType === 'partial' && startTimestamp) {
        requestOptions.startTime = Math.floor(startTimestamp / 1000); // Riot API expects seconds
        consola.info(
          chalk.yellow(
            `Filtering matches from ${new Date(startTimestamp).toISOString()}`,
          ),
        );
      }

      const matches = await riot.getIdsByPuuid(
        regionToCluster(region) as Region,
        puuid,
        requestOptions,
      );

      if (matches.length === 100) {
        await queues[regionToCluster(region)].add(
          `list-matches-${puuid}-${start + 100}`,
          {
            type: 'list-matches',
            puuid,
            start: start + 100,
            region,
            rewindId,
            startTimestamp,
            scanType,
          },
          {
            delay: ms('1s'),
            priority: priorities['list-matches'],
          },
        );
        await connection.incr(`rewind:${rewindId}:listing`);
      } else {
        await connection.set(`rewind:${rewindId}:status`, 'processing');

        // Update last scan timestamp when scan is complete
        if (rewindId) {
          await connection.set(`rewind:${rewindId}:last_scan`, Date.now());
        }
      }

      if (rewindId) {
        await connection.incrby(`rewind:${rewindId}:matches`, matches.length);
        await connection.incrby(`rewind:${rewindId}:total`, matches.length);
        await connection.decr(`rewind:${rewindId}:listing`);
      }

      // Exclude matches that already exist in the database
      const existingMatches = await collections.matches
        .find({
          'metadata.matchId': { $in: matches },
        })
        .project({ 'metadata.matchId': 1 })
        .toArray();

      const missingMatches = matches.filter(
        (match) =>
          !existingMatches.map((m) => m.metadata.matchId).includes(match),
      );

      const alreadyProcessed = existingMatches.map((m) => m.metadata.matchId);

      // Increase processed matches
      await connection.incrby(
        `rewind:${rewindId}:processed`,
        alreadyProcessed.length,
      );
      // Decrease pending matches
      await connection.decrby(
        `rewind:${rewindId}:matches`,
        alreadyProcessed.length,
      );

      if (rewindId) {
        const listing = await connection.get(`rewind:${rewindId}:listing`);
        const matches = await connection.get(`rewind:${rewindId}:matches`);
        if (listing === '0' && matches === '0') {
          consola.info(
            chalk.yellow(
              `No more matches to process for rewindId: ${rewindId}`,
            ),
          );
          await connection.set(`rewind:${rewindId}:status`, 'completed');

          consola.info(
            chalk.yellow(`Deleting cache for rewindId: ${rewindId}`),
          );
          // Delete exact keys
          await connection.del(`cache:stats:${rewindId}`);
          await connection.del(`cache:ai-badges:${rewindId}`);
          await connection.del(`cache:champion-insights:${rewindId}`);

          // Delete pattern-based keys (recent matches and champion mastery with different limits)
          const recentMatchKeys = await connection.keys(
            `cache:recent-matches:${rewindId}:*`,
          );
          const championMasteryKeys = await connection.keys(
            `cache:champion-mastery:v2:${rewindId}:*`,
          );
          const champInsightsKeys = await connection.keys(
            `cache:champion-insights:v2:${rewindId}:*`,
          );

          if (recentMatchKeys.length > 0) {
            await connection.del(...recentMatchKeys);
          }
          if (championMasteryKeys.length > 0) {
            await connection.del(...championMasteryKeys);
          }
          if (champInsightsKeys.length > 0) {
            await connection.del(...champInsightsKeys);
          }

          consola.info(
            chalk.yellow(
              `Deleted ${recentMatchKeys.length + championMasteryKeys.length + champInsightsKeys.length} cache keys`,
            ),
          );

          // Remove from visual queue
          const cluster = regionToCluster(region);
          await connection.zrem(`rewind:queue:${cluster}` as string, rewindId);
        }
      }

      await queues[regionToCluster(region)].addBulk(
        missingMatches.map((match) => ({
          name: `fetch-match-${match}`,
          data: {
            type: 'fetch-match',
            matchId: match,
            region,
            rewindId,
          },
          opts: {
            delay: ms('1s'),
            priority: priorities['fetch-match'],
          },
        })),
      );

      consola.success(chalk.green(`Matches for ${puuid} added to queue`));
      break;
    }

    case 'fetch-match': {
      const { matchId, region } = job.data;
      consola.info(chalk.greenBright(`Fetching match for ${matchId}`));
      const match = await riot
        .getMatchById(regionToCluster(region) as Region, matchId)
        .catch((error) => {
          consola.error(error);
          return null;
        });

      if (!match) {
        break;
      }

      await collections.matches.updateOne(
        { 'metadata.matchId': matchId },
        { $set: match },
        { upsert: true },
      );
      consola.success(chalk.green(`Match for ${matchId} saved`));

      await queues[regionToCluster(region)].add(
        `fetch-timeline-${matchId}`,
        {
          type: 'fetch-timeline',
          matchId,
          region,
          rewindId,
        },
        {
          delay: ms('1s'),
          priority: priorities['fetch-timeline'],
        },
      );

      break;
    }
    case 'fetch-timeline': {
      const { matchId, region, cluster } =
        job.data as FetchTimelineJobOptions & {
          cluster: string;
        };
      const isLegacyJob = !!cluster;
      consola.info(
        chalk.greenBright(
          `Fetching timeline for ${matchId} (${cluster ?? region})`,
        ),
      );
      const timeline = await riot.getTimeline(
        // @ts-expect-error
        regionToCluster(isLegacyJob ? cluster : region) as Region,
        matchId,
      );
      await collections.timelines.updateOne(
        { 'metadata.matchId': matchId },
        { $set: timeline as RiotAPITypes.MatchV5.MatchTimelineDTO },
        { upsert: true },
      );

      if (rewindId) {
        await connection.incr(`rewind:${rewindId}:processed`);
        await connection.decr(`rewind:${rewindId}:matches`);
        const listing = await connection.get(`rewind:${rewindId}:listing`);
        const matches = await connection.get(`rewind:${rewindId}:matches`);
        if (listing === '0' && matches === '0') {
          await connection.set(`rewind:${rewindId}:status`, 'completed');

          // Delete all player-specific caches
          await connection.del(`cache:stats:${rewindId}`);
          await connection.del(`cache:ai-badges:${rewindId}`);
          await connection.del(`cache:champion-insights:${rewindId}`);

          // Delete pattern-based keys (recent matches and champion mastery with different limits)
          const recentMatchKeys = await connection.keys(
            `cache:recent-matches:${rewindId}:*`,
          );
          const championMasteryKeys = await connection.keys(
            `cache:champion-mastery:v2:${rewindId}:*`,
          );
          const champInsightsKeys = await connection.keys(
            `cache:champion-insights:v2:${rewindId}:*`,
          );

          if (recentMatchKeys.length > 0) {
            await connection.del(...recentMatchKeys);
          }
          if (championMasteryKeys.length > 0) {
            await connection.del(...championMasteryKeys);
          }
          if (champInsightsKeys.length > 0) {
            await connection.del(...champInsightsKeys);
          }

          // Remove from visual queue
          const targetCluster = isLegacyJob
            ? (cluster as RiotAPITypes.Cluster)
            : regionToCluster(region);
          await connection.zrem(
            `rewind:queue:${targetCluster}` as string,
            rewindId,
          );
        }
      }

      consola.success(
        chalk.green(`Timeline for ${matchId} (${cluster ?? region}) saved`),
      );
      break;
    }
  }
};

const sharedWorkerOptions: WorkerOptions = {
  connection,
  concurrency: 1,
  limiter: {
    duration: ms('10s'),
    max: 10,
  },
};

type SharedWorker =
  | ListMatchesJobOptions
  | FetchMatchJobOptions
  | FetchTimelineJobOptions;

export let workers: Record<
  RiotAPITypes.Cluster,
  Worker<SharedWorker>
> = {} as Record<RiotAPITypes.Cluster, Worker<SharedWorker>>;

export function setupQueues() {
  consola.info(chalk.blue('Setting up queues...'));
  for (const [, queue] of Object.entries(queues)) {
    consola.success(chalk.green(`${queue.name} initialized...`));
  }
  // Cohorts queue (pre-processing percentiles)
  consola.success(chalk.green('cohorts initialized...'));
  consola.success(chalk.green('Queues setup complete'));
}

export function setupWorkers() {
  consola.info(chalk.blue('Setting up workers...'));

  workers = {
    americas: new Worker<SharedWorker>(
      queues.americas.name,
      workerFn,
      sharedWorkerOptions,
    ),
    europe: new Worker<SharedWorker>(
      queues.europe.name,
      workerFn,
      sharedWorkerOptions,
    ),
    asia: new Worker<SharedWorker>(
      queues.asia.name,
      workerFn,
      sharedWorkerOptions,
    ),
    sea: new Worker<SharedWorker>(
      queues.sea.name,
      workerFn,
      sharedWorkerOptions,
    ),
    esports: new Worker<SharedWorker>(
      queues.esports.name,
      workerFn,
      sharedWorkerOptions,
    ),
  };

  for (const [cluster, worker] of Object.entries(workers)) {
    worker.on('error', (error) => {
      consola.error(`[${cluster}]`, error);
    });
  }

  consola.success(chalk.green('Workers setup complete'));

  // Cohorts worker and scheduler
  setupCohortWorker();
  scheduleCohortsDaily(3).catch((err) => {
    consola.warn('[cohorts] scheduling failed', err);
  });
}

// -------------------- Cohorts queue & worker -------------------------------
interface CohortOrchestrateJob {
  type: 'cohort-orchestrate';
  year: number;
  patch?: string;
}
interface CohortProcessJob {
  type: 'cohort-process';
  championName: string;
  role: (typeof ROLES)[number] | string;
  year: number;
  patch?: string;
}
type CohortJob = CohortOrchestrateJob | CohortProcessJob;

export const cohortsQ = new Queue<CohortJob>('cohorts', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 1000,
    removeOnFail: 1000,
  },
});

const cohortWorkerConcurrency = Number(
  process.env.COHORT_WORKER_CONCURRENCY ??
    (process.env.NODE_ENV === 'production' ? 3 : 1),
);
export let cohortsWorker: Worker<CohortJob>;

function cohortWorkerFn(job: Job<CohortJob>) {
  const { type } = job.data;
  switch (type) {
    case 'cohort-orchestrate':
      return (async () => {
        const data = job.data as CohortOrchestrateJob;
        const year = data.year;
        const patch = data.patch ?? DDRAGON_DEFAULT_PATCH;
        consola.info(
          chalk.blue(`[cohorts] Orchestrating cohort processing for ${year}`),
        );
        const champions = await getChampionNames(patch);

        consola.info(chalk.blue(champions));

        if (champions.length === 0) {
          consola.warn('[cohorts] No champions found; skipping orchestration');
          return;
        }
        // Create process jobs in batches
        const roles = Array.from(ROLES);
        const addBulkPayload: Parameters<typeof cohortsQ.addBulk>[0] = [];
        for (const name of champions) {
          for (const role of roles) {
            const jobId = `cohort-process-${year}-${safeIdPart(name)}-${safeIdPart(String(role))}`;
            addBulkPayload.push({
              name: jobId,
              data: {
                type: 'cohort-process',
                championName: name,
                role,
                year,
                patch,
              },
              opts: { jobId, priority: 100, delay: ms('500ms') },
            });
          }
        }
        // Split into chunks of 100 to avoid oversized multi-add
        const chunkSize = 100;
        for (let i = 0; i < addBulkPayload.length; i += chunkSize) {
          const chunk = addBulkPayload.slice(i, i + chunkSize);
          await cohortsQ.addBulk(chunk);
        }
        // Metrics
        await connection.incrby(
          'metrics:cohorts:scheduled',
          addBulkPayload.length,
        );
        await connection.set(
          'metrics:cohorts:last_orchestrate',
          String(Date.now()),
        );
        consola.success(
          chalk.green(
            `[cohorts] Scheduled ${addBulkPayload.length} cohort-process jobs for ${year}`,
          ),
        );
      })();
    case 'cohort-process':
      return (async () => {
        const data = job.data as CohortProcessJob;
        const { championName, role } = data;
        const year = data.year;
        const startTs = Date.UTC(year, 0, 1);
        const endTs = Date.UTC(year + 1, 0, 1);
        const completedItemIds = await getCompletedItemIds();
        const pipeline = cohortChampionRolePercentilesAggregation({
          championName,
          role: String(role),
          startTs,
          endTs,
          winsOnly: false,
          sampleLimit: Number(
            process.env.COHORT_SAMPLE_LIMIT ??
              (process.env.NODE_ENV === 'production' ? 10000 : 3000),
          ),
          sortDesc: true,
          completedItemIds,
        });
        const start = Date.now();
        const docs = await collections.matches
          .aggregate<CohortPercentilesDoc>(pipeline, cohortAggOptions)
          .toArray()
          .catch((err) => {
            consola.warn(
              '[cohorts] aggregation failed',
              championName,
              role,
              err,
            );
            return [] as CohortPercentilesDoc[];
          });
        const end = Date.now();
        const doc = docs[0] ?? null;
        const cacheKey = `cache:cohort:percentiles:v5:${championName}:${role}:${year}:limit10000`;
        if (doc) {
          await connection.set(
            cacheKey,
            JSON.stringify(doc),
            'EX',
            Math.floor(ms('7d') / 1000),
          );
          // Persist to MongoDB collection (upsert by championName+role+year)
          try {
            const cohortsColl = client
              .db('riftcoach')
              .collection<CohortPercentilesRecord>('cohort_percentiles');
            await cohortsColl.updateOne(
              { championName, role: String(role), year },
              {
                $set: {
                  ...doc,
                  year,
                  patch: data.patch ?? DDRAGON_DEFAULT_PATCH,
                  updatedAt: Date.now(),
                },
              },
              { upsert: true },
            );
          } catch (err) {
            consola.warn('[cohorts] persist failed', championName, role, err);
          }
          await connection.incr('metrics:cohorts:processed');
          await connection.set(
            `metrics:cohorts:last_process:${championName}:${role}`,
            String(Date.now()),
          );
          consola.success(
            chalk.green(
              `[cohorts] processed ${championName} ${role} in ${end - start}ms`,
            ),
          );
        } else {
          await connection.incr('metrics:cohorts:skipped');
          consola.info(
            chalk.yellow(
              `[cohorts] no data for ${championName} ${role} (${end - start}ms)`,
            ),
          );
        }
      })();
  }
}

export function setupCohortWorker() {
  cohortsWorker = new Worker<CohortJob>(cohortsQ.name, cohortWorkerFn, {
    connection,
    concurrency: cohortWorkerConcurrency,
  });
  cohortsWorker.on('completed', async (job) => {
    await connection.incr('metrics:cohorts:jobs_completed');
  });
  cohortsWorker.on('failed', async (job, err) => {
    await connection.incr('metrics:cohorts:jobs_failed');
    consola.error('[cohorts] job failed', job?.name, err);
  });
  consola.success(chalk.green('Cohorts worker setup complete'));
}

export async function scheduleCohortsDaily(atHourUTC = 3) {
  const nowYear = Number(
    process.env.COHORT_YEAR ?? new Date().getUTCFullYear(),
  );
  const jobName = `cohort-orchestrate-${nowYear}`;
  const cron = `0 0 ${atHourUTC} * * *`;
  if (String(process.env.ENABLE_COHORT_SCHEDULER ?? 'true') !== 'true') {
    consola.info(
      chalk.yellow('[cohorts] scheduler disabled via ENABLE_COHORT_SCHEDULER'),
    );
    return;
  }
  await cohortsQ.add(
    jobName,
    { type: 'cohort-orchestrate', year: nowYear },
    {
      repeat: { pattern: cron, tz: 'UTC' },
      jobId: `cohort-orchestrate-${nowYear}`,
      removeOnComplete: true,
      removeOnFail: 100,
    },
  );
  consola.success(
    chalk.green(
      `[cohorts] scheduled daily orchestrate at 03:00 UTC (cron: ${cron})`,
    ),
  );
  // Missed execution catch-up (run once if older than 36h)
  const last =
    Number(await connection.get('metrics:cohorts:last_orchestrate')) || 0;
  if (!last || Date.now() - last > ms('36h')) {
    consola.info(
      chalk.yellow('[cohorts] last orchestrate stale; triggering catch-up'),
    );
    await cohortsQ.add(
      'cohort-orchestrate-catchup',
      { type: 'cohort-orchestrate', year: nowYear },
      {
        jobId: `cohort-orchestrate-${nowYear}-catchup`,
        removeOnComplete: true,
      },
    );
  }
}

export async function shutdownWorkers() {
  consola.info(chalk.yellow('Shutting down workers...'));
  await Promise.all(Object.values(workers).map((worker) => worker.close()));
  if (cohortsWorker) {
    try {
      await cohortsWorker.close();
    } catch (err) {
      consola.warn('[cohorts] worker close failed', err);
    }
  }
  consola.success(chalk.green('Workers shutdown complete'));
}

export async function monitorQueues(): Promise<{
  totalWaiting: number;
  totalActive: number;
}> {
  let totalWaiting = 0;
  let totalActive = 0;

  for (const [region, queue] of Object.entries(queues)) {
    const waiting = await queue.getWaiting();
    const active = await queue.getActive();
    totalWaiting += waiting.length;
    totalActive += active.length;

    if (waiting.length > 0 || active.length > 0) {
      consola.info(
        chalk.blue(
          `${region}: ${waiting.length} waiting, ${active.length} active`,
        ),
      );
    }
  }

  // Include cohorts in totals
  const cohortsWaiting = await cohortsQ.getWaiting();
  const cohortsActive = await cohortsQ.getActive();
  totalWaiting += cohortsWaiting.length;
  totalActive += cohortsActive.length;

  // Cohorts queue status
  if (cohortsWaiting.length > 0 || cohortsActive.length > 0) {
    consola.info(
      chalk.blue(
        `cohorts: ${cohortsWaiting.length} waiting, ${cohortsActive.length} active`,
      ),
    );
  }

  return { totalWaiting, totalActive };
}
