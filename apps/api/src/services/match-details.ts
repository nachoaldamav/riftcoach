import type { RiotAPITypes } from '@fightmegg/riot-api';
import type { DDragon } from '@fightmegg/riot-api';
import { collections } from '@riftcoach/clients.mongodb';
import { ALLOWED_QUEUE_IDS } from '@riftcoach/shared.constants';
import type { Item } from '@riftcoach/shared.lol-types';
import consola from 'consola';
import { riotAPI } from '../clients/riot.js';

// Extend the official DDragon type with an id property for our use case
type ItemWithId = Item & { id: string };

/**
 * Match insights v2 — context-rich, map-aware micro-stories per event
 * - Geometry + zone tagging + enemy-half
 * - Numbers advantage from event membership
 * - Level/Gold diffs from frames
 * - Item spike detection via DDragon (mythics / tier-2 boots / large legendaries)
 * - Vision density around the event (wards within ±60s and radius)
 * - Objective window (±90s around Drake/Herald/Baron kills)
 * - Heuristic flags: overextension, likely dive
 * - Insight writer: turns features into crisp, specific feedback
 */

// =====================
// Timeline local types
// =====================
export type TimelineEvent = {
  type: string;
  timestamp?: number;
  position?: { x: number; y: number } | null;
  participantId?: number;
  killerId?: number;
  victimId?: number;
  assistingParticipantIds?: number[];
  itemId?: number;
  // Optional DDragon-ish ward fields Riot includes in timeline
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
};

export type TimelineFrame = {
  timestamp?: number;
  events?: TimelineEvent[];
  participantFrames?: Record<string, ParticipantFrame>;
};

// =====================
// DDragon (items) cache
// =====================
export type DDragonItemsById = Record<string, ItemWithId>;

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
};

let _dd: DDragon | null = null;
let DD_ITEMS: DDragonItemsById = {};

/** Initialize (or refresh) a light item cache from DDragon using @fightmegg/riot-api. */
export async function ensureDDragonItemsLoaded(): Promise<void> {
  if (!_dd) _dd = riotAPI.ddragon;
  try {
    // fightmegg exposes an items accessor as ddragon.item.all()
    const itemsAny = (await _dd.items()).data;
    // Handle both possible shapes (array or { data }) defensively.
    const rawMap: Record<string, Item> = Array.isArray(itemsAny)
      ? {} // If it's an array, we can't use it directly as a Record
      : (itemsAny as Record<string, Item>);

    const out: DDragonItemsById = {};
    for (const [k, v] of Object.entries(rawMap)) {
      // Normalize id to string key - use the key from the data structure
      const idStr = String(k);
      out[idStr] = {
        ...v,
        id: idStr,
      } as ItemWithId;
    }
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
  if (
    roleUpper === 'BOTTOM' ||
    roleUpper === 'BOT' ||
    roleUpper === 'ADC' ||
    roleUpper === 'DUO_CARRY'
  )
    return 'BOTTOM';
  if (
    roleUpper === 'SUPPORT' ||
    roleUpper === 'UTILITY' ||
    roleUpper === 'DUO_SUPPORT'
  )
    return 'SUPPORT';
  return 'UNKNOWN';
}

function flattenEvents(frames: TimelineFrame[]): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const f of frames || []) {
    const fe = f.events;
    if (Array.isArray(fe)) out.push(...fe);
  }
  return out;
}

function findFrameAt(
  frames: TimelineFrame[],
  ts: number,
): TimelineFrame | null {
  if (!frames || frames.length === 0) return null;
  let cur: TimelineFrame | null = null;
  for (const f of frames) {
    if (typeof f.timestamp !== 'number') continue;
    if (f.timestamp <= ts) cur = f;
    else break;
  }
  return cur ?? frames[0] ?? null;
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
  if (!pf) {
    return {
      level: 0,
      xp: 0,
      gold: 0,
      totalGold: 0,
      cs: 0,
      championStats: {},
      damageStats: {},
    };
  }
  const minions = Number(pf.minionsKilled || 0);
  const jungle = Number(pf.jungleMinionsKilled || 0);
  const championStats = pf.championStats ?? {};
  const damageStats = pf.damageStats ?? {};
  return {
    level: Number(pf.level || 0),
    xp: Number(pf.xp || 0),
    gold: Number(pf.gold || 0),
    totalGold: Number(pf.totalGold || 0),
    cs: minions + jungle,
    championStats,
    damageStats,
  };
}

function isItemEventType(t: string): t is (typeof itemEventTypes)[number] {
  return (itemEventTypes as readonly string[]).includes(t);
}

function itemEventsUpTo(eventsAll: TimelineEvent[], pid: number, ts: number) {
  const filtered = eventsAll.filter(
    (ie) =>
      isItemEventType(ie.type) &&
      ie.participantId === pid &&
      (typeof ie.timestamp === 'number' ? ie.timestamp <= ts : true),
  );
  const purchasedIds: number[] = [];
  const removedIds: number[] = [];
  for (const ie of filtered) {
    if (ie.type === 'ITEM_PURCHASED') {
      if (typeof ie.itemId === 'number') purchasedIds.push(ie.itemId);
    } else if (
      ie.type === 'ITEM_SOLD' ||
      ie.type === 'ITEM_DESTROYED' ||
      ie.type === 'ITEM_UNDO'
    ) {
      if (typeof ie.itemId === 'number') removedIds.push(ie.itemId);
    }
  }
  const itemEvents = filtered.map((ie) => ({
    type: ie.type,
    itemId: ie.itemId,
    timestamp: ie.timestamp,
  }));
  const inv = purchasedIds.filter((id) => !removedIds.includes(id));
  // Broad GW set; keep it simple
  const grievousWoundsItemIds = [3916, 3165, 3011, 3123, 3033, 3075];
  const hasGW = inv.some((id) => grievousWoundsItemIds.includes(id));
  return { itemEvents, purchasedIds, removedIds, inventoryIds: inv, hasGW };
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
  const nearRiver = distToDiag < 0.06;
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
  return side === 'BLUE' ? s > 1.02 : s < 0.98;
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
// Spikes / vision / objectives
// =====================
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
  if (!it) return isTier2Boot(id); // fallback
  if (isTier2Boot(id)) return true;
  if (isLikelyMythic(it)) return true;
  return (it.depth ?? 0) >= 3 && !(it.from && it.from.length <= 1);
}

function recentSpikeWithin(
  itemEventsUpToObj: ReturnType<typeof itemEventsUpTo>,
  sinceMs: number,
  ts: number,
) {
  const recent = itemEventsUpToObj.itemEvents
    .filter(
      (e) =>
        e.type === 'ITEM_PURCHASED' &&
        typeof e.timestamp === 'number' &&
        ts - (e.timestamp ?? 0) <= sinceMs,
    )
    .map((e) => e.itemId)
    .filter((id): id is number => id != null);
  const spikes = recent.filter(isBigSpike);
  return { recent, spikes, hasSpike: spikes.length > 0 };
}

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

function numbersAdvantage(
  e: TimelineEvent,
  selfPid: number,
  participantsDict: Record<string, ParticipantBasic>,
) {
  const killer = e.killerId;
  const victim = e.victimId;
  const assistIds = (e.assistingParticipantIds || []).filter(
    Boolean,
  ) as number[];
  const pids = new Set<number>(
    [killer, victim, ...assistIds].filter((id): id is number => id != null),
  );
  const selfTeam = participantsDict[String(selfPid)]?.teamId;
  let ally = 0;
  let enemy = 0;
  for (const pid of pids) {
    const t = participantsDict[String(pid)]?.teamId;
    if (!t) continue;
    if (t === selfTeam) ally++;
    else enemy++;
  }
  return { ally, enemy, diff: ally - enemy };
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

function likelyDive(
  pos: { x: number; y: number } | null,
  zone: string,
  numbers: { ally: number; enemy: number },
) {
  if (!pos) return false;
  const inLane = zone.endsWith('_LANE');
  return inLane && numbers.enemy >= 2;
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

  if (f.numbers.diff <= -1)
    parts.push(
      `You took a ${Math.abs(f.numbers.diff)}-player disadvantage ${zoneText}${f.enemyHalf ? ' on enemy territory' : ''}.`,
    );
  else if (f.numbers.diff >= 1)
    parts.push(
      `Good ${f.numbers.ally}v${f.numbers.enemy} setup ${zoneText}${f.enemyHalf ? ' deep in enemy side' : ''}.`,
    );
  else
    parts.push(`Even fight ${zoneText}${f.enemyHalf ? ' on enemy half' : ''}.`);

  if (f.spikes.enemy && !f.spikes.self)
    parts.push(
      'Enemy had a fresh item spike within ~2m; consider delaying or pulling to neutral ground.',
    );
  if (f.spikes.self && !f.spikes.enemy)
    parts.push('You had a fresh spike—nice timing to force.');
  if (f.selfHasGW && !f.enemyHasGW && f.kind === 'kill')
    parts.push('Grievous Wounds helped secure the kill—keep it vs sustain.');
  if (!f.selfHasGW && f.enemyHasGW && f.kind === 'death')
    parts.push(
      'Enemy applied Grievous Wounds—avoid extended trades until it wears off.',
    );

  if (f.diffs.levelDiff <= -2)
    parts.push(
      `You were down ${Math.abs(f.diffs.levelDiff)} levels—high risk.`,
    );
  if (f.diffs.goldDiff <= -800)
    parts.push(
      `~${Math.abs(Math.round(f.diffs.goldDiff))}g deficit made this tough.`,
    );
  if (f.diffs.levelDiff >= 2)
    parts.push(
      `You had a ${f.diffs.levelDiff}-level lead—convert to objectives.`,
    );

  if (f.vision.enemy > f.vision.ally && f.enemyHalf)
    parts.push(
      'Enemy had better local vision; sweep or path through safer fog.',
    );
  if (f.objWin.nearbyObjective) {
    const k = f.objWin.kinds.join('/');
    if (f.kind === 'death')
      parts.push(`This death is inside the ${k} window—enemy can convert.`);
    else parts.push(`Great timing around ${k}—translate into the take.`);
  }

  if (f.enemyHalf && f.numbers.enemy >= 2 && f.kind === 'death') {
    if (f.likelyDive)
      parts.push('Classic dive pattern—thin the wave and hug fog earlier.');
    else
      parts.push(
        'Overextended without cover—reset earlier or wait for info on enemy positions.',
      );
  }

  return parts.length
    ? parts.join(' ')
    : `Standard ${f.kind} with neutral context.`;
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

  const participantsBasic = participants.map((p) => ({
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
      winningTeamItemTimelines: [],
      objectiveEventsRaw: [],
      events: [],
    };
  }

  const frames: TimelineFrame[] = Array.isArray(timeline.info?.frames)
    ? (timeline.info.frames as unknown as TimelineFrame[])
    : [];
  const eventsAll = flattenEvents(frames);

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

  // Ensure DDragon items are ready for spike logic
  await ensureDDragonItemsLoaded();

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

    const subjItems = itemEventsUpTo(eventsAll, subjectPid, ts);
    const enemyItems = opponentPid
      ? itemEventsUpTo(eventsAll, opponentPid, ts)
      : {
          itemEvents: [],
          purchasedIds: [],
          removedIds: [],
          inventoryIds: [],
          hasGW: false,
        };

    let kind: 'kill' | 'death' | 'assist' = 'assist';
    if (killerPid === subjectPid) kind = 'kill';
    else if (victimPid === subjectPid) kind = 'death';

    const selfSide = teamSide(subject.teamId);
    const zone = zoneLabel(position);
    const enemyHalfFlag = isEnemyHalf(position, selfSide);
    const numbers = numbersAdvantage(e, subjectPid, participantsDict);
    const diffs = levelGoldDiff(frameAt, subjectPid, opponentPid ?? null);

    const selfSpike = recentSpikeWithin(subjItems, 120_000, ts);
    const enemySpike = recentSpikeWithin(enemyItems, 120_000, ts);

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

    const likelyDiveFlag = likelyDive(position, zone, numbers);

    const features = {
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
      selfHasGW: subjItems.hasGW,
      enemyHasGW: enemyItems.hasGW,
    } satisfies EventFeatures;

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
      subjectHasGrievousWounds: subjItems.hasGW,
      enemyHasGrievousWounds: enemyItems.hasGW,
      subjectRecentSpikeItemIds: features.spikes.selfIds,
      enemyRecentSpikeItemIds: features.spikes.enemyIds,
      objectiveWindow: objWin,
      localVision: vision,
      likelyDive: likelyDiveFlag,

      killerId: killerPid,
      victimId: victimPid,
      assists: assistIds,

      subjectSnapshot: spf,
      enemySnapshot: opf,
      killerChampionStats: killerFrame.championStats,
      killerDamageStats: killerFrame.damageStats,
      victimChampionStats: victimFrame.championStats,
      victimDamageStats: victimFrame.damageStats,

      subjectItemEventsUpTo: subjItems.itemEvents,
      enemyItemEventsUpTo: enemyItems.itemEvents,
      subjectPurchasedItemsUpTo: subjItems.purchasedIds,
      subjectRemovedItemsUpTo: subjItems.removedIds,
      enemyPurchasedItemsUpTo: enemyItems.purchasedIds,
      enemyRemovedItemsUpTo: enemyItems.removedIds,

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
