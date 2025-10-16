import { http, HttpError } from '@/clients/http';
import { ChampionImage } from '@/components/champion-image';
import { useDataDragon } from '@/providers/data-dragon-provider';
import { Card, CardBody, Chip, Progress, Tooltip } from '@heroui/react';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { motion } from 'framer-motion';
import { Loader2, Swords } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export interface RewindStatusResponse {
  rewindId: string;
  matches: number;
  listing: number;
  total: number;
  processed: number;
  status: string; // 'listing' | 'processing' | 'completed'
  position: number | null;
}

export interface SummonerSummary {
  id: string; // internal id
  name: string;
  profileIconId: number;
  summonerLevel: number;
}

export const Route = createFileRoute('/$region/$name/$tag')({
  component: RouteComponent,
  loader: async ({ params }) => {
    const { region, name, tag } = params;
    try {
      const [statusRes, summonerRes] = await Promise.all([
        http.get<RewindStatusResponse>(
          `/v1/${encodeURIComponent(region)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}/rewind`,
        ),
        http.get<SummonerSummary>(
          `/v1/${encodeURIComponent(region)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`,
        ),
      ]);

      return {
        region,
        name,
        tag,
        initialStatus: statusRes.data,
        summoner: summonerRes.data,
      };
    } catch (err) {
      const message =
        err instanceof HttpError ? err.message : 'Failed to load status';
      return {
        region,
        name,
        tag,
        initialStatus: null as RewindStatusResponse | null,
        summoner: null as SummonerSummary | null,
        error: message,
      };
    }
  },
});

interface ProcessedMatch {
  matchId: string;
  playerChampionId: number;
  opponentChampionId: number;
  kills: number;
  deaths: number;
  assists: number;
  won: boolean;
  timestamp: number;
}

function RouteComponent() {
  const { region, name, tag, initialStatus, summoner, error } =
    Route.useLoaderData() as {
      region: string;
      name: string;
      tag: string;
      initialStatus: RewindStatusResponse | null;
      summoner: SummonerSummary | null;
      error?: string;
    };

  const { getProfileIconUrl } = useDataDragon();

  const { data: status, isLoading } = useQuery({
    queryKey: ['v1-rewind-status', region, name, tag],
    queryFn: async () => {
      const res = await http.get<RewindStatusResponse>(
        `/v1/${encodeURIComponent(region)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}/rewind`,
      );
      return res.data;
    },
    initialData: initialStatus ?? undefined,
    refetchInterval: 1000,
    refetchIntervalInBackground: true,
  });

  // Fetch v1 badges when not actively listing/processing (i.e., completed/idle)
  interface AIBadgeItem {
    title: string;
    description: string;
    reason: string;
  }
  interface AIBadgesResponse {
    badges: AIBadgeItem[];
  }
  const isIdle =
    !!status && status.status !== 'processing' && status.status !== 'listing';
  const { data: badgesData } = useQuery<AIBadgesResponse>({
    queryKey: ['v1-badges', region, name, tag],
    queryFn: async () => {
      const res = await http.get<AIBadgesResponse>(
        `/v1/${encodeURIComponent(region)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}/badges`,
        {
          timeout: 120000, // 2 minutes for AI processing
        },
      );
      return res.data;
    },
    enabled: isIdle,
    staleTime: 1000 * 60 * 60 * 12, // 12h
    gcTime: 1000 * 60 * 60 * 24, // 24h
    retry: 3, // Increased retries for AI requests
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000), // Increased max delay to 30s
  });

  const [processedMatches, setProcessedMatches] = useState<ProcessedMatch[]>(
    [],
  );
  const [wsConnected, setWsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const apiBaseUrl = import.meta.env.VITE_API_BASE_URL;
    if (!apiBaseUrl || !status?.rewindId) return;

    const wsUrl = apiBaseUrl
      .replace(/^https?:\/\//, 'ws://')
      .replace(/\/$/, '');
    const ws = new WebSocket(`${wsUrl}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsConnected(true);
      ws.send(
        JSON.stringify({
          type: 'subscribe',
          channel: `rewind:progress:${status.rewindId}`,
        }),
      );
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as
          | {
              type: 'match_processed';
              jobId: string;
              matchId: string;
              player: {
                championId: number;
                kills: number;
                deaths: number;
                assists: number;
                win: boolean;
              };
              opponent: { championId: number };
            }
          | { type: 'subscription_confirmed'; channel: string };

        if (message.type === 'match_processed') {
          const matchData: ProcessedMatch = {
            matchId: message.matchId,
            playerChampionId: message.player.championId,
            opponentChampionId: message.opponent.championId,
            kills: message.player.kills,
            deaths: message.player.deaths,
            assists: message.player.assists,
            won: message.player.win,
            timestamp: Date.now(),
          };

          setProcessedMatches((prev) => {
            const existing = prev.find((m) => m.matchId === message.matchId);
            if (existing) return prev;
            return [matchData, ...prev.slice(0, 9)];
          });
        }
      } catch (error) {
        console.error('Error parsing WebSocket message:', error);
      }
    };

    ws.onclose = () => setWsConnected(false);
    ws.onerror = () => setWsConnected(false);

    return () => {
      if (ws.readyState === WebSocket.OPEN) ws.close();
    };
  }, [status?.rewindId]);

  if (error) {
    return (
      <div className="min-h-screen bg-background gradient-mesh dark">
        <h1 className="text-red-500">{error}</h1>
      </div>
    );
  }

  if (isLoading && !status) {
    return (
      <div className="min-h-screen bg-background gradient-mesh dark">
        <h1>Loading</h1>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="min-h-screen bg-background gradient-mesh dark">
        <h1>No status data found</h1>
      </div>
    );
  }

  if (status.status === 'completed' && summoner) {
    const iconUrl = getProfileIconUrl(summoner.profileIconId);
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 dark relative">
        <div className="container mx-auto px-4 py-8">
          <div className="max-w-3xl mx-auto space-y-8">
            <div className="flex items-center gap-4">
              <img
                src={iconUrl}
                alt={summoner.name}
                className="w-16 h-16 rounded-full border border-slate-600"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-start gap-3 flex-wrap flex-col">
                  <h1 className="text-2xl font-bold text-white truncate">
                    {name}
                    <span className="text-slate-400">#{tag}</span>
                  </h1>
                  <div className="flex items-center gap-2">
                    <span className="text-slate-300">
                      Level {summoner.summonerLevel}
                    </span>
                    {badgesData?.badges?.length ? (
                      <div className="flex flex-wrap gap-2">
                        {badgesData.badges.map((b, idx) => (
                          <Tooltip
                            key={`${b.title}-hdr-${idx}`}
                            content={
                              <div className="max-w-xs text-left">
                                <p className="text-sm font-semibold text-white mb-1">
                                  {b.title}
                                </p>
                                <p className="text-xs text-slate-300">
                                  {b.reason}
                                </p>
                              </div>
                            }
                            placement="top"
                            className="bg-slate-800 text-slate-200 border border-slate-700"
                          >
                            <Chip
                              variant="bordered"
                              color="primary"
                              className="text-cyan-300 text-xs cursor-default"
                            >
                              {b.title.replace('The ', '')}
                            </Chip>
                          </Tooltip>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
            {/* Future profile sections will be added here */}
            <Card className="bg-slate-800/90 backdrop-blur-sm border-slate-700 shadow-xl">
              <CardBody className="p-8">
                <p className="text-slate-300">Profile content coming soon…</p>
              </CardBody>
            </Card>

            {/* Removed standalone Playstyle Badges card in favor of header chips */}
          </div>
        </div>
      </div>
    );
  }

  const progressPercentage =
    status.total > 0
      ? Math.min((status.processed / status.total) * 100, 100)
      : 0;

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: { staggerChildren: 0.1, delayChildren: 0.2 },
    },
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.6, ease: 'easeOut' as const },
    },
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 dark relative">
      <div
        className="absolute inset-0 opacity-20"
        style={{
          backgroundImage:
            'radial-gradient(circle, rgba(148, 163, 184, 0.3) 1px, transparent 1px)',
          backgroundSize: '20px 20px',
        }}
      />
      <div className="container mx-auto px-4 py-8">
        <motion.div
          variants={containerVariants}
          initial="hidden"
          animate="visible"
          className="max-w-3xl mx-auto space-y-8"
        >
          <motion.div variants={itemVariants} className="text-center space-y-4">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-cyan-500/20 border border-cyan-400/30">
              <div
                className={`w-2 h-2 rounded-full pulse-glow ${wsConnected ? 'bg-green-400' : 'bg-cyan-400'}`}
              />
              <span className="text-sm font-medium text-cyan-300">
                {wsConnected ? 'Live updates active' : 'Analyzing your matches'}
              </span>
            </div>
            <h1 className="text-4xl md:text-5xl font-bold text-balance text-white">
              League of Legends
              <span className="block text-cyan-400">Rewind</span>
            </h1>
            <p className="text-lg text-slate-300 max-w-2xl mx-auto text-pretty">
              We're gathering all your matches from {region.toUpperCase()} to
              create your personalized rewind
            </p>
          </motion.div>

          <motion.div variants={itemVariants}>
            <Card className="bg-slate-800/90 backdrop-blur-sm border-slate-700 shadow-xl">
              <CardBody className="p-8">
                <div className="space-y-6">
                  <div className="text-center space-y-2">
                    <h2 className="text-3xl font-bold text-white">
                      {Math.round(progressPercentage)}%
                    </h2>
                    <p className="text-slate-300">
                      {status.processed} of {status.total} matches processed
                    </p>
                  </div>

                  <div className="space-y-3">
                    <Progress
                      value={progressPercentage}
                      className="h-4"
                      color="primary"
                      size="lg"
                      aria-label="Progress bar"
                    />
                    <div className="flex justify-between text-sm text-slate-300">
                      <span>Listing: {status.listing ? 'Yes' : 'No'}</span>
                      <span className="capitalize">{status.status}</span>
                    </div>
                  </div>
                </div>
              </CardBody>
            </Card>
          </motion.div>

          <motion.div variants={itemVariants}>
            <Card className="bg-slate-700/80 backdrop-blur-sm border-slate-600 shadow-xl">
              <CardBody className="p-6">
                <div className="grid grid-cols-3 gap-6">
                  <div className="text-center">
                    <div className="text-2xl font-bold text-cyan-400 mb-1">
                      {status.total}
                    </div>
                    <div className="text-sm text-slate-300">Matches Found</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-cyan-400 mb-1">
                      {status.processed}
                    </div>
                    <div className="text-sm text-slate-300">Processed</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-cyan-400 mb-1">
                      {status.position ?? '-'}
                    </div>
                    <div className="text-sm text-slate-300">Queue Position</div>
                  </div>
                </div>
              </CardBody>
            </Card>
          </motion.div>

          <motion.div variants={itemVariants}>
            <Card className="bg-slate-600/70 backdrop-blur-sm border-slate-500 shadow-xl">
              <CardBody className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-lg font-semibold text-white mb-2">
                      Analyzing {region.toUpperCase()} Region
                    </h3>
                    <p className="text-sm text-slate-300">
                      Searching through Ranked queues for the complete picture
                    </p>
                  </div>
                  <div className="animate-spin">
                    <Loader2 className="w-8 h-8 text-cyan-400" />
                  </div>
                </div>
              </CardBody>
            </Card>
          </motion.div>

          <motion.div
            variants={itemVariants}
            className="text-center text-muted-foreground"
          >
            <p className="text-sm text-slate-300">
              Hang tight! Your personalized League of Legends rewind will be
              ready soon.
            </p>
          </motion.div>
        </motion.div>
      </div>

      {processedMatches.length > 0 && (
        <div className="fixed bottom-10 right-10 z-50">
          <div className="relative w-80">
            {processedMatches.slice(0, 6).map((match, index) => {
              const opacity = Math.max(1 - index * 0.25, 0.1);
              const yOffset = index * 8;
              const gradientClass = match.won
                ? 'bg-gradient-to-r from-slate-800/95 to-emerald-900/40'
                : 'bg-gradient-to-r from-slate-800/95 to-red-900/40';

              return (
                <motion.div
                  key={match.matchId}
                  initial={{ opacity: opacity, scale: 1, x: 100 }}
                  animate={{ opacity: opacity, scale: 1, x: 0, y: yOffset }}
                  exit={{ opacity: 0, scale: 1, x: 100 }}
                  transition={{
                    duration: 0.6,
                    delay: index * 0.1,
                    ease: 'easeOut',
                  }}
                  className="absolute bottom-0 right-0 w-full"
                  style={{ zIndex: 10 - index }}
                >
                  <Card
                    isPressable
                    className={`relative overflow-hidden border border-slate-600/50 shadow-lg hover:-translate-y-0.5 hover:shadow-xl transition-all duration-200 ease-out rounded-medium ${gradientClass} backdrop-blur-sm`}
                  >
                    <CardBody className="relative z-10 p-4">
                      <div className="flex items-center gap-4">
                        <div className="flex items-center gap-3 min-w-0">
                          <ChampionImage
                            championId={match.playerChampionId}
                            size="md"
                            showName={false}
                            className="shrink-0"
                          />
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 text-small">
                              <span className="font-medium text-slate-300">
                                K/D/A
                              </span>
                              <span className="text-slate-200">
                                <b className="text-white">{match.kills}</b>
                                <span className="mx-1 text-slate-400">/</span>
                                <b className="text-red-400">{match.deaths}</b>
                                <span className="mx-1 text-slate-400">/</span>
                                <b className="text-white">{match.assists}</b>
                              </span>
                            </div>
                          </div>
                        </div>
                        <div className="mx-2 flex h-12 w-12 shrink-0 items-center justify-center rounded-medium bg-slate-700/80 text-slate-300 border border-slate-600/50">
                          <Swords className="w-5 h-5" />
                          <span className="sr-only">versus</span>
                        </div>
                        <div className="ml-auto flex items-center gap-2">
                          <ChampionImage
                            championId={match.opponentChampionId}
                            size="md"
                            showName={false}
                            className="shrink-0"
                          />
                        </div>
                      </div>
                    </CardBody>
                  </Card>
                </motion.div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
