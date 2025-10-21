import consola from 'consola';
import { redis } from '../clients/redis.js';

export type DDragonItem = {
  name: string;
  plaintext?: string;
  gold?: { base?: number; total?: number; sell?: number; purchasable?: boolean };
  tags?: string[];
  from?: string[];
  into?: string[];
  stats?: Record<string, number>;
  effect?: Record<string, string>;
  depth?: number;
};

export type ItemMap = Record<number, DDragonItem>;

function normalizePatch(patch: string | null | undefined): string {
  const v = String(patch || '');
  const m = v.match(/(\d+)\.(\d+)/);
  if (m) return `${m[1]}.${m[2]}.1`;
  // Fallback to a reasonable default; can be overridden at runtime
  return '15.18.1';
}

export function inferPatchFromGameVersion(gameVersion: string | null | undefined): string {
  return normalizePatch(gameVersion);
}

async function fetchDDragonItems(patch: string): Promise<ItemMap> {
  const url = `https://ddragon.leagueoflegends.com/cdn/${patch}/data/en_US/item.json`;
  const res = await fetch(url);
  if (!res.ok) {
    consola.warn(`[ddragon-items] Failed to fetch item.json for ${patch}: ${res.status} ${res.statusText}`);
    throw new Error(`Failed to fetch ddragon items for ${patch}`);
  }
  const json = await res.json();
  const data = (json?.data || {}) as Record<string, DDragonItem>;
  const out: ItemMap = {};
  for (const [idStr, item] of Object.entries(data)) {
    const id = Number(idStr);
    if (Number.isFinite(id)) out[id] = item;
  }
  return out;
}

export async function getItemMap(patchRaw: string | null | undefined): Promise<ItemMap> {
  const patch = normalizePatch(patchRaw);
  const cacheKey = `cache:ddragon:items:${patch}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as ItemMap;
    }
  } catch (err) {
    consola.warn('[ddragon-items] redis get failed', err);
  }

  const items = await fetchDDragonItems(patch);

  try {
    // Cache for 3 days
    await redis.set(cacheKey, JSON.stringify(items), 'EX', 60 * 60 * 24 * 3);
  } catch (err) {
    consola.warn('[ddragon-items] redis set failed', err);
  }

  return items;
}

export function resolveItemNames(ids: Array<number | null | undefined>, items: ItemMap): string[] {
  const names: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'number' || !Number.isFinite(id)) continue;
    const item = items[id];
    if (item?.name) names.push(item.name);
  }
  return names;
}

export function pickItemMeta(
  ids: Array<number | null | undefined>,
  items: ItemMap,
): Record<number, { name: string; plaintext?: string; tags?: string[]; goldTotal?: number; goldBase?: number }> {
  const out: Record<number, { name: string; plaintext?: string; tags?: string[]; goldTotal?: number; goldBase?: number }> = {};
  for (const id of ids) {
    if (typeof id !== 'number' || !Number.isFinite(id)) continue;
    const it = items[id];
    if (it) {
      out[id] = {
        name: it.name,
        plaintext: it.plaintext,
        tags: it.tags || [],
        goldTotal: it.gold?.total,
        goldBase: it.gold?.base,
      };
    }
  }
  return out;
}