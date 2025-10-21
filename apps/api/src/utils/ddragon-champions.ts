import consola from 'consola';
import { redis } from '../clients/redis.js';

export type DDragonChampionSpell = {
  id?: string;
  name?: string;
  description?: string;
  tooltip?: string;
  sanitizedDescription?: string;
};

export type DDragonChampion = {
  key: string; // numeric string id
  id: string; // canonical key name, e.g. "Senna"
  name: string; // display name, e.g. "Senna"
  title?: string;
  blurb?: string;
  partype?: string;
  stats?: Record<string, number>;
  spells?: DDragonChampionSpell[];
  passive?: { name?: string; description?: string; sanitizedDescription?: string } | null;
};

export type ChampionMapById = Record<number, DDragonChampion>;

// Define the raw champion JSON shape to avoid any
interface ChampionDDJson {
  key: string;
  id: string;
  name: string;
  title?: string;
  blurb?: string;
  partype?: string;
  stats?: Record<string, number>;
  spells?: Array<{
    id?: string;
    name?: string;
    description?: string;
    tooltip?: string;
    sanitizedDescription?: string;
  }>;
  passive?: {
    name?: string;
    description?: string;
    sanitizedDescription?: string;
  };
}

function normalizePatch(patch: string | null | undefined): string {
  const v = String(patch || '');
  const m = v.match(/(\d+)\.(\d+)/);
  if (m) return `${m[1]}.${m[2]}.1`;
  // Fallback to a reasonable default; can be overridden at runtime
  return '15.18.1';
}

async function fetchDDragonChampions(patch: string): Promise<ChampionMapById> {
  const url = `https://ddragon.leagueoflegends.com/cdn/${patch}/data/en_US/champion.json`;
  const res = await fetch(url);
  if (!res.ok) {
    consola.warn(`[ddragon-champions] Failed to fetch champion.json for ${patch}: ${res.status} ${res.statusText}`);
    throw new Error(`Failed to fetch ddragon champions for ${patch}`);
  }
  const json = await res.json();
  const data = (json?.data || {}) as Record<string, ChampionDDJson>;
  const out: ChampionMapById = {};
  for (const [, champ] of Object.entries(data)) {
    const keyStr: string = String(champ?.key || '');
    const idNum = Number(keyStr);
    if (!Number.isFinite(idNum)) continue;
    const spells: DDragonChampionSpell[] = Array.isArray(champ?.spells)
      ? champ.spells.map((s: {
          id?: string;
          name?: string;
          description?: string;
          tooltip?: string;
          sanitizedDescription?: string;
        }) => ({
          id: s?.id,
          name: s?.name,
          description: s?.description,
          tooltip: s?.tooltip,
          sanitizedDescription: s?.sanitizedDescription,
        }))
      : [];
    const passive = champ?.passive
      ? {
          name: champ.passive?.name,
          description: champ.passive?.description,
          sanitizedDescription: champ.passive?.sanitizedDescription,
        }
      : null;
    out[idNum] = {
      key: keyStr,
      id: String(champ?.id || ''),
      name: String(champ?.name || ''),
      title: champ?.title,
      blurb: champ?.blurb,
      partype: champ?.partype,
      stats: champ?.stats,
      spells,
      passive,
    };
  }
  return out;
}

export async function getChampionMap(patchRaw: string | null | undefined): Promise<ChampionMapById> {
  const patch = normalizePatch(patchRaw);
  const cacheKey = `cache:ddragon:champions:${patch}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as ChampionMapById;
    }
  } catch (err) {
    consola.warn('[ddragon-champions] redis get failed', err);
  }

  const champs = await fetchDDragonChampions(patch);

  try {
    // Cache for 3 days
    await redis.set(cacheKey, JSON.stringify(champs), 'EX', 60 * 60 * 24 * 3);
  } catch (err) {
    consola.warn('[ddragon-champions] redis set failed', err);
  }

  return champs;
}

export function findChampionByName(name: string | null | undefined, map: ChampionMapById): DDragonChampion | null {
  const n = String(name || '').trim();
  if (!n) return null;
  for (const ch of Object.values(map)) {
    if (ch.name === n || ch.id === n) return ch;
  }
  return null;
}