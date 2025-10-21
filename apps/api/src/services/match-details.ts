import type { RiotAPITypes } from '@fightmegg/riot-api';
import type { DDragon } from '@fightmegg/riot-api';
import { collections } from '@riftcoach/clients.mongodb';
import { ALLOWED_QUEUE_IDS } from '@riftcoach/shared.constants';
import type { Item } from '@riftcoach/shared.lol-types';
import consola from 'consola';
import { riotAPI } from '../clients/riot.js';

// =====================
// Types
// =====================
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

export type ParticipantBasic = {
  participantId: number;
  puuid: string;
  summonerName: string;
  teamId: number;
  teamPosition: string;
  championId: number;
  championName: string;
  win: boolean;
  items: (number | null)[];
  summoner1Id: number;
  summoner2Id: number;
  kills: number;
  deaths: number;
  assists: number;
  kda: number;
};

// =====================
// DDragon cache
// =====================
export type DDragonItemsById = Record<string, ItemWithId>;
let _dd: DDragon | null = null;
let DD_ITEMS: DDragonItemsById = {};

export async function ensureDDragonItemsLoaded(): Promise<void> {
  if (!_dd) _dd = riotAPI.ddragon;
  try {
    const res: any = await (_dd as any).items();
    const rawMap: Record<string, Item> = res && res.data ? res.data : res; // supports both shapes
    const out: DDragonItemsById = {};
    for (const [k, v] of Object.entries(rawMap || {}))
      out[String(k)] = { ...(v as Item), id: String(k) } as ItemWithId;
    DD_ITEMS = out;
    consola.debug('[ddragon] items loaded', {
      count: Object.keys(DD_ITEMS).length,
    });
  } catch (err) {
    consola.warn('[ddragon] items load failed; continuing without spikes', err);
    DD_ITEMS = {};
  }
}

// =====================
// Helpers (roles, frames)
// =====================
const itemEventTypes = [
  'ITEM_PURCHASED',
  'ITEM_SOLD',
  'ITEM_DESTROYED',
  'ITEM_UNDO',
  'ITEM_TRANSFORMED',
] as const;

type ItemEvt = {
  type: TimelineEvent['type'];
  itemId?: number | null;
  timestamp?: number;
};

function upperRole(p: RiotAPITypes.MatchV5.ParticipantDTO): string {
  const raw = p.teamPosition ?? p.individualPosition ?? p.lane ?? '';
  return String(raw || '').toUpperCase();
}

function roleGroup(
  roleUpper: string,
): 'TOP' | 'JUNGLE' | 'MID' | 'BOTTOM' | 'SUPPORT' | 'UNKNOWN' {
  if (roleUpper === 'TOP') return 'TOP';
  if (roleUpper === 'JUNGLE') return 'JUNGLE';
  if (roleUpper === 'MIDDLE' || roleUpper === 'MID') return 'MID';
  if (['BOTTOM', 'BOT', 'ADC', 'DUO_CARRY'].includes(roleUpper))
    return 'BOTTOM';
  if (['SUPPORT', 'UTILITY', 'DUO_SUPPORT'].includes(roleUpper))
    return 'SUPPORT';
  return 'UNKNOWN';
}

function flattenEvents(frames: TimelineFrame[]): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const f of frames || [])
    if (Array.isArray(f.events)) out.push(...f.events);
  return out;
}

function findFrameAt(
  frames: TimelineFrame[],
  ts: number,
): TimelineFrame | null {
  if (!frames || frames.length === 0) return null;
  let lo = 0,
    hi = frames.length - 1,
    ans = 0;
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
  return frames[ans] ?? frames[0] ?? null;
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

function snapshotFromFrame(pf: ParticipantFrame | null) {
  if (!pf)
    return {
      level: 0,
      xp: 0,
      gold: 0,
      totalGold: 0,
      cs: 0,
      championStats: {},
      damageStats: {},
    };
  const minions = Number(pf.minionsKilled || 0);
  const jungle = Number(pf.jungleMinionsKilled || 0);
  return {
    level: Number(pf.level || 0),
    xp: Number(pf.xp || 0),
    gold: Number(pf.gold || 0),
    totalGold: Number(pf.totalGold || 0),
    cs: minions + jungle,
    championStats: pf.championStats ?? {},
    damageStats: pf.damageStats ?? {},
  };
}

function isItemEventType(t: string): t is (typeof itemEventTypes)[number] {
  return (itemEventTypes as readonly string[]).includes(t);
}

// =====================
// Positions index (uses participantFrames.position + events)
// =====================
export type Vec2 = { x: number; y: number };

type PosIndex = { byT: Array<{ t: number; pos: Record<number, Vec2> }> };

function buildPositionsIndex(frames: TimelineFrame[]): PosIndex {
  const byT: Array<{ t: number; pos: Record<number, Vec2> }> = [];
  for (const f of frames) {
    const t = typeof f.timestamp === 'number' ? f.timestamp : 0;
    const pos: Record<number, Vec2> = {};

    // participantFrames positions
    if (f.participantFrames) {
      for (const [pidStr, pf] of Object.entries(f.participantFrames)) {
        const p = (pf as any).position as { x: number; y: number } | undefined;
        if (p && typeof p.x === 'number' && typeof p.y === 'number')
          pos[Number(pidStr)] = { x: p.x, y: p.y };
      }
    }

    // events fallback
    if (Array.isArray(f.events)) {
      for (const e of f.events) {
        if (
          e.position &&
          typeof e.participantId === 'number' &&
          !pos[e.participantId]
        )
          pos[e.participantId] = { x: e.position.x, y: e.position.y };
        if (e.type === 'CHAMPION_KILL' && e.position) {
          if (typeof e.killerId === 'number' && !pos[e.killerId])
            pos[e.killerId] = { ...e.position };
          if (typeof e.victimId === 'number' && !pos[e.victimId])
            pos[e.victimId] = { ...e.position };
          if (Array.isArray(e.assistingParticipantIds))
            for (const aid of e.assistingParticipantIds)
              if (!pos[aid]) pos[aid] = { ...e.position };
        }
      }
    }

    byT.push({ t, pos });
  }
  byT.sort((a, b) => a.t - b.t);
  return { byT };
}

// =====================
// Dynamic AOI (geometry + damage involvement)
// =====================
function dist2(a: Vec2, b: Vec2) {
  const dx = a.x - b.x,
    dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function nearestPosInWindow(
  posIndex: PosIndex,
  pid: number,
  start: number,
  end: number,
): Vec2 | null {
  for (const { t, pos } of posIndex.byT) {
    if (t < start) continue;
    if (t > end) break;
    const p = pos[pid];
    if (p) return p;
  }
  return null;
}

function damageDeltaWindow(
  frames: TimelineFrame[],
  pid: number,
  start: number,
  end: number,
): { dealtChamp: number; taken: number } {
  let first: ParticipantFrame | null = null;
  let last: ParticipantFrame | null = null;
  for (const f of frames) {
    const t = Number(f.timestamp ?? 0);
    if (t < start || t > end) continue;
    const pf = f.participantFrames?.[String(pid)];
    if (!pf) continue;
    if (!first) first = pf;
    last = pf;
  }
  const fds = (first?.damageStats as any) || {};
  const lds = (last?.damageStats as any) || {};
  const dealtChamp =
    Number(lds.totalDamageDoneToChampions || 0) -
    Number(fds.totalDamageDoneToChampions || 0);
  const taken =
    Number(lds.totalDamageTaken || 0) - Number(fds.totalDamageTaken || 0);
  return { dealtChamp: Math.max(0, dealtChamp), taken: Math.max(0, taken) };
}

export type AoiTuning = {
  baseRadius: number;
  earlyRadius: number;
  pre3Radius: number;
  riverBonus: number;
  enemyHalfBonus: number;
  baseWindow: number;
  earlyWindow: number;
  damageRadiusMult: number;
};

export const AOI_TUNING: AoiTuning = {
  baseRadius: 1200,
  earlyRadius: 1700,
  pre3Radius: 2000,
  riverBonus: 1.1,
  enemyHalfBonus: 1.1,
  baseWindow: 5000,
  earlyWindow: 6000,
  damageRadiusMult: 1.25,
};

function computeAoiParams(
  whenMin: number,
  zone: string,
  enemyHalf: boolean,
  tuning = AOI_TUNING,
) {
  let radius = tuning.baseRadius;
  const windowMs = whenMin < 6 ? tuning.earlyWindow : tuning.baseWindow;
  if (whenMin < 3) radius = tuning.pre3Radius;
  else if (whenMin < 6) radius = tuning.earlyRadius;
  else radius = tuning.baseRadius;
  if (zone.endsWith('_RIVER')) radius *= tuning.riverBonus;
  if (enemyHalf) radius *= tuning.enemyHalfBonus;
  return { radius, windowMs };
}

function aoiCountsDynamic(
  posIndex: PosIndex,
  participantsDict: Record<string, ParticipantBasic>,
  frames: TimelineFrame[],
  ts: number,
  center: Vec2 | null,
  subjectTeamId: number,
  whenMin: number,
  zone: string,
  enemyHalf: boolean,
  mandatoryPids: number[] = [],
  tuning = AOI_TUNING,
) {
  const { radius, windowMs } = computeAoiParams(
    whenMin,
    zone,
    enemyHalf,
    tuning,
  );
  const start = ts - windowMs,
    end = ts + windowMs;
  const r2 = radius * radius;
  const seen = new Set<number>();
  const ally = new Set<number>();
  const enemy = new Set<number>();
  const teamOf = (pid: number) => participantsDict[String(pid)]?.teamId;

  // 1) geometric
  if (center) {
    for (const { t, pos } of posIndex.byT) {
      if (t < start) continue;
      if (t > end) break;
      for (const [pidStr, p] of Object.entries(pos)) {
        const pid = Number(pidStr);
        if (seen.has(pid)) continue;
        if (dist2(p, center) <= r2) {
          seen.add(pid);
          (teamOf(pid) === subjectTeamId ? ally : enemy).add(pid);
        }
      }
    }
  }

  // 2) damage involvement (champ-only)
  const relaxedR2 = (radius * tuning.damageRadiusMult) ** 2;
  for (const pidStr of Object.keys(participantsDict)) {
    const pid = Number(pidStr);
    if (seen.has(pid)) continue;
    const d = damageDeltaWindow(frames, pid, start, end);
    if (d.dealtChamp > 0 || d.taken > 0) {
      const p = center ? nearestPosInWindow(posIndex, pid, start, end) : null;
      if (!center || (p && dist2(p, center) <= relaxedR2)) {
        seen.add(pid);
        (teamOf(pid) === subjectTeamId ? ally : enemy).add(pid);
      }
    }
  }

  // 3) mandatory participants fallback
  for (const pid of mandatoryPids) {
    if (seen.has(pid)) continue;
    seen.add(pid);
    (teamOf(pid) === subjectTeamId ? ally : enemy).add(pid);
  }

  return {
    allies: ally.size,
    enemies: enemy.size,
    diff: ally.size - enemy.size,
    allyIds: [...ally],
    enemyIds: [...enemy],
    radius,
    windowMs,
  };
}

// =====================
// Map geometry + phases
// =====================
const MAP_MIN = 0;
const MAP_MAX = 15000;

type TeamSide = 'BLUE' | 'RED';
function teamSide(teamId?: number): TeamSide {
  return teamId === 100 ? 'BLUE' : 'RED';
}
function norm(v: number) {
  return Math.max(0, Math.min(1, (v - MAP_MIN) / (MAP_MAX - MAP_MIN)));
}

function zoneLabel(pos?: { x: number; y: number } | null): string {
  if (!pos) return 'unknown';
  const x = norm(pos.x);
  const y = norm(pos.y);
  const distToDiag = Math.abs(x - (1 - y));
  const nearRiver = distToDiag < 0.075;
  const lane = y > 0.66 ? 'TOP' : y < 0.33 ? 'BOTTOM' : 'MIDDLE';
  const nearLane =
    (lane === 'TOP' && x < 0.6) ||
    (lane === 'BOTTOM' && x > 0.4) ||
    lane === 'MIDDLE';
  if (nearRiver) return `${lane}_RIVER`;
  return nearLane ? `${lane}_LANE` : `${lane}_JUNGLE`;
}

function isEnemyHalf(
  pos: { x: number; y: number } | null,
  side: TeamSide,
): boolean {
  if (!pos) return false;
  const x = norm(pos.x);
  const y = norm(pos.y);
  const s = x + y;
  return side === 'BLUE' ? s > 1.03 : s < 0.97;
}

function minutes(ts: number) {
  return (ts || 0) / 60000;
}
function phaseByTime(m: number): 'EARLY' | 'MID' | 'LATE' {
  if (m < 14) return 'EARLY';
  if (m < 25) return 'MID';
  return 'LATE';
}

// =====================
// Vision & objectives
// =====================
const WARD_TYPES = new Set([
  'YELLOW_TRINKET',
  'CONTROL_WARD',
  'SIGHT_WARD',
  'BLUE_TRINKET',
  'TEEMO_MUSHROOM',
]);
function isWardPlace(
  e: TimelineEvent,
): e is TimelineEvent & { wardType: string } {
  return e.type === 'WARD_PLACED' && !!e.wardType && WARD_TYPES.has(e.wardType);
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function wardsNearTimeAndPos(
  eventsAll: TimelineEvent[],
  ts: number,
  center: { x: number; y: number } | null,
  windowMs: number,
  radius: number,
  byTeam: (pid?: number) => TeamSide,
) {
  if (!center) return { ally: 0, enemy: 0, samples: [] as TimelineEvent[] };
  const start = ts - windowMs;
  const end = ts + windowMs;
  const samples = eventsAll.filter(
    (e) =>
      isWardPlace(e) &&
      typeof e.timestamp === 'number' &&
      e.timestamp >= start &&
      e.timestamp <= end &&
      e.position &&
      distance(e.position, center) <= radius,
  );
  let ally = 0;
  let enemy = 0;
  for (const w of samples) {
    const side = byTeam(w.participantId);
    if (side === 'BLUE') ally++;
    else enemy++;
  }
  return { ally, enemy, samples };
}

function objectiveWindow(
  eventsAll: TimelineEvent[],
  ts: number,
  windowMs = 90_000,
) {
  const start = ts - windowMs;
  const end = ts + windowMs;
  const obj = eventsAll.filter(
    (e) =>
      e.type === 'ELITE_MONSTER_KILL' &&
      typeof e.timestamp === 'number' &&
      e.timestamp >= start &&
      e.timestamp <= end,
  );
  return {
    nearbyObjective: obj.length > 0,
    kinds: Array.from(new Set(obj.map((e) => e.monsterType || 'ELITE'))),
    deltas: obj.map((e) => (e.timestamp ?? 0) - ts),
  };
}

// =====================
// Inventory at time t + spikes
// =====================
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

function isTier2Boot(id: number) {
  return [3006, 3009, 3020, 3047, 3111, 3117, 3158].includes(id);
}
function isLikelyMythic(it?: ItemWithId) {
  return (
    !!it &&
    (it.tags?.includes('Mythic') ||
      (it.name ?? '').toLowerCase().includes('mythic'))
  );
}
function isBigSpike(id: number) {
  const it = DD_ITEMS[String(id)];
  if (!it) return isTier2Boot(id);
  if (isTier2Boot(id)) return true;
  if (isLikelyMythic(it)) return true;
  return (it.depth ?? 0) >= 3 && !(it.from && it.from.length <= 1);
}

function recentSpikeWithin(
  src: {
    itemEvents?: { type: string; itemId?: number | null; timestamp?: number }[];
    inventoryIds?: number[];
  },
  sinceMs: number,
  ts: number,
) {
  const recent = (src.itemEvents || [])
    .filter(
      (e) =>
        e.type === 'ITEM_PURCHASED' &&
        typeof e.timestamp === 'number' &&
        ts - (e.timestamp ?? 0) <= sinceMs,
    )
    .map((e) => e.itemId)
    .filter((id): id is number => id != null);
  const base = recent.length ? recent : src.inventoryIds || [];
  const spikes = base.filter(isBigSpike);
  return { recent: base, spikes, hasSpike: spikes.length > 0 };
}

// =====================
// Insight writer
// =====================
export type EventFeatures = {
  kind: 'kill' | 'death' | 'assist';
  whenMin: number;
  phase: 'EARLY' | 'MID' | 'LATE';
  zone: string;
  enemyHalf: boolean;
  numbers: { ally: number; enemy: number; diff: number };
  diffs: { levelDiff: number; goldDiff: number };
  spikes: {
    self: boolean;
    enemy: boolean;
    selfIds: number[];
    enemyIds: number[];
  };
  objWin: { nearbyObjective: boolean; kinds: string[]; deltas: number[] };
  vision: { ally: number; enemy: number };
  likelyDive: boolean;
  selfHasGW: boolean;
  enemyHasGW: boolean;
};

export function writeInsight(f: EventFeatures): string {
  const parts: string[] = [];
  const zoneText = f.zone.replace('_', ' ').toLowerCase();
  const label = `${f.numbers.ally}v${f.numbers.enemy}`;
  if (f.numbers.diff < 0)
    parts.push(
      `You took a ${label} ${zoneText}${f.enemyHalf ? ' on enemy territory' : ''}.`,
    );
  else if (f.numbers.diff > 0)
    parts.push(
      `Good ${label} setup ${zoneText}${f.enemyHalf ? ' deep in enemy side' : ''}.`,
    );
  else
    parts.push(
      `Even ${label} ${zoneText}${f.enemyHalf ? ' on enemy half' : ''}.`,
    );
  if (f.spikes.enemy && !f.spikes.self)
    parts.push('Enemy had a fresh item spike within ~2m; kite or delay.');
  if (f.spikes.self && !f.spikes.enemy)
    parts.push('You had a fresh spike—force with wave/vision.');
  if (f.selfHasGW && !f.enemyHasGW && f.kind === 'kill')
    parts.push('Your anti-heal mattered here.');
  if (!f.selfHasGW && f.enemyHasGW && f.kind === 'death')
    parts.push('They had anti-heal—avoid extended trades.');
  if (f.diffs.levelDiff <= -2)
    parts.push(`Down ${Math.abs(f.diffs.levelDiff)} levels—high risk.`);
  if (f.diffs.goldDiff <= -800)
    parts.push(`~${Math.abs(Math.round(f.diffs.goldDiff))}g deficit.`);
  if (f.diffs.levelDiff >= 2)
    parts.push(`Up ${f.diffs.levelDiff} levels—convert to objectives.`);
  if (f.vision.enemy > f.vision.ally && f.enemyHalf)
    parts.push('Enemy had better local vision—sweep first.');
  if (f.objWin.nearbyObjective) {
    const k = f.objWin.kinds.join('/');
    parts.push(
      f.kind === 'death'
        ? `Inside ${k} window—enemy converts.`
        : `Great ${k} timing—secure it.`,
    );
  }
  if (f.enemyHalf && f.numbers.enemy >= 2 && f.kind === 'death')
    parts.push(
      f.likelyDive
        ? 'Dive pattern—thin wave, hug fog.'
        : 'Overextended—reset or wait for info.',
    );
  return parts.join(' ') || `Standard ${f.kind} with neutral context.`;
}

// =====================
// Main entry
// =====================
export async function matchDetailsNode(
  puuid: string,
  matchId: string,
  includeAssistsInKills = true,
): Promise<Record<string, unknown> | null> {
  consola.debug('[matchDetailsNode] start', {
    puuid,
    matchId,
    includeAssistsInKills,
  });

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

  const subject = participants.find((p) => p.puuid === puuid);
  if (!subject) return null;
  const subjectRoleUpper = upperRole(subject);
  const subjectGroup = roleGroup(subjectRoleUpper);
  const opponent =
    participants.find(
      (p) =>
        p.puuid !== puuid &&
        p.teamId !== subject.teamId &&
        roleGroup(upperRole(p)) === subjectGroup,
    ) ??
    participants.find((p) => p.teamId !== subject.teamId) ??
    null;

  const participantsBasic: ParticipantBasic[] = participants.map((p) => ({
    participantId: p.participantId,
    puuid: p.puuid,
    summonerName: p.summonerName,
    teamId: p.teamId,
    teamPosition: (p.teamPosition ?? 'UNKNOWN') as string,
    championId: p.championId,
    championName: p.championName,
    win: p.win,
    items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6],
    summoner1Id: p.summoner1Id,
    summoner2Id: p.summoner2Id,
    kills: p.kills,
    deaths: p.deaths,
    assists: p.assists,
    kda: calcKDA(p.kills, p.deaths, p.assists),
  }));

  const participantsDict: Record<string, ParticipantBasic> = {};
  for (const p of participantsBasic)
    participantsDict[String(p.participantId)] = p;

  const winningTeamId = teams.find((t) => t.win)?.teamId ?? null;
  const winningTeamBuilds = participants
    .filter((p) => p.teamId === winningTeamId)
    .map((p) => ({
      participantId: p.participantId,
      puuid: p.puuid,
      summonerName: p.summonerName,
      teamPosition: (p.teamPosition ?? 'UNKNOWN') as string,
      championId: p.championId,
      championName: p.championName,
      win: p.win,
      items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6],
    }));

  const timeline = await collections.timelines.findOne({
    'metadata.matchId': matchId,
  });
  if (!timeline) {
    return {
      matchId: match.metadata.matchId,
      gameCreation: match.info.gameCreation,
      gameDuration: match.info.gameDuration,
      gameMode: match.info.gameMode,
      gameVersion: match.info.gameVersion,
      mapId: match.info.mapId,
      queueId: match.info.queueId,
      subject: {
        participantId: subject.participantId,
        puuid: subject.puuid,
        summonerName: subject.summonerName,
        teamId: subject.teamId,
        teamPosition: (subject.teamPosition ?? 'UNKNOWN') as string,
        championId: subject.championId,
        championName: subject.championName,
        summoner1Id: subject.summoner1Id,
        summoner2Id: subject.summoner2Id,
        kills: subject.kills,
        deaths: subject.deaths,
        assists: subject.assists,
        kda: calcKDA(subject.kills, subject.deaths, subject.assists),
        finalItems: [
          subject.item0,
          subject.item1,
          subject.item2,
          subject.item3,
          subject.item4,
          subject.item5,
          subject.item6,
        ],
      },
      opponent: opponent
        ? {
            participantId: opponent.participantId,
            puuid: opponent.puuid,
            summonerName: opponent.summonerName,
            teamId: opponent.teamId,
            teamPosition: (opponent.teamPosition ?? 'UNKNOWN') as string,
            championId: opponent.championId,
            championName: opponent.championName,
            summoner1Id: opponent.summoner1Id,
            summoner2Id: opponent.summoner2Id,
            kills: opponent.kills,
            deaths: opponent.deaths,
            assists: opponent.assists,
            kda: calcKDA(opponent.kills, opponent.deaths, opponent.assists),
            finalItems: [
              opponent.item0,
              opponent.item1,
              opponent.item2,
              opponent.item3,
              opponent.item4,
              opponent.item5,
              opponent.item6,
            ],
          }
        : null,
      participantsBasic,
      winningTeamId,
      winningTeamBuilds,
      winningTeamItemTimelines: [],
      objectiveEventsRaw: [],
      events: [],
    };
  }

  const frames: TimelineFrame[] = Array.isArray(timeline.info?.frames)
    ? (timeline.info.frames as unknown as TimelineFrame[])
    : [];
  const eventsAll = flattenEvents(frames);

  await ensureDDragonItemsLoaded();
  const posIndex = buildPositionsIndex(frames);

  const subjectPid = subject.participantId;
  const assistInclusion = includeAssistsInKills;

  const killDeathEvents = eventsAll.filter((e) => {
    if (e.type !== 'CHAMPION_KILL') return false;
    const isKiller = e.killerId === subjectPid;
    const isVictim = e.victimId === subjectPid;
    const isAssist =
      assistInclusion && Array.isArray(e.assistingParticipantIds)
        ? e.assistingParticipantIds.includes(subjectPid)
        : false;
    return isKiller || isVictim || isAssist;
  });

  const events = killDeathEvents.map((e) => {
    const ts = e.timestamp ?? 0;
    const whenMin = minutes(ts);
    const assistIds: number[] = Array.isArray(e.assistingParticipantIds)
      ? e.assistingParticipantIds
      : [];
    const position = e.position ? e.position : null;
    const frameAt = findFrameAt(frames, ts);

    const spf = snapshotFromFrame(getParticipantFrame(frameAt, subjectPid));
    const opponentPid = opponent?.participantId ?? null;
    const opf = snapshotFromFrame(
      opponentPid ? getParticipantFrame(frameAt, opponentPid) : null,
    );

    const killerPid = e.killerId;
    const victimPid = e.victimId;
    const killerFrame = snapshotFromFrame(
      getParticipantFrame(frameAt, killerPid ?? -1),
    );
    const victimFrame = snapshotFromFrame(
      getParticipantFrame(frameAt, victimPid ?? -1),
    );

    const selfSide = teamSide(subject.teamId);
    const zone = zoneLabel(position);
    const enemyHalfFlag = isEnemyHalf(position, selfSide);

    // AOI dynamic counts
    const center = position ? { x: position.x, y: position.y } : null;
    const mandatory = [
      e.killerId,
      e.victimId,
      ...(e.assistingParticipantIds || []),
    ].filter((x): x is number => typeof x === 'number');
    const pres = aoiCountsDynamic(
      posIndex,
      participantsDict,
      frames,
      ts,
      center,
      subject.teamId,
      whenMin,
      zone,
      enemyHalfFlag,
      mandatory,
    );
    const numbers = { ally: pres.allies, enemy: pres.enemies, diff: pres.diff };

    // Inventory & spikes
    const subjInv = inventoryAtTime(eventsAll, subjectPid, ts);
    const enemyInv = opponentPid
      ? inventoryAtTime(eventsAll, opponentPid, ts)
      : { inventoryIds: [], hasGW: false };
    const selfSpike = recentSpikeWithin(
      { inventoryIds: subjInv.inventoryIds },
      120_000,
      ts,
    );
    const enemySpike = recentSpikeWithin(
      { inventoryIds: enemyInv.inventoryIds },
      120_000,
      ts,
    );

    const diffs = levelGoldDiff(frameAt, subjectPid, opponentPid ?? null);
    const objWin = objectiveWindow(eventsAll, ts, 90_000);
    const byTeam = (pid?: number) =>
      teamSide(participantsDict[String(pid ?? subjectPid)]?.teamId);
    const vision = wardsNearTimeAndPos(
      eventsAll,
      ts,
      position,
      60_000,
      2500,
      byTeam,
    );
    const likelyDiveFlag =
      position && zone.endsWith('_LANE') && numbers.enemy >= 2 ? true : false;

    let kind: 'kill' | 'death' | 'assist' = 'assist';
    if (killerPid === subjectPid) kind = 'kill';
    else if (victimPid === subjectPid) kind = 'death';

    const features: EventFeatures = {
      kind,
      whenMin,
      phase: phaseByTime(whenMin),
      zone,
      enemyHalf: enemyHalfFlag,
      numbers,
      diffs,
      spikes: {
        self: selfSpike.hasSpike,
        enemy: enemySpike.hasSpike,
        selfIds: selfSpike.spikes,
        enemyIds: enemySpike.spikes,
      },
      objWin,
      vision: { ally: vision.ally, enemy: vision.enemy },
      likelyDive: likelyDiveFlag,
      selfHasGW: subjInv.hasGW,
      enemyHasGW: enemyInv.hasGW,
    };

    const insight = writeInsight(features);

    const base = {
      kind,
      timestamp: ts,
      whenMin,
      phase: features.phase,
      position,
      zone,
      enemyHalf: enemyHalfFlag,
      numbersAdvantage: numbers,
      levelDiffAt: diffs.levelDiff,
      goldDiffAt: diffs.goldDiff,
      subjectHasGrievousWounds: subjInv.hasGW,
      enemyHasGrievousWounds: enemyInv.hasGW,
      subjectRecentSpikeItemIds: features.spikes.selfIds,
      enemyRecentSpikeItemIds: features.spikes.enemyIds,
      objectiveWindow: objWin,
      localVision: vision,
      likelyDive: likelyDiveFlag,
      // Debug AOI
      aoiRadiusUsed: pres.radius,
      aoiWindowUsed: pres.windowMs,
      aoiAllyIds: pres.allyIds,
      aoiEnemyIds: pres.enemyIds,
      killerId: killerPid,
      victimId: victimPid,
      assists: assistIds,
      subjectSnapshot: spf,
      enemySnapshot: opf,
      killerChampionStats: killerFrame.championStats,
      killerDamageStats: killerFrame.damageStats,
      victimChampionStats: victimFrame.championStats,
      victimDamageStats: victimFrame.damageStats,
      subjectInventoryAtTs: subjInv.inventoryIds,
      enemyInventoryAtTs: enemyInv.inventoryIds,
      insight,
    };

    return {
      ...base,
      killer:
        killerPid != null
          ? (participantsDict[String(killerPid)] ?? null)
          : null,
      victim:
        victimPid != null
          ? (participantsDict[String(victimPid)] ?? null)
          : null,
      assistants: assistIds
        .map((aid) => participantsDict[String(aid)])
        .filter(Boolean),
    };
  });

  const objectiveEventsRaw = eventsAll.filter(
    (e) =>
      e.type === 'ELITE_MONSTER_KILL' ||
      e.type === 'BUILDING_KILL' ||
      e.type === 'TURRET_PLATE_DESTROYED',
  );

  const winningTeamItemTimelines = winningTeamBuilds.map((wt) => ({
    participantId: wt.participantId,
    puuid: wt.puuid,
    championId: wt.championId,
    championName: wt.championName,
    teamPosition: wt.teamPosition,
    itemEvents: eventsAll
      .filter(
        (ie) =>
          isItemEventType(ie.type) && ie.participantId === wt.participantId,
      )
      .map((ie) => ({
        type: ie.type,
        itemId: ie.itemId,
        timestamp: ie.timestamp,
      })),
  }));

  return {
    matchId: match.metadata.matchId,
    gameCreation: match.info.gameCreation,
    gameDuration: match.info.gameDuration,
    gameMode: match.info.gameMode,
    gameVersion: match.info.gameVersion,
    mapId: match.info.mapId,
    queueId: match.info.queueId,
    subject: {
      participantId: subject.participantId,
      puuid: subject.puuid,
      summonerName: subject.summonerName,
      teamId: subject.teamId,
      teamPosition: (subject.teamPosition ?? 'UNKNOWN') as string,
      championId: subject.championId,
      championName: subject.championName,
      summoner1Id: subject.summoner1Id,
      summoner2Id: subject.summoner2Id,
      finalItems: [
        subject.item0,
        subject.item1,
        subject.item2,
        subject.item3,
        subject.item4,
        subject.item5,
        subject.item6,
      ],
    },
    opponent: opponent
      ? {
          participantId: opponent.participantId,
          puuid: opponent.puuid,
          summonerName: opponent.summonerName,
          teamId: opponent.teamId,
          teamPosition: (opponent.teamPosition ?? 'UNKNOWN') as string,
          championId: opponent.championId,
          championName: opponent.championName,
          summoner1Id: opponent.summoner1Id,
          summoner2Id: opponent.summoner2Id,
          finalItems: [
            opponent.item0,
            opponent.item1,
            opponent.item2,
            opponent.item3,
            opponent.item4,
            opponent.item5,
            opponent.item6,
          ],
        }
      : null,
    participantsBasic,
    winningTeamId,
    winningTeamBuilds,
    winningTeamItemTimelines,
    objectiveEventsRaw,
    events,
  } as const;
}

// =====================
// Small helpers
// =====================
function calcKDA(kills?: number, deaths?: number, assists?: number): number {
  const k = Number(kills || 0);
  const d = Number(deaths || 0);
  const a = Number(assists || 0);
  const denom = Math.max(1, d);
  const v = (k + a) / denom;
  return Number(v.toFixed(2));
}

function levelGoldDiff(
  tsFrame: TimelineFrame | null,
  selfPid: number,
  oppPid?: number | null,
) {
  const self = snapshotFromFrame(getParticipantFrame(tsFrame, selfPid));
  const opp = snapshotFromFrame(getParticipantFrame(tsFrame, oppPid ?? -1));
  return {
    levelDiff: (self.level ?? 0) - (opp.level ?? 0),
    goldDiff: (self.totalGold ?? 0) - (opp.totalGold ?? 0),
  };
}
