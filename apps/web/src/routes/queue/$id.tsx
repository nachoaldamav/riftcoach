import { http, HttpError } from '@/clients/http';
import { ChampionImage } from '@/components/champion-image';
import {
  type QueueStatus,
  getQueueStatusQueryOptions,
} from '@/queries/get-queue-status';
import { Card, CardBody } from '@heroui/react';
import { Progress } from '@heroui/react';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { motion } from 'framer-motion';
import { Loader2, Swords } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export const Route = createFileRoute('/queue/$id')({
  loader: async ({ params }) => {
    const { id } = params;

    if (!id) {
      throw new Error('Queue ID is required');
    }

    try {
      const response = await http.get<QueueStatus>(
        `/rewind/${encodeURIComponent(id)}/status`,
      );

      return {
        id,
        initialStatus: response.data,
      };
    } catch (error) {
      const message =
        error instanceof HttpError
          ? error.message
          : 'Unable to load queue status.';

      return {
        id,
        initialStatus: null as QueueStatus | null,
        error: message,
      };
    }
  },
  head: ({ loaderData }) => {
    const status = loaderData?.initialStatus ?? null;
    const scope = status?.jobMapping?.scope;

    const title = scope
      ? `Riftcoach | Preparing your ${scope} rewind`
      : 'Riftcoach | Rewind preparation in progress';
    const description = scope
      ? `Track the progress of your personalized League of Legends rewind for ${scope} with live updates from Riftcoach.`
      : 'Monitor the progress of your personalized League of Legends rewind with live updates from Riftcoach.';

    return {
      meta: [
        {
          title,
        },
        {
          name: 'description',
          content: description,
        },
        {
          property: 'og:title',
          content: title,
        },
        {
          property: 'og:description',
          content: description,
        },
      ],
    };
  },
  component: RouteComponent,
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
  const { id } = Route.useParams();
  const { initialStatus } = Route.useLoaderData() as {
    id: string;
    initialStatus: QueueStatus | null;
    error?: string;
  };
  const navigate = useNavigate();
  const queueStatusQueryOptions = getQueueStatusQueryOptions(id);
  const { data: crawlData, isLoading } = useQuery({
    ...queueStatusQueryOptions,
    initialData: initialStatus ?? undefined,
  });
  const [elapsedTime, setElapsedTime] = useState(0);
  const [processedMatches, setProcessedMatches] = useState<ProcessedMatch[]>(
    [],
  );
  const [wsConnected, setWsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  // Navigate to rewind page when status is ready
  useEffect(() => {
    if (crawlData?.state === 'ready') {
      navigate({ to: '/rewind/$id', params: { id } });
    }
  }, [crawlData?.state, navigate, id]);

  // WebSocket connection
  useEffect(() => {
    const apiBaseUrl = import.meta.env.VITE_API_BASE_URL;
    if (!apiBaseUrl || !id) return;

    // Convert HTTP URL to WebSocket URL
    const wsUrl = apiBaseUrl
      .replace(/^https?:\/\//, 'ws://')
      .replace(/\/$/, '');

    const ws = new WebSocket(`${wsUrl}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket connected');
      setWsConnected(true);

      // Subscribe to match processing updates for this job
      ws.send(
        JSON.stringify({
          type: 'subscribe',
          channel: `rewind:progress:${id}`,
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
              opponent: {
                championId: number;
              };
            }
          | {
              type: 'subscription_confirmed';
              channel: string;
            };

        console.log('Received message:', message);

        if (message.type === 'subscription_confirmed') {
          console.log('Subscribed to channel:', message.channel);
        } else if (message.type === 'match_processed') {
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
            // Check if this match already exists to prevent duplicates
            const existingMatch = prev.find(
              (match) => match.matchId === message.matchId,
            );
            if (existingMatch) {
              return prev; // Don't add duplicate
            }

            // Add new match and keep last 10 matches
            return [matchData, ...prev.slice(0, 9)];
          });
        }
      } catch (error) {
        console.error('Error parsing WebSocket message:', error);
      }
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      setWsConnected(false);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      setWsConnected(false);
    };

    return () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    };
  }, [id]);

  useEffect(() => {
    if (!crawlData?.startedAt || isLoading) return;
    const interval = setInterval(() => {
      const now = Date.now();
      const elapsed = Math.floor((now - crawlData.startedAt) / 1000);
      setElapsedTime(elapsed);
    }, 1000);

    return () => clearInterval(interval);
  }, [crawlData?.startedAt, isLoading]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const progressPercentage = Math.min(
    ((crawlData?.matchesFetched || 0) / (crawlData?.idsFound || 1)) * 100,
    100,
  );

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.1,
        delayChildren: 0.2,
      },
    },
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: {
      opacity: 1,
      y: 0,
      transition: {
        duration: 0.6,
        ease: 'easeOut' as const,
      },
    },
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background gradient-mesh dark">
        <h1>Loading</h1>
      </div>
    );
  }

  if (!crawlData) {
    return (
      <div className="min-h-screen bg-background gradient-mesh dark">
        <h1>No data found</h1>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 dark relative">
      {/* Subtle dotted background pattern */}
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
          {/* Header */}
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
              We're gathering all your matches from {crawlData.jobMapping.scope}{' '}
              to create your personalized rewind
            </p>
          </motion.div>

          {/* Main Progress Card */}
          <motion.div variants={itemVariants}>
            <Card className="bg-slate-800/90 backdrop-blur-sm border-slate-700 shadow-xl">
              <CardBody className="p-8">
                <div className="space-y-6">
                  <div className="text-center space-y-2">
                    <h2 className="text-3xl font-bold text-white">
                      {Math.round(progressPercentage)}%
                    </h2>
                    <p className="text-slate-300">
                      {crawlData.matchesFetched} of {crawlData.idsFound} matches
                      processed
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
                      <span>Started {formatTime(elapsedTime)} ago</span>
                      <span className="capitalize">
                        {crawlData.state === 'listing'
                          ? 'Finding matches'
                          : crawlData.state}
                      </span>
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
                      {crawlData.idsFound}
                    </div>
                    <div className="text-sm text-slate-300">Matches Found</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-cyan-400 mb-1">
                      {crawlData.matchesFetched}
                    </div>
                    <div className="text-sm text-slate-300">Processed</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-cyan-400 mb-1">
                      {formatTime(elapsedTime)}
                    </div>
                    <div className="text-sm text-slate-300">Time Elapsed</div>
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
                      Analyzing EUROPE Region
                    </h3>
                    <p className="text-sm text-slate-300">
                      Searching through North Ranked Solo/Duo and Flex queues
                      for the complete picture
                    </p>
                  </div>
                  <div className="animate-spin">
                    <Loader2 className="w-8 h-8 text-cyan-400" />
                  </div>
                </div>
              </CardBody>
            </Card>
          </motion.div>

          {/* Footer */}
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

      {/* Toast-style Animated Matches - Fixed position bottom right */}
      {processedMatches.length > 0 && (
        <div className="fixed bottom-10 right-10 z-50">
          <div className="relative w-80">
            {processedMatches.slice(0, 6).map((match, index) => {
              const opacity = Math.max(1 - index * 0.25, 0.1);
              const yOffset = index * 8; // Increased vertical stacking offset

              // Better contrast background gradients
              const gradientClass = match.won
                ? 'bg-gradient-to-r from-slate-800/95 to-emerald-900/40'
                : 'bg-gradient-to-r from-slate-800/95 to-red-900/40';

              return (
                <motion.div
                  key={match.matchId}
                  initial={{ opacity: opacity, scale: 1, x: 100 }}
                  animate={{
                    opacity: opacity,
                    scale: 1,
                    x: 0,
                    y: yOffset,
                  }}
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
                    {/* Content */}
                    <CardBody className="relative z-10 p-4">
                      <div className="flex items-center gap-4">
                        {/* Player Avatar */}
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

                        {/* VS icon */}
                        <div className="mx-2 flex h-12 w-12 shrink-0 items-center justify-center rounded-medium bg-slate-700/80 text-slate-300 border border-slate-600/50">
                          <Swords className="w-5 h-5" />
                          <span className="sr-only">versus</span>
                        </div>

                        {/* Opponent Avatar */}
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
