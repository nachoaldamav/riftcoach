import { useDataDragon } from '@/providers/data-dragon-provider';
import { getAllMatchDataQueryOptions } from '@/queries/get-match-insights';
import { Avatar, Card, CardBody, Chip } from '@heroui/react';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { motion } from 'framer-motion';
import { Clock, Map as MapIcon, Target, Zap } from 'lucide-react';
import { useMemo, useState } from 'react';

export const Route = createFileRoute('/$region/$name/$tag/match/$matchId')({
  component: MatchAnalysisComponent,
});

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
          const pos = (pf as { position?: { x: number; y: number } }).position;
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

  // Compute the closest frame index to the selected moment timestamp
  const frameIndexForSelectedMoment = useMemo(() => {
    if (!selectedMoment || !timelineData) return 0;
    const frames = timelineData.info.frames || [];
    let bestIdx = 0;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      const ft = (frame as { timestamp?: number }).timestamp;
      if (typeof ft === 'number') {
        const diff = Math.abs(ft - selectedMoment.ts);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestIdx = i;
        }
      }
      for (const ev of frame.events || []) {
        const ts = (ev as { timestamp?: number }).timestamp;
        if (typeof ts === 'number') {
          const diff = Math.abs(ts - selectedMoment.ts);
          if (diff < bestDiff) {
            bestDiff = diff;
            bestIdx = i;
          }
        }
      }
    }
    return bestIdx;
  }, [selectedMoment, timelineData]);

  const participantById = useMemo(() => {
    if (!matchData) return new Map();
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

  // Player positions for that frame
  const playerPositions = useMemo(() => {
    if (!timelineData || !matchData) return [];
    const frames = timelineData.info.frames || [];
    const frame = frames[frameIndexForSelectedMoment];
    if (!frame)
      return [] as Array<{
        participantId: number;
        x: number;
        y: number;
        championName: string;
        teamId: number;
        summonerName: string;
      }>;

    const pById = new Map<
      number,
      { championName: string; teamId: number; summonerName: string }
    >();
    for (const p of matchData.info.participants) {
      pById.set(p.participantId, {
        championName: p.championName,
        teamId: p.teamId,
        summonerName: p.summonerName,
      });
    }

    const out: Array<{
      participantId: number;
      x: number;
      y: number;
      championName: string;
      teamId: number;
      summonerName: string;
    }> = [];

    const participantFrames = frame.participantFrames || {};
    for (let id = 1; id <= 10; id++) {
      const pf = participantFrames[String(id)] as
        | { position?: { x: number; y: number } }
        | undefined;
      const pos = pf?.position;
      const meta = pById.get(id);
      if (pos && meta) {
        out.push({
          participantId: id,
          x: pos.x,
          y: pos.y,
          championName: meta.championName,
          teamId: meta.teamId,
          summonerName: meta.summonerName,
        });
      }
    }
    return out;
  }, [frameIndexForSelectedMoment, timelineData, matchData]);

  const isLoading = isMatchLoading || isTimelineLoading || isInsightsLoading;

  // Helper functions
  const getChampionCentered = (championName: string) =>
    `https://ddragon.leagueoflegends.com/cdn/img/champion/centered/${championName}_0.jpg`;

  function findKillParticipants(
    ts: number,
  ): { killer?: string; victim?: string } | null {
    if (!timelineData) return null;
    const frames = timelineData.info.frames || [];
    let best: { killer?: number; victim?: number } | null = null;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (const frame of frames) {
      for (const ev of frame.events || []) {
        const e = ev as {
          timestamp?: number;
          type?: string;
          killerId?: number;
          victimId?: number;
        };
        if (e.type === 'CHAMPION_KILL' && typeof e.timestamp === 'number') {
          const diff = Math.abs(e.timestamp - ts);
          if (diff < bestDiff) {
            bestDiff = diff;
            best = { killer: e.killerId, victim: e.victimId };
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

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-neutral-950 via-neutral-900 to-neutral-950 p-6">
        <div className="max-w-7xl mx-auto">
          <div className="animate-pulse space-y-6">
            <div className="h-8 bg-neutral-800 rounded w-1/3" />
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="h-96 bg-neutral-800 rounded-xl" />
              <div className="h-96 bg-neutral-800 rounded-xl" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!matchData || !timelineData || !insightsData) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-neutral-950 via-neutral-900 to-neutral-950 p-6">
        <div className="max-w-7xl mx-auto">
          <Card className="bg-red-900/20 border-red-500/30">
            <CardBody className="p-8 text-center">
              <Target className="w-12 h-12 mx-auto mb-4 text-red-400" />
              <h2 className="text-xl font-bold text-red-400 mb-2">
                Match Not Found
              </h2>
              <p className="text-neutral-400">
                Unable to load match data. The match may not exist or there was
                an error fetching the data.
              </p>
            </CardBody>
          </Card>
        </div>
      </div>
    );
  }

  // Utilities for assets
  const getChampionSquare = (championName: string) =>
    version
      ? `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${championName}.png`
      : `https://ddragon.leagueoflegends.com/cdn/img/champion/${championName}.png`;

  const getItemIcon = (itemId?: number) =>
    version && itemId && itemId > 0
      ? `https://ddragon.leagueoflegends.com/cdn/${version}/img/item/${itemId}.png`
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

  const coordToStyle = (x: number, y: number): React.CSSProperties => {
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

  return (
    <div className="min-h-screen bg-gradient-to-br from-neutral-950 via-neutral-900 to-neutral-950 p-6">
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
                      className={`text-center p-4 rounded-lg ${
                        team.win
                          ? 'bg-accent-emerald-900/30 border border-accent-emerald-500/30'
                          : 'bg-red-900/30 border border-red-500/30'
                      }`}
                    >
                      <h3
                        className={`text-lg font-bold ${
                          team.win ? 'text-accent-emerald-400' : 'text-red-400'
                        }`}
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
                                ].map((it, idx) => (
                                  <img
                                    key={`it-${p.puuid}-${idx}-${it}`}
                                    src={getItemIcon(it)}
                                    alt="item"
                                    className={`w-5 h-5 rounded bg-neutral-900 border ${
                                      it
                                        ? 'border-neutral-700'
                                        : 'border-neutral-700/40 opacity-30'
                                    } object-cover`}
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
                    <img
                      src="/map.svg"
                      alt="Summoner's Rift Map"
                      className="w-full h-full opacity-70 contrast-90 filter brightness-75"
                    />

                    {/* Player markers at selected moment */}
                    {playerPositions.map((pp) => (
                      <div
                        key={`pp-${pp.participantId}`}
                        className="absolute"
                        style={coordToStyle(pp.x, pp.y)}
                      >
                        <Avatar
                          src={getChampionSquare(pp.championName)}
                          alt={pp.summonerName}
                          className={`w-6 h-6 ring-2 ${pp.teamId === 100 ? 'ring-blue-400' : 'ring-red-400'} shadow-md`}
                        />
                      </div>
                    ))}

                    {/* Selected moment markers */}
                    {selectedMoment?.coordinates?.map((c, i) => (
                      <div
                        key={`pt-${selectedMoment.ts}-${i}-${c.x}-${c.y}`}
                        className="absolute"
                        style={coordToStyle(c.x, c.y)}
                      >
                        <span className="relative flex h-3 w-3">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent-yellow-400 opacity-60" />
                          <span className="relative inline-flex rounded-full h-3 w-3 bg-accent-yellow-400 border border-neutral-900" />
                        </span>
                      </div>
                    ))}

                    {/* Corner decoration */}
                    <div className="absolute top-4 right-4 px-2 py-1 rounded bg-neutral-900/80 border border-neutral-700/60 text-xs text-neutral-300 flex items-center gap-1">
                      <MapIcon className="w-3 h-3" />
                      {selectedMoment
                        ? `t ${formatClock(selectedMoment.ts)}`
                        : '—'}
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
                          color={
                            selectedMoment.enemyHalf ? 'danger' : 'default'
                          }
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
                  {insightsData.keyMoments.map((moment, index) => {
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
                        className={`w-full text-left p-3 rounded-lg border transition-colors ${
                          isSelected
                            ? 'bg-neutral-800/70 border-accent-yellow-400/50'
                            : 'bg-neutral-800/40 border-neutral-700/50 hover:bg-neutral-800/70'
                        }`}
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
                            {/* Dark overlay for better text readability */}
                            <div className="absolute inset-0 bg-black/30" />
                            {/* VS text */}
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
    </div>
  );
}
