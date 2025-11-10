import { PerformanceCategoryCard } from '@/components/performance/PerformanceCategoryCard';
import { Avatar, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { type ChartConfig, ChartContainer } from '@/components/ui/chart';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useDataDragon } from '@/providers/data-dragon-provider';
import {
  type ItemSuggestion,
  type MatchProgressEntry,
  getAllMatchDataQueryOptions,
  getChampionRoleDetailQueryOptions,
} from '@/queries/get-match-insights';
import type { RiotAPITypes } from '@fightmegg/riot-api';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { formatDistanceToNow } from 'date-fns';
import { motion } from 'framer-motion';
import {
  ChevronRight,
  Clock,
  Map as MapIcon,
  Sparkles,
  Target,
  Zap,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  Tooltip as RechartsTooltip,
  ReferenceLine,
  XAxis,
  YAxis,
} from 'recharts';

export const Route = createFileRoute('/$region/$name/$tag/match/$matchId')({
  component: MatchAnalysisComponent,
});

// ────────────────────────────────────────────────────────────────────────────
// Interpolation + helper utilities
// ────────────────────────────────────────────────────────────────────────────
type Vec2 = { x: number; y: number };
type TimelineEvent = RiotAPITypes.MatchV5.EventDTO;
type ParticipantFrame = RiotAPITypes.MatchV5.ParticipantFrameDTO;
type TimelineFrame = RiotAPITypes.MatchV5.FrameDTO;

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
  if (!events.length)
    return { inventoryIds: [] as number[], hasGrievousWounds: false };
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

  const hasGrievousWounds = inventory.some((id) =>
    GRIEVOUS_WOUND_ITEM_IDS.has(id),
  );
  return { inventoryIds: inventory, hasGrievousWounds };
}

function selectParticipantFrameForTimestamp(
  previous: TimelineFrame | null,
  next: TimelineFrame | null,
  participantId: number,
  ts: number,
) {
  const prevFrame =
    previous?.participantFrames?.[String(participantId)] ?? null;
  const nextFrame = next?.participantFrames?.[String(participantId)] ?? null;
  const prevTs = Number(previous?.timestamp ?? Number.NaN);
  const nextTs = Number(next?.timestamp ?? Number.NaN);
  // Use exact frame at or before timestamp (floor). Only use next when previous is missing.
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

const percentFormatter = new Intl.NumberFormat('en-US', {
  style: 'percent',
  maximumFractionDigits: 0,
});

type ProgressMetricKey =
  | 'csPerMin'
  | 'damagePerMin'
  | 'goldPerMin'
  | 'visionPerMin'
  | 'killParticipation';

type ProgressMetricDefinition = {
  key: ProgressMetricKey;
  label: string;
  description: string;
  color: string;
  format: (value: number | null | undefined) => string;
  transform?: (value: number | null | undefined) => number | null;
};

const PROGRESS_METRICS: Record<ProgressMetricKey, ProgressMetricDefinition> = {
  csPerMin: {
    key: 'csPerMin',
    label: 'CS / min',
    description: 'Last-hit pace including lane and jungle CS per minute.',
    color: '#facc15',
    format: (value) =>
      typeof value === 'number' ? preciseNumberFormatter.format(value) : '—',
  },
  damagePerMin: {
    key: 'damagePerMin',
    label: 'Damage / min',
    description: 'Champion damage per minute across the match.',
    color: '#f97316',
    format: (value) =>
      typeof value === 'number' ? numberFormatter.format(value) : '—',
  },
  goldPerMin: {
    key: 'goldPerMin',
    label: 'Gold / min',
    description: 'Gold generation tempo from farming, objectives and fights.',
    color: '#f59e0b',
    format: (value) =>
      typeof value === 'number' ? numberFormatter.format(value) : '—',
  },
  visionPerMin: {
    key: 'visionPerMin',
    label: 'Vision / min',
    description: 'Vision score per minute measuring wards and denials.',
    color: '#22d3ee',
    format: (value) =>
      typeof value === 'number' ? preciseNumberFormatter.format(value) : '—',
  },
  killParticipation: {
    key: 'killParticipation',
    label: 'Kill Participation',
    description:
      'Share of team kills you contributed to with kills or assists.',
    color: '#a855f7',
    format: (value) =>
      typeof value === 'number' ? percentFormatter.format(value) : '—',
    transform: (value) =>
      typeof value === 'number' ? Math.round(value * 1000) / 10 : null,
  },
};

// Queue label mapping for common Riot queue IDs
const QUEUE_LABELS: Record<number, string> = {
  420: 'Ranked Solo/Duo',
  440: 'Ranked Flex',
  400: 'Normal Draft',
  430: 'Normal Blind',
  700: 'Clash',
  1900: 'ARAM',
};

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
  const { data: progressData, isLoading: isProgressLoading } = useQuery(
    queryOptions.progress,
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
  const [comparisonMode, setComparisonMode] = useState<'cohort' | 'self'>(
    'cohort',
  );
  const [selectedProgressMetric, setSelectedProgressMetric] =
    useState<ProgressMetricKey>('csPerMin');

  const metricAvailability = useMemo(() => {
    const matches = progressData?.matches ?? [];
    const availability: Record<ProgressMetricKey, boolean> = {
      csPerMin: false,
      damagePerMin: false,
      goldPerMin: false,
      visionPerMin: false,
      killParticipation: false,
    };
    for (const match of matches) {
      for (const metricKey of Object.keys(
        PROGRESS_METRICS,
      ) as ProgressMetricKey[]) {
        const rawValue = match[metricKey];
        if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
          availability[metricKey] = true;
        }
      }
    }
    return availability;
  }, [progressData]);

  useEffect(() => {
    if (!metricAvailability[selectedProgressMetric]) {
      const fallback = (
        Object.keys(PROGRESS_METRICS) as ProgressMetricKey[]
      ).find((metricKey) => metricAvailability[metricKey]);
      if (fallback && fallback !== selectedProgressMetric) {
        setSelectedProgressMetric(fallback);
      }
    }
  }, [metricAvailability, selectedProgressMetric]);

  const progressMetricDefinition = PROGRESS_METRICS[selectedProgressMetric];

  type ProgressChartDatum = {
    matchId: string;
    order: number;
    label: string;
    rawValue: number | null;
    value: number | null;
    isCurrent: boolean;
    gameCreation: number;
    win: boolean;
  };

  const progressMatches = useMemo<MatchProgressEntry[]>(() => {
    const matches = progressData?.matches ?? [];
    if (!matches.length) return [];
    return [...matches].sort(
      (a, b) => Number(a.gameCreation ?? 0) - Number(b.gameCreation ?? 0),
    );
  }, [progressData]);

  const progressChartData = useMemo<ProgressChartDatum[]>(() => {
    const metric = PROGRESS_METRICS[selectedProgressMetric];
    if (!progressMatches.length) return [];
    return progressMatches.map((entry, index) => {
      const rawValue = entry[selectedProgressMetric];
      const transformed = metric.transform
        ? metric.transform(rawValue)
        : rawValue;
      return {
        matchId: entry.matchId,
        order: index + 1,
        label: new Date(entry.gameCreation).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
        }),
        rawValue: typeof rawValue === 'number' ? rawValue : null,
        value:
          typeof transformed === 'number' && Number.isFinite(transformed)
            ? transformed
            : null,
        isCurrent: entry.matchId === matchId,
        gameCreation: entry.gameCreation,
        win: Boolean(entry.win),
      };
    });
  }, [progressMatches, selectedProgressMetric, matchId]);

  const filteredProgressChartData = useMemo(
    () => progressChartData.filter((datum) => datum.value !== null),
    [progressChartData],
  );

  const progressSummary = useMemo(() => {
    const metric = PROGRESS_METRICS[selectedProgressMetric];
    const valid = progressChartData.filter(
      (datum) => typeof datum.rawValue === 'number',
    );
    if (!valid.length) return null;

    const current =
      valid.find((datum) => datum.isCurrent) ?? valid[valid.length - 1];
    const previous = valid.filter((datum) => datum.matchId !== current.matchId);

    const average =
      previous.length > 0
        ? previous.reduce((sum, datum) => sum + (datum.rawValue ?? 0), 0) /
          previous.length
        : null;

    const trailing = valid.slice(-5);
    const trailingAverage =
      trailing.length > 0
        ? trailing.reduce((sum, datum) => sum + (datum.rawValue ?? 0), 0) /
          trailing.length
        : null;

    const earlierWindow = valid.slice(
      Math.max(valid.length - 10, 0),
      Math.max(valid.length - 5, 0),
    );
    const earlierAverage =
      earlierWindow.length > 0
        ? earlierWindow.reduce((sum, datum) => sum + (datum.rawValue ?? 0), 0) /
          earlierWindow.length
        : null;

    const best = valid.reduce<ProgressChartDatum | null>((acc, datum) => {
      if (datum.rawValue === null) return acc;
      if (
        !acc ||
        (datum.rawValue ?? Number.NEGATIVE_INFINITY) >
          (acc.rawValue ?? Number.NEGATIVE_INFINITY)
      ) {
        return datum;
      }
      return acc;
    }, null);

    const worst = valid.reduce<ProgressChartDatum | null>((acc, datum) => {
      if (datum.rawValue === null) return acc;
      if (
        !acc ||
        (datum.rawValue ?? Number.POSITIVE_INFINITY) <
          (acc.rawValue ?? Number.POSITIVE_INFINITY)
      ) {
        return datum;
      }
      return acc;
    }, null);

    return {
      metric,
      current,
      average,
      trailingAverage,
      earlierAverage,
      best,
      worst,
    };
  }, [progressChartData, selectedProgressMetric]);

  const progressRangeLabel = useMemo(() => {
    if (!progressMatches.length) return null;
    const first = progressMatches[0];
    const last = progressMatches[progressMatches.length - 1];
    const firstDate = new Date(first.gameCreation).toLocaleDateString(
      undefined,
      {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      },
    );
    const lastDate = new Date(last.gameCreation).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    return firstDate === lastDate ? firstDate : `${firstDate} – ${lastDate}`;
  }, [progressMatches]);

  const progressChartConfig = useMemo<ChartConfig>(
    () => ({
      trend: {
        label: progressMetricDefinition.label,
        color: progressMetricDefinition.color,
      },
    }),
    [progressMetricDefinition],
  );

  // Subject participant and normalized role declared before first usage
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

  const normalizedRole = (
    subjectParticipant?.teamPosition ??
    subjectParticipant?.individualPosition ??
    ''
  ).toUpperCase();

  const subjectChampionName =
    subjectParticipant?.championName ??
    progressData?.championName ??
    'Champion';

  const normalizedRoleLabel = (
    progressData?.role ??
    normalizedRole ??
    'UNKNOWN'
  ).toLowerCase();
  const friendlyRoleLabel =
    normalizedRoleLabel === 'utility'
      ? 'support'
      : normalizedRoleLabel === 'unknown'
        ? 'role'
        : normalizedRoleLabel;

  const formatProgressValue = (value: number | null | undefined) =>
    progressMetricDefinition.format(value ?? null);

  const formatProgressDifference = (value: number | null) => {
    if (value === null) return '—';
    const formatted = progressMetricDefinition.format(Math.abs(value));
    if (value > 0) return `+${formatted}`;
    if (value < 0) return `-${formatted}`;
    return formatted;
  };

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
    const frames: TimelineFrame[] = timelineData.info?.frames ?? [];
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
    const frames: TimelineFrame[] = timelineData.info?.frames ?? [];
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
            : null;
        const totalGold =
          typeof frameInfo.frame?.totalGold === 'number'
            ? frameInfo.frame.totalGold
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
    const frames: TimelineFrame[] = timelineData.info?.frames ?? [];
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

  // Derived header info
  const subjectTeam = useMemo(() => {
    if (!matchData || !subjectParticipant) return null;
    return (
      matchData.info.teams.find(
        (t) => t.teamId === subjectParticipant.teamId,
      ) ?? null
    );
  }, [matchData, subjectParticipant]);

  const queueLabel = useMemo(() => {
    if (!matchData) return '—';
    return (
      QUEUE_LABELS[Number(matchData.info.queueId)] ??
      matchData.info.gameMode ??
      'Unknown Queue'
    );
  }, [matchData]);

  const gameDurationStr = useMemo(() => {
    if (!matchData) return '—';
    const total = Number(matchData.info.gameDuration ?? 0);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }, [matchData]);

  const timeAgoStr = useMemo(() => {
    if (!matchData) return '—';
    try {
      return formatDistanceToNow(
        new Date(Number(matchData.info.gameCreation ?? 0)),
        {
          addSuffix: true,
        },
      );
    } catch {
      return '—';
    }
  }, [matchData]);

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

  const championRoleQueryEnabled =
    Boolean(subjectParticipant?.championName) &&
    normalizedRole !== '' &&
    !['UNKNOWN', 'INVALID', 'NONE'].includes(normalizedRole);

  const { data: championRoleDetail, isLoading: isChampionRoleLoading } =
    useQuery({
      ...getChampionRoleDetailQueryOptions(
        region,
        name,
        tag,
        subjectParticipant?.championName ?? '',
        normalizedRole || 'UNKNOWN',
      ),
      enabled: championRoleQueryEnabled,
    });

  const matchDurationMinutes = useMemo(
    () => (matchData ? Math.max(matchData.info.gameDuration / 60, 1) : 1),
    [matchData],
  );

  const laneSnapshots = useMemo(() => {
    if (!timelineData || !subjectParticipant) return null;
    const frames = timelineData.info.frames ?? [];
    if (!frames.length) return null;
    const pid = subjectParticipant.participantId;
    const findFrame = (targetMs: number) => {
      for (const frame of frames) {
        const ts = Number(frame.timestamp ?? Number.NaN);
        if (!Number.isFinite(ts)) continue;
        if (ts >= targetMs) {
          const pf =
            (frame.participantFrames?.[String(pid)] as
              | ParticipantFrame
              | undefined) ?? null;
          if (pf) return pf;
        }
      }
      const last = frames[frames.length - 1];
      return (
        (last?.participantFrames?.[String(pid)] as
          | ParticipantFrame
          | undefined) ?? null
      );
    };
    const getValues = (pf: ParticipantFrame | null | undefined) => {
      if (!pf) return { gold: null, cs: null };
      const gold =
        typeof pf.totalGold === 'number'
          ? pf.totalGold
          : typeof pf.currentGold === 'number'
            ? pf.currentGold
            : null;
      const cs = (pf.minionsKilled ?? 0) + (pf.jungleMinionsKilled ?? 0);
      return { gold, cs };
    };
    const at10 = getValues(findFrame(10 * 60 * 1000));
    const at15 = getValues(findFrame(15 * 60 * 1000));
    return {
      goldAt10: at10.gold,
      csAt10: at10.cs,
      goldAt15: at15.gold,
      csAt15: at15.cs,
    };
  }, [timelineData, subjectParticipant]);

  const comparisonSubtitle =
    comparisonMode === 'cohort'
      ? 'Compared with similar players for this champion and role.'
      : 'Compared with your recent median for this champion and role.';
  const comparisonSourceAvailable =
    comparisonMode === 'cohort'
      ? Boolean(championRoleDetail?.cohort?.percentiles?.p50)
      : Boolean(championRoleDetail?.playerPercentiles?.percentiles?.p50);

  const performanceComparisons = useMemo(() => {
    if (!subjectParticipant || !matchData) return [];
    const minutes = matchDurationMinutes || 1;
    const totalCs =
      (subjectParticipant.totalMinionsKilled ?? 0) +
      (subjectParticipant.neutralMinionsKilled ?? 0);
    const cspm = totalCs / minutes;
    const dpm = (subjectParticipant.totalDamageDealtToChampions ?? 0) / minutes;
    const dtpm = (subjectParticipant.totalDamageTaken ?? 0) / minutes;
    const kpm = (subjectParticipant.kills ?? 0) / minutes;
    const apm = (subjectParticipant.assists ?? 0) / minutes;
    const deathsPerMin = (subjectParticipant.deaths ?? 0) / minutes;

    const baselineSource =
      comparisonMode === 'cohort'
        ? (championRoleDetail?.cohort?.percentiles?.p50 ?? null)
        : (championRoleDetail?.playerPercentiles?.percentiles?.p50 ?? null);

    const getBaseline = (key: string) =>
      baselineSource && typeof baselineSource[key] === 'number'
        ? (baselineSource[key] as number)
        : null;

    const formatValue = (value: number | null, digits: number) => {
      if (value == null || Number.isNaN(value)) return '—';
      if (digits <= 0) {
        return numberFormatter.format(Math.round(value));
      }
      return value.toFixed(digits);
    };

    const formatDiff = (value: number | null, digits: number) => {
      if (value == null || Number.isNaN(value)) return null;
      if (digits <= 0) {
        const rounded = Math.round(value);
        if (rounded === 0) return '±0';
        return `${rounded > 0 ? '+' : ''}${numberFormatter.format(rounded)}`;
      }
      const rounded = Number(value.toFixed(digits));
      if (Math.abs(rounded) < 10 ** -digits) return '±0';
      return `${rounded > 0 ? '+' : ''}${rounded.toFixed(digits)}`;
    };

    const cards = [
      {
        key: 'goldAt10',
        label: 'Gold @ 10',
        value: laneSnapshots?.goldAt10 ?? null,
        digits: 0,
      },
      {
        key: 'csAt10',
        label: 'CS @ 10',
        value: laneSnapshots?.csAt10 ?? null,
        digits: 0,
      },
      {
        key: 'goldAt15',
        label: 'Gold @ 15',
        value: laneSnapshots?.goldAt15 ?? null,
        digits: 0,
      },
      {
        key: 'csAt15',
        label: 'CS @ 15',
        value: laneSnapshots?.csAt15 ?? null,
        digits: 0,
      },
      { key: 'cspm', label: 'CS / Min', value: cspm, digits: 2 },
      { key: 'dpm', label: 'Damage / Min', value: dpm, digits: 0 },
      {
        key: 'dtpm',
        label: 'Damage Taken / Min',
        value: dtpm,
        digits: 0,
        invert: true,
      },
      { key: 'kpm', label: 'Kills / Min', value: kpm, digits: 2 },
      { key: 'apm', label: 'Assists / Min', value: apm, digits: 2 },
      {
        key: 'deathsPerMin',
        label: 'Deaths / Min',
        value: deathsPerMin,
        digits: 2,
        invert: true,
      },
    ];

    return cards.map((card) => {
      const baseline = getBaseline(card.key);
      const diff =
        baseline != null && card.value != null ? card.value - baseline : null;
      const diffDisplay = formatDiff(diff, card.digits);
      const trendClass =
        diffDisplay === '±0'
          ? 'text-neutral-300'
          : diff == null
            ? 'text-neutral-300'
            : diff > 0
              ? card.invert
                ? 'text-red-300'
                : 'text-emerald-300'
              : card.invert
                ? 'text-emerald-300'
                : 'text-red-300';
      return {
        key: card.key,
        label: card.label,
        value: card.value,
        valueDisplay: formatValue(card.value, card.digits),
        baselineValue: baseline,
        baselineDisplay:
          baseline != null ? formatValue(baseline, card.digits) : '—',
        diffDisplay,
        trendClass,
        invert: Boolean(card.invert),
        digits: card.digits,
      };
    });
  }, [
    subjectParticipant,
    matchData,
    matchDurationMinutes,
    comparisonMode,
    championRoleDetail,
    laneSnapshots,
  ]);

  const winProbabilityChartConfig = useMemo(
    () =>
      ({
        winProb: {
          label: 'Win Probability',
          color: '#60a5fa',
        },
        impact: {
          label: 'Impact Score',
          color: '#facc15',
        },
      }) satisfies ChartConfig,
    [],
  );

  const winProbabilityData = useMemo(() => {
    if (!timelineData || !subjectParticipant || participantById.size === 0)
      return [];
    const frames = timelineData.info.frames ?? [];
    if (!frames.length) return [];
    const pid = subjectParticipant.participantId;
    let prevGold = 0;
    let prevXp = 0;
    let prevDamage = 0;
    let prevCs = 0;

    const rawData = frames
      .map((frame) => {
        const ts = Number(frame.timestamp ?? Number.NaN);
        if (!Number.isFinite(ts)) return null;

        const pf =
          (frame.participantFrames?.[String(pid)] as
            | ParticipantFrame
            | undefined) ?? null;

        let teamGold = 0;
        let enemyGold = 0;
        for (const [id, meta] of participantById.entries()) {
          const pfTeam =
            (frame.participantFrames?.[String(id)] as
              | ParticipantFrame
              | undefined) ?? null;
          const totalGold =
            typeof pfTeam?.totalGold === 'number'
              ? pfTeam.totalGold
              : typeof pfTeam?.currentGold === 'number'
                ? pfTeam.currentGold
                : 0;
          if (meta.teamId === subjectParticipant.teamId) {
            teamGold += totalGold;
          } else {
            enemyGold += totalGold;
          }
        }

        const goldDiff = teamGold - enemyGold;
        const probability = 1 / (1 + Math.exp(-goldDiff / 1800));

        const totalGold =
          typeof pf?.totalGold === 'number'
            ? pf.totalGold
            : typeof pf?.currentGold === 'number'
              ? pf.currentGold
              : prevGold;
        const xp = typeof pf?.xp === 'number' ? pf.xp : prevXp;
        const damage =
          (
            pf?.damageStats as
              | { totalDamageDoneToChampions?: number }
              | undefined
          )?.totalDamageDoneToChampions ?? prevDamage;
        const cs = (pf?.minionsKilled ?? 0) + (pf?.jungleMinionsKilled ?? 0);

        const goldDelta = totalGold - prevGold;
        const xpDelta = xp - prevXp;
        const damageDelta = damage - prevDamage;
        const csDelta = cs - prevCs;

        const rawImpact =
          goldDelta / 320 + xpDelta / 150 + damageDelta / 900 + csDelta * 0.9;
        const clampedImpact = Math.max(0, rawImpact);

        prevGold = totalGold;
        prevXp = xp;
        prevDamage = damage;
        prevCs = cs;

        return {
          minute: Number((ts / 60000).toFixed(1)),
          winProb: Math.max(0, Math.min(100, probability * 100)),
          impactRaw: Number(clampedImpact.toFixed(2)),
        };
      })
      .filter(
        (
          entry,
        ): entry is {
          minute: number;
          winProb: number;
          impactRaw: number;
        } => Boolean(entry),
      );

    // Find max impact to normalize to 0-100
    const maxImpact = Math.max(...rawData.map((d) => d.impactRaw), 0.01);

    return rawData.map((d) => ({
      ...d,
      impact: Math.min(100, (d.impactRaw / maxImpact) * 100),
    }));
  }, [timelineData, subjectParticipant, participantById]);

  // Gold graph config and dataset (team gold difference over time)
  const goldChartConfig = useMemo(
    () =>
      ({
        goldDiff: {
          label: 'Gold Difference',
          color: '#f59e0b',
        },
      }) satisfies ChartConfig,
    [],
  );

  const goldGraphData = useMemo(() => {
    if (!timelineData || !subjectParticipant || participantById.size === 0)
      return [];
    const frames = timelineData.info.frames ?? [];
    if (!frames.length) return [];

    return frames
      .map((frame) => {
        const ts = Number(frame.timestamp ?? Number.NaN);
        if (!Number.isFinite(ts)) return null;

        let teamGold = 0;
        let enemyGold = 0;
        for (const [id, meta] of participantById.entries()) {
          const pfTeam =
            (frame.participantFrames?.[String(id)] as
              | ParticipantFrame
              | undefined) ?? null;
          const totalGold =
            typeof pfTeam?.totalGold === 'number'
              ? pfTeam.totalGold
              : typeof pfTeam?.currentGold === 'number'
                ? pfTeam.currentGold
                : 0;
          if (meta.teamId === subjectParticipant.teamId) {
            teamGold += totalGold;
          } else {
            enemyGold += totalGold;
          }
        }

        const goldDiff = teamGold - enemyGold;

        return {
          minute: Number((ts / 60000).toFixed(1)),
          goldDiff,
          teamGold,
          enemyGold,
        };
      })
      .filter(
        (
          entry,
        ): entry is {
          minute: number;
          goldDiff: number;
          teamGold: number;
          enemyGold: number;
        } => Boolean(entry),
      );
  }, [timelineData, subjectParticipant, participantById]);

  const detailedStatsByTeam = useMemo(() => {
    if (!matchData) return [];
    type MaybeRiotId = { riotIdGameName?: string; riotIdTagline?: string };
    return [100, 200].map((teamId) => {
      const teamMeta = matchData.info.teams.find(
        (team) => team.teamId === teamId,
      );
      const participants = matchData.info.participants
        .filter((p) => p.teamId === teamId)
        .map((p) => {
          const rp = p as MaybeRiotId;
          const displayName = rp.riotIdGameName ?? p.summonerName ?? 'Unknown';
          const displayTag = rp.riotIdTagline ?? null;
          const cs =
            (p.totalMinionsKilled ?? 0) + (p.neutralMinionsKilled ?? 0);
          const csPerMin = cs / matchDurationMinutes;
          const kdaRatio = (p.kills + p.assists) / Math.max(1, p.deaths ?? 0);
          const damageShare =
            typeof p.challenges?.teamDamagePercentage === 'number'
              ? p.challenges.teamDamagePercentage * 100
              : null;
          return {
            participant: p,
            displayName,
            displayTag,
            cs,
            csPerMin,
            kdaRatio,
            goldEarned: p.goldEarned ?? 0,
            damage: p.totalDamageDealtToChampions ?? 0,
            damageTaken: p.totalDamageTaken ?? 0,
            visionScore: p.visionScore ?? 0,
            wardsPlaced: p.wardsPlaced ?? 0,
            wardsKilled: p.wardsKilled ?? 0,
            damageShare,
          };
        });
      return {
        teamId,
        win: Boolean(teamMeta?.win),
        name: teamId === 100 ? 'Blue Side' : 'Red Side',
        participants,
      };
    });
  }, [matchData, matchDurationMinutes]);

  // Build grouped category metrics
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-render when performanceComparisons change
  const categoryCards = useMemo(() => {
    const byKey = new Map(performanceComparisons.map((c) => [c.key, c]));

    const get = (k: string) => byKey.get(k);
    const num = (n: number | null | undefined) =>
      n == null || Number.isNaN(n) ? null : n;

    // Extract percentiles from championRoleDetail cohort data
    const percentiles = championRoleDetail?.cohort?.percentiles;
    const getPercentile = (key: string, percentile: 'p50' | 'p75' | 'p90') => {
      const value = percentiles?.[percentile]?.[key];
      return num(value);
    };

    const toMetric = (
      k: string,
      label: string,
      opts?: { invert?: boolean; percent?: boolean },
    ) => {
      const c = get(k);
      return c
        ? {
            key: k,
            label,
            value: num(c.value),
            valueDisplay: c.valueDisplay,
            baseline: num(c.baselineValue ?? null),
            invert: opts?.invert ?? Boolean(c.invert),
            percent: opts?.percent ?? false,
            p50: getPercentile(k, 'p50'),
            p75: getPercentile(k, 'p75'),
            p90: getPercentile(k, 'p90'),
          }
        : null;
    };

    const normalize = (
      val: number | null | undefined,
      base: number | null | undefined,
      invert?: boolean,
    ) => {
      if (val == null || base == null) return null;
      const v = Number(val);
      const b = Number(base);
      if (!Number.isFinite(v) || !Number.isFinite(b) || b === 0) return null;
      const ratio = invert ? b / v : v / b;
      // Map ratio to 0-100 scale where 0.5 ratio = 0 points, 1.0 ratio = 50 points, 2.0 ratio = 100 points
      // Formula: score = (ratio - 0.5) * 100, clamped to [0, 100]
      const score = (ratio - 0.5) * 100;
      return Math.max(0, Math.min(100, Math.round(score)));
    };

    // Economy metrics
    const econMetrics = [
      toMetric('goldAt10', 'Gold @10'),
      toMetric('goldAt15', 'Gold @15'),
      toMetric('csAt10', 'CS @10'),
      toMetric('csAt15', 'CS @15'),
      toMetric('cspm', 'CS / Min'),
    ].filter(Boolean) as Array<{
      key: string;
      label: string;
      value: number | null;
      valueDisplay: string;
      baseline: number | null;
      invert?: boolean;
      percent?: boolean;
      p50?: number | null;
      p75?: number | null;
      p90?: number | null;
    }>;
    const econScoreParts = econMetrics
      .map((m) => normalize(m.value, m.baseline, m.invert))
      .filter((v): v is number => v != null);
    const econScore = econScoreParts.length
      ? Math.round(
          econScoreParts.reduce((a, b) => a + b, 0) / econScoreParts.length,
        )
      : 0;

    // Fighting metrics
    const fightMetrics = [
      toMetric('dpm', 'Damage / Min'),
      toMetric('kpm', 'Kills / Min'),
      toMetric('apm', 'Assists / Min'),
      toMetric('dtpm', 'Damage Taken / Min', { invert: true }),
      toMetric('deathsPerMin', 'Deaths / Min', { invert: true }),
    ].filter(Boolean) as Array<{
      key: string;
      label: string;
      value: number | null;
      valueDisplay: string;
      baseline: number | null;
      invert?: boolean;
      percent?: boolean;
      p50?: number | null;
      p75?: number | null;
      p90?: number | null;
    }>;
    const fightScoreParts = fightMetrics
      .map((m) => normalize(m.value, m.baseline, m.invert))
      .filter((v): v is number => v != null);
    const fightScore = fightScoreParts.length
      ? Math.round(
          fightScoreParts.reduce((a, b) => a + b, 0) / fightScoreParts.length,
        )
      : 0;

    // Vision metrics from team comparison
    let visionMetrics: Array<{
      key: string;
      label: string;
      value: number | null;
      valueDisplay: string;
      baseline: number | null;
      invert?: boolean;
      percent?: boolean;
      p50?: number | null;
      p75?: number | null;
      p90?: number | null;
    }> = [];
    let visionScore = 0;
    if (subjectParticipant) {
      const team = detailedStatsByTeam.find(
        (t) => t.teamId === subjectParticipant.teamId,
      );
      const subject =
        team?.participants.find(
          (p) => p.participant.puuid === subjectParticipant.puuid,
        ) ?? null;
      if (team && subject) {
        const avg = (arr: number[]) =>
          arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
        const teamVisionAvg = avg(team.participants.map((p) => p.visionScore));
        const teamWardsPlacedAvg = avg(
          team.participants.map((p) => p.wardsPlaced),
        );
        const teamWardsKilledAvg = avg(
          team.participants.map((p) => p.wardsKilled),
        );
        const fmt = (n?: number | null) =>
          n == null ? '—' : numberFormatter.format(Math.round(n));
        // Static percentile data for vision stats
        // Support (UTILITY) roles have higher values
        const isSupport = normalizedRole === 'UTILITY';
        const visionScorePercentiles = isSupport
          ? { p50: 45, p75: 60, p90: 75 }
          : { p50: 25, p75: 35, p90: 50 };
        const wardsPlacedPercentiles = isSupport
          ? { p50: 20, p75: 28, p90: 35 }
          : { p50: 8, p75: 12, p90: 18 };
        const wardsKilledPercentiles = isSupport
          ? { p50: 8, p75: 12, p90: 16 }
          : { p50: 3, p75: 5, p90: 8 };

        visionMetrics = [
          {
            key: 'visionScore',
            label: 'Vision Score',
            value: subject.visionScore ?? null,
            valueDisplay: fmt(subject.visionScore),
            baseline: teamVisionAvg,
            p50:
              getPercentile('visionScore', 'p50') ?? visionScorePercentiles.p50,
            p75:
              getPercentile('visionScore', 'p75') ?? visionScorePercentiles.p75,
            p90:
              getPercentile('visionScore', 'p90') ?? visionScorePercentiles.p90,
          },
          {
            key: 'wardsPlaced',
            label: 'Wards Placed',
            value: subject.wardsPlaced ?? null,
            valueDisplay: fmt(subject.wardsPlaced),
            baseline: teamWardsPlacedAvg,
            p50:
              getPercentile('wardsPlaced', 'p50') ?? wardsPlacedPercentiles.p50,
            p75:
              getPercentile('wardsPlaced', 'p75') ?? wardsPlacedPercentiles.p75,
            p90:
              getPercentile('wardsPlaced', 'p90') ?? wardsPlacedPercentiles.p90,
          },
          {
            key: 'wardsKilled',
            label: 'Wards Cleared',
            value: subject.wardsKilled ?? null,
            valueDisplay: fmt(subject.wardsKilled),
            baseline: teamWardsKilledAvg,
            p50:
              getPercentile('wardsKilled', 'p50') ?? wardsKilledPercentiles.p50,
            p75:
              getPercentile('wardsKilled', 'p75') ?? wardsKilledPercentiles.p75,
            p90:
              getPercentile('wardsKilled', 'p90') ?? wardsKilledPercentiles.p90,
          },
        ];
        const visScoreParts = visionMetrics
          .map((m) => normalize(m.value, m.baseline, false))
          .filter((v): v is number => v != null);
        visionScore = visScoreParts.length
          ? Math.round(
              visScoreParts.reduce((a, b) => a + b, 0) / visScoreParts.length,
            )
          : 0;
      }
    }

    const bgUrl = subjectParticipant
      ? getChampionCentered(subjectParticipant.championName)
      : undefined;

    return {
      economy: { score: econScore, metrics: econMetrics, bgUrl },
      fighting: { score: fightScore, metrics: fightMetrics, bgUrl },
      vision: { score: visionScore, metrics: visionMetrics, bgUrl },
    };
  }, [performanceComparisons, detailedStatsByTeam, subjectParticipant]);

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
          className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex items-center gap-4">
            {/* Subject champion */}
            {subjectParticipant ? (
              <div className="relative">
                <Avatar className="h-12 w-12 rounded-lg ring-2 ring-neutral-700">
                  <AvatarImage
                    src={getChampionSquare(subjectParticipant.championName)}
                    alt={subjectParticipant.championName}
                  />
                </Avatar>
              </div>
            ) : null}
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl sm:text-3xl font-bold text-neutral-50">
                  {subjectTeam?.win ? 'Victory' : 'Defeat'}
                </h1>
                <Badge
                  className={
                    subjectTeam?.win
                      ? 'bg-emerald-500/10 text-emerald-200 border border-emerald-400/40'
                      : 'bg-red-500/10 text-red-200 border border-red-400/40'
                  }
                >
                  {queueLabel}
                </Badge>
              </div>
              <div className="text-sm text-neutral-400 flex items-center gap-2">
                <span>{gameDurationStr}</span>
                <span>•</span>
                <span>{timeAgoStr}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  aria-label="Show AI match summary"
                  className="h-9 w-9 rounded-lg border border-neutral-700/60 bg-neutral-900/60 hover:bg-neutral-800 text-neutral-200 p-0"
                >
                  <Sparkles className="size-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                className="w-96 bg-neutral-900 border-neutral-700 text-neutral-100"
              >
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-accent-yellow-400" />
                    <h3 className="text-sm font-semibold">AI Summary</h3>
                  </div>
                  {isInsightsLoading ? (
                    <p className="text-sm text-neutral-400">
                      Loading insights…
                    </p>
                  ) : insightsData?.summary ? (
                    <p className="text-sm leading-relaxed whitespace-pre-wrap text-neutral-200">
                      {insightsData.summary}
                    </p>
                  ) : (
                    <p className="text-sm text-neutral-400">
                      No summary available yet.
                    </p>
                  )}
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </motion.div>

        <Tabs defaultValue="overview" className="space-y-8">
          <TabsList className="bg-neutral-900/60 border border-neutral-700/60 rounded-lg p-1 w-full sm:w-auto">
            <TabsTrigger value="overview" className="px-4 py-2">
              Overview
            </TabsTrigger>
            <TabsTrigger value="insights" className="px-4 py-2">
              Insights
            </TabsTrigger>
            <TabsTrigger value="timeline" className="px-4 py-2">
              Timeline
            </TabsTrigger>
            <TabsTrigger value="gold" className="px-4 py-2">
              Gold Graph
            </TabsTrigger>
            <TabsTrigger value="winprob" className="px-4 py-2">
              Win Probability
            </TabsTrigger>
            <TabsTrigger value="stats" className="px-4 py-2">
              Stats
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-8">
            {/* Match Results (Scoreboard) */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
            >
              <Card className="bg-neutral-900/90 backdrop-blur-sm border border-neutral-700/60 py-0">
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

                  {[100, 200].map((teamId) => {
                    const team = matchData.info.teams.find(
                      (t) => t.teamId === teamId,
                    );
                    const participants = matchData.info.participants.filter(
                      (p) => p.teamId === teamId,
                    );
                    const teamKills = participants.reduce(
                      (acc, q) => acc + (q.kills ?? 0),
                      0,
                    );
                    const teamGold = participants.reduce(
                      (acc, q) => acc + (q.goldEarned ?? 0),
                      0,
                    );
                    const teamDamageTotal = participants.reduce(
                      (acc, q) => acc + (q.totalDamageDealtToChampions ?? 0),
                      0,
                    );
                    const sideLabel =
                      teamId === 100
                        ? 'Team 1 • Blue Side'
                        : 'Team 2 • Red Side';
                    const headerClass = team?.win
                      ? 'bg-accent-emerald-900/25 border-accent-emerald-500/40 text-accent-emerald-300'
                      : 'bg-red-900/25 border-red-500/40 text-red-300';
                    return (
                      <div key={`team-${teamId}`} className="mb-6">
                        {/* Team header */}
                        <div
                          className={cn(
                            'flex items-center justify-between p-3 rounded-lg border',
                            headerClass,
                          )}
                        >
                          <div className="flex items-center gap-2">
                            <span className="font-semibold">{sideLabel}</span>
                            <span className="text-xs text-neutral-300">
                              {team?.win ? 'Victory' : 'Defeat'}
                            </span>
                          </div>
                          <div className="flex items-center gap-4 text-xs text-neutral-300">
                            <span className="flex items-center gap-1">
                              Kills{' '}
                              <span className="font-semibold text-neutral-100">
                                {teamKills}
                              </span>
                            </span>
                            <span className="flex items-center gap-1">
                              Drakes{' '}
                              <span className="font-semibold text-neutral-100">
                                {team?.objectives?.dragon?.kills ?? 0}
                              </span>
                            </span>
                            <span className="flex items-center gap-1">
                              Barons{' '}
                              <span className="font-semibold text-neutral-100">
                                {team?.objectives?.baron?.kills ?? 0}
                              </span>
                            </span>
                            <span className="flex items-center gap-1">
                              Towers{' '}
                              <span className="font-semibold text-neutral-100">
                                {team?.objectives?.tower?.kills ?? 0}
                              </span>
                            </span>
                            <span className="flex items-center gap-1">
                              Heralds{' '}
                              <span className="font-semibold text-neutral-100">
                                {team?.objectives?.riftHerald?.kills ?? 0}
                              </span>
                            </span>
                            <span className="flex items-center gap-1">
                              Gold{' '}
                              <span className="font-semibold text-neutral-100">
                                {numberFormatter.format(teamGold)}
                              </span>
                            </span>
                          </div>
                        </div>

                        {/* Player rows */}
                        <div className="mt-2 space-y-2">
                          {participants.map((p) => {
                            const rp = p as {
                              riotIdGameName?: string;
                              riotIdTagline?: string;
                            };
                            const isSubject =
                              subjectParticipant?.puuid === p.puuid;
                            const displayName =
                              rp.riotIdGameName ?? p.summonerName;
                            const displayTag =
                              rp.riotIdTagline ?? (isSubject ? tag : undefined);
                            const minutes = Math.max(
                              1,
                              Math.floor(matchData.info.gameDuration / 60),
                            );
                            const csTotal =
                              (p.totalMinionsKilled ?? 0) +
                              (p.neutralMinionsKilled ?? 0);
                            const kdaRatio =
                              (p.kills + p.assists) /
                              Math.max(1, p.deaths ?? 0);
                            const kpPct =
                              teamKills > 0
                                ? Math.round(
                                    ((p.kills + p.assists) / teamKills) * 100,
                                  )
                                : 0;
                            const damage = p.totalDamageDealtToChampions ?? 0;
                            const dmgShare =
                              teamDamageTotal > 0
                                ? (damage / teamDamageTotal) * 100
                                : 0;
                            return (
                              <div
                                key={`row-${p.puuid}`}
                                className={cn(
                                  'flex items-center gap-3 p-3 rounded-lg border',
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

                                {/* Name + items */}
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
                                  {/* Items */}
                                  <div className="flex items-center gap-1 mt-2">
                                    {[
                                      p.item0,
                                      p.item1,
                                      p.item2,
                                      p.item3,
                                      p.item4,
                                      p.item5,
                                    ].map(
                                      (it: number | undefined, idx: number) =>
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

                                {/* Right stats */}
                                <div className="flex items-center gap-8 shrink-0 min-w-[280px]">
                                  <div className="text-sm text-neutral-400">
                                    <div className="flex items-center gap-1">
                                      <span className="text-neutral-500">
                                        KDA
                                      </span>
                                      <span className="text-neutral-300 font-semibold">
                                        {p.kills}/{p.deaths}/{p.assists}
                                      </span>
                                      <span className="ml-1 text-neutral-500">
                                        ({kdaRatio.toFixed(1)})
                                      </span>
                                    </div>
                                    <div className="flex items-center gap-1 mt-1">
                                      <span className="text-neutral-500">
                                        CS
                                      </span>
                                      <span className="text-neutral-300 font-semibold">
                                        {csTotal}
                                      </span>
                                    </div>
                                  </div>
                                  <div className="text-sm text-neutral-400">
                                    <div className="flex items-center gap-1">
                                      <span className="text-neutral-500">
                                        KP
                                      </span>
                                      <span className="text-neutral-300 font-semibold">
                                        {kpPct}%
                                      </span>
                                    </div>
                                    <div className="mt-1 w-48 sm:w-56">
                                      <div className="flex items-center justify-between text-[12px]">
                                        <span className="text-neutral-500">
                                          DMG
                                        </span>
                                        <span className="text-neutral-300 font-semibold">
                                          {numberFormatter.format(damage)}
                                        </span>
                                      </div>
                                      <Progress
                                        value={Math.round(dmgShare)}
                                        className="h-[10px] bg-neutral-800"
                                      />
                                    </div>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </CardBody>
              </Card>
            </motion.div>

            {/* Key Moments moved to Timeline tab */}
          </TabsContent>

          {/* Insights tab: previously Performance */}
          <TabsContent value="insights" className="space-y-8">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <Card className="bg-neutral-900/90 backdrop-blur-sm border border-neutral-700/60">
                <CardBody className="p-6 space-y-6">
                  <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.3em] text-accent-yellow-400">
                        <Clock className="h-4 w-4" />
                        <span>Rewind</span>
                      </div>
                      <h2 className="text-2xl font-bold text-neutral-50">
                        {subjectChampionName} progress
                      </h2>
                      <p className="text-sm text-neutral-400">
                        Track how your {subjectChampionName} {friendlyRoleLabel}{' '}
                        games have trended across the last{' '}
                        {progressMatches.length} matches.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {(
                        Object.keys(PROGRESS_METRICS) as ProgressMetricKey[]
                      ).map((metricKey) => {
                        const metric = PROGRESS_METRICS[metricKey];
                        const isSelected = metricKey === selectedProgressMetric;
                        const isAvailable = metricAvailability[metricKey];
                        return (
                          <Button
                            key={metricKey}
                            variant={isSelected ? 'secondary' : 'outline'}
                            size="sm"
                            disabled={!isAvailable}
                            onClick={() => setSelectedProgressMetric(metricKey)}
                          >
                            {metric.label}
                          </Button>
                        );
                      })}
                    </div>
                  </div>

                  {isProgressLoading ? (
                    <div className="space-y-4">
                      <div className="h-64 w-full animate-pulse rounded-lg bg-neutral-800/40" />
                      <div className="grid gap-4 md:grid-cols-3">
                        {[0, 1, 2].map((item) => (
                          <div
                            key={`progress-skeleton-${item}`}
                            className="rounded-lg border border-neutral-800/60 bg-neutral-800/40 p-4"
                          >
                            <div className="h-4 w-1/2 rounded bg-neutral-700/50" />
                            <div className="mt-3 h-6 w-1/3 rounded bg-neutral-700/50" />
                            <div className="mt-2 h-3 w-2/3 rounded bg-neutral-700/40" />
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : filteredProgressChartData.length ? (
                    <div className="space-y-6">
                      <div className="grid gap-4 lg:grid-cols-[2fr,1fr]">
                        <ChartContainer
                          config={progressChartConfig}
                          className="h-[320px] w-full"
                        >
                          <ComposedChart data={filteredProgressChartData}>
                            <defs>
                              <linearGradient
                                id="progressGradient"
                                x1="0"
                                x2="0"
                                y1="0"
                                y2="1"
                              >
                                <stop
                                  offset="5%"
                                  stopColor={progressMetricDefinition.color}
                                  stopOpacity={0.35}
                                />
                                <stop
                                  offset="95%"
                                  stopColor={progressMetricDefinition.color}
                                  stopOpacity={0}
                                />
                              </linearGradient>
                            </defs>
                            <CartesianGrid
                              strokeDasharray="4 4"
                              opacity={0.2}
                            />
                            <XAxis
                              dataKey="label"
                              tickLine={false}
                              axisLine={false}
                              tick={{ fill: '#9ca3af', fontSize: 12 }}
                              minTickGap={16}
                            />
                            <YAxis
                              tick={{ fill: '#9ca3af', fontSize: 12 }}
                              axisLine={false}
                              tickLine={false}
                            />
                            <RechartsTooltip
                              cursor={{
                                stroke: 'rgba(148, 163, 184, 0.4)',
                                strokeWidth: 1,
                              }}
                              content={({ active, payload }) => {
                                if (!active || !payload?.length) return null;
                                const datum = payload[0]?.payload as
                                  | ProgressChartDatum
                                  | undefined;
                                if (!datum) return null;
                                return (
                                  <div className="rounded-lg border border-neutral-700/60 bg-neutral-900/90 p-3 text-xs text-neutral-200">
                                    <div className="flex items-center justify-between gap-4 text-neutral-100">
                                      <span className="font-semibold">
                                        {datum.isCurrent
                                          ? 'Current match'
                                          : `Match ${datum.order}`}
                                      </span>
                                      <span
                                        className={cn(
                                          'text-[11px]',
                                          datum.win
                                            ? 'text-emerald-400'
                                            : 'text-red-400',
                                        )}
                                      >
                                        {datum.win ? 'Win' : 'Loss'}
                                      </span>
                                    </div>
                                    <div className="mt-1 text-[11px] text-neutral-400">
                                      {new Date(
                                        datum.gameCreation,
                                      ).toLocaleDateString()}
                                    </div>
                                    <div className="mt-3 text-sm font-semibold text-neutral-50">
                                      {formatProgressValue(datum.rawValue)}
                                    </div>
                                  </div>
                                );
                              }}
                            />
                            <Area
                              type="monotone"
                              dataKey="value"
                              stroke="none"
                              fill="url(#progressGradient)"
                            />
                            <Line
                              type="monotone"
                              dataKey="value"
                              stroke="var(--color-trend)"
                              strokeWidth={2}
                              dot={({ cx, cy, payload }) => {
                                const datum = payload as ProgressChartDatum;
                                const radius = datum.isCurrent ? 5 : 3;
                                return (
                                  <circle
                                    cx={cx}
                                    cy={cy}
                                    r={radius}
                                    stroke="var(--color-trend)"
                                    strokeWidth={datum.isCurrent ? 2 : 1}
                                    fill={
                                      datum.isCurrent
                                        ? 'rgba(250, 204, 21, 0.9)'
                                        : '#0f172a'
                                    }
                                  />
                                );
                              }}
                              activeDot={{
                                r: 6,
                                strokeWidth: 2,
                                stroke: 'var(--color-trend)',
                                fill: 'rgba(250, 204, 21, 0.9)',
                              }}
                            />
                            {progressSummary &&
                              progressSummary.average !== null && (
                                <ReferenceLine
                                  y={
                                    progressMetricDefinition.transform
                                      ? (progressMetricDefinition.transform(
                                          progressSummary.average,
                                        ) ?? undefined)
                                      : progressSummary.average
                                  }
                                  stroke="rgba(250, 204, 21, 0.45)"
                                  strokeDasharray="4 4"
                                />
                              )}
                          </ComposedChart>
                        </ChartContainer>
                        <div className="space-y-4">
                          <div className="rounded-lg border border-neutral-800/60 bg-neutral-800/40 p-4">
                            <p className="text-xs uppercase tracking-[0.2em] text-neutral-400">
                              Current match
                            </p>
                            <div className="mt-2 flex items-baseline justify-between">
                              <span className="text-3xl font-semibold text-neutral-100">
                                {formatProgressValue(
                                  progressSummary?.current?.rawValue ?? null,
                                )}
                              </span>
                              <span className="text-xs text-neutral-400">
                                vs avg{' '}
                                {formatProgressDifference(
                                  typeof progressSummary?.current?.rawValue ===
                                    'number' &&
                                    typeof progressSummary?.average === 'number'
                                    ? progressSummary.current.rawValue -
                                        progressSummary.average
                                    : null,
                                )}
                              </span>
                            </div>
                            <p className="mt-1 text-sm text-neutral-400">
                              {progressMetricDefinition.description}
                            </p>
                          </div>
                          <div className="rounded-lg border border-neutral-800/60 bg-neutral-800/40 p-4">
                            <p className="text-xs uppercase tracking-[0.2em] text-neutral-400">
                              Last 5 vs prior 5
                            </p>
                            <div className="mt-2 flex items-baseline justify-between">
                              <span className="text-lg font-semibold text-neutral-100">
                                {formatProgressValue(
                                  progressSummary?.trailingAverage ?? null,
                                )}
                              </span>
                              <span className="text-xs text-neutral-400">
                                {formatProgressDifference(
                                  typeof progressSummary?.trailingAverage ===
                                    'number' &&
                                    typeof progressSummary?.earlierAverage ===
                                      'number'
                                    ? progressSummary.trailingAverage -
                                        progressSummary.earlierAverage
                                    : null,
                                )}
                              </span>
                            </div>
                            <p className="mt-1 text-sm text-neutral-400">
                              Rolling momentum across your latest streak.
                            </p>
                          </div>
                          <div className="rounded-lg border border-neutral-800/60 bg-neutral-800/40 p-4">
                            <p className="text-xs uppercase tracking-[0.2em] text-neutral-400">
                              Best &amp; worst
                            </p>
                            <div className="mt-2 space-y-1 text-sm text-neutral-300">
                              <div className="flex items-center justify-between">
                                <span className="text-neutral-400">Peak</span>
                                <span className="font-semibold text-neutral-100">
                                  {formatProgressValue(
                                    progressSummary?.best?.rawValue ?? null,
                                  )}
                                </span>
                              </div>
                              <div className="flex items-center justify-between">
                                <span className="text-neutral-400">Low</span>
                                <span className="font-semibold text-neutral-100">
                                  {formatProgressValue(
                                    progressSummary?.worst?.rawValue ?? null,
                                  )}
                                </span>
                              </div>
                            </div>
                            <p className="mt-1 text-xs text-neutral-500">
                              Use these outliers to review what went right or
                              wrong.
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-lg border border-neutral-700/60 bg-neutral-800/40 p-4 text-sm text-neutral-400">
                      Not enough recent games on this champion-role to chart
                      your progress yet.
                    </div>
                  )}
                </CardBody>
              </Card>
            </motion.div>
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <Card className="bg-neutral-900/90 backdrop-blur-sm border border-neutral-700/60">
                <CardBody className="p-6 space-y-6">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h2 className="text-2xl font-bold text-neutral-50">
                        Performance Benchmarks
                      </h2>
                      <p className="text-sm text-neutral-400">
                        {comparisonSubtitle}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant={
                          comparisonMode === 'cohort' ? 'secondary' : 'outline'
                        }
                        size="sm"
                        onClick={() => setComparisonMode('cohort')}
                      >
                        Cohort
                      </Button>
                      <Button
                        variant={
                          comparisonMode === 'self' ? 'secondary' : 'outline'
                        }
                        size="sm"
                        onClick={() => setComparisonMode('self')}
                        disabled={!championRoleDetail?.playerPercentiles}
                      >
                        Personal
                      </Button>
                    </div>
                  </div>
                  {isChampionRoleLoading ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                      {[...Array(3).keys()].map((idx) => (
                        <div
                          key={`benchmark-skeleton-${idx}`}
                          className="rounded-lg border border-neutral-800/60 bg-neutral-800/40 p-4 space-y-3 animate-pulse"
                        >
                          <div className="h-3 w-1/3 rounded bg-neutral-700/50" />
                          <div className="h-6 w-1/2 rounded bg-neutral-700/50" />
                          <div className="h-3 w-2/3 rounded bg-neutral-700/50" />
                        </div>
                      ))}
                    </div>
                  ) : comparisonSourceAvailable ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                      <PerformanceCategoryCard
                        title="Economy"
                        score={categoryCards.economy.score}
                        bgImageUrl={categoryCards.economy.bgUrl}
                        metrics={categoryCards.economy.metrics.map((m) => ({
                          key: m.key,
                          label: m.label,
                          value: m.value,
                          valueDisplay: m.valueDisplay,
                          baseline: m.baseline,
                          invert: m.invert,
                          percent: m.percent,
                          p50: m.p50,
                          p75: m.p75,
                          p90: m.p90,
                        }))}
                      />
                      <PerformanceCategoryCard
                        title="Fighting"
                        score={categoryCards.fighting.score}
                        bgImageUrl={categoryCards.fighting.bgUrl}
                        metrics={categoryCards.fighting.metrics.map((m) => ({
                          key: m.key,
                          label: m.label,
                          value: m.value,
                          valueDisplay: m.valueDisplay,
                          baseline: m.baseline,
                          invert: m.invert,
                          percent: m.percent,
                          p50: m.p50,
                          p75: m.p75,
                          p90: m.p90,
                        }))}
                      />
                      <PerformanceCategoryCard
                        title="Vision"
                        score={categoryCards.vision.score}
                        bgImageUrl={categoryCards.vision.bgUrl}
                        metrics={categoryCards.vision.metrics.map((m) => ({
                          key: m.key,
                          label: m.label,
                          value: m.value,
                          valueDisplay: m.valueDisplay,
                          baseline: m.baseline,
                          invert: m.invert,
                          percent: m.percent,
                          p50: m.p50,
                          p75: m.p75,
                          p90: m.p90,
                        }))}
                      />
                    </div>
                  ) : (
                    <div className="rounded-lg border border-neutral-700/60 bg-neutral-800/40 p-4 text-sm text-neutral-400">
                      {comparisonMode === 'cohort'
                        ? 'Not enough historical data yet to build cohort benchmarks for this champion and role.'
                        : 'Not enough historical data yet to build personal medians for this champion and role.'}
                    </div>
                  )}
                </CardBody>
              </Card>
            </motion.div>
            {/* Build Suggestions */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 }}
            >
              <Card className="bg-neutral-900/90 backdrop-blur-sm border border-neutral-700/60 py-0">
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
                          <span className="text-neutral-300">
                            Generating build recommendation with AI...
                          </span>
                        </div>
                      </div>
                    ) : buildsData?.buildOrder &&
                      buildsData.buildOrder.length > 0 ? (
                      buildsData.buildOrder.map((entry, idx) => (
                        <div
                          key={`bo-${entry.order}-${entry.itemId}`}
                          className="flex items-center gap-2"
                        >
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
                            <span className="mt-1 text-xs text-neutral-400">
                              #{entry.order} {entry.itemName}
                            </span>
                          </div>
                          {idx < buildsData.buildOrder.length - 1 && (
                            <ChevronRight className="w-4 h-4 text-neutral-500" />
                          )}
                        </div>
                      ))
                    ) : (
                      slotColumns.map((col, idx) => (
                        <div
                          key={`col-wrapper-${col.slotKey}`}
                          className="flex items-center gap-2"
                        >
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
                                      {sug.action === 'replace_item' &&
                                      sug.replacesId > 0 ? (
                                        <img
                                          src={getItemIcon(sug.replacesId)}
                                          alt={
                                            sug.replacesName || 'Replaced item'
                                          }
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
                                        {sug.action === 'replace_item'
                                          ? 'Replace'
                                          : 'Add'}
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
                      {
                        buildsData.overallAnalysis.split(
                          'Grounded item facts (from DDragon):',
                        )[0]
                      }
                    </p>
                  )}
                </CardBody>
              </Card>
            </motion.div>
          </TabsContent>

          {/* Timeline tab */}
          <TabsContent value="timeline" className="space-y-8">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
            >
              <Card className="bg-neutral-900/90 backdrop-blur-sm border border-neutral-700/60 py-0">
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
                        <div
                          className="absolute inset-0"
                          style={getMapTransformStyle(1.75)}
                        >
                          <img
                            src="/map.svg"
                            alt="Summoner's Rift Map"
                            className="absolute inset-0 w-full h-full opacity-70 contrast-90 filter brightness-75"
                          />
                          {eventSnapshot?.entries.map((pp) => {
                            const participantDetails =
                              participantDetailsById.get(pp.participantId);
                            return (
                              <div
                                key={`pp-${pp.participantId}`}
                                className="absolute"
                                style={coordToStyle(pp.x, pp.y)}
                              >
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
                                    className="w-[22rem] border-neutral-700/70 bg-neutral-900/95 p-0 text-neutral-100"
                                  >
                                    <PlayerPopoverContent
                                      entry={pp}
                                      participant={participantDetails}
                                      formatClock={formatClock}
                                      getChampionSquare={getChampionSquare}
                                      getItemIcon={getItemIcon}
                                      timelineEvents={timelineEvents}
                                    />
                                  </PopoverContent>
                                </Popover>
                              </div>
                            );
                          })}
                        </div>
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
                      {selectedMoment && (
                        <div className="mt-4 p-4 bg-neutral-800/60 rounded-lg border border-neutral-700/50">
                          <div className="flex items-center justify-between mb-1">
                            <h3 className="font-semibold text-neutral-100 truncate">
                              {selectedMoment.title}
                            </h3>
                            <Badge
                              className={`text-xs font-semibold ${selectedMoment.enemyHalf ? 'bg-red-500/10 text-red-200 border border-red-500/40' : 'bg-neutral-800/70 text-neutral-200 border border-neutral-700/60'}`}
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
                            <span className="text-neutral-300">
                              Gathering key moments...
                            </span>
                          </div>
                        </div>
                      ) : (
                        insightsData?.keyMoments.map(
                          (moment, index: number) => {
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
                          },
                        )
                      )}
                    </div>
                  </div>
                </CardBody>
              </Card>
            </motion.div>
          </TabsContent>

          {/* Gold Graph tab */}
          <TabsContent value="gold" className="space-y-8">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <Card className="bg-neutral-900/90 backdrop-blur-sm border border-neutral-700/60">
                <CardBody className="p-6 space-y-6">
                  <div>
                    <h2 className="text-2xl font-bold text-neutral-50">
                      Gold Advantage
                    </h2>
                    <p className="text-sm text-neutral-400">
                      Team gold difference over time.
                    </p>
                  </div>
                  {goldGraphData.length > 0 ? (
                    <>
                      {console.log('Key moments data:', insightsData?.keyMoments)}
                      <ChartContainer
                        config={goldChartConfig}
                        className="h-[320px] w-full"
                      >
                        <ComposedChart data={goldGraphData}>
                        <CartesianGrid strokeDasharray="4 4" opacity={0.2} />
                        <XAxis
                          dataKey="minute"
                          type="number"
                          domain={["dataMin", "dataMax"]}
                          allowDataOverflow
                          tickLine={false}
                          axisLine={false}
                          tick={{ fill: '#9ca3af', fontSize: 12 }}
                          label={{
                            value: 'Minutes',
                            position: 'insideBottomRight',
                            offset: -4,
                            fill: '#9ca3af',
                            fontSize: 12,
                          }}
                        />
                        <YAxis
                          tick={{ fill: '#9ca3af', fontSize: 12 }}
                          axisLine={false}
                          tickLine={false}
                        />
                        <RechartsTooltip
                          cursor={{
                            stroke: 'rgba(148, 163, 184, 0.4)',
                            strokeWidth: 1,
                          }}
                          content={({ active, payload, label }) => {
                            if (!active || !payload?.length) return null;
                            
                            // Check if hovering near a key moment
                            const nearbyMoment = insightsData?.keyMoments?.find(
                              (moment) => {
                                const momentMinute = moment.ts / 60000;
                                return Math.abs(momentMinute - (label as number)) < 0.5;
                              }
                            );
                            
                            if (nearbyMoment) {
                              return (
                                <div className="max-w-xs rounded-lg border border-orange-500/40 bg-neutral-900/95 p-3 text-xs text-neutral-200">
                                  <div className="flex items-center gap-2">
                                    <span className="text-lg">⚡</span>
                                    <div className="font-semibold text-orange-400">
                                      {formatClock(nearbyMoment.ts)}
                                    </div>
                                  </div>
                                  <div className="mt-2 font-semibold text-neutral-100">
                                    {nearbyMoment.title}
                                  </div>
                                  <div className="mt-1 text-neutral-300">
                                    {nearbyMoment.insight}
                                  </div>
                                  {nearbyMoment.suggestion && (
                                    <div className="mt-2 rounded border border-neutral-700/60 bg-neutral-800/60 p-2 text-neutral-400">
                                      💡 {nearbyMoment.suggestion}
                                    </div>
                                  )}
                                </div>
                              );
                            }
                            
                            const datum = payload[0]?.payload as
                              | {
                                  goldDiff: number;
                                  teamGold: number;
                                  enemyGold: number;
                                }
                              | undefined;
                            if (!datum) return null;
                            return (
                              <div className="rounded-lg border border-neutral-700/60 bg-neutral-900/90 p-3 text-xs text-neutral-200">
                                <div className="font-semibold text-neutral-100">
                                  Minute {label}
                                </div>
                                <div className="mt-2 flex items-center justify-between">
                                  <span className="text-neutral-400">
                                    Gold diff
                                  </span>
                                  <span className="font-semibold text-accent-blue-200">
                                    {numberFormatter.format(datum.goldDiff)}
                                  </span>
                                </div>
                                <div className="mt-1 grid grid-cols-2 gap-2">
                                  <div className="flex items-center justify-between">
                                    <span className="text-neutral-400">
                                      Team
                                    </span>
                                    <span className="font-semibold">
                                      {numberFormatter.format(datum.teamGold)}
                                    </span>
                                  </div>
                                  <div className="flex items-center justify-between">
                                    <span className="text-neutral-400">
                                      Enemy
                                    </span>
                                    <span className="font-semibold">
                                      {numberFormatter.format(datum.enemyGold)}
                                    </span>
                                  </div>
                                </div>
                              </div>
                            );
                          }}
                        />
                        <Area
                          type="monotone"
                          dataKey="goldDiff"
                          stroke="var(--color-goldDiff)"
                          fill="var(--color-goldDiff)"
                          fillOpacity={0.15}
                          strokeWidth={2}
                          dot={false}
                        />
                        <ReferenceLine
                          y={0}
                          stroke="rgba(148,163,184,0.4)"
                          strokeDasharray="6 6"
                        />
                        {/* Key moment markers */}
                        {insightsData?.keyMoments?.map((moment, idx) => {
                          const minuteValue = moment.ts / 60000;
                          console.log('Gold chart moment marker:', { minuteValue, ts: moment.ts, title: moment.title });
                          return (
                            <ReferenceLine
                              key={`gold-moment-${moment.ts}-${idx}`}
                              x={minuteValue}
                              stroke="rgba(249, 115, 22, 0.35)"
                              strokeWidth={2}
                              strokeDasharray="5 5"
                              ifOverflow="extendDomain"
                              label={{
                                value: '⚡',
                                position: 'top',
                                fill: 'rgb(249, 115, 22)',
                                fontSize: 16,
                              }}
                            />
                          );
                        })}
                        </ComposedChart>
                      </ChartContainer>
                    </>
                  ) : (
                    <div className="rounded-lg border border-neutral-700/60 bg-neutral-800/40 p-4 text-sm text-neutral-400">
                      Gold graph unavailable without timeline frames.
                    </div>
                  )}
                </CardBody>
              </Card>
            </motion.div>
          </TabsContent>

          {/* Win Probability tab */}
          <TabsContent value="winprob" className="space-y-8">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <Card className="bg-neutral-900/90 backdrop-blur-sm border border-neutral-700/60">
                <CardBody className="p-6 space-y-6">
                  <div>
                    <h2 className="text-2xl font-bold text-neutral-50">
                      Win Probability Timeline
                    </h2>
                    <p className="text-sm text-neutral-400">
                      Gold advantage logistic model with an impact score per
                      minute.
                    </p>
                  </div>
                  {winProbabilityData.length > 0 ? (
                    <ChartContainer
                      config={winProbabilityChartConfig}
                      className="h-[320px] w-full"
                    >
                      <ComposedChart data={winProbabilityData}>
                        <CartesianGrid strokeDasharray="4 4" opacity={0.2} />
                        <XAxis
                          dataKey="minute"
                          type="number"
                          domain={["dataMin", "dataMax"]}
                          allowDataOverflow
                          tickLine={false}
                          axisLine={false}
                          tick={{ fill: '#9ca3af', fontSize: 12 }}
                          label={{
                            value: 'Minutes',
                            position: 'insideBottomRight',
                            offset: -4,
                            fill: '#9ca3af',
                            fontSize: 12,
                          }}
                        />
                        <YAxis
                          domain={[0, 100]}
                          tickFormatter={(value) => `${Math.round(value)}%`}
                          tick={{ fill: '#9ca3af', fontSize: 12 }}
                          axisLine={false}
                          tickLine={false}
                        />
                        <RechartsTooltip
                          cursor={{
                            stroke: 'rgba(148, 163, 184, 0.4)',
                            strokeWidth: 1,
                          }}
                          content={({ active, payload, label }) => {
                            if (!active || !payload?.length) return null;
                            
                            // Check if hovering near a key moment
                            const nearbyMoment = insightsData?.keyMoments?.find(
                              (moment) => {
                                const momentMinute = moment.ts / 60000;
                                return Math.abs(momentMinute - (label as number)) < 0.5;
                              }
                            );
                            
                            if (nearbyMoment) {
                              return (
                                <div className="max-w-xs rounded-lg border border-orange-500/40 bg-neutral-900/95 p-3 text-xs text-neutral-200">
                                  <div className="flex items-center gap-2">
                                    <span className="text-lg">⚡</span>
                                    <div className="font-semibold text-orange-400">
                                      {formatClock(nearbyMoment.ts)}
                                    </div>
                                  </div>
                                  <div className="mt-2 font-semibold text-neutral-100">
                                    {nearbyMoment.title}
                                  </div>
                                  <div className="mt-1 text-neutral-300">
                                    {nearbyMoment.insight}
                                  </div>
                                  {nearbyMoment.suggestion && (
                                    <div className="mt-2 rounded border border-neutral-700/60 bg-neutral-800/60 p-2 text-neutral-400">
                                      💡 {nearbyMoment.suggestion}
                                    </div>
                                  )}
                                </div>
                              );
                            }
                            
                            const datum = payload[0]?.payload as
                              | { winProb: number; impactRaw: number }
                              | undefined;
                            if (!datum) return null;
                            return (
                              <div className="rounded-lg border border-neutral-700/60 bg-neutral-900/90 p-3 text-xs text-neutral-200">
                                <div className="font-semibold text-neutral-100">
                                  Minute {label}
                                </div>
                                <div className="mt-2 flex items-center justify-between">
                                  <span className="text-neutral-400">
                                    Win probability
                                  </span>
                                  <span className="font-semibold text-accent-blue-200">
                                    {datum.winProb.toFixed(1)}%
                                  </span>
                                </div>
                                <div className="mt-1 flex items-center justify-between">
                                  <span className="text-neutral-400">
                                    Impact score
                                  </span>
                                  <span className="font-semibold text-accent-yellow-200">
                                    {datum.impactRaw.toFixed(2)}
                                  </span>
                                </div>
                              </div>
                            );
                          }}
                        />
                        <Area
                          type="monotone"
                          dataKey="winProb"
                          stroke="var(--color-winProb)"
                          fill="var(--color-winProb)"
                          fillOpacity={0.15}
                          strokeWidth={2}
                          dot={false}
                        />
                        <Line
                          type="monotone"
                          dataKey="impact"
                          stroke="var(--color-impact)"
                          strokeWidth={2}
                          dot={false}
                          strokeDasharray="4 2"
                        />
                        <ReferenceLine
                          y={50}
                          stroke="rgba(148,163,184,0.4)"
                          strokeDasharray="6 6"
                        />
                        {/* Key moment markers */}
                        {insightsData?.keyMoments?.map((moment, idx) => {
                          const minuteValue = moment.ts / 60000;
                          console.log('Win prob chart moment marker:', { minuteValue, ts: moment.ts, title: moment.title });
                          return (
                            <ReferenceLine
                              key={`winprob-moment-${moment.ts}-${idx}`}
                              x={minuteValue}
                              stroke="rgba(249, 115, 22, 0.35)"
                              strokeWidth={2}
                              strokeDasharray="5 5"
                              ifOverflow="extendDomain"
                              label={{
                                value: '⚡',
                                position: 'top',
                                fill: 'rgb(249, 115, 22)',
                                fontSize: 16,
                              }}
                            />
                          );
                        })}
                      </ComposedChart>
                    </ChartContainer>
                  ) : (
                    <div className="rounded-lg border border-neutral-700/60 bg-neutral-800/40 p-4 text-sm text-neutral-400">
                      Win probability chart unavailable without timeline frames.
                    </div>
                  )}
                </CardBody>
              </Card>
            </motion.div>
          </TabsContent>

          <TabsContent value="stats" className="space-y-8">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <Card className="bg-neutral-900/90 backdrop-blur-sm border border-neutral-700/60">
                <CardBody className="p-6 space-y-6">
                  <div>
                    <h2 className="text-2xl font-bold text-neutral-50">
                      Detailed Player Stats
                    </h2>
                    <p className="text-sm text-neutral-400">
                      Expanded postgame-style breakdown including damage share,
                      vision, and pacing metrics.
                    </p>
                  </div>
                  <div className="space-y-8">
                    {detailedStatsByTeam.map((team) => (
                      <div
                        key={`team-details-${team.teamId}`}
                        className="space-y-3"
                      >
                        <div
                          className={cn(
                            'flex items-center justify-between rounded-lg border px-4 py-3 text-sm font-semibold',
                            team.teamId === 100
                              ? 'border-accent-blue-400/40 bg-accent-blue-900/20 text-accent-blue-100'
                              : 'border-red-400/40 bg-red-900/20 text-red-100',
                          )}
                        >
                          <span>
                            {team.win ? 'Victory' : 'Defeat'} · {team.name}
                          </span>
                        </div>
                        <div className="overflow-x-auto">
                          <table className="min-w-full text-sm text-neutral-200">
                            <thead className="text-xs uppercase tracking-wide text-neutral-500">
                              <tr>
                                <th className="px-3 py-2 text-left">Player</th>
                                <th className="px-3 py-2 text-left">Role</th>
                                <th className="px-3 py-2 text-left">
                                  K / D / A
                                </th>
                                <th className="px-3 py-2 text-right">KDA</th>
                                <th className="px-3 py-2 text-right">
                                  CS (CS/min)
                                </th>
                                <th className="px-3 py-2 text-right">Gold</th>
                                <th className="px-3 py-2 text-right">Damage</th>
                                <th className="px-3 py-2 text-right">Taken</th>
                                <th className="px-3 py-2 text-right">Vision</th>
                                <th className="px-3 py-2 text-right">Wards</th>
                                <th className="px-3 py-2 text-right">DMG%</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-neutral-800/60">
                              {team.participants.map((row) => {
                                const isSubject =
                                  row.participant.puuid ===
                                  subjectParticipant?.puuid;
                                const role =
                                  row.participant.teamPosition ||
                                  row.participant.individualPosition ||
                                  '—';
                                const damageShareDisplay =
                                  row.damageShare != null
                                    ? `${row.damageShare.toFixed(1)}%`
                                    : '—';
                                const wardsDisplay = `${row.wardsPlaced}/${row.wardsKilled}`;
                                return (
                                  <tr
                                    key={row.participant.puuid}
                                    className={cn(
                                      'transition-colors',
                                      isSubject
                                        ? 'bg-accent-blue-900/30'
                                        : 'bg-neutral-900/20 hover:bg-neutral-800/30',
                                    )}
                                  >
                                    <td className="px-3 py-2">
                                      <div className="flex items-center gap-3">
                                        <Avatar className="h-10 w-10 rounded-lg">
                                          <AvatarImage
                                            src={getChampionSquare(
                                              row.participant.championName,
                                            )}
                                            alt={row.participant.championName}
                                          />
                                        </Avatar>
                                        <div>
                                          <div className="font-semibold text-neutral-100">
                                            {row.displayName}
                                            {row.displayTag ? (
                                              <span className="text-xs text-neutral-500 ml-1">
                                                #{row.displayTag}
                                              </span>
                                            ) : null}
                                          </div>
                                          <div className="text-xs text-neutral-500">
                                            {row.participant.championName}
                                          </div>
                                        </div>
                                      </div>
                                    </td>
                                    <td className="px-3 py-2 text-neutral-300">
                                      {role}
                                    </td>
                                    <td className="px-3 py-2 text-neutral-300">
                                      {row.participant.kills}/
                                      {row.participant.deaths}/
                                      {row.participant.assists}
                                    </td>
                                    <td className="px-3 py-2 text-right">
                                      {Number.isFinite(row.kdaRatio)
                                        ? row.kdaRatio.toFixed(2)
                                        : '—'}
                                    </td>
                                    <td className="px-3 py-2 text-right">
                                      {numberFormatter.format(row.cs)}
                                      <span className="text-xs text-neutral-500 ml-1">
                                        ({row.csPerMin.toFixed(2)})
                                      </span>
                                    </td>
                                    <td className="px-3 py-2 text-right">
                                      {numberFormatter.format(row.goldEarned)}
                                    </td>
                                    <td className="px-3 py-2 text-right">
                                      {numberFormatter.format(row.damage)}
                                    </td>
                                    <td className="px-3 py-2 text-right">
                                      {numberFormatter.format(row.damageTaken)}
                                    </td>
                                    <td className="px-3 py-2 text-right">
                                      {numberFormatter.format(row.visionScore)}
                                    </td>
                                    <td className="px-3 py-2 text-right">
                                      {wardsDisplay}
                                    </td>
                                    <td className="px-3 py-2 text-right">
                                      {damageShareDisplay}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardBody>
              </Card>
            </motion.div>
          </TabsContent>
        </Tabs>
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
  timelineEvents: TimelineEvent[];
};

function PlayerPopoverContent({
  entry,
  participant,
  formatClock,
  getItemIcon,
  getChampionSquare,
  timelineEvents,
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

  const inventory =
    entry.inventory.length > 0 ? entry.inventory : itemsFromParticipant;
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
      : participant &&
          typeof (participant as { champExperience?: number })
            .champExperience === 'number'
        ? (participant as { champExperience?: number }).champExperience
        : null;

  const csFromParticipant =
    (participant?.totalMinionsKilled ?? 0) +
    (participant?.neutralMinionsKilled ?? 0);
  const cs = entry.frame ? entry.cs : csFromParticipant;
  const frameReferenceTs = entry.frameTimestamp ?? entry.ts;
  const elapsedMinutes = frameReferenceTs > 0 ? frameReferenceTs / 60000 : null;
  const csPerMin =
    elapsedMinutes && elapsedMinutes > 0 ? cs / elapsedMinutes : null;

  // Use frame-specific damage stats instead of match totals
  const ds = entry.frame?.damageStats as Record<string, number> | undefined;
  const damageDealt = {
    physical:
      ds?.physicalDamageDoneToChampions ??
      ds?.physicalDamageDealtToChampions ??
      0,
    magic:
      ds?.magicDamageDoneToChampions ?? ds?.magicDamageDealtToChampions ?? 0,
    true: ds?.trueDamageDoneToChampions ?? ds?.trueDamageDealtToChampions ?? 0,
  };
  const totalDamageDealt =
    ds?.totalDamageDoneToChampions ??
    ds?.totalDamageDealtToChampions ??
    damageDealt.physical + damageDealt.magic + damageDealt.true;

  const damageTaken = {
    physical: ds?.physicalDamageTaken ?? 0,
    magic: ds?.magicDamageTaken ?? 0,
    true: ds?.trueDamageTaken ?? 0,
  };
  const totalDamageTaken =
    ds?.totalDamageTaken ??
    damageTaken.physical + damageTaken.magic + damageTaken.true;

  const snapshotClock =
    typeof entry.frameTimestamp === 'number'
      ? formatClock(entry.frameTimestamp)
      : '–';
  const deltaSeconds =
    typeof entry.frameDeltaMs === 'number' ? entry.frameDeltaMs / 1000 : null;
  const deltaLabel =
    deltaSeconds != null
      ? `${entry.snapshotSource === 'previous' ? '−' : '+'}${preciseNumberFormatter.format(
          Math.abs(deltaSeconds),
        )}s`
      : null;

  // Compute K/D/A up to the snapshot timestamp from timeline events (frame-based)
  const kdaMatch = participant
    ? `${participant.kills}/${participant.deaths}/${participant.assists}`
    : '—';
  const snapshotTs =
    typeof entry.frameTimestamp === 'number' ? entry.frameTimestamp : entry.ts;
  let killsUpTo = 0;
  let deathsUpTo = 0;
  let assistsUpTo = 0;
  if (Array.isArray(timelineEvents) && typeof snapshotTs === 'number') {
    for (const ev of timelineEvents) {
      if (ev?.type !== 'CHAMPION_KILL') continue;
      const t = Number(ev.timestamp ?? 0);
      if (Number.isFinite(t) && t > snapshotTs) break; // events sorted ascending
      if (ev.killerId === entry.participantId) killsUpTo++;
      if (ev.victimId === entry.participantId) deathsUpTo++;
      const assts = (ev.assistingParticipantIds ?? []) as number[];
      if (assts.includes(entry.participantId)) assistsUpTo++;
    }
  }
  const kdaFrame = `${killsUpTo}/${deathsUpTo}/${assistsUpTo}`;
  const kda =
    (timelineEvents?.length ?? 0) > 0 && typeof snapshotTs === 'number'
      ? kdaFrame
      : kdaMatch;
  const visionScore =
    typeof participant?.visionScore === 'number'
      ? participant.visionScore
      : null;

  return (
    <div className="w-[350px] p-3 space-y-3">
      {/* Compact Header */}
      <div className="flex items-center gap-3">
        <Avatar
          className={cn(
            'h-12 w-12 rounded-lg ring-2 flex-shrink-0',
            entry.teamId === 100 ? 'ring-accent-blue-400' : 'ring-red-400',
          )}
        >
          <AvatarImage
            src={getChampionSquare(entry.championName)}
            alt={entry.championName}
            className="rounded-lg"
          />
        </Avatar>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-neutral-100 truncate">
              {entry.summonerName}
            </h3>
            <Badge
              variant="outline"
              className={cn(
                'text-[10px] px-1.5 py-0',
                entry.teamId === 100
                  ? 'border-accent-blue-400/30 text-accent-blue-300 bg-accent-blue-400/10'
                  : 'border-red-400/30 text-red-300 bg-red-400/10',
              )}
            >
              {entry.teamId === 100 ? 'Blue' : 'Red'}
            </Badge>
          </div>
          <div className="text-xs text-neutral-400">{entry.championName}</div>
          <div className="flex items-center gap-2 text-xs text-neutral-500">
            <span className="flex items-center gap-1">
              <Clock className="h-2.5 w-2.5" />
              {formatClock(entry.ts)}
            </span>
            {typeof entry.frameTimestamp === 'number' && (
              <span className="flex items-center gap-1">
                <Target className="h-2.5 w-2.5" />
                {snapshotClock}
                {deltaLabel && (
                  <span className="text-neutral-600">({deltaLabel})</span>
                )}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Compact Stats Row - Frame-specific data */}
      <div className="grid grid-cols-4 gap-1.5">
        <div className="bg-neutral-800/40 rounded p-2 text-center">
          <div className="text-xs text-neutral-500">LVL</div>
          <div className="text-sm font-semibold text-neutral-100">
            {level ?? '—'}
          </div>
        </div>
        <div className="bg-neutral-800/40 rounded p-2 text-center">
          <div className="text-xs text-neutral-500">KDA</div>
          <div className="text-sm font-semibold text-neutral-100">{kda}</div>
        </div>
        <div className="bg-neutral-800/40 rounded p-2 text-center">
          <div className="text-xs text-neutral-500">CS</div>
          <div className="text-sm font-semibold text-neutral-100">
            {numberFormatter.format(Math.round(cs))}
          </div>
        </div>
        <div className="bg-neutral-800/40 rounded p-2 text-center">
          <div className="text-xs text-neutral-500">CS/M</div>
          <div className="text-sm font-semibold text-neutral-100">
            {csPerMin && Number.isFinite(csPerMin)
              ? preciseNumberFormatter.format(csPerMin)
              : '—'}
          </div>
        </div>
      </div>

      {/* Compact Tabs */}
      <Tabs defaultValue="build" className="w-full">
        <TabsList className="grid grid-cols-3 gap-1 p-1 bg-neutral-800/30 rounded-md h-8">
          <TabsTrigger value="build" className="text-xs py-1">
            Build
          </TabsTrigger>
          <TabsTrigger value="damage" className="text-xs py-1">
            Damage
          </TabsTrigger>
          <TabsTrigger value="stats" className="text-xs py-1">
            Stats
          </TabsTrigger>
        </TabsList>

        <TabsContent value="build" className="mt-2 space-y-2">
          {/* Compact Items Grid */}
          <div className="grid grid-cols-6 gap-1">
            {slots.map((itemId, idx) => (
              <div key={`slot-${entry.participantId}-${idx}`}>
                {itemId ? (
                  <img
                    src={getItemIcon(itemId) || undefined}
                    alt={`Item ${itemId}`}
                    title={`Item ${itemId}`}
                    className="h-8 w-8 rounded border border-neutral-700 bg-neutral-900 object-cover"
                  />
                ) : (
                  <div className="h-8 w-8 rounded border border-dashed border-neutral-700 bg-neutral-800/20" />
                )}
              </div>
            ))}
          </div>

          {/* Compact Gold Stats */}
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-neutral-800/40 rounded p-2">
              <div className="text-xs text-neutral-500">Gold</div>
              <div className="text-sm font-semibold text-yellow-400">
                {goldInBag != null ? numberFormatter.format(goldInBag) : '—'}
              </div>
            </div>
            <div className="bg-neutral-800/40 rounded p-2">
              <div className="text-xs text-neutral-500">Total</div>
              <div className="text-sm font-semibold text-neutral-200">
                {totalGold != null
                  ? numberFormatter.format(Math.round(totalGold))
                  : '—'}
              </div>
            </div>
          </div>

          {overflow.length > 0 && (
            <div className="text-center">
              <Badge variant="secondary" className="text-[10px] px-1.5">
                +{overflow.length}
              </Badge>
            </div>
          )}
        </TabsContent>

        <TabsContent value="damage" className="mt-2 space-y-2">
          {/* Compact Damage Dealt */}
          <div className="bg-neutral-800/40 rounded p-2">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-neutral-400 flex items-center gap-1">
                <Zap className="h-3 w-3 text-orange-400" />
                Dealt
              </span>
              <span className="text-xs font-semibold text-neutral-200 font-mono">
                {numberFormatter.format(Math.round(totalDamageDealt))}
              </span>
            </div>
            <div className="space-y-1">
              {[
                { key: 'physical', color: 'text-orange-400' },
                { key: 'magic', color: 'text-blue-400' },
                { key: 'true', color: 'text-neutral-300' },
              ].map(({ key, color }) => (
                <div key={key} className="flex items-center gap-2">
                  <span className={cn('text-[10px] capitalize', color)}>
                    {key.slice(0, 3)}
                  </span>
                  <Progress
                    value={
                      totalDamageDealt > 0
                        ? Math.min(
                            100,
                            (damageDealt[key as keyof typeof damageDealt] /
                              totalDamageDealt) *
                              100,
                          )
                        : 0
                    }
                    className="h-1.5 flex-1"
                  />
                  <span className="text-[10px] text-neutral-400 font-mono">
                    {numberFormatter.format(
                      Math.round(damageDealt[key as keyof typeof damageDealt]),
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Compact Damage Taken */}
          <div className="bg-neutral-800/40 rounded p-2">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-neutral-400 flex items-center gap-1">
                <div className="h-2 w-2 rounded-full bg-red-500" />
                Taken
              </span>
              <span className="text-xs font-semibold text-neutral-200 font-mono">
                {numberFormatter.format(Math.round(totalDamageTaken))}
              </span>
            </div>
            <div className="space-y-1">
              {[
                { key: 'physical', color: 'text-orange-400' },
                { key: 'magic', color: 'text-blue-400' },
                { key: 'true', color: 'text-neutral-300' },
              ].map(({ key, color }) => (
                <div key={key} className="flex items-center gap-2">
                  <span className={cn('text-[10px] capitalize', color)}>
                    {key.slice(0, 3)}
                  </span>
                  <Progress
                    value={
                      totalDamageTaken > 0
                        ? Math.min(
                            100,
                            (damageTaken[key as keyof typeof damageTaken] /
                              totalDamageTaken) *
                              100,
                          )
                        : 0
                    }
                    className="h-1.5 flex-1"
                  />
                  <span className="text-[10px] text-neutral-400 font-mono">
                    {numberFormatter.format(
                      Math.round(damageTaken[key as keyof typeof damageTaken]),
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="stats" className="mt-2 space-y-2">
          {/* Compact Core Stats */}
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-neutral-800/40 rounded p-2">
              <div className="text-xs text-neutral-500">XP</div>
              <div className="text-sm font-semibold text-neutral-100">
                {xp != null ? numberFormatter.format(Math.round(xp)) : '—'}
              </div>
            </div>
            <div className="bg-neutral-800/40 rounded p-2">
              <div className="text-xs text-neutral-500">Vision</div>
              <div className="text-sm font-semibold text-neutral-100">
                {visionScore != null
                  ? numberFormatter.format(Math.round(visionScore))
                  : '—'}
              </div>
            </div>
          </div>

          {/* Compact Match Total Damage */}
          {participant?.totalDamageDealtToChampions != null && (
            <div className="bg-neutral-800/40 rounded p-2">
              <div className="text-xs text-neutral-500">Match Damage</div>
              <div className="text-sm font-semibold text-neutral-100 font-mono">
                {numberFormatter.format(
                  Math.round(participant.totalDamageDealtToChampions),
                )}
              </div>
            </div>
          )}

          {/* Compact Additional Info */}
          <div className="text-xs text-neutral-500 text-center">
            {inventory.length === 0 ? (
              <span>No items</span>
            ) : (
              <span>{snapshotClock}</span>
            )}
            {deltaLabel && (
              <span className="ml-1 text-neutral-600">({deltaLabel})</span>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
