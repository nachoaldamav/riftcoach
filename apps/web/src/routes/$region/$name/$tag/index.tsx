import { http, HttpError } from '@/clients/http';
import { ProcessingLayout } from '@/components/layouts/ProcessingLayout';
import { ProfileLayout } from '@/components/layouts/ProfileLayout';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
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

export interface HeatmapData {
  xBin: number;
  yBin: number;
  count: number;
  grid: number;
}

export const Route = createFileRoute('/$region/$name/$tag/')({
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

  const queryClient = useQueryClient();

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

  // Track previous status to detect completion
  const [previousStatus, setPreviousStatus] = useState<string | null>(null);
  const [showScanBox, setShowScanBox] = useState(false);

  // Handle status changes and query revalidation
  useEffect(() => {
    if (status) {
      if (
        previousStatus &&
        (previousStatus === 'processing' || previousStatus === 'listing') &&
        status.status === 'completed'
      ) {
        queryClient.invalidateQueries({
          queryKey: ['v1-badges', region, name, tag],
        });
        queryClient.invalidateQueries({
          queryKey: ['player-overview', region, name, tag],
        });
        queryClient.invalidateQueries({
          queryKey: ['recent-matches', region, name, tag],
        });
        queryClient.invalidateQueries({
          queryKey: ['champion-insights', region, name, tag],
        });
        queryClient.invalidateQueries({
          queryKey: ['champion-mastery', region, name, tag],
        });
        queryClient.invalidateQueries({
          queryKey: ['v1-heatmap', region, name, tag],
        });
        queryClient.invalidateQueries({
          queryKey: ['v1-champions-stats', region, name, tag],
        });
      }

      if (
        summoner &&
        (status.status === 'processing' || status.status === 'listing')
      ) {
        setShowScanBox(true);
      } else {
        setShowScanBox(false);
      }

      setPreviousStatus(status.status);
    }
  }, [status, previousStatus, queryClient, region, name, tag, summoner]);

  // Fetch v1 badges when not actively listing/processing (i.e., completed/idle)
  interface AIBadgeItem {
    title: string;
    description: string;
    reason: string;
    polarity?: 'good' | 'bad' | 'neutral';
  }
  interface AIBadgesResponse {
    badges: AIBadgeItem[];
  }
  const isIdle =
    !!status && status.status !== 'processing' && status.status !== 'listing';
  const {
    data: badgesData,
    isLoading: isBadgesLoading,
    isFetching: isBadgesFetching,
  } = useQuery<AIBadgesResponse>({
    queryKey: ['v1-badges', region, name, tag],
    queryFn: async () => {
      const res = await http.get<AIBadgesResponse>(
        `/v1/${encodeURIComponent(region)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}/badges`,
        { timeout: 120000 },
      );
      return res.data;
    },
    enabled: isIdle,
    staleTime: 1000 * 60 * 60 * 12,
    gcTime: 1000 * 60 * 60 * 24,
    retry: 3,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
  });

  // WebSocket connection for live progress
  const [wsConnected, setWsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const [processedMatches, setProcessedMatches] = useState<ProcessedMatch[]>(
    [],
  );

  useEffect(() => {
    const apiBaseUrl = import.meta.env.VITE_API_BASE_URL;
    if (!apiBaseUrl || !status?.rewindId) return;

    const wsUrl = apiBaseUrl
      .replace(/^http:/, 'ws:')
      .replace(/^https:/, 'wss:')
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
          setProcessedMatches((prev) => {
            const exists = prev.find((m) => m.matchId === message.matchId);
            if (exists) return prev;
            return [
              {
                matchId: message.matchId,
                playerChampionId: message.player.championId,
                opponentChampionId: message.opponent.championId,
                kills: message.player.kills,
                deaths: message.player.deaths,
                assists: message.player.assists,
                won: message.player.win,
                timestamp: Date.now(),
              },
              ...prev.slice(0, 9),
            ];
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

  // Early returns for error/loading/no status
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

  // Single return with conditional layouts
  const isProcessing =
    status.status === 'processing' || status.status === 'listing';

  if (isProcessing && !summoner) {
    return (
      <ProcessingLayout
        region={region}
        status={status}
        wsConnected={wsConnected}
      />
    );
  }

  return (
    <ProfileLayout
      summoner={summoner as SummonerSummary}
      region={region}
      name={name}
      tag={tag}
      badges={badgesData?.badges}
      isBadgesLoading={isBadgesLoading}
      isBadgesFetching={isBadgesFetching}
      isIdle={isIdle}
      showScanBox={showScanBox}
      status={status}
      wsConnected={wsConnected}
      onClose={() => setShowScanBox(false)}
    />
  );
}
