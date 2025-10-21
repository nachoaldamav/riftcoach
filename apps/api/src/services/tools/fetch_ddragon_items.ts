import consola from 'consola';
import type { ItemMap } from '../../utils/ddragon-items.js';
import { getItemMap, inferPatchFromGameVersion } from '../../utils/ddragon-items.js';
import type { ToolSpec, ToolRuntimeContext } from './types.js';

export const fetchDDragonItemsTool: ToolSpec = {
  name: 'fetch_ddragon_items',
  description:
    'Retrieve League of Legends item metadata from DDragon by numeric IDs or fuzzy name search.',
  schema: {
    type: 'object',
    properties: {
      patch: { type: 'string' },
      itemIds: {
        type: 'array',
        items: { type: 'integer' },
      },
      query: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
    additionalProperties: false,
  },
  async execute(input: Record<string, unknown>, runtimeCtx: ToolRuntimeContext): Promise<Record<string, unknown>> {
    const itemIdsRaw = Array.isArray((input as { itemIds?: unknown }).itemIds)
      ? ((input as { itemIds?: unknown }).itemIds as unknown[])
          .map((v) => Number(v))
          .filter((v) => Number.isFinite(v))
      : [];
    const rawQuery = (input as { query?: unknown }).query;
    const query = typeof rawQuery === 'string' && rawQuery.trim().length > 0
      ? rawQuery.trim().toLowerCase()
      : null;
    const rawLimit = (input as { limit?: unknown }).limit;
    const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit)
      ? Math.min(Math.max(1, Math.trunc(rawLimit)), 50)
      : 20;

    const ctxItems = runtimeCtx.ctx.items as { patch?: string } | undefined;
    const infoObj = runtimeCtx.ctx.info as { gameVersion?: string } | undefined;
    const rawPatch = (input as { patch?: unknown }).patch;
    const patch =
      (typeof rawPatch === 'string' && rawPatch.length > 0 ? rawPatch : ctxItems?.patch) ?? inferPatchFromGameVersion(infoObj?.gameVersion);

    let itemMap: ItemMap;
    try {
      itemMap = await getItemMap(patch);
    } catch (error) {
      consola.warn('[match-insights] item tool failed to load DDragon', error);
      itemMap = {} as ItemMap;
    }

    const entries = Object.entries(itemMap);
    const filtered = entries
      .filter(([idStr, item]) => {
        const id = Number(idStr);
        if (itemIdsRaw.length > 0 && itemIdsRaw.includes(id)) {
          return true;
        }
        if (query) {
          const haystack = `${item.name} ${(item.plaintext ?? '').toLowerCase()}`.toLowerCase();
          return haystack.includes(query);
        }
        return itemIdsRaw.length === 0 && !query;
      })
      .slice(0, limit)
      .map(([idStr, item]) => ({
        id: Number(idStr),
        name: item.name,
        plaintext: item.plaintext ?? null,
        tags: item.tags ?? [],
        gold: item.gold ?? null,
        depth: item.depth ?? null,
      }));

    return {
      patch,
      count: filtered.length,
      items: filtered,
    };
  },
};