import type { RiotAPITypes } from '@fightmegg/riot-api';
import { collections } from '@riftcoach/clients.mongodb';
import { ALLOWED_QUEUE_IDS } from '@riftcoach/shared.constants';
import consola from 'consola';

// Define local timeline types to avoid missing Riot type exports
type TimelineEvent = {
  type: string;
  timestamp?: number;
  position?: { x: number; y: number } | null;
  participantId?: number;
  killerId?: number;
  victimId?: number;
  assistingParticipantIds?: number[];
  itemId?: number;
};

type ParticipantFrame = {
  level?: number;
  xp?: number;
  gold?: number;
  totalGold?: number;
  minionsKilled?: number;
  jungleMinionsKilled?: number;
  championStats?: unknown;
  damageStats?: unknown;
};

type TimelineFrame = {
  timestamp?: number;
  events?: TimelineEvent[];
  participantFrames?: Record<string, ParticipantFrame>;
};

// Helpers
const itemEventTypes = [
  'ITEM_PURCHASED',
  'ITEM_SOLD',
  'ITEM_DESTROYED',
  'ITEM_UNDO',
  'ITEM_TRANSFORMED',
] as const;
const removalEventTypes = new Set<
  'ITEM_SOLD' | 'ITEM_DESTROYED' | 'ITEM_UNDO'
>(['ITEM_SOLD', 'ITEM_DESTROYED', 'ITEM_UNDO']);
const grievousWoundsItemIds = [3916, 3165, 3011, 3123, 3033, 3075];

function upperRole(p: RiotAPITypes.MatchV5.ParticipantDTO): string {
  const raw = p.teamPosition ?? p.individualPosition ?? p.lane ?? '';
  return String(raw || '').toUpperCase();
}

function roleGroup(roleUpper: string): 'TOP' | 'JUNGLE' | 'MID' | 'BOTTOM' | 'SUPPORT' | 'UNKNOWN' {
  if (roleUpper === 'TOP') return 'TOP';
  if (roleUpper === 'JUNGLE') return 'JUNGLE';
  if (roleUpper === 'MIDDLE' || roleUpper === 'MID') return 'MID';
  if (roleUpper === 'BOTTOM' || roleUpper === 'BOT' || roleUpper === 'ADC' || roleUpper === 'DUO_CARRY') return 'BOTTOM';
  if (roleUpper === 'SUPPORT' || roleUpper === 'UTILITY' || roleUpper === 'DUO_SUPPORT') return 'SUPPORT';
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

function findFrameAt(frames: TimelineFrame[], ts: number): TimelineFrame | null {
  if (!frames || frames.length === 0) return null;
  // Frames are typically sorted ascending by timestamp; get the latest <= ts
  let cur: TimelineFrame | null = null;
  for (const f of frames) {
    if (typeof f.timestamp !== 'number') continue;
    if (f.timestamp <= ts) cur = f;
    else break;
  }
  // If none <= ts, fallback to first
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

function isItemEventType(t: string): t is typeof itemEventTypes[number] {
  return (itemEventTypes as readonly string[]).includes(t);
}

function isRemovalEventType(t: string): t is 'ITEM_SOLD' | 'ITEM_DESTROYED' | 'ITEM_UNDO' {
  return t === 'ITEM_SOLD' || t === 'ITEM_DESTROYED' || t === 'ITEM_UNDO';
}

function itemEventsUpTo(
  eventsAll: TimelineEvent[],
  pid: number,
  ts: number,
) {
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
    } else if (isRemovalEventType(ie.type)) {
      if (typeof ie.itemId === 'number') removedIds.push(ie.itemId);
    }
  }
  const itemEvents = filtered.map((ie) => ({
    type: ie.type,
    itemId: ie.itemId,
    timestamp: ie.timestamp,
  }));
  const inv = purchasedIds.filter((id) => !removedIds.includes(id));
  const hasGW = inv.some((id) => grievousWoundsItemIds.includes(id));
  return { itemEvents, purchasedIds, removedIds, inventoryIds: inv, hasGW };
}

export async function matchDetailsNode(
  puuid: string,
  matchId: string,
  includeAssistsInKills = true,
): Promise<Record<string, unknown> | null> {
  consola.debug('[matchDetailsNode] start', { puuid, matchId, includeAssistsInKills });

  const match = await collections.matches.findOne({
    'metadata.matchId': matchId,
    'info.participants.puuid': puuid,
  });

  if (!match) {
    consola.debug('[matchDetailsNode] match not found');
    return null;
  }
  const allowedQueues = ALLOWED_QUEUE_IDS as unknown as readonly number[];
  if (!allowedQueues.includes(match.info.queueId as number)) {
    consola.debug('[matchDetailsNode] queue not allowed', match.info.queueId);
    return null;
  }

  const participants = match.info.participants;
  const teams = match.info.teams;

  const subject = participants.find((p) => p.puuid === puuid);
  if (!subject) {
    consola.debug('[matchDetailsNode] subject missing in participants');
    return null;
  }
  const subjectRoleUpper = upperRole(subject);
  const subjectGroup = roleGroup(subjectRoleUpper);
  const opponent = participants.find(
    (p) => p.puuid !== puuid && p.teamId !== subject.teamId && roleGroup(upperRole(p)) === subjectGroup,
  ) ?? participants.find((p) => p.teamId !== subject.teamId) ?? null;

  if (!opponent) {
    consola.debug('[matchDetailsNode] opponent not found, falling back to any enemy');
  }

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

  const participantsDict: Record<string, typeof participantsBasic[number]> = {};
  for (const p of participantsBasic) participantsDict[String(p.participantId)] = p;

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

  const timeline = await collections.timelines.findOne({ 'metadata.matchId': matchId });
  if (!timeline) {
    consola.debug('[matchDetailsNode] timeline not found');
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
        finalItems: [subject.item0, subject.item1, subject.item2, subject.item3, subject.item4, subject.item5, subject.item6],
      },
      opponent: opponent ? {
        participantId: opponent.participantId,
        puuid: opponent.puuid,
        summonerName: opponent.summonerName,
        teamId: opponent.teamId,
        teamPosition: (opponent.teamPosition ?? 'UNKNOWN') as string,
        championId: opponent.championId,
        championName: opponent.championName,
        summoner1Id: opponent.summoner1Id,
        summoner2Id: opponent.summoner2Id,
        finalItems: [opponent.item0, opponent.item1, opponent.item2, opponent.item3, opponent.item4, opponent.item5, opponent.item6],
      } : null,
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
  consola.debug('[matchDetailsNode] flattened events', { total: eventsAll.length, frames: frames.length });

  const subjectPid = subject.participantId;
  const assistInclusion = includeAssistsInKills;

  const killDeathEvents = eventsAll.filter((e) => {
    if (e.type !== 'CHAMPION_KILL') return false;
    const isKiller = e.killerId === subjectPid;
    const isVictim = e.victimId === subjectPid;
    const isAssist = assistInclusion && Array.isArray(e.assistingParticipantIds)
      ? e.assistingParticipantIds.includes(subjectPid)
      : false;
    return isKiller || isVictim || isAssist;
  });

  const events = killDeathEvents.map((e) => {
    const ts = e.timestamp ?? 0;
    const assistIds: number[] = Array.isArray(e.assistingParticipantIds)
      ? e.assistingParticipantIds
      : [];
    const position = e.position ? e.position : null;
    const frameAt = findFrameAt(frames, ts);

    const spf = snapshotFromFrame(getParticipantFrame(frameAt, subjectPid));
    const opponentPid = opponent?.participantId ?? null;
    const opf = snapshotFromFrame(opponentPid ? getParticipantFrame(frameAt, opponentPid) : null);

    const killerPid = e.killerId;
    const victimPid = e.victimId;

    const killerFrame = snapshotFromFrame(getParticipantFrame(frameAt, killerPid ?? -1));
    const victimFrame = snapshotFromFrame(getParticipantFrame(frameAt, victimPid ?? -1));
    const assistantsStats = assistIds.map((aid) => ({
      participantId: aid,
      championStats: snapshotFromFrame(getParticipantFrame(frameAt, aid)).championStats,
    }));

    const subjItems = itemEventsUpTo(eventsAll, subjectPid, ts);
    const enemyItems = opponentPid ? itemEventsUpTo(eventsAll, opponentPid, ts) : { itemEvents: [], purchasedIds: [], removedIds: [], inventoryIds: [], hasGW: false };

    let kind: 'kill' | 'death' | 'assist' = 'assist';
    if (killerPid === subjectPid) kind = 'kill';
    else if (victimPid === subjectPid) kind = 'death';

    const base = {
      kind,
      timestamp: ts,
      position,
      killerId: killerPid,
      victimId: victimPid,
      assists: assistIds,
      subjectSnapshot: spf,
      enemySnapshot: opf,
      killerChampionStats: killerFrame.championStats,
      killerDamageStats: killerFrame.damageStats,
      victimChampionStats: victimFrame.championStats,
      victimDamageStats: victimFrame.damageStats,
      assistantsStats,
      subjectItemEventsUpTo: subjItems.itemEvents,
      enemyItemEventsUpTo: enemyItems.itemEvents,
      subjectPurchasedItemsUpTo: subjItems.purchasedIds,
      subjectRemovedItemsUpTo: subjItems.removedIds,
      enemyPurchasedItemsUpTo: enemyItems.purchasedIds,
      enemyRemovedItemsUpTo: enemyItems.removedIds,
      subjectHasGrievousWounds: subjItems.hasGW,
      enemyHasGrievousWounds: enemyItems.hasGW,
    };

    return {
      ...base,
      killer: killerPid != null ? participantsDict[String(killerPid)] ?? null : null,
      victim: victimPid != null ? participantsDict[String(victimPid)] ?? null : null,
      assistants: assistIds.map((aid) => participantsDict[String(aid)]).filter(Boolean),
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
      .filter((ie) => isItemEventType(ie.type) && ie.participantId === wt.participantId)
      .map((ie) => ({ type: ie.type, itemId: ie.itemId, timestamp: ie.timestamp })),
  }));

  consola.debug('[matchDetailsNode] built events', { killsOrDeaths: events.length });

  const result = {
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
      finalItems: [subject.item0, subject.item1, subject.item2, subject.item3, subject.item4, subject.item5, subject.item6],
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
          finalItems: [opponent.item0, opponent.item1, opponent.item2, opponent.item3, opponent.item4, opponent.item5, opponent.item6],
        }
      : null,
    participantsBasic,
    winningTeamId,
    winningTeamBuilds,
    winningTeamItemTimelines,
    objectiveEventsRaw,
    events,
  };

  return result;
}