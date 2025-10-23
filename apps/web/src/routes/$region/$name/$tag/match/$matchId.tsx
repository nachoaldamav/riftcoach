import { useDataDragon } from '@/providers/data-dragon-provider';
import { getAllMatchDataQueryOptions } from '@/queries/get-match-insights';
import { Avatar, Card, CardBody, Chip, cn } from '@heroui/react';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { motion } from 'framer-motion';
import { Clock, Map as MapIcon, Target, Zap } from 'lucide-react';
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
};

type ParticipantFrame = {
  position?: Vec2;
  level?: number;
  totalGold?: number;
  gold?: number;
  minionsKilled?: number;
  jungleMinionsKilled?: number;
};

type TimelineFrame = {
  timestamp?: number;
  events?: TimelineEvent[];
  participantFrames?: Record<string, ParticipantFrame>;
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

  // Interpolated snapshot at the event timestamp
  const eventSnapshot = useMemo(() => {
    if (!timelineData || !matchData || !selectedMoment) return null;
    const frames: TimelineFrame[] = (timelineData.info.frames ||
      []) as TimelineFrame[];
    const ts = selectedMoment.ts;

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

    const entries: Array<{
      participantId: number;
      championName: string;
      teamId: number;
      summonerName: string;
      x: number;
      y: number;
      confidence: number;
      radius: number; // map units
      isActor: boolean;
    }> = [];

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
        });
      }
    }

    return { ts, eventPos, entries };
  }, [timelineData, matchData, selectedMoment]);

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

  const isLoading = isMatchLoading || isTimelineLoading || isInsightsLoading;

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

  if (isLoading) {
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

  if (!matchData || !timelineData || !insightsData) {
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
    <div className="max-w-7xl mx-auto space-y-8">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center gap-4"
      >
        <h1 className="text-3xl font-bold text-neutral-50">Match Analysis</h1>
        <Chip color="primary" variant="flat">
          {matchData.info.gameMode}
        </Chip>
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
                  <div
                    className={`text-center p-4 rounded-lg ${team.win ? 'bg-accent-emerald-900/30 border border-accent-emerald-500/30' : 'bg-red-900/30 border border-red-500/30'}`}
                  >
                    <h3
                      className={`text-lg font-bold ${team.win ? 'text-accent-emerald-400' : 'text-red-400'}`}
                    >
                      {team.win ? 'Victory' : 'Defeat'}
                    </h3>
                  </div>

                  <div className="space-y-2">
                    {matchData.info.participants
                      .filter((p) => p.teamId === team.teamId)
                      .map((p) => (
                        <div
                          key={`row-${p.puuid}`}
                          className="flex items-center gap-3 p-3 bg-neutral-800/50 rounded-lg border border-neutral-700/40"
                        >
                          <div className="flex items-center gap-2">
                            <Avatar
                              src={getChampionSquare(p.championName)}
                              alt={p.championName}
                              className="w-10 h-10"
                            />
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

                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-neutral-200 truncate">
                              {p.summonerName}
                            </div>
                            <div className="text-sm text-neutral-400">
                              {p.kills}/{p.deaths}/{p.assists}
                            </div>

                            {/* Items */}
                            <div className="flex items-center gap-1 mt-1">
                              {[
                                p.item0,
                                p.item1,
                                p.item2,
                                p.item3,
                                p.item4,
                                p.item5,
                              ].map((it: number | undefined, idx: number) => (
                                <img
                                  key={`it-${p.puuid}-${idx}-${it}`}
                                  src={getItemIcon(it)}
                                  alt="item"
                                  className={`w-5 h-5 rounded bg-neutral-900 border ${it ? 'border-neutral-700' : 'border-neutral-700/40 opacity-30'} object-cover`}
                                />
                              ))}
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
                      ))}
                  </div>
                </div>
              ))}
            </div>
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
                    {eventSnapshot?.entries.map((pp) => (
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
                        <Avatar
                          src={getChampionSquare(pp.championName)}
                          alt={pp.summonerName}
                          className={cn(
                            'w-6 h-6 ring-2',
                            pp.teamId === 100
                              ? 'ring-blue-400'
                              : 'ring-red-400',
                            'shadow-md z-20',
                            !pp.isActor ? 'opacity-50' : '',
                          )}
                        />
                      </div>
                    ))}
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
                      <Chip
                        size="sm"
                        variant="flat"
                        color={selectedMoment.enemyHalf ? 'danger' : 'default'}
                      >
                        {selectedMoment.zone}
                      </Chip>
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
                {insightsData.keyMoments.map((moment, index: number) => {
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
                })}
              </div>
            </div>
          </CardBody>
        </Card>
      </motion.div>
    </div>
  );
}
