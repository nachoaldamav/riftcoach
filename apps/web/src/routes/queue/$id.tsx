import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { getQueueStatusQueryOptions } from '@/queries/get-queue-status';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { motion } from 'framer-motion';
import { Clock, Search, Trophy, Gamepad2, Target, Zap } from 'lucide-react';
import { useEffect, useState, useRef } from 'react';

export const Route = createFileRoute('/queue/$id')({
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
  const { data: crawlData, isLoading } = useQuery(
    getQueueStatusQueryOptions(id),
  );
  const [elapsedTime, setElapsedTime] = useState(0);
  const [processedMatches, setProcessedMatches] = useState<ProcessedMatch[]>([]);
  const [wsConnected, setWsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  // WebSocket connection
  useEffect(() => {
    const apiBaseUrl = import.meta.env.VITE_API_BASE_URL;
    if (!apiBaseUrl || !id) return;

    // Convert HTTP URL to WebSocket URL
    const wsUrl = apiBaseUrl.replace(/^https?:\/\//, 'ws://').replace(/\/$/, '');
    
    const ws = new WebSocket(`${wsUrl}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket connected');
      setWsConnected(true);
      
      // Subscribe to match processing updates for this job
      ws.send(JSON.stringify({
        type: 'subscribe',
        channel: `rewind:progress:${id}`
      }));
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        
        if (message.type === 'subscription_confirmed') {
          console.log('Subscribed to channel:', message.channel);
        } else if (message.type === 'match_processed') {
          const matchData: ProcessedMatch = {
            matchId: message.data.matchId,
            playerChampionId: message.data.playerChampionId,
            opponentChampionId: message.data.opponentChampionId,
            kills: message.data.kills,
            deaths: message.data.deaths,
            assists: message.data.assists,
            won: message.data.won,
            timestamp: Date.now()
          };
          
          setProcessedMatches(prev => [matchData, ...prev.slice(0, 9)]); // Keep last 10 matches
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
    <div className="min-h-screen bg-background gradient-mesh dark">
      <div className="container mx-auto px-4 py-8">
        <motion.div
          variants={containerVariants}
          initial="hidden"
          animate="visible"
          className="max-w-3xl mx-auto space-y-8"
        >
          {/* Header */}
          <motion.div variants={itemVariants} className="text-center space-y-4">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 border border-primary/20">
              <div className={`w-2 h-2 rounded-full pulse-glow ${wsConnected ? 'bg-green-500' : 'bg-primary'}`} />
              <span className="text-sm font-medium text-primary">
                {wsConnected ? 'Live updates active' : 'Analyzing your matches'}
              </span>
            </div>
            <h1 className="text-4xl md:text-5xl font-bold text-balance">
              League of Legends
              <span className="block text-primary">Rewind</span>
            </h1>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto text-pretty">
              We're gathering all your matches from {crawlData.jobMapping.scope}{' '}
              to create your personalized rewind
            </p>
          </motion.div>

          {/* Main Progress Card */}
          <motion.div variants={itemVariants}>
            <Card className="p-8 bg-card/50 backdrop-blur-sm border-border/50">
              <div className="space-y-6">
                <div className="text-center space-y-2">
                  <h2 className="text-3xl font-bold">
                    {Math.round(progressPercentage)}%
                  </h2>
                  <p className="text-muted-foreground">
                    {crawlData.matchesFetched} of {crawlData.idsFound} matches
                    processed
                  </p>
                </div>

                <div className="space-y-3">
                  <Progress value={progressPercentage} className="h-4" />
                  <div className="flex justify-between text-sm text-muted-foreground">
                    <span>Started {formatTime(elapsedTime)} ago</span>
                    <span className="capitalize">
                      {crawlData.state === 'listing'
                        ? 'Finding matches'
                        : crawlData.state}
                    </span>
                  </div>
                </div>
              </div>
            </Card>
          </motion.div>

          {/* Recently Processed Matches */}
          {processedMatches.length > 0 && (
            <motion.div variants={itemVariants}>
              <Card className="p-6 bg-card/30 backdrop-blur-sm border-border/50">
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    <Zap className="w-5 h-5 text-primary" />
                    <h3 className="text-lg font-semibold">Recently Processed Matches</h3>
                  </div>
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {processedMatches.map((match) => (
                      <div
                        key={match.matchId}
                        className="flex items-center justify-between p-3 rounded-lg bg-background/50 border border-border/30"
                      >
                        <div className="flex items-center gap-3">
                          <div className="flex items-center gap-2">
                            <Gamepad2 className="w-4 h-4 text-muted-foreground" />
                            <span className="text-sm font-mono text-muted-foreground">
                              Champion {match.playerChampionId}
                            </span>
                          </div>
                          <div className="flex items-center gap-1">
                            <Target className="w-4 h-4 text-muted-foreground" />
                            <span className="text-sm text-muted-foreground">
                              vs {match.opponentChampionId}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant={match.won ? "default" : "destructive"}>
                            {match.won ? "Victory" : "Defeat"}
                          </Badge>
                          <span className="text-sm font-mono text-muted-foreground">
                            {match.kills}/{match.deaths}/{match.assists}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </Card>
            </motion.div>
          )}

          <motion.div
            variants={itemVariants}
            className="grid grid-cols-1 md:grid-cols-3 gap-4"
          >
            <Card className="p-6 bg-card/30 backdrop-blur-sm border-border/50">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-primary/20">
                  <Search className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Matches Found</p>
                  <p className="text-2xl font-bold">{crawlData.idsFound}</p>
                </div>
              </div>
            </Card>

            <Card className="p-6 bg-card/30 backdrop-blur-sm border-border/50">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-success/20">
                  <Trophy className="w-5 h-5 text-[color:var(--color-success)]" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Processed</p>
                  <p className="text-2xl font-bold">
                    {crawlData.matchesFetched}
                  </p>
                </div>
              </div>
            </Card>

            <Card className="p-6 bg-card/30 backdrop-blur-sm border-border/50">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-blue/20">
                  <Clock className="w-5 h-5 text-[color:var(--color-blue)]" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Time Elapsed</p>
                  <p className="text-2xl font-bold">
                    {formatTime(elapsedTime)}
                  </p>
                </div>
              </div>
            </Card>
          </motion.div>

          <motion.div variants={itemVariants}>
            <Card className="p-6 bg-card/30 backdrop-blur-sm border-border/50">
              <div className="text-center space-y-2">
                <h3 className="text-lg font-semibold">
                  Analyzing {crawlData.jobMapping.region.toUpperCase()} Region
                </h3>
                <p className="text-sm text-muted-foreground">
                  Searching through both Ranked Solo/Duo and Flex queues for the
                  complete picture
                </p>
              </div>
            </Card>
          </motion.div>

          {/* Footer */}
          <motion.div
            variants={itemVariants}
            className="text-center text-muted-foreground"
          >
            <p className="text-sm">
              Hang tight! Your personalized League of Legends rewind will be
              ready soon.
            </p>
          </motion.div>
        </motion.div>
      </div>
    </div>
  );
}
