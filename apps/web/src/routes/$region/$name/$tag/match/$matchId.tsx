import { cn } from '@/lib/utils';
import { useDataDragon } from '@/providers/data-dragon-provider';
import {
  type ItemSuggestion,
  getAllMatchDataQueryOptions,
} from '@/queries/get-match-insights';
import { Avatar, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { motion } from 'framer-motion';
import { ChevronRight, Clock, Map as MapIcon, Target, Zap } from 'lucide-react';
import type { RiotAPITypes } from '@fightmegg/riot-api';
import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';

export const Route = createFileRoute('/$region/$name/$tag/match/$matchId')({
  component: MatchAnalysisComponent,
});

// ────────────────────────────────────────────────────────────────────────────
// Interpolation + helper utilities
// ────────────────────────────────────────────────────────────────────────────
type Vec2 = { x: number; y: number };

type TimelineEvent = {
  type: string;
  timestamp?: number;
  position?: Vec2 | null;
  participantId?: number;
  killerId?: number;
  victimId?: number;
  assistingParticipantIds?: number[];
  creatorId?: number;
  itemId?: number | null;
  beforeId?: number | null;
  afterId?: number | null;
};

type ParticipantFrame = {
  position?: Vec2;
  level?: number;
  totalGold?: number;
  gold?: number;
  currentGold?: number;
  minionsKilled?: number;
  jungleMinionsKilled?: number;
  xp?: number;
  championStats?: Record<string, number>;
  damageStats?: Record<string, number>;
  [key: string]: unknown;
};

type TimelineFrame = {
  timestamp?: number;
  events?: TimelineEvent[];
  participantFrames?: Record<string, ParticipantFrame>;
};

type SnapshotEntry = {
  participantId: number;
  championName: string;
  teamId: number;
  summonerName: string;
  x: number;
  y: number;
  confidence: number;
  radius: number;
  isActor: boolean;
  frame: ParticipantFrame | null;
  frameTimestamp: number | null;
  frameDeltaMs: number | null;
  snapshotSource: 'previous' | 'next' | 'none';
  currentGold: number | null;
  totalGold: number | null;
  cs: number;
  inventory: number[];
  hasGrievousWounds: boolean;
  ts: number;
};

type EventSnapshot = {
  ts: number;
  eventPos: Vec2 | null;
  entries: SnapshotEntry[];
};

const dist2 = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

function boundingFrames(frames: TimelineFrame[], ts: number) {
  if (!frames?.length)
    return {
      f0: null as TimelineFrame | null,
      f1: null as TimelineFrame | null,
    };
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
  const f0 = frames[ans] ?? null;
  const f1 = frames[Math.min(ans + 1, frames.length - 1)] ?? null;
  return { f0, f1 };
}

function interpolateParticipantPosition(
  frames: TimelineFrame[],
  pid: number,
  ts: number,
) {
  const { f0, f1 } = boundingFrames(frames, ts);
  const p0: Vec2 | null =
    f0?.participantFrames?.[String(pid)]?.position ?? null;
  const p1: Vec2 | null =
    f1?.participantFrames?.[String(pid)]?.position ?? null;
  const t0 = Number(f0?.timestamp ?? Number.NaN);
  const t1 = Number(f1?.timestamp ?? Number.NaN);

  // If both timestamps are valid, pick the closest frame (no interpolation)
  if (p0 && p1 && Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0) {
    const d0 = Math.abs(ts - t0);
    const d1 = Math.abs(t1 - ts);
    const chosen = d1 < d0 ? { pos: p1, dt: d1 } : { pos: p0, dt: d0 };

    // Confidence & radius scale with time distance to the chosen frame start
    const secFromChosen = chosen.dt / 1000;
    const radius = 80 + secFromChosen * 10; // map units
    const confidence = Math.max(0.25, 1 - secFromChosen / 180);

    return {
      position: chosen.pos,
      confidence,
      radius,
      source: 'nearest' as const,
    };
  }

  // One-sided fallback
  if (p0 && Number.isFinite(t0)) {
    const gap = Math.abs(ts - t0) / 1000;
    return {
      position: p0,
      confidence: Math.max(0.25, 1 - gap / 180),
      radius: 80 + gap * 10,
      source: 'nearest' as const,
    };
  }
  if (p1 && Number.isFinite(t1)) {
    const gap = Math.abs(t1 - ts) / 1000;
    return {
      position: p1,
      confidence: Math.max(0.25, 1 - gap / 180),
      radius: 80 + gap * 10,
      source: 'nearest' as const,
    };
  }

  return {
    position: null,
    confidence: 0,
    radius: 300,
    source: 'missing' as const,
  };
}

function findClosestKillEvent(
  frames: TimelineFrame[],
  ts: number,
): { event: TimelineEvent; diffMs: number } | null {
  let best: TimelineEvent | null = null;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const fr of frames) {
    for (const ev of fr?.events ?? []) {
      if (ev?.type !== 'CHAMPION_KILL' || typeof ev?.timestamp !== 'number')
        continue;
      const diff = Math.abs(ev.timestamp - ts);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = ev;
      }
    }
  }
  return best ? { event: best, diffMs: bestDiff } : null;
}

const ITEM_EVENT_TYPES = new Set<string>([
  'ITEM_PURCHASED',
  'ITEM_SOLD',
  'ITEM_DESTROYED',
  'ITEM_UNDO',
  'ITEM_TRANSFORMED',
]);

const GRIEVOUS_WOUND_ITEM_IDS = new Set<number>([
  3916, 3165, 3011, 3123, 3033, 3076, 3075,
]);

function computeInventoryAtTime(
  events: TimelineEvent[],
  participantId: number,
  ts: number,
) {
  if (!events.length) return { inventoryIds: [] as number[], hasGrievousWounds: false };
  const inventory: number[] = [];

  const add = (id?: number | null) => {
    if (typeof id === 'number' && Number.isFinite(id) && id > 0) {
      inventory.push(id);
    }
  };

  const remove = (id?: number | null) => {
    if (typeof id !== 'number' || !Number.isFinite(id) || id <= 0) return;
    for (let i = inventory.length - 1; i >= 0; i -= 1) {
      if (inventory[i] === id) {
        inventory.splice(i, 1);
        break;
      }
    }
  };

  for (const evt of events) {
    if (evt.participantId !== participantId) continue;
    const evtTs = typeof evt.timestamp === 'number' ? evt.timestamp : 0;
    if (evtTs > ts) break;
    if (!evt?.type || !ITEM_EVENT_TYPES.has(evt.type)) continue;

    switch (evt.type) {
      case 'ITEM_PURCHASED':
        add(evt.itemId);
        break;
      case 'ITEM_SOLD':
      case 'ITEM_DESTROYED':
        remove(evt.itemId);
        break;
      case 'ITEM_UNDO':
        if (evt.beforeId) remove(evt.beforeId);
        if (evt.afterId) add(evt.afterId);
        else if (evt.itemId) remove(evt.itemId);
        break;
      case 'ITEM_TRANSFORMED':
        if (evt.beforeId) remove(evt.beforeId);
        if (evt.afterId) add(evt.afterId);
        else add(evt.itemId);
        break;
      default:
        break;
    }
  }

  const hasGrievousWounds = inventory.some((id) => GRIEVOUS_WOUND_ITEM_IDS.has(id));
  return { inventoryIds: inventory, hasGrievousWounds };
}

function selectParticipantFrameForTimestamp(
  previous: TimelineFrame | null,
  next: TimelineFrame | null,
  participantId: number,
  ts: number,
) {
  const prevFrame = previous?.participantFrames?.[String(participantId)] ?? null;
  const nextFrame = next?.participantFrames?.[String(participantId)] ?? null;
  const prevTs = Number(previous?.timestamp ?? Number.NaN);
  const nextTs = Number(next?.timestamp ?? Number.NaN);

  if (
    prevFrame &&
    nextFrame &&
    Number.isFinite(prevTs) &&
    Number.isFinite(nextTs)
  ) {
    const diffPrev = Math.abs(ts - prevTs);
    const diffNext = Math.abs(nextTs - ts);
    if (diffNext < diffPrev) {
      return {
        frame: nextFrame,
        frameTimestamp: nextTs,
        frameDeltaMs: diffNext,
        snapshotSource: 'next' as const,
      };
    }
    return {
      frame: prevFrame,
      frameTimestamp: prevTs,
      frameDeltaMs: diffPrev,
      snapshotSource: 'previous' as const,
    };
  }

  if (prevFrame && Number.isFinite(prevTs)) {
    return {
      frame: prevFrame,
      frameTimestamp: prevTs,
      frameDeltaMs: Math.abs(ts - prevTs),
      snapshotSource: 'previous' as const,
    };
  }

  if (nextFrame && Number.isFinite(nextTs)) {
    return {
      frame: nextFrame,
      frameTimestamp: nextTs,
      frameDeltaMs: Math.abs(nextTs - ts),
      snapshotSource: 'next' as const,
    };
  }

  return {
    frame: null,
    frameTimestamp: null,
    frameDeltaMs: null,
    snapshotSource: 'none' as const,
  };
}

const numberFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0,
});

const preciseNumberFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
});

// ────────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────────
function MatchAnalysisComponent() {
  const { region, name, tag, matchId } = Route.useParams();
  const { version } = useDataDragon();

  // Use the new query options
  const queryOptions = getAllMatchDataQueryOptions(region, name, tag, matchId);

  const { data: matchData, isLoading: isMatchLoading } = useQuery(
    queryOptions.match,
  );
  const { data: timelineData, isLoading: isTimelineLoading } = useQuery(
    queryOptions.timeline,
  );
  const { data: insightsData, isLoading: isInsightsLoading } = useQuery(
    queryOptions.insights,
  );
  const { data: buildsData, isLoading: isBuildsLoading } = useQuery(
    queryOptions.builds,
  );

  // Summoner Spells mapping (id -> spell key, e.g., 4 -> 'SummonerFlash')
  const { data: spellKeyById } = useQuery<{ [id: number]: string }>({
    queryKey: ['ddragon-spells', version],
    enabled: Boolean(version),
    queryFn: async () => {
      const res = await fetch(
        `https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/summoner.json`,
      );
      const json = (await res.json()) as {
        data: Record<
          string,
          { id: string; key: string; image: { full: string } }
        >;
      };
      const map: Record<number, string> = {};
      for (const spell of Object.values(json.data)) {
        const keyNum = Number(spell.key);
        if (!Number.isNaN(keyNum)) map[keyNum] = spell.id;
      }
      return map;
    },
  });

  // Compute map bounds from timeline for coordinate normalization
  const [maxX, maxY] = useMemo(() => {
    if (!timelineData) return [15000, 15000] as const;
    try {
      const xs: number[] = [];
      const ys: number[] = [];
      for (const frame of timelineData.info.frames || []) {
        for (const pf of Object.values(frame.participantFrames || {})) {
          const pos = (pf as { position?: Vec2 }).position;
          if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
            xs.push(pos.x);
            ys.push(pos.y);
          }
        }
      }
      const mx = xs.length ? Math.max(...xs) : 15000;
      const my = ys.length ? Math.max(...ys) : 15000;
      return [mx, my] as const;
    } catch {
      return [15000, 15000] as const;
    }
  }, [timelineData]);

  // Key moments state
  const [selectedMomentIndex, setSelectedMomentIndex] = useState(0);
  const selectedMoment = insightsData?.keyMoments[selectedMomentIndex] || null;

  const participantById = useMemo(() => {
    if (!matchData)
      return new Map<
        number,
        { championName: string; teamId: number; summonerName: string }
      >();
    const m = new Map<
      number,
      { championName: string; teamId: number; summonerName: string }
    >();
    for (const p of matchData.info.participants) {
      m.set(p.participantId, {
        championName: p.championName,
        teamId: p.teamId,
        summonerName: p.summonerName,
      });
    }
    return m;
  }, [matchData]);

  const participantDetailsById = useMemo(() => {
    if (!matchData)
      return new Map<number, RiotAPITypes.MatchV5.ParticipantDTO>();
    const map = new Map<number, RiotAPITypes.MatchV5.ParticipantDTO>();
    for (const p of matchData.info.participants) {
      map.set(p.participantId, p);
    }
    return map;
  }, [matchData]);

  const timelineEvents = useMemo(() => {
    if (!timelineData) return [] as TimelineEvent[];
    const frames: TimelineFrame[] = (timelineData.info.frames || []) as TimelineFrame[];
    const evts: TimelineEvent[] = [];
    for (const frame of frames) {
      for (const evt of frame?.events ?? []) {
        if (evt) evts.push(evt as TimelineEvent);
      }
    }
    return evts.sort(
      (a, b) => Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0),
    );
  }, [timelineData]);

  // Interpolated snapshot at the event timestamp
  const eventSnapshot = useMemo(() => {
    if (!timelineData || !matchData || !selectedMoment) return null;
    const frames: TimelineFrame[] = (timelineData.info.frames ||
      []) as TimelineFrame[];
    const ts = selectedMoment.ts;

    const { f0: frameBefore, f1: frameAfter } = boundingFrames(frames, ts);

    // Find closest CHAMPION_KILL to snap killer/victim to exact event position if appropriate
    const killInfo = findClosestKillEvent(frames, ts);
    const killEvent = killInfo?.event ?? null;
    const eventPos: Vec2 | null = killEvent?.position ?? null;
    const diffMs = killInfo?.diffMs ?? Number.POSITIVE_INFINITY;

    const actorIds = new Set<number>(
      [
        killEvent?.killerId,
        killEvent?.victimId,
        ...(killEvent?.assistingParticipantIds ?? []),
      ].filter((x): x is number => typeof x === 'number'),
    );

    // Participant meta
    const meta = new Map<
      number,
      { championName: string; teamId: number; summonerName: string }
    >();
    for (const p of matchData.info.participants) {
      meta.set(p.participantId, {
        championName: p.championName,
        teamId: p.teamId,
        summonerName: p.summonerName,
      });
    }

    const entries: SnapshotEntry[] = [];

    const SAFE_SNAP_MS = 250; // Only trust event position when very close in time
    const SAME_SPOT_EPS = 60; // Considered same spot in map units for snapping

    for (let pid = 1; pid <= 10; pid++) {
      const m = meta.get(pid);
      if (!m) continue;
      const snap = interpolateParticipantPosition(frames, pid, ts);
      let pos = snap.position;
      let conf = snap.confidence;
      let rad = snap.radius;
      const isActor = actorIds.has(pid);

      // Snap logic: Victim snaps to event position if time is close; Killer only if also spatially the same
      if (isActor && eventPos && killEvent) {
        const trustEventTime = diffMs <= SAFE_SNAP_MS;
        const distanceToEvent =
          pos && eventPos ? dist2(pos, eventPos) : Number.POSITIVE_INFINITY;

        if (pid === killEvent.victimId) {
          if (trustEventTime) {
            pos = eventPos;
            conf = Math.max(conf, 0.9);
            rad = Math.min(rad, 40);
          }
        } else if (pid === killEvent.killerId) {
          // Only snap killer if their interpolated position is essentially at the event spot and time is close
          if (trustEventTime && distanceToEvent <= SAME_SPOT_EPS) {
            pos = eventPos;
            conf = Math.max(conf, 0.85);
            rad = Math.min(rad, 40);
          }
        }
      }

      if (pos) {
        const frameInfo = selectParticipantFrameForTimestamp(
          frameBefore,
          frameAfter,
          pid,
          ts,
        );
        const { inventoryIds, hasGrievousWounds } = computeInventoryAtTime(
          timelineEvents,
          pid,
          ts,
        );
        const currentGold =
          typeof frameInfo.frame?.currentGold === 'number'
            ? frameInfo.frame.currentGold
            : typeof frameInfo.frame?.gold === 'number'
              ? frameInfo.frame.gold
              : null;
        const totalGold =
          typeof frameInfo.frame?.totalGold === 'number'
            ? frameInfo.frame.totalGold
            : typeof frameInfo.frame?.gold === 'number'
              ? frameInfo.frame.gold
              : null;
        const csValue =
          (frameInfo.frame?.minionsKilled ?? 0) +
          (frameInfo.frame?.jungleMinionsKilled ?? 0);

        entries.push({
          participantId: pid,
          championName: m.championName,
          teamId: m.teamId,
          summonerName: m.summonerName,
          x: pos.x,
          y: pos.y,
          confidence: conf,
          radius: rad,
          isActor,
          frame: frameInfo.frame,
          frameTimestamp: frameInfo.frameTimestamp,
          frameDeltaMs: frameInfo.frameDeltaMs,
          snapshotSource: frameInfo.snapshotSource,
          currentGold,
          totalGold,
          cs: csValue,
          inventory: inventoryIds,
          hasGrievousWounds,
          ts,
        });
      }
    }

    return { ts, eventPos, entries } satisfies EventSnapshot;
  }, [timelineData, matchData, selectedMoment, timelineEvents]);

  // AOI center for zooming (prefer event position, fallback to actors' centroid, then selectedMoment.coordinates[0])
  const [aoiZoomEnabled, setAoiZoomEnabled] = useState(true);
  const aoiCenter = useMemo(() => {
    if (eventSnapshot?.eventPos) return eventSnapshot.eventPos;
    const actorEntries = eventSnapshot?.entries?.filter((e) => e.isActor) ?? [];
    if (actorEntries.length > 0) {
      const sx = actorEntries.reduce((acc, e) => acc + e.x, 0);
      const sy = actorEntries.reduce((acc, e) => acc + e.y, 0);
      return { x: sx / actorEntries.length, y: sy / actorEntries.length };
    }
    const cc =
      selectedMoment && 'coordinates' in selectedMoment
        ? (selectedMoment as { coordinates?: { x: number; y: number }[] })
            ?.coordinates?.[0]
        : undefined;
    if (cc && typeof cc.x === 'number' && typeof cc.y === 'number')
      return cc as Vec2;
    return null;
  }, [eventSnapshot, selectedMoment]);

  const getMapTransformStyle = (zoom: number): CSSProperties => {
    if (!aoiZoomEnabled || zoom <= 1) return {};
    const useMaxX = maxX || 15000;
    const useMaxY = maxY || 15000;

    let cx = 0.5; // normalized [0..1] from left
    let cyTop = 0.5; // normalized [0..1] from top
    if (aoiCenter) {
      const normX =
        aoiCenter.x > 1 || aoiCenter.y > 1
          ? aoiCenter.x / useMaxX
          : aoiCenter.x;
      const normY =
        aoiCenter.x > 1 || aoiCenter.y > 1
          ? aoiCenter.y / useMaxY
          : aoiCenter.y;
      cx = Math.min(1, Math.max(0, normX));
      const yTop = 1 - normY; // convert to top-left origin space
      cyTop = Math.min(1, Math.max(0, yTop));
    }

    // Compute translate in %; clamp so the scaled map stays within bounds
    const minT = (1 - zoom) * 100; // left/top most allowed
    const tx = Math.min(0, Math.max(minT, (0.5 - zoom * cx) * 100));
    const ty = Math.min(0, Math.max(minT, (0.5 - zoom * cyTop) * 100));

    return {
      transformOrigin: '0 0',
      transform: `translate(${tx}%, ${ty}%) scale(${zoom})`,
    };
  };

  // Separate loading states - only block on essential match data
  const isEssentialDataLoading = isMatchLoading || isTimelineLoading;

  // Helper functions
  const getChampionCentered = (championName: string) =>
    `https://ddragon.leagueoflegends.com/cdn/img/champion/centered/${championName}_0.jpg`;

  function findKillParticipants(
    ts: number,
  ): { killer?: string; victim?: string } | null {
    if (!timelineData) return null;
    const frames: TimelineFrame[] = (timelineData.info.frames ||
      []) as TimelineFrame[];
    let best: { killer?: number; victim?: number } | null = null;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (const frame of frames) {
      for (const ev of frame.events || []) {
        if (ev.type === 'CHAMPION_KILL' && typeof ev.timestamp === 'number') {
          const diff = Math.abs(ev.timestamp - ts);
          if (diff < bestDiff) {
            bestDiff = diff;
            best = { killer: ev.killerId, victim: ev.victimId };
          }
        }
      }
    }
    if (!best) return null;
    const killerName = best.killer
      ? participantById.get(best.killer)?.championName
      : undefined;
    const victimName = best.victim
      ? participantById.get(best.victim)?.championName
      : undefined;
    if (!killerName && !victimName) return null;
    return { killer: killerName, victim: victimName };
  }

  // Utilities for assets
  const { version: ddVersion } = useDataDragon();
  const getChampionSquare = (championName: string) =>
    ddVersion
      ? `https://ddragon.leagueoflegends.com/cdn/${ddVersion}/img/champion/${championName}.png`
      : `https://ddragon.leagueoflegends.com/cdn/img/champion/${championName}.png`;

  const getItemIcon = (itemId?: number) =>
    ddVersion && itemId && itemId > 0
      ? `https://ddragon.leagueoflegends.com/cdn/${ddVersion}/img/item/${itemId}.png`
      : '';

  const getSpellIcon = (spellId?: number) => {
    if (!spellId || !version || !spellKeyById) return '';
    const key = spellKeyById[spellId];
    if (!key) return '';
    return `https://ddragon.leagueoflegends.com/cdn/${version}/img/spell/${key}.png`;
  };

  const formatClock = (ms: number) => {
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  const coordToStyle = (x: number, y: number): CSSProperties => {
    const useMaxX = maxX || 15000;
    const useMaxY = maxY || 15000;
    const normX = x > 1 || y > 1 ? x / useMaxX : x; // support normalized or absolute
    const normY = x > 1 || y > 1 ? y / useMaxY : y;
    return {
      left: `${normX * 100}%`,
      top: `${(1 - normY) * 100}%`, // invert Y for top-left origin
      transform: 'translate(-50%, -50%)',
    };
  };

  const radiusToStyle = (rUnits: number): CSSProperties => {
    const useMaxX = maxX || 15000;
    const useMaxY = maxY || 15000;
    const w = (rUnits / useMaxX) * 100;
    const h = (rUnits / useMaxY) * 100;
    return { width: `${w * 2}%`, height: `${h * 2}%` }; // diameter
  };

  // Subject participant and slot suggestions mapping
  const subjectParticipant = useMemo(() => {
    if (!matchData) return null;
    const nameLc = name.toLowerCase();
    const tagLc = tag.toLowerCase();

    interface MaybeRiotId {
      riotIdGameName?: string;
      riotIdTagline?: string;
    }

    const byRiotId = matchData.info.participants.find((p) => {
      const rp = p as MaybeRiotId;
      return (
        typeof rp.riotIdGameName === 'string' &&
        typeof rp.riotIdTagline === 'string' &&
        rp.riotIdGameName.toLowerCase() === nameLc &&
        rp.riotIdTagline.toLowerCase() === tagLc
      );
    });
    if (byRiotId) return byRiotId;

    const bySummoner = matchData.info.participants.find(
      (p) =>
        typeof p.summonerName === 'string' &&
        p.summonerName.toLowerCase() === nameLc,
    );
    return bySummoner ?? null;
  }, [matchData, name, tag]);

  const slotKeys = [
    'item0',
    'item1',
    'item2',
    'item3',
    'item4',
    'item5',
  ] as const;

  const slotColumns = useMemo(() => {
    const baseItems = subjectParticipant
      ? [
          subjectParticipant.item0 || 0,
          subjectParticipant.item1 || 0,
          subjectParticipant.item2 || 0,
          subjectParticipant.item3 || 0,
          subjectParticipant.item4 || 0,
          subjectParticipant.item5 || 0,
        ]
      : [0, 0, 0, 0, 0, 0];

    const suggestions: ItemSuggestion[] = buildsData?.suggestions ?? [];

    return slotKeys.map((slotKey, idx) => {
      let baseId = baseItems[idx] || 0;

      // Gather suggestions relevant to this slot
      const slotSugs = suggestions.filter((s: ItemSuggestion) => {
        if (s.action === 'add_to_slot' && s.targetSlot === slotKey) return true;
        if (s.action === 'replace_item') {
          const repStr = s.replaceItemId;
          const repNum = repStr ? Number(repStr) : Number.NaN;
          return Number.isFinite(repNum) && repNum === baseId;
        }
        return false;
      });

      // If we have an add_to_slot suggestion, treat it as overriding the base item
      const addOverrides = slotSugs.filter(
        (s: ItemSuggestion) =>
          s.action === 'add_to_slot' && s.targetSlot === slotKey,
      );
      let overridden = false;
      if (addOverrides.length > 0) {
        const chosen = addOverrides[0];
        const sugStr = chosen.suggestedItemId;
        const sugNum = sugStr ? Number(sugStr) : 0;
        baseId = Number.isFinite(sugNum) ? sugNum : 0;
        overridden = true;
      }

      // Map remaining suggestions (exclude add_to_slot used as base override)
      const mapped = slotSugs
        .filter(
          (s: ItemSuggestion) =>
            !(s.action === 'add_to_slot' && s.targetSlot === slotKey),
        )
        .map((s: ItemSuggestion) => {
          const sugStr = s.suggestedItemId;
          const sugNum = sugStr ? Number(sugStr) : 0;
          const repStr = s.replaceItemId;
          const repNum = repStr ? Number(repStr) : 0;
          return {
            id: Number.isFinite(sugNum) ? sugNum : 0,
            name: s.suggestedItemName as string | undefined,
            action: s.action as string,
            reasoning: s.reasoning as string,
            replacesId: Number.isFinite(repNum) ? repNum : 0,
            replacesName: s.replaceItemName as string | undefined,
            targetSlot: s.targetSlot as string | undefined,
          };
        });

      return { slotKey, baseId, suggestions: mapped, overridden };
    });
  }, [subjectParticipant, buildsData, slotKeys]);

  if (isEssentialDataLoading) {
    return (
      <div className="max-w-7xl mx-auto">
        <div className="animate-pulse space-y-6">
          <div className="h-8 bg-neutral-800 rounded w-1/3" />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="h-96 bg-neutral-800 rounded-xl" />
            <div className="h-96 bg-neutral-800 rounded-xl" />
          </div>
        </div>
      </div>
    );
  }

  if (!matchData || !timelineData) {
    return (
      <div className="max-w-7xl mx-auto">
        <Card className="bg-red-900/20 border-red-500/30">
          <CardBody className="p-8 text-center">
            <Target className="w-12 h-12 mx-auto mb-4 text-red-400" />
            <h2 className="text-xl font-bold text-red-400 mb-2">
              Match Not Found
            </h2>
            <p className="text-neutral-400">
              Unable to load match data. The match may not exist or there was an
              error fetching the data.
            </p>
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="max-w-7xl mx-auto space-y-8">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center gap-4"
      >
        <h1 className="text-3xl font-bold text-neutral-50">Match Analysis</h1>
        <Badge className="bg-accent-blue-500/15 text-accent-blue-200 border border-accent-blue-400/40">
          {matchData.info.gameMode}
        </Badge>
      </motion.div>

      {/* Match Results (Scoreboard) */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
      >
        <Card className="bg-neutral-900/90 backdrop-blur-sm border border-neutral-700/60">
          <CardBody className="p-8">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl font-bold text-neutral-50 flex items-center gap-3">
                <Target className="w-6 h-6 text-accent-blue-400" />
                Match Results
              </h2>
              <div className="flex items-center gap-2 text-sm text-neutral-400">
                <Clock className="w-4 h-4" />
                {Math.floor(matchData.info.gameDuration / 60)}m{' '}
                {matchData.info.gameDuration % 60}s
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              {matchData.info.teams.map((team) => (
                <div key={team.teamId} className="space-y-4">
                  {/* Team result header */}
                  <div
                    className={`text-center p-4 rounded-lg ${team.win ? 'bg-accent-emerald-900/30 border border-accent-emerald-500/30' : 'bg-red-900/30 border border-red-500/30'}`}
                  >
                    <h3
                      className={`text-lg font-bold ${team.win ? 'text-accent-emerald-400' : 'text-red-400'}`}
                    >
                      {team.win ? 'Victory' : 'Defeat'}
                      <span className="ml-2 text-sm text-neutral-300">
                        ({team.teamId === 100 ? 'Blue Side' : 'Red Side'})
                      </span>
                    </h3>
                  </div>

                  {/* Players */}
                  <div className="space-y-2">
                    {matchData.info.participants
                      .filter((p) => p.teamId === team.teamId)
                      .map((p) => {
                        const rp = p as {
                          riotIdGameName?: string;
                          riotIdTagline?: string;
                        };
                        const isSubject = subjectParticipant?.puuid === p.puuid;
                        const displayName = rp.riotIdGameName ?? p.summonerName;
                        const displayTag =
                          rp.riotIdTagline ?? (isSubject ? tag : undefined);
                        const teamKills = matchData.info.participants
                          .filter((q) => q.teamId === team.teamId)
                          .reduce((acc, q) => acc + (q.kills ?? 0), 0);
                        const minutes = Math.max(
                          1,
                          Math.floor(matchData.info.gameDuration / 60),
                        );
                        const csTotal =
                          (p.totalMinionsKilled ?? 0) +
                          (p.neutralMinionsKilled ?? 0);
                        const csPerMin = csTotal / minutes;
                        const kpPct =
                          teamKills > 0
                            ? Math.round(
                                ((p.kills + p.assists) / teamKills) * 100,
                              )
                            : 0;
                        return (
                          <div
                            key={`row-${p.puuid}`}
                            className={cn(
                              'flex items-center gap-3 p-3 rounded-lg border transition-colors',
                              isSubject
                                ? 'bg-accent-blue-900/20 border-accent-blue-400 ring-2 ring-accent-blue-400'
                                : 'bg-neutral-800/50 border-neutral-700/40',
                            )}
                          >
                            {/* Champion + spells */}
                            <div className="flex items-center gap-2 shrink-0">
                              <Avatar className="h-10 w-10 rounded-lg">
                                <AvatarImage
                                  src={getChampionSquare(p.championName)}
                                  alt={p.championName}
                                />
                              </Avatar>
                              <div className="flex flex-col gap-1">
                                <img
                                  src={getSpellIcon(p.summoner1Id)}
                                  alt="S1"
                                  className="w-5 h-5 rounded border border-neutral-700 bg-neutral-900 object-cover"
                                />
                                <img
                                  src={getSpellIcon(p.summoner2Id)}
                                  alt="S2"
                                  className="w-5 h-5 rounded border border-neutral-700 bg-neutral-900 object-cover"
                                />
                              </div>
                            </div>

                            {/* Name + tagline + small stats */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 truncate">
                                <span className="font-medium text-neutral-200 truncate">
                                  {displayName}
                                </span>
                                {displayTag && (
                                  <span className="text-xs text-neutral-300 px-2 py-0.5 rounded border border-neutral-700/60 bg-neutral-800/60">
                                    #{displayTag}
                                  </span>
                                )}
                              </div>
                              <div className="mt-0.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-400">
                                <span className="flex items-center gap-1">
                                  <span className="text-neutral-500">KDA</span>
                                  <span className="text-neutral-300 font-semibold">
                                    {p.kills}/{p.deaths}/{p.assists}
                                  </span>
                                </span>
                                <span className="flex items-center gap-1">
                                  <span className="text-neutral-500">
                                    CS/min
                                  </span>
                                  <span className="text-neutral-300 font-semibold">
                                    {csPerMin.toFixed(1)}
                                  </span>
                                </span>
                                <span className="flex items-center gap-1">
                                  <span className="text-neutral-500">
                                    Vision
                                  </span>
                                  <span className="text-neutral-300 font-semibold">
                                    {p.visionScore ?? 0}
                                  </span>
                                </span>
                                {teamKills > 0 && (
                                  <span className="flex items-center gap-1">
                                    <span className="text-neutral-500">KP</span>
                                    <span className="text-neutral-300 font-semibold">
                                      {kpPct}%
                                    </span>
                                  </span>
                                )}
                              </div>

                              {/* Items */}
                              <div className="flex items-center gap-1 mt-2">
                                {[
                                  p.item0,
                                  p.item1,
                                  p.item2,
                                  p.item3,
                                  p.item4,
                                  p.item5,
                                ].map((it: number | undefined, idx: number) =>
                                  it && it > 0 ? (
                                    <img
                                      key={`it-${p.puuid}-${idx}-${it}`}
                                      src={getItemIcon(it)}
                                      alt="item"
                                      className="w-5 h-5 rounded bg-neutral-900 border border-neutral-700 object-cover"
                                    />
                                  ) : (
                                    <div
                                      key={`it-${p.puuid}-${idx}-${it}`}
                                      className="w-5 h-5 rounded bg-neutral-800/50 border border-neutral-700/40"
                                    />
                                  ),
                                )}
                                {/* Trinket */}
                                <img
                                  key={`it-${p.puuid}-trinket-${p.item6}`}
                                  src={getItemIcon(p.item6)}
                                  alt="trinket"
                                  className="w-5 h-5 rounded bg-neutral-900 border border-amber-500/50 object-cover"
                                />
                              </div>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      </motion.div>

      {/* Build Suggestions */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
      >
        <Card className="bg-neutral-900/90 backdrop-blur-sm border border-neutral-700/60">
          <CardBody className="p-6">
            <div className="flex items-center gap-1 mb-4 flex-row">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                data-name="Your Icon"
                viewBox="0 0 100 125"
                x="0px"
                y="0px"
                className="size-8 text-white"
                color="currentColor"
                fill="currentColor"
                stroke="transparent"
              >
                <title>Item Suggestions</title>
                <path d="m90.64,59.09l-16.25-7.09c-3.93-1.71-7.06-4.85-8.77-8.77l-7.09-16.25c-.55-1.26-2.34-1.26-2.89,0l-7.09,16.25c-1.71,3.93-4.85,7.06-8.77,8.77l-16.27,7.1c-1.26.55-1.26,2.33,0,2.88l16.55,7.32c3.92,1.73,7.04,4.88,8.73,8.82l6.86,15.94c.54,1.27,2.34,1.27,2.89,0l7.08-16.22c1.71-3.93,4.85-7.06,8.77-8.77l16.25-7.09c1.26-.55,1.26-2.34,0-2.89Z" />
                <path d="m25.28,48.51l3.32-7.61c.8-1.84,2.27-3.31,4.11-4.11l7.62-3.32c.59-.26.59-1.1,0-1.35l-7.62-3.32c-1.84-.8-3.31-2.27-4.11-4.11l-3.32-7.62c-.26-.59-1.1-.59-1.35,0l-3.32,7.62c-.8,1.84-2.27,3.31-4.11,4.11l-7.63,3.33c-.59.26-.59,1.09,0,1.35l7.76,3.43c1.84.81,3.3,2.29,4.09,4.13l3.22,7.47c.26.59,1.1.6,1.35,0Z" />
                <path d="m39.89,13.95l4.12,1.82c.98.43,1.75,1.22,2.17,2.19l1.71,3.97c.14.32.58.32.72,0l1.76-4.04c.43-.98,1.21-1.76,2.18-2.18l4.04-1.76c.31-.14.31-.58,0-.72l-4.04-1.76c-.98-.43-1.76-1.21-2.18-2.18l-1.76-4.04c-.14-.31-.58-.31-.72,0l-1.76,4.04c-.43.98-1.21,1.76-2.18,2.18l-4.05,1.77c-.31.14-.31.58,0,.72Z" />
              </svg>
              <Tooltip>
                <TooltipTrigger asChild>
                  <h2 className="text-2xl font-bold text-neutral-50 decoration-dotted underline">
                    Item Suggestions
                  </h2>
                </TooltipTrigger>
                <TooltipContent className="bg-black/90 text-neutral-100">
                  AI generated item suggestions
                </TooltipContent>
              </Tooltip>
            </div>

            {/* 6 columns: built item + suggestions */}
            <div className="flex items-center gap-4 overflow-x-auto py-2">
              {isBuildsLoading ? (
                <div className="flex items-center justify-center w-full py-8">
                  <div className="flex items-center gap-3">
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-accent-yellow-400" />
                    <span className="text-neutral-300">Generating build recommendation with AI...</span>
                  </div>
                </div>
              ) : buildsData?.buildOrder && buildsData.buildOrder.length > 0 ? (
                buildsData.buildOrder.map((entry, idx) => (
                  <div key={`bo-${entry.order}-${entry.itemId}`} className="flex items-center gap-2">
                    <div className="flex flex-col items-center">
                      {entry.itemId > 0 ? (
                        <img
                          src={getItemIcon(entry.itemId)}
                          alt={entry.itemName}
                          title={entry.reasoning}
                          className="size-12 rounded-lg bg-neutral-900 border border-accent-yellow-500/50 object-cover"
                        />
                      ) : (
                        <div className="size-12 rounded-lg bg-neutral-800/50 border border-neutral-700/50" />
                      )}
                      <span className="mt-1 text-xs text-neutral-400">#{entry.order} {entry.itemName}</span>
                    </div>
                    {idx < buildsData.buildOrder.length - 1 && (
                      <ChevronRight className="w-4 h-4 text-neutral-500" />
                    )}
                  </div>
                ))
              ) : (
                slotColumns.map((col, idx) => (
                  <div key={`col-wrapper-${col.slotKey}`} className="flex items-center gap-2">
                    <div
                      key={`col-${col.slotKey}`}
                      className="flex flex-col items-start gap-3 ml-2"
                    >
                      {/* Base item */}
                      <div className="flex flex-col items-center">
                        {col.baseId > 0 ? (
                          <img
                            src={getItemIcon(col.baseId)}
                            alt={`Base ${col.slotKey}`}
                            title={
                              col.overridden
                                ? 'AI override: component added to slot'
                                : undefined
                            }
                            className={cn(
                              'size-12 rounded-lg bg-neutral-900 border object-cover',
                              col.overridden
                                ? 'border-accent-yellow-500/70 ring-2 ring-accent-yellow-400'
                                : 'border-neutral-700/70',
                            )}
                          />
                        ) : (
                          <div className="size-12 rounded-lg bg-neutral-800/50 border border-neutral-700/50" />
                        )}
                      </div>

                      {/* Suggestions stack */}
                      <div className="flex flex-col gap-2">
                        {col.suggestions.length > 0
                          ? col.suggestions.map((sug, sidx) => (
                          <div
                                key={`sug-${col.slotKey}-${sidx}-${sug.id}`}
                                className="relative"
                                title={
                                  sug.action === 'replace_item'
                                    ? `Replace ${sug.replacesName ?? 'item'} → ${sug.name ?? 'recommended'}. ${sug.reasoning}`
                                    : `Add to ${col.slotKey}. ${sug.reasoning}`
                                }
                              >
                                <img
                                  src={getItemIcon(sug.id)}
                                  alt={sug.name || 'Suggestion'}
                                  className="size-12 rounded-lg bg-neutral-900 border border-accent-yellow-500/50 object-cover"
                                />
                                {sug.action === 'replace_item' && sug.replacesId > 0 ? (
                                  <img
                                    src={getItemIcon(sug.replacesId)}
                                    alt={sug.replacesName || 'Replaced item'}
                                    className="absolute -bottom-1 -left-1 size-5 rounded-full bg-neutral-900 border border-red-500/60 object-cover shadow-md"
                                  />
                                ) : null}
                                <span
                                  className={cn(
                                    'absolute -top-1 -right-1 text-[10px] px-1 py-0.5 rounded border',
                                    sug.action === 'replace_item'
                                      ? 'bg-red-900/60 border-red-500/60 text-red-200'
                                      : 'bg-accent-yellow-900/60 border-accent-yellow-500/60 text-accent-yellow-200',
                                  )}
                                >
                                  {sug.action === 'replace_item' ? 'Replace' : 'Add'}
                                </span>
                              </div>
                            ))
                          : null}
                      </div>
                    </div>
                    {idx < slotColumns.length - 1 && (
                      <ChevronRight className="w-4 h-4 text-neutral-500" />
                    )}
                  </div>
                ))
              )}
            </div>

            {/* Overall analysis */}
            {buildsData?.overallAnalysis && (
              <p className="mt-4 text-sm text-neutral-300 leading-relaxed">
                {buildsData.overallAnalysis}
              </p>
            )}
          </CardBody>
        </Card>
      </motion.div>

      {/* Key Moments with Map */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
      >
        <Card className="bg-neutral-900/90 backdrop-blur-sm border border-neutral-700/60">
          <CardBody className="p-8">
            <div className="flex items-center gap-3 mb-6">
              <Zap className="w-6 h-6 text-accent-yellow-400" />
              <h2 className="text-2xl font-bold text-neutral-50">
                Key Moments
              </h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-5 gap-6">
              {/* Map */}
              <div className="md:col-span-3">
                <div className="relative w-full aspect-square bg-gradient-to-br from-neutral-800 to-neutral-900 rounded-2xl overflow-hidden border border-neutral-700/50">
                  {/* Transform layer: scales and pans the map and markers to center AOI */}
                  <div
                    className="absolute inset-0"
                    style={getMapTransformStyle(1.75)}
                  >
                    <img
                      src="/map.svg"
                      alt="Summoner's Rift Map"
                      className="absolute inset-0 w-full h-full opacity-70 contrast-90 filter brightness-75"
                    />

                    {/* Interpolated player markers at selected moment */}
                    {eventSnapshot?.entries.map((pp) => {
                      const participantDetails = participantDetailsById.get(
                        pp.participantId,
                      );
                      return (
                        <div
                          key={`pp-${pp.participantId}`}
                          className="absolute"
                          style={coordToStyle(pp.x, pp.y)}
                        >
                          {/* Uncertainty halo */}
                          <div
                            className="absolute rounded-full border border-white/10 bg-white/5"
                            style={{
                              ...radiusToStyle(pp.radius),
                              left: '50%',
                              top: '50%',
                              transform: 'translate(-50%, -50%)',
                              opacity: Math.max(
                                0.25,
                                Math.min(0.85, 1 - pp.confidence + 0.35),
                              ),
                              filter: 'blur(2px)',
                            }}
                          />
                          {/* Avatar marker */}
                          <Popover>
                            <PopoverTrigger asChild>
                              <Avatar
                                className={cn(
                                  'h-6 w-6 cursor-pointer rounded-md ring-2 transition-transform hover:scale-[1.08]',
                                  pp.teamId === 100
                                    ? 'ring-blue-400'
                                    : 'ring-red-400',
                                  'shadow-md z-20',
                                  !pp.isActor ? 'opacity-50' : '',
                                )}
                              >
                                <AvatarImage
                                  src={getChampionSquare(pp.championName)}
                                  alt={pp.summonerName}
                                />
                              </Avatar>
                            </PopoverTrigger>
                            <PopoverContent
                              side="top"
                              align="center"
                              className="w-80 max-w-[18rem] border-neutral-700/70 bg-neutral-900/95 p-0 text-neutral-100"
                            >
                              <PlayerPopoverContent
                                entry={pp}
                                participant={participantDetails}
                                formatClock={formatClock}
                                getChampionSquare={getChampionSquare}
                                getItemIcon={getItemIcon}
                              />
                            </PopoverContent>
                          </Popover>
                        </div>
                      );
                    })}
                  </div>

                  {/* Corner controls (outside of transform so UI doesn't scale) */}
                  <div className="absolute top-4 right-4 flex items-center gap-2">
                    <div className="px-2 py-1 rounded bg-neutral-900/80 border border-neutral-700/60 text-xs text-neutral-300 flex items-center gap-1">
                      <MapIcon className="w-3 h-3" />
                      {eventSnapshot
                        ? `t ${formatClock(eventSnapshot.ts)}`
                        : '—'}
                    </div>
                    <button
                      type="button"
                      onClick={() => setAoiZoomEnabled((v) => !v)}
                      className={`px-2 py-1 rounded text-xs border ${aoiZoomEnabled ? 'bg-accent-yellow-500/20 border-accent-yellow-400/50 text-accent-yellow-200' : 'bg-neutral-900/80 border-neutral-700/60 text-neutral-300'}`}
                      title="Toggle Area-of-Interest zoom"
                    >
                      {aoiZoomEnabled ? 'Zoom Out' : 'Zoom In'}
                    </button>
                  </div>
                </div>

                {/* Selected moment details */}
                {selectedMoment && (
                  <div className="mt-4 p-4 bg-neutral-800/60 rounded-lg border border-neutral-700/50">
                    <div className="flex items-center justify-between mb-1">
                      <h3 className="font-semibold text-neutral-100 truncate">
                        {selectedMoment.title}
                      </h3>
                      <Badge
                        className={`text-xs font-semibold ${
                          selectedMoment.enemyHalf
                            ? 'bg-red-500/10 text-red-200 border border-red-500/40'
                            : 'bg-neutral-800/70 text-neutral-200 border border-neutral-700/60'
                        }`}
                      >
                        {selectedMoment.zone}
                      </Badge>
                    </div>
                    <p className="text-sm text-neutral-300">
                      {selectedMoment.insight}
                    </p>
                    {selectedMoment.suggestion && (
                      <p className="text-xs text-neutral-400 mt-1 italic">
                        Suggestion: {selectedMoment.suggestion}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Moments list */}
              <div className="space-y-3 md:col-span-2">
                {isInsightsLoading ? (
                  <div className="flex items-center justify-center w-full py-8">
                    <div className="flex items-center gap-3">
                      <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-accent-yellow-400" />
                      <span className="text-neutral-300">Gathering key moments...</span>
                    </div>
                  </div>
                ) : (
                  insightsData?.keyMoments.map((moment, index: number) => {
                    const isSelected = index === selectedMomentIndex;
                    const versus = findKillParticipants(moment.ts);
                    return (
                      <motion.button
                        key={`km-${moment.ts}-${moment.title.slice(0, 10)}`}
                        type="button"
                        onClick={() => setSelectedMomentIndex(index)}
                        initial={{ opacity: 0, x: 10 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: index * 0.03 }}
                        className={`w-full text-left p-3 rounded-lg border transition-colors ${isSelected ? 'bg-neutral-800/70 border-accent-yellow-400/50' : 'bg-neutral-800/40 border-neutral-700/50 hover:bg-neutral-800/70'}`}
                      >
                        {versus && (
                        <div className="relative h-12 mb-2 rounded-lg overflow-hidden">
                          {/* Killer background (left side) */}
                          <div
                            className="absolute inset-0 w-1/2 bg-cover opacity-100"
                            style={{
                              backgroundImage: versus.killer
                                ? `url(${getChampionCentered(versus.killer)})`
                                : 'none',
                              backgroundPosition: 'center 20%',
                              maskImage:
                                'linear-gradient(to right, rgba(0,0,0,1) 0%, rgba(0,0,0,0.8) 70%, rgba(0,0,0,0) 100%)',
                              WebkitMaskImage:
                                'linear-gradient(to right, rgba(0,0,0,1) 0%, rgba(0,0,0,0.8) 70%, rgba(0,0,0,0) 100%)',
                            }}
                          />
                          {/* Victim background (right side) */}
                          <div
                            className="absolute inset-0 left-1/2 w-1/2 bg-cover opacity-40 grayscale"
                            style={{
                              backgroundImage: versus.victim
                                ? `url(${getChampionCentered(versus.victim)})`
                                : 'none',
                              backgroundPosition: 'center 20%',
                              maskImage:
                                'linear-gradient(to left, rgba(0,0,0,1) 0%, rgba(0,0,0,0.8) 70%, rgba(0,0,0,0) 100%)',
                              WebkitMaskImage:
                                'linear-gradient(to left, rgba(0,0,0,1) 0%, rgba(0,0,0,0.8) 70%, rgba(0,0,0,0) 100%)',
                            }}
                          />
                          <div className="absolute inset-0 bg-black/30" />
                          <div className="relative flex items-center justify-center h-full">
                            <span className="text-sm font-bold text-white drop-shadow-lg">
                              VS
                            </span>
                          </div>
                        </div>
                      )}
                      <div className="flex items-center justify-between">
                        <h4 className="font-medium text-neutral-100 truncate">
                          {moment.title}
                        </h4>
                        <span className="text-xs text-neutral-400 ml-2">
                          {formatClock(moment.ts)}
                        </span>
                      </div>
                      <p className="text-xs text-neutral-400 mt-1 line-clamp-2">
                        {moment.insight}
                      </p>
                    </motion.button>
                  );
                })
                )}
              </div>
            </div>
          </CardBody>
        </Card>
      </motion.div>
      </div>
    </TooltipProvider>
  );
}

type PlayerPopoverContentProps = {
  entry: SnapshotEntry;
  participant?: RiotAPITypes.MatchV5.ParticipantDTO;
  formatClock: (ms: number) => string;
  getItemIcon: (itemId?: number) => string;
  getChampionSquare: (championName: string) => string;
};

function PlayerPopoverContent({
  entry,
  participant,
  formatClock,
  getItemIcon,
  getChampionSquare,
}: PlayerPopoverContentProps) {
  const itemsFromParticipant = participant
    ? [
        participant.item0,
        participant.item1,
        participant.item2,
        participant.item3,
        participant.item4,
        participant.item5,
      ].filter((id): id is number => typeof id === 'number' && id > 0)
    : [];

  const inventory = entry.inventory.length > 0 ? entry.inventory : itemsFromParticipant;
  const slots = Array.from({ length: 6 }, (_, idx) => inventory[idx] ?? null);
  const overflow = inventory.length > 6 ? inventory.slice(6) : [];

  const goldInBag =
    typeof entry.currentGold === 'number' && Number.isFinite(entry.currentGold)
      ? Math.max(0, Math.round(entry.currentGold))
      : null;
  const totalGold =
    typeof entry.totalGold === 'number' && Number.isFinite(entry.totalGold)
      ? Math.max(0, Math.round(entry.totalGold))
      : participant && typeof participant.goldEarned === 'number'
        ? participant.goldEarned
        : null;

  const level =
    typeof entry.frame?.level === 'number'
      ? entry.frame.level
      : participant && typeof participant.champLevel === 'number'
        ? participant.champLevel
        : null;

  const xp =
    typeof entry.frame?.xp === 'number'
      ? entry.frame.xp
      : participant && typeof (participant as { champExperience?: number }).champExperience === 'number'
        ? (participant as { champExperience?: number }).champExperience
        : null;

  const csFromParticipant =
    (participant?.totalMinionsKilled ?? 0) + (participant?.neutralMinionsKilled ?? 0);
  const cs = entry.frame ? entry.cs : csFromParticipant;
  const frameReferenceTs = entry.frameTimestamp ?? entry.ts;
  const elapsedMinutes = frameReferenceTs > 0 ? frameReferenceTs / 60000 : null;
  const csPerMin =
    elapsedMinutes && elapsedMinutes > 0
      ? cs / elapsedMinutes
      : null;

  const damageDealt = {
    physical: participant?.physicalDamageDealtToChampions ?? 0,
    magic: participant?.magicDamageDealtToChampions ?? 0,
    true: participant?.trueDamageDealtToChampions ?? 0,
  };
  const totalDamageDealt =
    damageDealt.physical + damageDealt.magic + damageDealt.true;

  const damageTaken = {
    physical: participant?.physicalDamageTaken ?? 0,
    magic: participant?.magicDamageTaken ?? 0,
    true: participant?.trueDamageTaken ?? 0,
  };
  const totalDamageTaken =
    damageTaken.physical + damageTaken.magic + damageTaken.true;

  const snapshotClock =
    typeof entry.frameTimestamp === 'number'
      ? formatClock(entry.frameTimestamp)
      : '–';
  const deltaSeconds =
    typeof entry.frameDeltaMs === 'number'
      ? entry.frameDeltaMs / 1000
      : null;
  const deltaLabel =
    deltaSeconds != null
      ? `${entry.snapshotSource === 'previous' ? '−' : '+'}${preciseNumberFormatter.format(
          Math.abs(deltaSeconds),
        )}s`
      : null;

  const kda = participant
    ? `${participant.kills}/${participant.deaths}/${participant.assists}`
    : '—';
  const visionScore =
    typeof participant?.visionScore === 'number'
      ? participant.visionScore
      : null;

  const renderDamageRow = (
    label: string,
    value: number,
    total: number,
  ) => (
    <div key={label} className="space-y-1">
      <div className="flex items-center justify-between text-xs text-neutral-400">
        <span>{label}</span>
        <span className="text-neutral-200">
          {numberFormatter.format(Math.round(value))}
        </span>
      </div>
      <Progress value={total > 0 ? Math.min(100, (value / total) * 100) : 0} />
    </div>
  );

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-3">
        <Avatar
          className={cn(
            'h-10 w-10 rounded-lg ring-2',
            entry.teamId === 100 ? 'ring-blue-400/70' : 'ring-red-400/70',
          )}
        >
          <AvatarImage
            src={getChampionSquare(entry.championName)}
            alt={entry.championName}
          />
        </Avatar>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="truncate text-sm font-semibold text-neutral-100">
              {entry.summonerName}
            </div>
            <span
              className={cn(
                'text-xs font-medium',
                entry.teamId === 100 ? 'text-accent-blue-200' : 'text-red-200',
              )}
            >
              {entry.teamId === 100 ? 'Blue Side' : 'Red Side'}
            </span>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-neutral-400">
            <span>{entry.championName}</span>
            <span>•</span>
            <span>Moment {formatClock(entry.ts)}</span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-neutral-500">
            <span>Snapshot {snapshotClock}</span>
            {deltaLabel ? <span>({deltaLabel})</span> : null}
          </div>
        </div>
      </div>

      <Tabs defaultValue="build" className="w-full">
        <TabsList className="gap-1">
          <TabsTrigger value="build">Build</TabsTrigger>
          <TabsTrigger value="damage">Damage</TabsTrigger>
          <TabsTrigger value="stats">Stats</TabsTrigger>
        </TabsList>

        <TabsContent value="build" className="space-y-3">
          <div className="grid grid-cols-3 gap-2 pt-1">
            {slots.map((itemId, idx) => (
              <div
                key={`slot-${entry.participantId}-${idx}`}
                className="flex flex-col items-center gap-1 text-[11px] text-neutral-400"
              >
                {itemId ? (
                  <img
                    src={getItemIcon(itemId) || undefined}
                    alt={`Item ${itemId}`}
                    title={`Item ${itemId}`}
                    className="h-12 w-12 rounded-lg border border-neutral-700/60 bg-neutral-900 object-cover shadow"
                  />
                ) : (
                  <div className="h-12 w-12 rounded-lg border border-dashed border-neutral-700/40 bg-neutral-800/40" />
                )}
                <span className="text-[10px] uppercase tracking-wide text-neutral-500">
                  Slot {idx + 1}
                </span>
              </div>
            ))}
          </div>
          {overflow.length > 0 ? (
            <p className="text-xs text-neutral-400">
              +{overflow.length} component{overflow.length > 1 ? 's' : ''} in inventory
            </p>
          ) : null}
          <div className="space-y-1 text-sm">
            <div className="flex items-center justify-between text-neutral-300">
              <span>Gold in bag</span>
              <span className="font-semibold text-accent-yellow-200">
                {goldInBag != null ? numberFormatter.format(goldInBag) : '—'}
              </span>
            </div>
            <div className="flex items-center justify-between text-neutral-300">
              <span>Total gold earned</span>
              <span>{
                totalGold != null ? numberFormatter.format(Math.round(totalGold)) : '—'
              }</span>
            </div>
          </div>
          {entry.hasGrievousWounds ? (
            <p className="text-[11px] text-accent-yellow-200">
              Grievous Wounds item equipped at this moment.
            </p>
          ) : null}
          {inventory.length === 0 && (
            <p className="text-xs text-neutral-400">
              No items purchased yet at this timestamp.
            </p>
          )}
        </TabsContent>

        <TabsContent value="damage" className="space-y-4">
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
              Damage Dealt
            </h4>
            <div className="mt-2 space-y-2">
              {['physical', 'magic', 'true'].map((key) =>
                renderDamageRow(
                  key.charAt(0).toUpperCase() + key.slice(1),
                  damageDealt[key as keyof typeof damageDealt],
                  totalDamageDealt,
                ),
              )}
            </div>
          </div>
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
              Damage Taken
            </h4>
            <div className="mt-2 space-y-2">
              {['physical', 'magic', 'true'].map((key) =>
                renderDamageRow(
                  key.charAt(0).toUpperCase() + key.slice(1),
                  damageTaken[key as keyof typeof damageTaken],
                  totalDamageTaken,
                ),
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="stats" className="space-y-3">
          <div className="grid grid-cols-2 gap-3 text-sm text-neutral-300">
            <div>
              <span className="block text-xs uppercase tracking-wide text-neutral-500">
                Level
              </span>
              <span className="text-neutral-100">{level ?? '—'}</span>
            </div>
            <div>
              <span className="block text-xs uppercase tracking-wide text-neutral-500">
                K / D / A
              </span>
              <span className="text-neutral-100">{kda}</span>
            </div>
            <div>
              <span className="block text-xs uppercase tracking-wide text-neutral-500">
                Creep Score
              </span>
              <span className="text-neutral-100">
                {numberFormatter.format(Math.round(cs))}
                {csPerMin && Number.isFinite(csPerMin) ? (
                  <span className="ml-1 text-[11px] text-neutral-400">
                    ({preciseNumberFormatter.format(csPerMin)}/m)
                  </span>
                ) : null}
              </span>
            </div>
            <div>
              <span className="block text-xs uppercase tracking-wide text-neutral-500">
                Experience
              </span>
              <span className="text-neutral-100">
                {xp != null ? numberFormatter.format(Math.round(xp)) : '—'}
              </span>
            </div>
            <div>
              <span className="block text-xs uppercase tracking-wide text-neutral-500">
                Vision Score
              </span>
              <span className="text-neutral-100">
                {visionScore != null
                  ? numberFormatter.format(Math.round(visionScore))
                  : '—'}
              </span>
            </div>
            <div>
              <span className="block text-xs uppercase tracking-wide text-neutral-500">
                Total Damage to Champs
              </span>
              <span className="text-neutral-100">
                {participant?.totalDamageDealtToChampions != null
                  ? numberFormatter.format(
                      Math.round(participant.totalDamageDealtToChampions),
                    )
                  : '—'}
              </span>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
