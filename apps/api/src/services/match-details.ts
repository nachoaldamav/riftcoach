import type { RiotAPITypes } from '@fightmegg/riot-api';
import type { DDragon } from '@fightmegg/riot-api';
import { collections } from '@riftcoach/clients.mongodb';
import { ALLOWED_QUEUE_IDS } from '@riftcoach/shared.constants';
import type { Item } from '@riftcoach/shared.lol-types';
import consola from 'consola';
import { riotAPI } from '../clients/riot.js';

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

export type ParticipantDetails = ParticipantBasic & {
  individualPosition: string;
  lane: string;
  role: string;
  championLevel: number;
  goldEarned: number;
  goldSpent: number;
  totalMinionsKilled: number;
  neutralMinionsKilled: number;
  totalDamageDealtToChampions: number;
  totalDamageTaken: number;
  visionScore: number;
  timePlayed: number;
  perks: RiotAPITypes.MatchV5.Perks;
  completedItemIds: number[];
  trinketId: number | null;
  rawParticipant: RiotAPITypes.MatchV5.ParticipantDTO;
};

export type EventParticipantState = {
  participantId: number;
  teamId: number;
  championName: string;
  frameTimestamp: number | null;
  frame: Record<string, unknown> | null;
  inventory: {
    itemIds: number[];
    completedItemIds: number[];
    hasGrievousWounds: boolean;
  };
};

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
  participantStates: EventParticipantState[];
  rawEvent: TimelineEvent;
};

const MAP_MIN = 0;
const MAP_MAX = 15000;

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
  teamId: number,
): boolean {
  if (!pos) return false;
  const x = norm(pos.x);
  const y = norm(pos.y);
  const s = x + y;
  return teamId === 100 ? s > 1.03 : s < 0.97;
}

function minutes(ts: number) {
  return (ts || 0) / 60000;
}

function phaseByTime(m: number): 'EARLY' | 'MID' | 'LATE' {
  if (m < 14) return 'EARLY';
  if (m < 25) return 'MID';
  return 'LATE';
}

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
    for (const [k, v] of Object.entries(rawMap || {}))
      out[String(k)] = { ...(v as Item), id: String(k) } as ItemWithId;
    DD_ITEMS = out;
    consola.debug('[ddragon] items loaded', {
      count: Object.keys(DD_ITEMS).length,
    });
  } catch (err) {
    consola.warn('[ddragon] items load failed; continuing without cache', err);
    DD_ITEMS = {};
  }
}

function isItemEventType(t: string): t is (typeof itemEventTypes)[number] {
  return (itemEventTypes as readonly string[]).includes(t);
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

function cloneParticipantFrame(
  pf: ParticipantFrame | null,
): Record<string, unknown> | null {
  if (!pf) return null;
  try {
    return JSON.parse(JSON.stringify(pf));
  } catch {
    return {
      level: pf.level ?? 0,
      xp: pf.xp ?? 0,
      gold: pf.gold ?? 0,
      totalGold: pf.totalGold ?? 0,
      currentGold: (pf as { currentGold?: number }).currentGold ?? null,
      minionsKilled: pf.minionsKilled ?? 0,
      jungleMinionsKilled: pf.jungleMinionsKilled ?? 0,
      championStats: pf.championStats ?? {},
      damageStats: pf.damageStats ?? {},
      position: pf.position ?? null,
    };
  }
}

type ItemEvt = {
  type: TimelineEvent['type'];
  itemId?: number | null;
  timestamp?: number;
};

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

function isCompletedItem(id: number): boolean {
  const it = DD_ITEMS[String(id)];
  if (!it) return true;
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

function calcKDA(kills?: number, deaths?: number, assists?: number): number {
  const k = Number(kills || 0);
  const d = Number(deaths || 0);
  const a = Number(assists || 0);
  const denom = Math.max(1, d);
  const v = (k + a) / denom;
  return Number(v.toFixed(2));
}

function buildParticipantDetails(
  p: RiotAPITypes.MatchV5.ParticipantDTO,
): ParticipantDetails {
  const items = [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6];
  return {
    participantId: p.participantId,
    puuid: p.puuid,
    summonerName: p.summonerName,
    teamId: p.teamId,
    teamPosition: (p.teamPosition ?? 'UNKNOWN') as string,
    championId: p.championId,
    championName: p.championName,
    win: !!p.win,
    items,
    summoner1Id: p.summoner1Id,
    summoner2Id: p.summoner2Id,
    kills: p.kills,
    deaths: p.deaths,
    assists: p.assists,
    kda: calcKDA(p.kills, p.deaths, p.assists),
    individualPosition: (p.individualPosition ?? 'UNKNOWN') as string,
    lane: (p.lane ?? 'UNKNOWN') as string,
    role: (p.role ?? 'UNKNOWN') as string,
    championLevel: p.champLevel,
    goldEarned: p.goldEarned,
    goldSpent: p.goldSpent,
    totalMinionsKilled: p.totalMinionsKilled,
    neutralMinionsKilled: p.neutralMinionsKilled,
    totalDamageDealtToChampions: p.totalDamageDealtToChampions,
    totalDamageTaken: p.totalDamageTaken,
    visionScore: p.visionScore,
    timePlayed: p.timePlayed,
    perks: p.perks,
    completedItemIds: filterCompletedItemIds(items),
    trinketId:
      typeof p.item6 === 'number' && Number.isFinite(p.item6)
        ? (p.item6 as number)
        : null,
    rawParticipant: p,
  } satisfies ParticipantDetails;
}

function eventInvolvesParticipant(event: TimelineEvent, pid: number): boolean {
  if (event.participantId === pid) return true;
  if (event.killerId === pid) return true;
  if (event.victimId === pid) return true;
  if (event.creatorId === pid) return true;
  if (Array.isArray(event.assistingParticipantIds))
    return event.assistingParticipantIds.includes(pid);
  return false;
}

function buildEventDetail(
  event: TimelineEvent,
  frames: TimelineFrame[],
  eventsAll: TimelineEvent[],
  participants: ParticipantDetails[],
  subjectTeamId: number,
): MatchEventDetail | null {
  const ts = Number(event.timestamp ?? 0);
  const frame = findFrameAt(frames, ts);
  const when = minutes(ts);
  const position = event.position ? { ...event.position } : null;
  const zone = zoneLabel(position);
  const participantStates: EventParticipantState[] = participants.map((p) => {
    const pf = getParticipantFrame(frame, p.participantId);
    const cloned = cloneParticipantFrame(pf);
    const inventory = inventoryAtTime(eventsAll, p.participantId, ts);
    const completedAtTs = filterCompletedItemIds(inventory.inventoryIds);
    return {
      participantId: p.participantId,
      teamId: p.teamId,
      championName: p.championName,
      frameTimestamp: frame?.timestamp ?? null,
      frame: cloned,
      inventory: {
        itemIds: inventory.inventoryIds,
        completedItemIds: completedAtTs,
        hasGrievousWounds: inventory.hasGW,
      },
    } satisfies EventParticipantState;
  });

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
    relatedParticipantIds: participantStates
      .filter((state) => {
        if (!state.frame) return false;
        return true;
      })
      .map((state) => state.participantId),
    participantStates,
    rawEvent: event,
  } satisfies MatchEventDetail;
}

export async function matchDetailsNode(
  puuid: string,
  matchId: string,
): Promise<Record<string, unknown> | null> {
  consola.debug('[matchDetailsNode] start', {
    puuid,
    matchId,
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

  const opponent =
    participants.find(
      (p) => p.teamId !== subject.teamId && p.lane === subject.lane,
    ) ?? null;

  await ensureDDragonItemsLoaded();

  const participantDetails = participants.map((p) =>
    buildParticipantDetails(p),
  );

  const participantsBasic: ParticipantBasic[] = participantDetails.map((p) => ({
    participantId: p.participantId,
    puuid: p.puuid,
    summonerName: p.summonerName,
    teamId: p.teamId,
    teamPosition: p.teamPosition,
    championId: p.championId,
    championName: p.championName,
    win: p.win,
    items: p.items,
    summoner1Id: p.summoner1Id,
    summoner2Id: p.summoner2Id,
    kills: p.kills,
    deaths: p.deaths,
    assists: p.assists,
    kda: p.kda,
  }));

  const timeline = await collections.timelines.findOne({
    'metadata.matchId': matchId,
  });

  const baseResponse = {
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
      completedFinalItems: filterCompletedItemIds([
        subject.item0,
        subject.item1,
        subject.item2,
        subject.item3,
        subject.item4,
        subject.item5,
        subject.item6,
      ]),
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
          completedFinalItems: filterCompletedItemIds([
            opponent.item0,
            opponent.item1,
            opponent.item2,
            opponent.item3,
            opponent.item4,
            opponent.item5,
            opponent.item6,
          ]),
        }
      : null,
    teams,
    participantsBasic,
    participants: participantDetails,
  };

  if (!timeline) {
    return {
      ...baseResponse,
      events: [],
    } as const;
  }

  const frames: TimelineFrame[] = Array.isArray(timeline.info?.frames)
    ? (timeline.info.frames as unknown as TimelineFrame[])
    : [];
  const eventsAll = flattenEvents(frames);

  const subjectPid = subject.participantId;
  const relevantEvents = eventsAll
    .filter((e) => eventInvolvesParticipant(e, subjectPid))
    .map((event) =>
      buildEventDetail(
        event,
        frames,
        eventsAll,
        participantDetails,
        subject.teamId,
      ),
    )
    .filter((evt): evt is MatchEventDetail => evt !== null);

  return {
    ...baseResponse,
    events: relevantEvents,
  } as const;
}
