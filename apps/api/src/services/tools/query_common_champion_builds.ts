import { collections } from '@riftcoach/clients.mongodb';
import type { Document } from 'mongodb';
import {
  getItemMap,
  inferPatchFromGameVersion,
} from '../../utils/ddragon-items.js';
import type { ToolSpec } from './types.js';
import type { ToolRuntimeContext } from './types.js';

type BuildEntry = {
  matchId: string | null;
  items: number[];
};

type ItemMetadata = {
  tags?: string[];
  name?: string;
  gold?: { total?: number };
  into?: string[];
  from?: string[];
  depth?: number;
  group?: string; // DDragon unique group
};

type ItemMetadataMap = Record<number, ItemMetadata>;

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function extractItems(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isNumber).map((n) => Math.trunc(n));
}

function isTier2Boot(id: number): boolean {
  return [3006, 3009, 3020, 3047, 3111, 3117, 3158].includes(id);
}

function isCompletedItem(id: number, itemMap: ItemMetadataMap): boolean {
  const item = itemMap[id];
  if (!item) return true;
  const tags = (item.tags || []).map((tag) => String(tag).toLowerCase());
  const name = String(item.name || '').toLowerCase();
  if (tags.includes('trinket')) return false;
  if (tags.includes('consumable') || /elixir|potion|ward|cookie/.test(name))
    return false;
  if (isTier2Boot(id)) return true;
  if (tags.includes('mythic')) return true;
  if (Array.isArray(item.into) && item.into.length > 0) return false;
  const total = Number(item.gold?.total ?? 0);
  if (total >= 2300) return true;
  const depth = Number(item.depth ?? 0);
  if (depth >= 3) return true;
  return total >= 900 && (!item.from || item.from.length === 0);
}

function filterCompletedItems(
  ids: number[],
  itemMap: ItemMetadataMap,
): number[] {
  return ids.filter((id) => isCompletedItem(id, itemMap));
}

async function runAggregation(
  championName: string | undefined,
  role: string | undefined,
  limit: number,
): Promise<BuildEntry[]> {
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

  const pipeline: Document[] = [
    { $match: preMatch },
    {
      $project: {
        _id: 0,
        matchId: '$metadata.matchId',
        participants: {
          $map: {
            input: '$info.participants',
            as: 'p',
            in: {
              championName: '$$p.championName',
              teamPosition: { $ifNull: ['$$p.teamPosition', 'UNKNOWN'] },
              items: [
                '$$p.item0',
                '$$p.item1',
                '$$p.item2',
                '$$p.item3',
                '$$p.item4',
                '$$p.item5',
                '$$p.item6',
              ],
            },
          },
        },
      },
    },
    { $unwind: '$participants' },
    {
      $match: {
        ...(championName ? { 'participants.championName': championName } : {}),
        ...(role ? { 'participants.teamPosition': role } : {}),
      },
    },
    {
      $project: {
        matchId: 1,
        items: '$participants.items',
      },
    },
    { $limit: Math.max(50, limit * 20) },
  ];

  const docs = await collections.matches
    .aggregate(pipeline, { allowDiskUse: true, maxTimeMS: 20_000 })
    .toArray();

  return docs.map((doc) => ({
    matchId: typeof doc.matchId === 'string' ? doc.matchId : null,
    items: extractItems(doc.items),
  }));
}

function summarizeBuilds(
  entries: BuildEntry[],
  itemMap: ItemMetadataMap,
  limit: number,
): Array<{
  completedItemIds: number[];
  count: number;
  sampleMatchIds: string[];
}> {
  const counts = new Map<
    string,
    { items: number[]; count: number; matches: string[] }
  >();
  for (const entry of entries) {
    const completed = filterCompletedItems(entry.items, itemMap);
    if (completed.length === 0) continue;
    const key = completed.join('-');
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
      if (entry.matchId && existing.matches.length < 5) {
        existing.matches.push(entry.matchId);
      }
    } else {
      counts.set(key, {
        items: completed,
        count: 1,
        matches: entry.matchId ? [entry.matchId] : [],
      });
    }
  }

  return [...counts.values()]
    .sort((a, b) => {
      const lenDiff = b.items.length - a.items.length;
      if (lenDiff !== 0) return lenDiff;
      return b.count - a.count;
    })
    .slice(0, limit)
    .map((entry) => ({
      completedItemIds: entry.items,
      count: entry.count,
      sampleMatchIds: entry.matches,
    }));
}

function resolveChampion(
  input: Record<string, unknown>,
  runtimeCtx: ToolRuntimeContext,
): string | undefined {
  const raw = (input as { championName?: unknown }).championName;
  if (typeof raw === 'string' && raw.trim().length) return raw.trim();
  const ctxSubject = (runtimeCtx.ctx as { subject?: unknown }).subject as
    | { championName?: unknown }
    | undefined;
  if (ctxSubject && typeof ctxSubject.championName === 'string') {
    return ctxSubject.championName;
  }
  return undefined;
}

function resolveRole(
  input: Record<string, unknown>,
  runtimeCtx: ToolRuntimeContext,
): string | undefined {
  const raw = (input as { role?: unknown }).role;
  if (typeof raw === 'string' && raw.trim().length) return raw.trim();
  const ctxSubject = (runtimeCtx.ctx as { subject?: unknown }).subject as
    | { teamPosition?: unknown }
    | undefined;
  if (ctxSubject && typeof ctxSubject.teamPosition === 'string') {
    return ctxSubject.teamPosition;
  }
  return undefined;
}

export const queryCommonChampionBuildsTool: ToolSpec = {
  name: 'query_common_champion_builds',
  description:
    'Returns the most common completed item builds for a champion and role. Items include only finished purchases (mythics, legendaries, tier-2 boots).',
  schema: {
    type: 'object',
    properties: {
      championName: { type: 'string' },
      role: {
        type: 'string',
        enum: ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY', 'UNKNOWN'],
      },
      limit: { type: 'integer', minimum: 1, maximum: 10 },
    },
    additionalProperties: false,
  },
  async execute(input, runtimeCtx) {
    const championName = resolveChampion(input, runtimeCtx);
    const role = resolveRole(input, runtimeCtx);
    const rawLimit = (input as { limit?: unknown }).limit;
    const limit =
      typeof rawLimit === 'number' && Number.isFinite(rawLimit)
        ? Math.max(1, Math.min(10, Math.trunc(rawLimit)))
        : 10;

    const entries = await runAggregation(championName, role, limit);
    const ctxItems = runtimeCtx.ctx.items as { patch?: string } | undefined;
    const infoObj = runtimeCtx.ctx.info as { gameVersion?: string } | undefined;
    const patch =
      ctxItems?.patch ?? inferPatchFromGameVersion(infoObj?.gameVersion);
    const itemMap = await getItemMap(patch);
    const builds = summarizeBuilds(entries, itemMap, limit);

    return {
      championName,
      role,
      patch,
      totalSamples: entries.length,
      builds,
    };
  },
};
