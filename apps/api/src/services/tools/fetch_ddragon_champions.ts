import consola from 'consola';
import { findChampionByName, getChampionMap } from '../../utils/ddragon-champions.js';
import { inferPatchFromGameVersion } from '../../utils/ddragon-items.js';
import type { ToolSpec, ToolRuntimeContext } from './types.js';
import { buildAbilityHintFromDDragon } from './utils.js';

export const fetchDDragonChampionsTool: ToolSpec = {
  name: 'fetch_ddragon_champions',
  description:
    'Fetch champion metadata and quick ability heuristics from DDragon for the provided champion names.',
  schema: {
    type: 'object',
    properties: {
      patch: { type: 'string' },
      names: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    required: ['names'],
    additionalProperties: false,
  },
  async execute(input: Record<string, unknown>, runtimeCtx: ToolRuntimeContext): Promise<Record<string, unknown>> {
    const names = Array.isArray((input as { names?: unknown }).names)
      ? ((input as { names?: unknown }).names as unknown[])
          .map((n) => String(n ?? '').trim())
          .filter((n) => n.length > 0)
      : [];

    const ctxItems = runtimeCtx.ctx.items as { patch?: string } | undefined;
    const infoObj = runtimeCtx.ctx.info as { gameVersion?: string } | undefined;
    const rawPatch = (input as { patch?: unknown }).patch;
    const patch =
      (typeof rawPatch === 'string' && rawPatch.length > 0 ? rawPatch : ctxItems?.patch) ?? inferPatchFromGameVersion(infoObj?.gameVersion);

    try {
      const champMap = await getChampionMap(patch);
      const champions = names
        .map((n) => {
          const ch = findChampionByName(n, champMap);
          if (!ch) return null;
          return {
            name: ch.name,
            key: ch.key,
            title: ch.title,
            abilityHints: buildAbilityHintFromDDragon(ch),
          };
        })
        .filter((ch): ch is NonNullable<typeof ch> => !!ch);
      return { patch, champions };
    } catch (error) {
      consola.warn('[match-insights] champion tool failed', error);
      return { patch, champions: [] };
    }
  },
};