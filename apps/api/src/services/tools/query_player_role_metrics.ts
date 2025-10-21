import { collections } from '@riftcoach/clients.mongodb';
import consola from 'consola';
import type { Document } from 'mongodb';
import type { ToolSpec } from './types.js';

export const queryPlayerRoleMetricsTool: ToolSpec = {
  name: 'query_player_role_metrics',
  description:
    'Retrieve player-specific averages per champion and role (games played, KDA, CS, gold, damage, win rate).',
  schema: {
    type: 'object',
    properties: {
      puuid: { type: 'string' },
      role: {
        type: 'string',
        enum: ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY', 'UNKNOWN'],
      },
      championName: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 20 },
    },
    required: ['puuid'],
    additionalProperties: false,
  },
  async execute(input) {
    const rawPuuid = (input as { puuid?: unknown }).puuid;
    const puuid = typeof rawPuuid === 'string' && rawPuuid.trim().length ? rawPuuid.trim() : '';
    const rawRole = (input as { role?: unknown }).role;
    const role = typeof rawRole === 'string' && rawRole.length > 0 ? rawRole : undefined;
    const rawChampionName = (input as { championName?: unknown }).championName;
    const championName =
      typeof rawChampionName === 'string' && rawChampionName.trim().length
        ? rawChampionName.trim()
        : undefined;
    const rawLimit = (input as { limit?: unknown }).limit;
    const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit)
      ? Math.min(Math.max(1, Math.trunc(rawLimit)), 20)
      : 5;

    const match: Record<string, unknown> = {
      'info.queueId': { $in: [400, 420, 440, 430] },
      'info.participants.puuid': puuid,
    };

    const pipeline: Document[] = [
      { $match: match },
      { $unwind: '$info.participants' },
      {
        $match: {
          'info.participants.puuid': puuid,
          ...(championName
            ? { 'info.participants.championName': championName }
            : {}),
          ...(role ? { 'info.participants.teamPosition': role } : {}),
        },
      },
      {
        $group: {
          _id: {
            role: '$info.participants.teamPosition',
            championName: '$info.participants.championName',
          },
          games: { $sum: 1 },
          avgKills: { $avg: '$info.participants.kills' },
          avgDeaths: { $avg: '$info.participants.deaths' },
          avgAssists: { $avg: '$info.participants.assists' },
          avgGold: { $avg: '$info.participants.goldEarned' },
          avgDamage: { $avg: '$info.participants.totalDamageDealtToChampions' },
          winRate: { $avg: { $cond: [{ $eq: ['$info.participants.win', true] }, 1, 0] } },
        },
      },
      { $sort: { games: -1 } },
      { $limit: limit },
    ];

    try {
      const results = await collections.matches.aggregate(pipeline).toArray();
      return { puuid, role, championName, results };
    } catch (error) {
      consola.error('[match-insights] player stats tool failed', error);
      return { puuid, role, championName, results: [] };
    }
  },
};