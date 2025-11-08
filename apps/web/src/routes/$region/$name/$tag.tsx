import { http, HttpError } from '@/clients/http';
import { ProcessingLayout } from '@/components/layouts/ProcessingLayout';
import { Navbar } from '@/components/navbar';
import { ProfileHeader } from '@/components/profile-header';
import { ProfileTabs } from '@/components/profile-tabs';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Outlet, createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

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
  head: ({ loaderData }) => {
    const summonerName = loaderData?.summoner?.name ?? loaderData?.name ?? null;
    const tag = loaderData?.tag ?? null;
    const status = loaderData?.initialStatus?.status ?? null;

    const title =
      summonerName && tag
        ? `Riftcoach | ${summonerName}#${tag} Rewind Overview`
        : 'Riftcoach | Player Rewind Overview';

    const descriptionSegments: string[] = [];
    if (summonerName && tag) {
      descriptionSegments.push(
        `Dive into ${summonerName}#${tag}'s League of Legends performance with personalized rewind analytics and champion insights.`,
      );
    } else {
      descriptionSegments.push(
        'Explore personalized League of Legends performance insights, champion trends, and rewind progress with Riftcoach.',
      );
    }

    if (status) {
      descriptionSegments.push(`Current rewind status: ${status}.`);
    }

    const description = descriptionSegments.join(' ');

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
});

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

      setPreviousStatus(status.status);
    }
  }, [status, previousStatus, queryClient, region, name, tag]);

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
      <ProcessingLayout region={region} status={status} wsConnected={false} />
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-neutral-950 via-neutral-900 to-neutral-800 relative">
      <Navbar status={status} wsConnected={false} />
      <div className="container mx-auto px-6 py-12 max-w-7xl">
        <div className="space-y-8">
          <ProfileHeader
            summoner={summoner as SummonerSummary}
            region={region}
            name={name}
            tag={tag}
            badges={badgesData?.badges}
            isBadgesLoading={isBadgesLoading}
            isBadgesFetching={isBadgesFetching}
            isIdle={isIdle}
          />
          <ProfileTabs region={region} name={name} tag={tag} />
          <Outlet />
        </div>
      </div>
    </div>
  );
}
