import type { RiotAPITypes } from '@fightmegg/riot-api';
import type { DDragon } from '@fightmegg/riot-api';
import { collections } from '@riftcoach/clients.mongodb';
import { ALLOWED_QUEUE_IDS } from '@riftcoach/shared.constants';
import type { Item } from '@riftcoach/shared.lol-types';
import consola from 'consola';
import { riotAPI } from '../clients/riot.js';
import { getItemMap, inferPatchFromGameVersion, type ItemMap } from '../utils/ddragon-items.js';

// Strict item data shape for enriched itemsData
type ItemDataResolved = {
  id: number;
  name: string;
  plaintext?: string;
  tags: string[];
  gold?: { base?: number; total?: number; sell?: number; purchasable?: boolean };
  depth?: number;
  from: string[];
  into: string[];
  group?: string;
};

/* ────────────────────────────────────────────────────────────────────────── */
/* Item Data Enrichment                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

function extractAllItemIds(
  participants: RiotAPITypes.MatchV5.ParticipantDTO[],
  eventsAll: TimelineEvent[]
): Set<number> {
  const itemIds = new Set<number>();
  
  // Extract from final participant items
  for (const p of participants) {
    const items = [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6];
    for (const itemId of items) {
      if (typeof itemId === 'number' && Number.isFinite(itemId) && itemId > 0) {
        itemIds.add(itemId);
      }
    }
  }
  
  // Extract from timeline events
  for (const event of eventsAll) {
    if (typeof event.itemId === 'number' && Number.isFinite(event.itemId) && event.itemId > 0) {
      itemIds.add(event.itemId);
    }
  }
  
  return itemIds;
}

async function enrichMatchWithItems(
  participants: RiotAPITypes.MatchV5.ParticipantDTO[],
  eventsAll: TimelineEvent[],
  gameVersion: string | undefined
): Promise<{
  itemsData: Record<number, ItemDataResolved>;
}> {
  const patch = inferPatchFromGameVersion(gameVersion);
  const itemMap = await getItemMap(patch);
  
  // Extract all item IDs from the match
  const allItemIds = extractAllItemIds(participants, eventsAll);
  
  // Create items data object
  const itemsData: Record<number, ItemDataResolved> = {};
  for (const itemId of allItemIds) {
    const item = itemMap[itemId];
    if (item) {
      itemsData[itemId] = {
        id: itemId,
        name: item.name,
        plaintext: item.plaintext,
        tags: item.tags ?? [],
        gold: item.gold,
        depth: item.depth,
        from: item.from ?? [],
        into: item.into ?? [],
        group: item.group,
      };
    }
  }
  
  return {
    itemsData,
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Types                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

export type ItemWithId = Item & { id: string };

export type TimelineEvent = {
  type: string;
  timestamp?: number;
  position?: { x: number; y: number } | null;
  participantId?: number;
  killerId?: number;
  victimId?: number;
  assistingParticipantIds?: number[];
  itemId?: number;
  wardType?: string;
  creatorId?: number;
  monsterType?: string;
};

export type ParticipantFrame = {
  level?: number;
  xp?: number;
  gold?: number;
  totalGold?: number;
  currentGold?: number;
  minionsKilled?: number;
  jungleMinionsKilled?: number;
  championStats?: unknown;
  damageStats?: unknown;
  position?: { x: number; y: number };
};

export type TimelineFrame = {
  timestamp?: number;
  events?: TimelineEvent[];
  participantFrames?: Record<string, ParticipantFrame>;
};

const itemEventTypes = [
  'ITEM_PURCHASED',
  'ITEM_SOLD',
  'ITEM_DESTROYED',
  'ITEM_UNDO',
  'ITEM_TRANSFORMED',
] as const;

export type SlimParticipant = {
  participantId: number;
  puuid: string;
  summonerName: string;
  teamId: number; // 100 / 200
  championId: number;
  championName: string;
  summoner1Id: number;
  summoner2Id: number;
  totalMinionsKilled: number;
  goldEarned: number;
  visionScore: number;
  win: boolean;
  inferredPosition:
    | 'TOP'
    | 'JUNGLE'
    | 'MIDDLE'
    | 'BOTTOM'
    | 'UTILITY'
    | 'UNKNOWN';
  completedItemIds: number[];
  trinketId: number | null;
};

export type EventParticipantState = {
  participantId: number;
  teamId: number;
  championName: string;
  frameTimestamp: number | null;
  positionDeltaMs: number | null;
  positionSource: 'previous' | 'next' | 'exact' | 'none';
  frame: {
    level?: number;
    totalGold?: number;
    position?: { x: number; y: number } | null;
    minionsKilled?: number;
    jungleMinionsKilled?: number;
  } | null;
  inventory: {
    itemIds: number[];
    completedItemIds: number[];
    hasGrievousWounds: boolean;
  };
};

export type EventNearbyParticipant = {
  participantId: number;
  teamId: number;
  championName: string;
  inferredPosition: SlimParticipant['inferredPosition'];
  distance: number;
  position: { x: number; y: number } | null;
  positionDeltaMs: number | null;
  positionSource: 'previous' | 'next' | 'exact' | 'none';
  isActor: boolean;
};

const NEARBY_DISTANCE_UNITS = 1_200; // ~Flash + auto range; close enough to impact fight

export type MatchEventDetail = {
  type: string;
  timestamp: number;
  phase: 'EARLY' | 'MID' | 'LATE';
  zone: string;
  enemyHalf: boolean;
  position: { x: number; y: number } | null;
  killerId: number | null;
  victimId: number | null;
  assistingParticipantIds: number[];
  relatedParticipantIds: number[];
  participantStates: EventParticipantState[]; // actors only
  proximity: {
    radius: number;
    reference: 'event' | 'actors';
    participants: EventNearbyParticipant[];
  };
  proximitySummary?: {
    allies: {
      total: number;
      within600: number;
      within1000: number;
      closest: number | null;
      closestChampions: string[];
    };
    enemies: {
      total: number;
      within600: number;
      within1000: number;
      closest: number | null;
      closestChampions: string[];
    };
    numbersAdvantage: number;
  };
  frameDeltaSummary?: {
    nearby: { count: number; avgMs: number | null; maxMs: number | null };
    actors: { count: number; avgMs: number | null; maxMs: number | null };
  };
  positionConfidence?: number; // 0..1 derived from frame deltas (higher = fresher positions)
  rawEventType?: string; // tiny breadcrumb, no blob
};

/* ────────────────────────────────────────────────────────────────────────── */
/* DDragon cache                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

export type DDragonItemsById = Record<string, ItemWithId>;
let _dd: DDragon | null = null;
let DD_ITEMS: DDragonItemsById = {};

export async function ensureDDragonItemsLoaded(): Promise<void> {
  if (!_dd) _dd = riotAPI.ddragon;
  if (Object.keys(DD_ITEMS).length > 0) return;
  try {
    type ItemsClient = {
      items: () => Promise<
        Record<string, Item> | { data?: Record<string, Item> }
      >;
    };
    const client = _dd as unknown as ItemsClient;
    const res = await client.items();
    const rawMap: Record<string, Item> =
      typeof res === 'object' && res !== null && 'data' in res
        ? ((res as { data?: Record<string, Item> }).data ?? {})
        : ((res as Record<string, Item>) ?? {});
    const out: DDragonItemsById = {};
    for (const [k, v] of Object.entries(rawMap || {})) {
      out[String(k)] = { ...(v as Item), id: String(k) } as ItemWithId;
    }
    DD_ITEMS = out;
    consola.debug('[ddragon] items loaded', {
      count: Object.keys(DD_ITEMS).length,
    });
  } catch (err) {
    consola.warn('[ddragon] items load failed; continuing without cache', err);
    DD_ITEMS = {};
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Geometry & phases                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

const MAP_MIN = 0;
const MAP_MAX = 15000;
const SMITE_ID = 11;

const norm = (v: number) =>
  Math.max(0, Math.min(1, (v - MAP_MIN) / (MAP_MAX - MAP_MIN)));
const minutes = (ts: number) => (ts || 0) / 60000;

function phaseByTime(m: number): 'EARLY' | 'MID' | 'LATE' {
  if (m < 14) return 'EARLY';
  if (m < 25) return 'MID';
  return 'LATE';
}

function zoneLabel(pos?: { x: number; y: number } | null): string {
  if (!pos) return 'unknown';
  const x = norm(pos.x);
  const y = norm(pos.y);

  const dist = (cx: number, cy: number) => {
    const dx = x - cx;
    const dy = y - cy;
    return Math.hypot(dx, dy);
  };

  const BLUE_NEXUS = { x: 0.08, y: 0.08 };
  const RED_NEXUS = { x: 0.92, y: 0.92 };
  const NEXUS_RADIUS = 0.11;
  const BASE_RADIUS = 0.17;

  if (dist(BLUE_NEXUS.x, BLUE_NEXUS.y) <= NEXUS_RADIUS) return 'BLUE_NEXUS';
  if (dist(RED_NEXUS.x, RED_NEXUS.y) <= NEXUS_RADIUS) return 'RED_NEXUS';
  if (dist(BLUE_NEXUS.x, BLUE_NEXUS.y) <= BASE_RADIUS) return 'BLUE_BASE';
  if (dist(RED_NEXUS.x, RED_NEXUS.y) <= BASE_RADIUS) return 'RED_BASE';

  const BARON_PIT = { x: 0.32, y: 0.73 };
  const DRAGON_PIT = { x: 0.68, y: 0.27 };
  const PIT_RADIUS = 0.05;

  if (dist(BARON_PIT.x, BARON_PIT.y) <= PIT_RADIUS) return 'BARON_PIT';
  if (dist(DRAGON_PIT.x, DRAGON_PIT.y) <= PIT_RADIUS) return 'DRAGON_PIT';

  const rotAcross = (y - x) / Math.SQRT2;
  const rotAlong = (x + y - 1) / Math.SQRT2;
  const distToRiver = Math.abs(rotAlong) * Math.SQRT2;

  if (distToRiver <= 0.045) {
    if (rotAcross > 0.14) return 'TOP_RIVER';
    if (rotAcross < -0.14) return 'BOTTOM_RIVER';
    return 'MIDDLE_RIVER';
  }

  const absAcross = Math.abs(rotAcross);
  const MID_LANE_BAND = 0.1;
  const LANE_BAND = 0.33;
  const MID_JUNGLE_BAND = 0.2;

  if (absAcross <= MID_LANE_BAND) return 'MIDDLE_LANE';
  if (rotAcross >= LANE_BAND) return 'TOP_LANE';
  if (rotAcross <= -LANE_BAND) return 'BOTTOM_LANE';
  if (absAcross <= MID_JUNGLE_BAND) return 'MIDDLE_JUNGLE';
  return rotAcross > 0 ? 'TOP_JUNGLE' : 'BOTTOM_JUNGLE';
}

function isEnemyHalf(
  pos: { x: number; y: number } | null,
  teamId: number,
): boolean {
  if (!pos) return false;
  const x = norm(pos.x);
  const y = norm(pos.y);
  const s = x + y;
  return teamId === 100 ? s > 1.03 : s < 0.97;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Frames helpers                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

function flattenEvents(frames: TimelineFrame[]): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const f of frames || [])
    if (Array.isArray(f.events)) out.push(...f.events);
  return out;
}

function boundingFrames(
  frames: TimelineFrame[],
  ts: number,
): { previous: TimelineFrame | null; next: TimelineFrame | null } {
  if (!frames || frames.length === 0)
    return { previous: null, next: null };
  let lo = 0;
  let hi = frames.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = Number(frames[mid]?.timestamp ?? 0);
    if (t <= ts) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const previous = frames[ans] ?? null;
  const nextIndex = Math.min(ans + 1, frames.length - 1);
  const next = frames[nextIndex] ?? null;
  return { previous, next };
}

type ParticipantPositionSnapshot = {
  frame: TimelineFrame | null;
  timestamp: number | null;
  position: { x: number; y: number } | null;
  deltaMs: number | null;
  source: 'previous' | 'next' | 'exact' | 'none';
};

function nearestParticipantPosition(
  frames: TimelineFrame[],
  pid: number,
  ts: number,
): ParticipantPositionSnapshot {
  if (!frames || frames.length === 0)
    return { frame: null, timestamp: null, position: null, deltaMs: null, source: 'none' };

  const { previous, next } = boundingFrames(frames, ts);
  const candidates: Array<{
    frame: TimelineFrame | null;
    timestamp: number;
    position: { x: number; y: number };
    deltaMs: number;
    source: 'previous' | 'next' | 'exact';
  }> = [];

  const pushCandidate = (
    frame: TimelineFrame | null,
    source: 'previous' | 'next',
  ) => {
    if (!frame) return;
    const timestamp = Number(frame.timestamp ?? Number.NaN);
    const pf = getParticipantFrame(frame, pid);
    const pos = pf?.position ?? null;
    if (!pos || !Number.isFinite(timestamp)) return;
    const deltaMs = Math.abs(ts - timestamp);
    candidates.push({
      frame,
      timestamp,
      position: { ...pos },
      deltaMs,
      source: deltaMs === 0 ? 'exact' : source,
    });
  };

  pushCandidate(previous, 'previous');
  if (next !== previous) pushCandidate(next, 'next');

  const best = candidates.sort((a, b) => a.deltaMs - b.deltaMs)[0];
  if (best)
    return {
      frame: best.frame,
      timestamp: best.timestamp,
      position: best.position,
      deltaMs: best.deltaMs,
      source: best.source,
    };

  const fallbackFrame = previous ?? next ?? null;
  const fallbackTimestamp = Number(fallbackFrame?.timestamp ?? Number.NaN);
  const fallbackPf = fallbackFrame ? getParticipantFrame(fallbackFrame, pid) : null;
  return {
    frame: fallbackFrame,
    timestamp: Number.isFinite(fallbackTimestamp) ? fallbackTimestamp : null,
    position: fallbackPf?.position ?? null,
    deltaMs: Number.isFinite(fallbackTimestamp)
      ? Math.abs(ts - Number(fallbackTimestamp))
      : null,
    source: 'none',
  };
}

function distanceBetween(
  a: { x: number; y: number } | null,
  b: { x: number; y: number } | null,
): number | null {
  if (!a || !b) return null;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function getParticipantFrame(
  frame: TimelineFrame | null,
  pid: number,
): ParticipantFrame | null {
  if (!frame) return null;
  const dict = frame.participantFrames;
  if (!dict) return null;
  return dict[String(pid)] ?? null;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Items/inventory                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

function isItemEventType(t: string): t is (typeof itemEventTypes)[number] {
  return (itemEventTypes as readonly string[]).includes(t);
}

type ItemEvt = {
  type: TimelineEvent['type'];
  itemId?: number | null;
  timestamp?: number;
};

function isTier2Boot(id: number) {
  return [3006, 3009, 3020, 3047, 3111, 3117, 3158].includes(id);
}

function isCompletedItem(id: number): boolean {
  const it = DD_ITEMS[String(id)];
  if (!it) return true; // fallback: assume completed if unknown
  const tags = (it.tags || []).map((t) => String(t).toLowerCase());
  const name = String(it.name || '').toLowerCase();
  if (tags.includes('trinket')) return false;
  if (tags.includes('consumable') || /elixir|potion|ward|cookie/.test(name))
    return false;
  if (isTier2Boot(id)) return true;
  if (tags.includes('mythic')) return true;
  if (Array.isArray(it.into) && it.into.length > 0) return false;
  const total = Number(it.gold?.total ?? 0);
  if (total >= 2300) return true;
  const depth = Number(it.depth ?? 0);
  if (depth >= 3) return true;
  return total >= 900 && (!it.from || it.from.length === 0);
}

function filterCompletedItemIds(
  ids: Array<number | null | undefined>,
): number[] {
  return ids
    .filter((id): id is number => typeof id === 'number' && Number.isFinite(id))
    .filter((id) => isCompletedItem(id));
}

function inventoryAtTime(eventsAll: TimelineEvent[], pid: number, ts: number) {
  const evts: ItemEvt[] = eventsAll
    .filter(
      (ie) =>
        isItemEventType(ie.type) &&
        ie.participantId === pid &&
        (typeof ie.timestamp !== 'number' || ie.timestamp <= ts),
    )
    .map((ie) => ({
      type: ie.type,
      itemId: ie.itemId ?? null,
      timestamp: ie.timestamp ?? 0,
    }))
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

  const counts = new Map<number, number>();
  const push = (id: number) => counts.set(id, (counts.get(id) ?? 0) + 1);
  const pop = (id: number) => {
    const c = (counts.get(id) ?? 0) - 1;
    if (c <= 0) counts.delete(id);
    else counts.set(id, c);
  };

  for (const e of evts) {
    const id = typeof e.itemId === 'number' ? e.itemId : null;
    if (e.type === 'ITEM_PURCHASED' && id != null) push(id);
    else if (
      (e.type === 'ITEM_SOLD' || e.type === 'ITEM_DESTROYED') &&
      id != null
    )
      pop(id);
    else if (e.type === 'ITEM_UNDO' && id != null) pop(id);
    else if (e.type === 'ITEM_TRANSFORMED' && id != null) push(id);
  }

  const inv = [...counts.entries()].flatMap(([id, c]) =>
    Array.from({ length: c }, () => id),
  );
  const GW = new Set([3916, 3165, 3011, 3123, 3033, 3076, 3075]);
  const hasGW = inv.some((id) => GW.has(id));
  return { inventoryIds: inv, hasGW };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Role/position inference                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

// Determine modal lane by movement in first N minutes
function inferLaneFromMovement(
  frames: TimelineFrame[],
  pid: number,
  minutesCap = 6,
): 'TOP' | 'MIDDLE' | 'BOTTOM' | 'UNKNOWN' {
  if (!frames?.length) return 'UNKNOWN';
  const capTs = minutesCap * 60_000;
  const counts = { TOP: 0, MIDDLE: 0, BOTTOM: 0 } as Record<
    'TOP' | 'MIDDLE' | 'BOTTOM',
    number
  >;
  for (const fr of frames) {
    const ts = Number(fr.timestamp ?? 0);
    if (ts > capTs) break;
    const pf = fr.participantFrames?.[String(pid)];
    const pos = pf?.position ?? null;
    const z = zoneLabel(pos);
    if (z.startsWith('TOP')) counts.TOP++;
    else if (z.startsWith('MIDDLE')) counts.MIDDLE++;
    else if (z.startsWith('BOTTOM')) counts.BOTTOM++;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const key = best?.[0];
  if (best && best[1] > 0 && (key === 'TOP' || key === 'MIDDLE' || key === 'BOTTOM')) {
    return key;
  }
  return 'UNKNOWN';
}

function hasSmite(p: RiotAPITypes.MatchV5.ParticipantDTO) {
  return p.summoner1Id === SMITE_ID || p.summoner2Id === SMITE_ID;
}

function inferSupportOrCarry(
  botAllies: RiotAPITypes.MatchV5.ParticipantDTO[],
  self: RiotAPITypes.MatchV5.ParticipantDTO,
): 'UTILITY' | 'BOTTOM' {
  if (botAllies.length < 2) return 'BOTTOM';
  const [a, b] = botAllies;
  const csA = a.totalMinionsKilled;
  const csB = b.totalMinionsKilled;
  const support = csA <= csB ? a : b; // lower CS ~ support heuristic
  return support.puuid === self.puuid ? 'UTILITY' : 'BOTTOM';
}

function inferPosition(
  p: RiotAPITypes.MatchV5.ParticipantDTO,
  frames: TimelineFrame[],
  teamMates: RiotAPITypes.MatchV5.ParticipantDTO[],
): 'TOP' | 'JUNGLE' | 'MIDDLE' | 'BOTTOM' | 'UTILITY' | 'UNKNOWN' {
  // 1) Smite is definitive jungle signal
  if (hasSmite(p)) return 'JUNGLE';

  // 2) Movement-derived lane
  const laneByMove = inferLaneFromMovement(frames, p.participantId);

  if (laneByMove === 'TOP') return 'TOP';
  if (laneByMove === 'MIDDLE') return 'MIDDLE';
  if (laneByMove === 'BOTTOM') {
    // Decide support vs carry using CS share among bot duo
    const botDuo = teamMates
      .filter((t) => !hasSmite(t))
      .filter(
        (t) =>
          t.puuid === p.puuid ||
          inferLaneFromMovement(frames, t.participantId) === 'BOTTOM',
      );
    try {
      return inferSupportOrCarry(botDuo, p);
    } catch {
      return 'BOTTOM';
    }
  }

  // 3) Fallback: use Riot fields if movement inconclusive
  const tp = (p.teamPosition ?? p.role ?? p.lane ?? 'UNKNOWN').toUpperCase();
  if (tp === 'UTILITY' || tp === 'SUPPORT') return 'UTILITY';
  if (tp === 'BOTTOM' || tp === 'ADC' || tp === 'DUO_CARRY') return 'BOTTOM';
  if (tp === 'MIDDLE' || tp === 'MID') return 'MIDDLE';
  if (tp === 'TOP') return 'TOP';
  if (tp === 'JUNGLE') return 'JUNGLE';

  return 'UNKNOWN';
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Builders                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

function slimParticipant(
  p: RiotAPITypes.MatchV5.ParticipantDTO,
  frames: TimelineFrame[],
  teamMates: RiotAPITypes.MatchV5.ParticipantDTO[],
): SlimParticipant {
  const items = [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6];
  const inferred = inferPosition(p, frames, teamMates);
  return {
    participantId: p.participantId,
    puuid: p.puuid,
    summonerName: p.summonerName,
    teamId: p.teamId,
    championId: p.championId,
    championName: p.championName,
    summoner1Id: p.summoner1Id,
    summoner2Id: p.summoner2Id,
    totalMinionsKilled: p.totalMinionsKilled,
    goldEarned: p.goldEarned,
    visionScore: p.visionScore,
    win: !!p.win,
    inferredPosition: inferred,
    completedItemIds: filterCompletedItemIds(items),
    trinketId:
      typeof p.item6 === 'number' && Number.isFinite(p.item6) ? p.item6 : null,
  };
}

function actorsOf(e: TimelineEvent): number[] {
  const s = new Set<number>();
  if (typeof e.participantId === 'number') s.add(e.participantId);
  if (typeof e.killerId === 'number') s.add(e.killerId);
  if (typeof e.victimId === 'number') s.add(e.victimId);
  if (typeof e.creatorId === 'number') s.add(e.creatorId);
  for (const a of e.assistingParticipantIds ?? [])
    if (typeof a === 'number') s.add(a);
  return [...s];
}

function minimalFrameSnapshot(
  pf: ParticipantFrame | null,
  overridePosition?: { x: number; y: number } | null,
) {
  if (!pf && !overridePosition) return null;
  return {
    level: pf?.level,
    totalGold: pf?.totalGold ?? pf?.gold,
    position: overridePosition ?? pf?.position ?? null,
    minionsKilled: pf?.minionsKilled,
    jungleMinionsKilled: pf?.jungleMinionsKilled,
  };
}

function buildEventDetail(
  event: TimelineEvent,
  frames: TimelineFrame[],
  eventsAll: TimelineEvent[],
  participants: SlimParticipant[],
  subjectTeamId: number,
): MatchEventDetail {
  const ts = Number(event.timestamp ?? 0);
  const when = minutes(ts);
  const position = event.position ? { ...event.position } : null;
  const zone = zoneLabel(position);

  const actorIds = actorsOf(event);
  const actorIdSet = new Set(actorIds);
  const positionSnapshots = new Map<number, ParticipantPositionSnapshot>();

  const participantStates: EventParticipantState[] = actorIds.map((pid) => {
    const p = participants.find((pp) => pp.participantId === pid);
    const nearest = nearestParticipantPosition(frames, pid, ts);
    positionSnapshots.set(pid, nearest);
    const pf = getParticipantFrame(nearest.frame, pid);
    const inv = inventoryAtTime(eventsAll, pid, ts);
    const completedAtTs = filterCompletedItemIds(inv.inventoryIds);
    return {
      participantId: pid,
      teamId: p?.teamId ?? (pid <= 5 ? 100 : 200),
      championName: p?.championName ?? '',
      frameTimestamp: nearest.timestamp ?? null,
      positionDeltaMs: nearest.deltaMs,
      positionSource: nearest.source,
      frame: minimalFrameSnapshot(pf, nearest.position),
      inventory: {
        itemIds: inv.inventoryIds,
        completedItemIds: completedAtTs,
        hasGrievousWounds: inv.hasGW,
      },
    };
  });

  const referencePoints: Array<{ x: number; y: number }> = [];
  let reference: 'event' | 'actors' = 'event';
  if (position) {
    referencePoints.push(position);
  } else {
    reference = 'actors';
    for (const state of participantStates) {
      const pos = state.frame?.position ?? null;
      if (pos) referencePoints.push(pos);
    }
  }

  const nearby: EventNearbyParticipant[] = [];
  for (const p of participants) {
    const cached = positionSnapshots.get(p.participantId);
    const nearest = cached ?? nearestParticipantPosition(frames, p.participantId, ts);
    if (!cached) positionSnapshots.set(p.participantId, nearest);
    const pos = nearest.position;
    if (!pos || referencePoints.length === 0) continue;
    const distances = referencePoints
      .map((ref) => distanceBetween(ref, pos))
      .filter((d): d is number => typeof d === 'number' && Number.isFinite(d));
    if (!distances.length) continue;
    const minDist = Math.min(...distances);
    if (minDist > NEARBY_DISTANCE_UNITS) continue;
    nearby.push({
      participantId: p.participantId,
      teamId: p.teamId,
      championName: p.championName,
      inferredPosition: p.inferredPosition,
      distance: minDist,
      position: pos,
      positionDeltaMs: nearest.deltaMs,
      positionSource: nearest.source,
      isActor: actorIdSet.has(p.participantId),
    });
  }

  nearby.sort((a, b) => a.distance - b.distance);

  // Derive a compact proximity summary for the AI (ally/enemy counts and closest distances)
  const alliesNear = nearby.filter((n) => n.teamId === subjectTeamId);
  const enemiesNear = nearby.filter((n) => n.teamId !== subjectTeamId);
  const countWithin = (arr: typeof nearby, d: number) =>
    arr.filter((n) => typeof n.distance === 'number' && n.distance <= d).length;
  const CLOSE_600 = 600;
  const THREAT_1000 = 1000;
  const proximitySummary = {
    allies: {
      total: alliesNear.length,
      within600: countWithin(alliesNear, CLOSE_600),
      within1000: countWithin(alliesNear, THREAT_1000),
      closest: alliesNear.length ? alliesNear[0].distance : null,
      closestChampions: alliesNear.slice(0, 3).map((n) => n.championName),
    },
    enemies: {
      total: enemiesNear.length,
      within600: countWithin(enemiesNear, CLOSE_600),
      within1000: countWithin(enemiesNear, THREAT_1000),
      closest: enemiesNear.length ? enemiesNear[0].distance : null,
      closestChampions: enemiesNear.slice(0, 3).map((n) => n.championName),
    },
    numbersAdvantage: alliesNear.length - enemiesNear.length,
  } as const;

  // Frame distance summary: give AI a quick sense of how fresh positions are
  const deltasNearby = nearby
    .map((n) => n.positionDeltaMs)
    .filter((d): d is number => typeof d === 'number' && Number.isFinite(d));
  const deltasActors = participantStates
    .map((s) => s.positionDeltaMs)
    .filter((d): d is number => typeof d === 'number' && Number.isFinite(d));

  const stats = (vals: number[]) => {
    if (!vals.length) return { count: 0, avgMs: null as number | null, maxMs: null as number | null };
    const sum = vals.reduce((a, b) => a + b, 0);
    const avg = Math.round(sum / vals.length);
    const max = Math.max(...vals);
    return { count: vals.length, avgMs: avg, maxMs: max };
  };
  const nearbyStats = stats(deltasNearby);
  const actorStats = stats(deltasActors);
  const worstMs = Math.max(nearbyStats.maxMs ?? 0, actorStats.maxMs ?? 0);
  const MAX_DELTA_MS = 30_000; // cap considered stale at ~30s per your UI logic
  const positionConfidence = Math.max(0, Math.min(1, 1 - worstMs / MAX_DELTA_MS));

  return {
    type: event.type,
    timestamp: ts,
    phase: phaseByTime(when),
    zone,
    enemyHalf: isEnemyHalf(position, subjectTeamId),
    position,
    killerId: event.killerId ?? null,
    victimId: event.victimId ?? null,
    assistingParticipantIds: Array.isArray(event.assistingParticipantIds)
      ? event.assistingParticipantIds
      : [],
    relatedParticipantIds: actorIds,
    participantStates,
    proximity: {
      radius: NEARBY_DISTANCE_UNITS,
      reference,
      participants: nearby,
    },
    proximitySummary,
    frameDeltaSummary: {
      nearby: { count: nearbyStats.count, avgMs: nearbyStats.avgMs, maxMs: nearbyStats.maxMs },
      actors: { count: actorStats.count, avgMs: actorStats.avgMs, maxMs: actorStats.maxMs },
    },
    positionConfidence,
    rawEventType: event.type,
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Public: build trimmed AI context                                          */
/* ────────────────────────────────────────────────────────────────────────── */

export async function matchDetailsNode(
  puuid: string,
  matchId: string,
): Promise<Record<string, unknown> | null> {
  consola.debug('[matchDetailsNode] start', { puuid, matchId });

  const match = await collections.matches.findOne({
    'metadata.matchId': matchId,
    'info.participants.puuid': puuid,
  });
  if (!match) return null;

  const allowedQueues = ALLOWED_QUEUE_IDS as unknown as readonly number[];
  if (!allowedQueues.includes(match.info.queueId as number)) return null;

  const participants = match.info
    .participants as RiotAPITypes.MatchV5.ParticipantDTO[];
  const teams = match.info.teams as RiotAPITypes.MatchV5.TeamDTO[];

  const subjectP = participants.find((p) => p.puuid === puuid);
  if (!subjectP) return null;

  await ensureDDragonItemsLoaded();

  // Timeline (optional)
  const timeline = await collections.timelines.findOne({
    'metadata.matchId': matchId,
  });
  let frames: TimelineFrame[] = [];
  const framesRaw = timeline?.info?.frames;
  if (Array.isArray(framesRaw)) {
    frames = framesRaw as unknown as TimelineFrame[];
  }
  const eventsAll = flattenEvents(frames);

  // Slim participants with inferred positions
  const byTeam: Record<100 | 200, RiotAPITypes.MatchV5.ParticipantDTO[]> = {
    100: participants.filter((p) => p.teamId === 100),
    200: participants.filter((p) => p.teamId === 200),
  };
  const slim: SlimParticipant[] = participants.map((p) =>
    slimParticipant(p, frames, byTeam[p.teamId as 100 | 200]),
  );

  const subject = slim.find((p) => p.puuid === puuid);
  if (!subject) return null;

  // Choose opponent by **inferred** lane/role
  const opponent =
    slim
      .filter((p) => p.teamId !== subject.teamId)
      .filter((p) => {
        // Bot duo: subject BOTTOM fights enemy BOTTOM (carry) or UTILITY (support)
        if (
          subject.inferredPosition === 'BOTTOM' ||
          subject.inferredPosition === 'UTILITY'
        ) {
          return (
            p.inferredPosition === 'BOTTOM' || p.inferredPosition === 'UTILITY'
          );
        }
        return p.inferredPosition === subject.inferredPosition;
      })
      // Prefer the enemy with **closest lane CS profile** vs subject
      .sort(
        (a, b) =>
          Math.abs(a.totalMinionsKilled - subject.totalMinionsKilled) -
          Math.abs(b.totalMinionsKilled - subject.totalMinionsKilled),
      )[0] ?? null;

  // Relevant events: only those involving the subject (keeps payload light)
  const subjectPid = subject.participantId;
  const relevantEvents = frames.length
    ? eventsAll
        .filter((e) => {
          const ids = new Set(actorsOf(e));
          return ids.has(subjectPid);
        })
        .map((event) =>
          buildEventDetail(event, frames, eventsAll, slim, subject.teamId),
        )
    : [];

  // Minimal match meta + tiny teams
  const base = {
    matchId: match.metadata.matchId,
    gameCreation: match.info.gameCreation,
    gameDuration: match.info.gameDuration,
    gameMode: match.info.gameMode,
    gameVersion: match.info.gameVersion,
    mapId: match.info.mapId,
    queueId: match.info.queueId,
    outcome: match.info.teams.find((t) => t.teamId === subject.teamId)?.win
      ? 'win'
      : 'lose',
    teams:
      teams?.map((t) => ({
        teamId: t.teamId,
        win: !!t.win,
        objectives: {
          baron: t.objectives?.baron?.kills ?? 0,
          dragon: t.objectives?.dragon?.kills ?? 0,
          riftHerald: t.objectives?.riftHerald?.kills ?? 0,
          horde: (() => {
            const obj = t.objectives as unknown as Record<string, { kills?: number }>;
            const v = obj?.horde?.kills;
            return typeof v === 'number' && Number.isFinite(v) ? v : 0;
          })(),
          tower: t.objectives?.tower?.kills ?? 0,
        },
      })) ?? [],
  };

  // Subject/opponent minimal blocks
  const subjectBlock = {
    participantId: subject.participantId,
    puuid: subject.puuid,
    summonerName: subject.summonerName,
    teamId: subject.teamId,
    inferredPosition: subject.inferredPosition,
    championId: subject.championId,
    championName: subject.championName,
    summoner1Id: subject.summoner1Id,
    summoner2Id: subject.summoner2Id,
    finalItems: subject.completedItemIds,
    trinketId: subject.trinketId,
  };

  const opponentBlock = opponent
    ? {
        participantId: opponent.participantId,
        puuid: opponent.puuid,
        summonerName: opponent.summonerName,
        teamId: opponent.teamId,
        inferredPosition: opponent.inferredPosition,
        championId: opponent.championId,
        championName: opponent.championName,
        summoner1Id: opponent.summoner1Id,
        summoner2Id: opponent.summoner2Id,
        finalItems: opponent.completedItemIds,
        trinketId: opponent.trinketId,
      }
    : null;

  // Participants table for quick lookups (10 rows, slim)
  const participantsBrief = slim.map((p) => ({
    participantId: p.participantId,
    teamId: p.teamId,
    championName: p.championName,
    inferredPosition: p.inferredPosition,
    totalMinionsKilled: p.totalMinionsKilled,
    goldEarned: p.goldEarned,
    visionScore: p.visionScore,
    completedItemIds: p.completedItemIds,
  }));

  // Enrich with items data
  const enrichmentData = await enrichMatchWithItems(
    participants,
    eventsAll,
    match.info.gameVersion
  );

  return {
    ...base,
    subject: subjectBlock,
    opponent: opponentBlock,
    participants: participantsBrief,
    events: relevantEvents,
    itemsData: enrichmentData.itemsData,
  } as const;
}
