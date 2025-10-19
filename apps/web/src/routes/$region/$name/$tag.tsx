import { http, HttpError } from '@/clients/http';
import { BentoGrid, BentoItem } from '@/components/bento/BentoGrid';
import { ChampionInsightsCard } from '@/components/bento/ChampionInsightsCard';
import { ChampionMasteryCard } from '@/components/bento/ChampionMasteryCard';
import { OverviewCard } from '@/components/bento/OverviewCard';
import { RecentMatchesCard } from '@/components/bento/RecentMatchesCard';
import { ChampionImage } from '@/components/champion-image';
import { HeatmapOverlay } from '@/components/heatmap-overlay';
import { HeatmapIcon } from '@/components/icons/CustomIcons';
import { Navbar } from '@/components/navbar';
import { useDataDragon } from '@/providers/data-dragon-provider';
import {
  Card,
  CardBody,
  Chip,
  Progress,
  Select,
  SelectItem,
  Tooltip,
} from '@heroui/react';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { motion } from 'framer-motion';
import { Loader2, Swords } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

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

function HeatmapCard() {
  const { region, name, tag } = Route.useParams();
  const { champions } = useDataDragon();

  // Static role and mode lists
  const roles = [
    { key: 'TOP', label: 'Top', icon: '⚔️' },
    { key: 'JUNGLE', label: 'Jungle', icon: '🌲' },
    { key: 'MIDDLE', label: 'Middle', icon: '🏰' },
    { key: 'BOTTOM', label: 'Bottom', icon: '🏹' },
    { key: 'UTILITY', label: 'Support', icon: '🛡️' },
  ];

  const modes = [
    { key: 'kills', label: 'Kills', icon: '⚔️', color: 'success' },
    { key: 'deaths', label: 'Deaths', icon: '💀', color: 'danger' },
  ];

  const [selectedRole, setSelectedRole] = useState('BOTTOM');
  const [selectedChampion, setSelectedChampion] = useState<number | null>(null);
  const [selectedMode, setSelectedMode] = useState<'kills' | 'deaths'>('kills');
  const [hasUserSelectedRole, setHasUserSelectedRole] = useState(false);

  // Champion list from Data Dragon, sorted by name
  const championList = useMemo(
    () =>
      champions
        ? Object.values(champions).sort((a, b) => a.name.localeCompare(b.name))
        : [],
    [champions],
  );

  const { data: heatmapData, isLoading: isHeatmapLoading } = useQuery<
    HeatmapData[]
  >({
    queryKey: [
      'v1-heatmap',
      region,
      name,
      tag,
      selectedRole,
      selectedChampion,
      selectedMode,
    ],
    queryFn: async () => {
      const params: Record<string, string | number | boolean> = {
        role: selectedRole,
        mode: selectedMode,
      };
      if (selectedChampion !== null) {
        params.championId = selectedChampion;
      }
      const res = await http.get<HeatmapData[]>(
        `/v1/${encodeURIComponent(region)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}/heatmap`,
        {
          params,
        },
      );
      return res.data;
    },
    enabled: !!selectedRole,
  });

  // Fetch champions stats for counts per role/champion
  interface RoleChampStats {
    _id: string; // role key, e.g., 'MIDDLE'
    champs: Array<{
      championId: number;
      championName: string;
      games: number;
      wins: number;
      losses: number;
      winRate: number;
    }>;
  }

  const { data: champsStats } = useQuery<RoleChampStats[]>({
    queryKey: ['v1-champions-stats', region, name, tag],
    queryFn: async () => {
      const res = await http.get<RoleChampStats[]>(
        `/v1/${encodeURIComponent(region)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}/champions`,
      );
      return res.data;
    },
    staleTime: 1000 * 60 * 60 * 12,
    gcTime: 1000 * 60 * 60 * 24,
    retry: 2,
  });

  // Compute total games per role
  const roleGames = useMemo(() => {
    const map: Record<string, number> = {};
    for (const group of champsStats || []) {
      let total = 0;
      for (const c of group.champs) {
        total += c.games || 0;
      }
      map[group._id] = total;
    }
    return map;
  }, [champsStats]);

  // Disable roles with zero games
  const disabledRoleKeys = useMemo(() => {
    if (!champsStats) return [];
    return roles.filter((r) => (roleGames[r.key] || 0) === 0).map((r) => r.key);
  }, [champsStats, roleGames]);

  // Calculate the most played role based on roleGames
  const mostPlayedRole = useMemo(() => {
    if (!roleGames || Object.keys(roleGames).length === 0) return 'BOTTOM';
    return Object.entries(roleGames).reduce(
      (max, [role, games]) => (games > (roleGames[max] || 0) ? role : max),
      'BOTTOM',
    );
  }, [roleGames]);

  // Update selected role when most played role changes (only if user hasn't manually selected a role)
  useEffect(() => {
    if (
      !hasUserSelectedRole &&
      mostPlayedRole !== 'BOTTOM' &&
      !disabledRoleKeys.includes(mostPlayedRole)
    ) {
      setSelectedRole(mostPlayedRole);
    }
  }, [mostPlayedRole, hasUserSelectedRole, disabledRoleKeys]);

  // Champion games for currently selected role
  const championGamesBySelectedRole = useMemo(() => {
    const map: Record<number, number> = {};
    const entry = (champsStats || []).find((g) => g._id === selectedRole);
    if (entry) {
      for (const c of entry.champs) {
        map[c.championId] = c.games || 0;
      }
    }
    return map;
  }, [champsStats, selectedRole]);

  // Only show champions with games > 0 for the selected role (show all until stats loaded)
  const visibleChampions = useMemo(() => {
    const hasCounts = Object.keys(championGamesBySelectedRole).length > 0;
    if (!hasCounts) return championList;
    return championList.filter(
      (c) => (championGamesBySelectedRole[Number(c.key)] || 0) > 0,
    );
  }, [championList, championGamesBySelectedRole]);

  // If current role becomes disabled, pick the first available role with games
  useEffect(() => {
    if (disabledRoleKeys.includes(selectedRole)) {
      const fallback = roles.find((r) => !disabledRoleKeys.includes(r.key));
      if (fallback && fallback.key !== selectedRole) {
        setSelectedRole(fallback.key);
        setHasUserSelectedRole(true); // Mark as user selected since we're forcing a change
      }
    }
  }, [disabledRoleKeys, selectedRole]);

  // If selected champion has zero games for current role, reset it
  useEffect(() => {
    if (
      selectedChampion !== null &&
      (championGamesBySelectedRole[Number(selectedChampion)] || 0) === 0
    ) {
      setSelectedChampion(null);
    }
  }, [selectedChampion, championGamesBySelectedRole]);

  // Role icon from Community Dragon (neutral icon)
  const getRoleIconUrl = (roleKey: string) =>
    `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-clash/global/default/assets/images/position-selector/positions/icon-position-${roleKey.toLowerCase()}.png`;

  const selectedChampionData = useMemo(() => {
    if (!selectedChampion) return null;
    return championList.find((c) => c.key === String(selectedChampion)) ?? null;
  }, [selectedChampion, championList]);

  return (
    <Card className="h-full bg-neutral-900/90 backdrop-blur-sm border border-neutral-700/60 shadow-soft-lg hover:shadow-soft-xl transition-all duration-200">
      <CardBody className="p-8 space-y-6">
        <div className="flex items-center gap-4">
          <div className="p-3 bg-gradient-to-br from-accent-purple-900/30 to-accent-blue-900/30 rounded-xl">
            <HeatmapIcon className="w-6 h-6 text-accent-purple-400" />
          </div>
          <div>
            <h3 className="text-xl font-display font-bold text-neutral-50">
              Heatmap Analysis
            </h3>
            <p className="text-sm text-neutral-400">
              Positional gameplay patterns
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Select
            size="sm"
            variant="bordered"
            label="Role"
            selectedKeys={[selectedRole]}
            disabledKeys={disabledRoleKeys}
            className="bg-neutral-800/50"
            classNames={{
              trigger: 'border-neutral-700 hover:border-accent-blue-600',
              value: 'text-neutral-100 font-medium',
            }}
            renderValue={() => {
              const role = roles.find((r) => r.key === selectedRole);
              if (!role) return null;
              const games = roleGames[role.key] || 0;
              return (
                <div className="flex items-center justify-between w-full">
                  <div className="flex items-center gap-2">
                    <img
                      src={getRoleIconUrl(role.key)}
                      alt={role.label}
                      className="w-5 h-5"
                    />
                    <span>{role.label}</span>
                  </div>
                  <span className="text-xs text-slate-300">{games}</span>
                </div>
              );
            }}
            onSelectionChange={(keys) => {
              const selected = Array.from(keys)[0] as string;
              // Prevent selecting disabled roles
              if (!disabledRoleKeys.includes(selected)) {
                setSelectedRole(selected);
                setHasUserSelectedRole(true);
              }
            }}
          >
            {roles.map((role) => (
              <SelectItem
                key={role.key}
                textValue={role.label}
                startContent={
                  <img
                    src={getRoleIconUrl(role.key)}
                    alt={role.label}
                    className="w-5 h-5"
                  />
                }
              >
                <div className="flex items-center justify-between w-full">
                  <span>{role.label}</span>
                  <span className="text-xs text-slate-300">
                    {roleGames[role.key] || 0}
                  </span>
                </div>
              </SelectItem>
            ))}
          </Select>
          <Select
            size="sm"
            variant="bordered"
            label="Champion"
            selectedKeys={selectedChampion ? [String(selectedChampion)] : []}
            className="bg-neutral-800/50"
            classNames={{
              trigger:
                'border-neutral-700 hover:border-accent-blue-600 bg-neutral-800/50',
              value: 'text-neutral-100 font-medium',
            }}
            renderValue={() => {
              if (!selectedChampionData) return null;
              const games = selectedChampion
                ? championGamesBySelectedRole[Number(selectedChampion)] || 0
                : 0;
              return (
                <div className="flex items-center justify-between w-full">
                  <div className="flex items-center gap-2">
                    <ChampionImage
                      championId={selectedChampionData.id}
                      size="sm"
                      showName={false}
                    />
                    <span>{selectedChampionData.name}</span>
                  </div>
                  <span className="text-xs text-slate-300">{games}</span>
                </div>
              );
            }}
            onSelectionChange={(keys) => {
              const selected = Array.from(keys)[0] as string | undefined;
              setSelectedChampion(selected ? Number(selected) : null);
            }}
          >
            {visibleChampions.map((champion) => (
              <SelectItem
                key={champion.key}
                textValue={champion.name}
                startContent={
                  <ChampionImage
                    championId={champion.id}
                    size="sm"
                    showName={false}
                  />
                }
              >
                <div className="flex items-center justify-between w-full">
                  <span>{champion.name}</span>
                  <span className="text-xs text-slate-300">
                    {championGamesBySelectedRole[Number(champion.key)] || 0}
                  </span>
                </div>
              </SelectItem>
            ))}
          </Select>
          <Select
            size="sm"
            variant="bordered"
            label="Mode"
            selectedKeys={[selectedMode]}
            className="bg-neutral-800/50"
            classNames={{
              trigger: 'border-neutral-700 hover:border-accent-blue-600',
              value: 'text-neutral-100 font-medium',
            }}
            onSelectionChange={(keys) => {
              const selected = Array.from(keys)[0] as 'kills' | 'deaths';
              setSelectedMode(selected);
            }}
          >
            {modes.map((mode) => (
              <SelectItem key={mode.key} textValue={mode.label}>
                <div className="flex items-center gap-3">
                  <span className="text-lg">{mode.icon}</span>
                  <span className="font-medium">{mode.label}</span>
                </div>
              </SelectItem>
            ))}
          </Select>
        </div>

        <div className="relative w-full aspect-square bg-gradient-to-br from-neutral-800 to-neutral-900 rounded-2xl overflow-hidden border border-neutral-700/50">
          <img
            src="/map.svg"
            alt="Summoner's Rift Map"
            className="w-full h-full opacity-60 contrast-90 filter brightness-75"
          />
          {isHeatmapLoading && (
            <div className="absolute inset-0 bg-neutral-950/70 flex items-center justify-center backdrop-blur-sm">
              <div className="flex flex-col items-center gap-4">
                <Loader2 className="w-12 h-12 text-accent-blue-500 animate-spin" />
                <p className="text-sm font-medium text-white">
                  Analyzing gameplay patterns...
                </p>
              </div>
            </div>
          )}
          {heatmapData && (
            <HeatmapOverlay data={heatmapData} mode={selectedMode} />
          )}

          {/* Subtle corner decoration */}
          <div className="absolute top-4 right-4 w-2 h-2 bg-accent-blue-400 rounded-full opacity-60" />
          <div className="absolute bottom-4 left-4 w-1 h-1 bg-accent-purple-400 rounded-full opacity-40" />
        </div>
      </CardBody>
    </Card>
  );
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
    polarity?: 'good' | 'bad' | 'neutral';
  }
  interface AIBadgesResponse {
    badges: AIBadgeItem[];
  }
  const isIdle =
    !!status && status.status !== 'processing' && status.status !== 'listing';
  const { data: badgesData, isLoading: isBadgesLoading } =
    useQuery<AIBadgesResponse>({
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
      <div className="min-h-screen bg-gradient-to-br from-neutral-950 via-neutral-900 to-neutral-800 relative">
        <Navbar />
        <div className="container mx-auto px-6 py-12 max-w-7xl">
          <div className="space-y-16">
            {/* Enhanced Header Section */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
              className="flex items-center gap-8 p-10 rounded-3xl bg-neutral-900/80 backdrop-blur-sm border border-neutral-700/50 shadow-soft-lg"
            >
              <div className="relative">
                <motion.div
                  whileHover={{ scale: 1.05 }}
                  transition={{ duration: 0.2 }}
                >
                  <img
                    src={iconUrl}
                    alt={summoner.name}
                    className="w-24 h-24 rounded-2xl border-2 border-neutral-700 shadow-soft"
                  />
                  <div className="absolute -bottom-1 -right-1 bg-accent-blue-500 text-white text-sm font-medium px-3 py-1 rounded-lg shadow-soft">
                    {summoner.summonerLevel}
                  </div>
                </motion.div>
              </div>
              <div className="flex-1 min-w-0">
                <div className="space-y-4">
                  <div>
                    <h1 className="text-4xl font-display font-bold text-neutral-50 tracking-tight">
                      {name}
                    </h1>
                    <p className="text-xl text-neutral-400 font-medium">
                      #{tag}
                    </p>
                  </div>
                  <div className="flex items-center gap-4 flex-wrap">
                    {isBadgesLoading && isIdle ? (
                      <div className="flex items-center gap-3 px-4 py-2 bg-accent-blue-50 dark:bg-accent-blue-900/20 rounded-full border border-accent-blue-200 dark:border-accent-blue-800">
                        <Loader2 className="w-4 h-4 text-accent-blue-600 dark:text-accent-blue-400 animate-spin" />
                        <span className="text-sm font-medium text-accent-blue-700 dark:text-accent-blue-300">
                          AI is analyzing your playstyle...
                        </span>
                      </div>
                    ) : badgesData?.badges?.length ? (
                      <div className="flex flex-wrap gap-3">
                        {badgesData.badges.map((b, idx) => (
                          <Tooltip
                            key={`${b.title}-hdr-${idx}`}
                            content={
                              <div className="max-w-xs text-left p-3">
                                <p className="text-sm font-semibold text-neutral-100 mb-2">
                                  {b.title}
                                </p>
                                <p className="text-xs text-neutral-300 leading-relaxed">
                                  {b.reason}
                                </p>
                              </div>
                            }
                            placement="top"
                            className="bg-black/95 border border-white/10 shadow-soft-lg"
                          >
                            <Chip
                              variant="flat"
                              color="default"
                              size="md"
                              className={`${
                                (b.polarity ?? 'neutral') === 'good'
                                  ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-700 hover:bg-emerald-200 dark:hover:bg-emerald-800/40'
                                  : (b.polarity ?? 'neutral') === 'bad'
                                    ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-700 hover:bg-red-200 dark:hover:bg-red-800/40'
                                    : 'bg-slate-200 dark:bg-slate-800 text-slate-800 dark:text-slate-200 border border-slate-300 dark:border-slate-700 hover:bg-slate-300 dark:hover:bg-slate-700/40'
                              } font-semibold transition-colors duration-150 cursor-default px-4 py-2`}
                            >
                              {b.title}
                            </Chip>
                          </Tooltip>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.2 }}
              className="space-y-8"
            >
              <BentoGrid className="max-w-none">
                <BentoItem span="md">
                  <OverviewCard region={region} name={name} tag={tag} />
                </BentoItem>
                <BentoItem span="md">
                  <ChampionMasteryCard region={region} name={name} tag={tag} />
                  <ChampionInsightsCard region={region} name={name} tag={tag} />
                </BentoItem>
                <BentoItem span="md">
                  <HeatmapCard />
                </BentoItem>
                <BentoItem span="md">
                  <RecentMatchesCard region={region} name={name} tag={tag} />
                </BentoItem>
              </BentoGrid>
            </motion.div>
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
    <div className="min-h-screen bg-gradient-to-br from-neutral-900 via-neutral-800 to-neutral-900 dark relative">
      <Navbar />
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
            <h1 className="text-4xl md:text-5xl font-bold text-balance text-neutral-50">
              League of Legends
              <span className="block text-cyan-400">Rewind</span>
            </h1>
            <p className="text-lg text-neutral-300 max-w-2xl mx-auto text-pretty">
              We're gathering all your matches from {region.toUpperCase()} to
              create your personalized rewind
            </p>
          </motion.div>

          <motion.div variants={itemVariants}>
            <Card className="bg-neutral-800/90 backdrop-blur-sm border-neutral-700 shadow-xl">
              <CardBody className="p-8">
                <div className="space-y-6">
                  <div className="text-center space-y-2">
                    <h2 className="text-3xl font-bold text-neutral-50">
                      {Math.round(progressPercentage)}%
                    </h2>
                    <p className="text-neutral-300">
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
                    <div className="flex justify-between text-sm text-neutral-300">
                      <span>Listing: {status.listing ? 'Yes' : 'No'}</span>
                      <span className="capitalize">{status.status}</span>
                    </div>
                  </div>
                </div>
              </CardBody>
            </Card>
          </motion.div>

          <motion.div variants={itemVariants}>
            <Card className="bg-neutral-700/80 backdrop-blur-sm border-neutral-600 shadow-xl">
              <CardBody className="p-6">
                <div className="grid grid-cols-3 gap-6">
                  <div className="text-center">
                    <div className="text-2xl font-bold text-cyan-400 mb-1">
                      {status.total}
                    </div>
                    <div className="text-sm text-neutral-300">
                      Matches Found
                    </div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-cyan-400 mb-1">
                      {status.processed}
                    </div>
                    <div className="text-sm text-neutral-300">Processed</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-cyan-400 mb-1">
                      {status.position ?? '-'}
                    </div>
                    <div className="text-sm text-neutral-300">
                      Queue Position
                    </div>
                  </div>
                </div>
              </CardBody>
            </Card>
          </motion.div>

          <motion.div variants={itemVariants}>
            <Card className="bg-neutral-600/70 backdrop-blur-sm border-neutral-500 shadow-xl">
              <CardBody className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-lg font-semibold text-neutral-50 mb-2">
                      Analyzing {region.toUpperCase()} Region
                    </h3>
                    <p className="text-sm text-neutral-300">
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
