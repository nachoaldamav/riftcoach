import type { RiotAPITypes } from '@fightmegg/riot-api';
import type { DDragon } from '@fightmegg/riot-api';
import { collections } from '@riftcoach/clients.mongodb';
import { ALLOWED_QUEUE_IDS } from '@riftcoach/shared.constants';
import type { Item } from '@riftcoach/shared.lol-types';
import consola from 'consola';
import { riotAPI } from '../clients/riot.js';

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

/* ────────────────────────────────────────────────────────────────────────── */
/* Frames helpers                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

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
  return best && best[1] > 0 ? (best[0] as any) : 'UNKNOWN';
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

function minimalFrameSnapshot(pf: ParticipantFrame | null) {
  if (!pf) return null;
  return {
    level: pf.level,
    totalGold: pf.totalGold ?? pf.gold,
    position: pf.position ?? null,
    minionsKilled: pf.minionsKilled,
    jungleMinionsKilled: pf.jungleMinionsKilled,
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
  const frame = findFrameAt(frames, ts);
  const when = minutes(ts);
  const position = event.position ? { ...event.position } : null;
  const zone = zoneLabel(position);

  const actorIds = actorsOf(event);
  const participantStates: EventParticipantState[] = actorIds.map((pid) => {
    const p = participants.find((pp) => pp.participantId === pid)!;
    const pf = getParticipantFrame(frame, pid);
    const inv = inventoryAtTime(eventsAll, pid, ts);
    const completedAtTs = filterCompletedItemIds(inv.inventoryIds);
    return {
      participantId: pid,
      teamId: p?.teamId ?? (pid <= 5 ? 100 : 200),
      championName: p?.championName ?? '',
      frameTimestamp: frame?.timestamp ?? null,
      frame: minimalFrameSnapshot(pf),
      inventory: {
        itemIds: inv.inventoryIds,
        completedItemIds: completedAtTs,
        hasGrievousWounds: inv.hasGW,
      },
    };
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
    relatedParticipantIds: actorIds,
    participantStates,
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
  const frames: TimelineFrame[] = Array.isArray(timeline?.info?.frames)
    ? (timeline!.info.frames as unknown as TimelineFrame[])
    : [];
  const eventsAll = flattenEvents(frames);

  // Slim participants with inferred positions
  const byTeam: Record<100 | 200, RiotAPITypes.MatchV5.ParticipantDTO[]> = {
    100: participants.filter((p) => p.teamId === 100),
    200: participants.filter((p) => p.teamId === 200),
  };
  const slim: SlimParticipant[] = participants.map((p) =>
    slimParticipant(p, frames, byTeam[p.teamId as 100 | 200]),
  );

  const subject = slim.find((p) => p.puuid === puuid)!;

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
          horde: (t as any)?.objectives?.horde?.kills ?? 0, // if present on patch
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

  return {
    ...base,
    subject: subjectBlock,
    opponent: opponentBlock,
    participants: participantsBrief,
    events: relevantEvents,
  } as const;
}
