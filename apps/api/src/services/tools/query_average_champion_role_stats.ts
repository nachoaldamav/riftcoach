import { collections } from '@riftcoach/clients.mongodb';
import type { Document } from 'mongodb';
import type { ToolSpec } from './types.js';

export const queryAverageChampionRoleStatsTool: ToolSpec = {
  name: 'query_average_champion_role_stats',
  description:
    'Query MongoDB for aggregated averages per champion and role (kills, deaths, assists, damage, CS, vision, win rate).',
  schema: {
    type: 'object',
    properties: {
      championName: { type: 'string' },
      role: {
        type: 'string',
        enum: ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY', 'UNKNOWN'],
      },
      limit: { type: 'integer', minimum: 1, maximum: 20 },
    },
    additionalProperties: false,
  },
  async execute(input) {
    const rawChampionName = (input as { championName?: unknown }).championName;
    const championName =
      typeof rawChampionName === 'string' && rawChampionName.trim().length
        ? rawChampionName.trim()
        : undefined;

    const rawRole = (input as { role?: unknown }).role;
    const role =
      typeof rawRole === 'string' && rawRole.length > 0 ? rawRole : undefined;

    const rawLimit = (input as { limit?: unknown }).limit;
    const limit =
      typeof rawLimit === 'number' && Number.isFinite(rawLimit)
        ? Math.min(Math.max(1, Math.trunc(rawLimit)), 20)
        : 5;

    const preMatch: Record<string, unknown> = {
      'info.queueId': { $in: [400, 420, 430, 440] },
    };

    if (championName || role) {
      preMatch['info.participants'] = {
        $elemMatch: {
          ...(championName ? { championName } : {}),
          ...(role ? { teamPosition: role } : {}),
        },
      };
    }

    const pipeline = [
      { $match: preMatch },

      // Keep only the participant fields we need
      {
        $project: {
          _id: 0,
          participants: {
            $map: {
              input: '$info.participants',
              as: 'p',
              in: {
                championName: '$$p.championName',
                teamPosition: { $ifNull: ['$$p.teamPosition', 'UNKNOWN'] },
                kills: '$$p.kills',
                deaths: '$$p.deaths',
                assists: '$$p.assists',
                totalDamageDealtToChampions: '$$p.totalDamageDealtToChampions',
                totalMinionsKilled: '$$p.totalMinionsKilled',
                visionScore: '$$p.visionScore',
                win: '$$p.win',
              },
            },
          },
        },
      },

      { $unwind: '$participants' },

      // Cheap post-unwind filter
      {
        $match: {
          ...(championName
            ? { 'participants.championName': championName }
            : {}),
          ...(role ? { 'participants.teamPosition': role } : {}),
        },
      },

      {
        $group: {
          _id: {
            championName: '$participants.championName',
            role: '$participants.teamPosition',
          },
          games: { $sum: 1 },
          avgKills: { $avg: '$participants.kills' },
          avgDeaths: { $avg: '$participants.deaths' },
          avgAssists: { $avg: '$participants.assists' },
          avgDamage: { $avg: '$participants.totalDamageDealtToChampions' },
          avgCs: { $avg: '$participants.totalMinionsKilled' },
          avgVisionScore: { $avg: '$participants.visionScore' },
          winRate: { $avg: { $toInt: '$participants.win' } },
        },
      },

      { $sort: { games: -1 } },
      { $limit: limit },
    ] as Document[];

    try {
      const results = await collections.matches
        .aggregate(pipeline, {
          allowDiskUse: true,
          maxTimeMS: 20_000,
          // hint: 'idx_participant_champ_role_queue', // enable if planner goes rogue
        })
        .toArray();

      return { championName, role, results };
    } catch (error) {
      // You might want to log `error` with more context
      return { championName, role, results: [] };
    }
  },
};
