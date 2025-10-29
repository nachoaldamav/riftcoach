import { http } from '@/clients/http';
import { HeatmapOverlay } from '@/components/heatmap-overlay';
import { useDataDragon } from '@/providers/data-dragon-provider';
import { Avatar, Button, Card, CardBody, Chip } from '@heroui/react';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Loader2,
} from 'lucide-react';
import { useMemo, useState } from 'react';

export const Route = createFileRoute('/$region/$name/$tag/champions')({
  component: ChampionsComponent,
});

type ChampionRoleStatItem = {
  championName: string;
  role: 'TOP' | 'JUNGLE' | 'MIDDLE' | 'BOTTOM' | 'UTILITY' | 'UNKNOWN';
  totalMatches: number;
  wins: number;
  losses: number;
  winRate: number; // 0..1
  kda: number;
  avgKills: number;
  avgDeaths: number;
  avgAssists: number;
  avgGoldEarned: number;
  avgCS: number;
  avgCspm: number;
  avgGoldAt10: number;
  avgCsAt10: number;
  avgGoldAt15: number;
  avgCsAt15: number;
  avgDpm: number;
  avgDtpm: number;
  avgKpm: number;
  avgDeathsPerMin: number;
  avgApm: number;
  avgDamageShare?: number;
  avgDamageTakenShare?: number;
  avgObjectiveParticipationPct?: number;
  earlyGankDeathRateSmart?: number;
  aiScore?: number;
};

type CohortPercentiles = {
  championName: string;
  role: string;
  percentiles: {
    p50: Record<string, number>;
    p75: Record<string, number>;
    p90: Record<string, number>;
    p95: Record<string, number>;
  };
};

type ChampionRoleInsight = {
  summary: string;
  strengths: string[];
  weaknesses: string[];
};

type ChampionRoleDetailResponse = {
  championName: string;
  role: string;
  aiScore: number | null;
  reasoning?: string;
  stats: ChampionRoleStatItem;
  cohort: CohortPercentiles | null;
  insights: ChampionRoleInsight;
};

type HeatmapPoint = {
  xBin: number;
  yBin: number;
  count: number;
  grid: number;
};

type ChampionsApiResponse = {
  page: number;
  pageSize: number;
  total: number;
  data: ChampionRoleStatItem[];
};

// Role icon from Community Dragon (same helper as matches page)
const getRoleIconUrl = (roleKey: string) => {
  if (roleKey === 'ALL')
    return 'https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-clash/global/default/assets/images/position-selector/positions/icon-position-fill.png';
  return `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-clash/global/default/assets/images/position-selector/positions/icon-position-${roleKey.toLowerCase()}.png`;
};

const pageSize = 20;

// Normalize champion names to handle case differences and known variations
const normalizeChampionName = (name: string): string => {
  const normalized = name.toLowerCase().trim();

  // Handle known champion name variations
  const nameMapping: Record<string, string> = {
    fiddlesticks: 'fiddlesticks',
    nunu: 'nunu & willump',
    reksai: "rek'sai",
    kogmaw: "kog'maw",
    leesin: 'lee sin',
    masteryi: 'master yi',
    missfortune: 'miss fortune',
    twistedfate: 'twisted fate',
    xinzhao: 'xin zhao',
    jarvaniv: 'jarvan iv',
    aurelionsol: 'aurelion sol',
    tahmkench: 'tahm kench',
    velkoz: "vel'koz",
    chogath: "cho'gath",
    kaisa: "kai'sa",
    khazix: "kha'zix",
    rengar: 'rengar',
    wukong: 'wukong',
  };

  return nameMapping[normalized] || normalized;
};

const getScoreTone = (score?: number) => {
  if (score === undefined || score === null) return 'bg-neutral-800/70';
  if (score >= 75)
    return 'bg-emerald-900/30 border-emerald-700/40 text-emerald-300';
  if (score >= 60) return 'bg-sky-900/30 border-sky-700/40 text-sky-300';
  if (score >= 45) return 'bg-amber-900/30 border-amber-700/40 text-amber-300';
  return 'bg-red-900/30 border-red-700/40 text-red-300';
};

const getScoreTextClass = (score?: number) => {
  if (score === undefined || score === null) return 'text-neutral-100';
  if (score >= 75) return 'text-emerald-300';
  if (score >= 60) return 'text-sky-300';
  if (score >= 45) return 'text-amber-300';
  return 'text-red-300';
};

type PercentileSet = {
  p50?: number;
  p75?: number;
  p90?: number;
};

const chipBaseClasses =
  'px-2 py-0.5 rounded-full border text-[10px] font-semibold uppercase tracking-wide';

const evaluatePerformance = (
  value: number | undefined,
  percentiles: PercentileSet | null,
  invert = false,
) => {
  if (
    value === undefined ||
    value === null ||
    !percentiles ||
    (typeof percentiles.p50 !== 'number' &&
      typeof percentiles.p75 !== 'number' &&
      typeof percentiles.p90 !== 'number')
  ) {
    return null;
  }

  const { p50, p75, p90 } = percentiles;

  if (!invert) {
    if (typeof p90 === 'number' && value >= p90)
      return {
        label: 'Elite',
        className: `${chipBaseClasses} bg-emerald-900/30 border-emerald-700/40 text-emerald-300`,
      };
    if (typeof p75 === 'number' && value >= p75)
      return {
        label: 'Great',
        className: `${chipBaseClasses} bg-sky-900/30 border-sky-700/40 text-sky-200`,
      };
    if (typeof p50 === 'number' && value >= p50)
      return {
        label: 'Above Avg',
        className: `${chipBaseClasses} bg-neutral-800/70 border-neutral-700/40 text-neutral-200`,
      };
    return {
      label: 'Needs Work',
      className: `${chipBaseClasses} bg-red-900/30 border-red-700/40 text-red-300`,
    };
  }

  if (typeof p50 === 'number' && value <= p50)
    return {
      label: 'Disciplined',
      className: `${chipBaseClasses} bg-emerald-900/30 border-emerald-700/40 text-emerald-300`,
    };
  if (typeof p75 === 'number' && value <= p75)
    return {
      label: 'Stable',
      className: `${chipBaseClasses} bg-sky-900/30 border-sky-700/40 text-sky-200`,
    };
  if (typeof p90 === 'number' && value >= p90)
    return {
      label: 'Needs Work',
      className: `${chipBaseClasses} bg-red-900/30 border-red-700/40 text-red-300`,
    };
  return {
    label: 'High',
    className: `${chipBaseClasses} bg-amber-900/30 border-amber-700/40 text-amber-300`,
  };
};

const formatValue = (
  value: number | undefined,
  options: { digits?: number; percent?: boolean } = {},
) => {
  if (value === undefined || value === null || Number.isNaN(value)) return '—';
  const digits = options.digits ?? 1;
  if (options.percent) {
    return `${(value * 100).toFixed(digits)}%`;
  }
  return value.toFixed(digits);
};

const getPercentilesForKey = (
  cohort: CohortPercentiles | null | undefined,
  key: string,
): PercentileSet | null => {
  if (!cohort?.percentiles) return null;
  const { p50, p75, p90 } = cohort.percentiles;
  const hasValue =
    typeof p50?.[key] === 'number' ||
    typeof p75?.[key] === 'number' ||
    typeof p90?.[key] === 'number';
  if (!hasValue) return null;
  return {
    p50: p50?.[key],
    p75: p75?.[key],
    p90: p90?.[key],
  };
};

function ChampionsComponent() {
  const { region, name, tag } = Route.useParams();

  const [page, setPage] = useState<number>(1);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const { data: championsData, isLoading } = useQuery<ChampionsApiResponse>({
    queryKey: ['v1-champions-stats', region, name, tag, page],
    queryFn: async () => {
      const res = await http.get<ChampionsApiResponse>(
        `/v1/${encodeURIComponent(region)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}/champions-stats?page=${page}&pageSize=${pageSize}`,
      );
      return res.data;
    },
    staleTime: 1000 * 60 * 5,
  });

  const items = useMemo(() => championsData?.data ?? [], [championsData?.data]);
  const total = championsData?.total ?? 0;
  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(total / pageSize)),
    [total],
  );

  const handleToggle = (key: string) => {
    setExpandedKey((prev) => (prev === key ? null : key));
  };

  return (
    <div className="space-y-6">
      {/* List */}
      <Card className="bg-neutral-900/90 backdrop-blur-sm border border-neutral-700/60 shadow-soft-lg">
        <CardBody className="p-6 space-y-4">
          {isLoading || !championsData ? (
            <div className="animate-pulse space-y-4">
              <div className="h-6 bg-neutral-800 rounded w-1/3" />
              {Array.from({ length: 6 }, (_, i) => (
                <div
                  key={`loading-champ-skeleton-${i + 1}`}
                  className="flex items-center space-x-3"
                >
                  <div className="w-12 h-12 bg-neutral-800 rounded-xl" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 bg-neutral-800 rounded w-3/4" />
                    <div className="h-3 bg-neutral-800 rounded w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="flex items-center justify-center py-12">
              <div className="text-center">
                <p className="text-neutral-300">
                  No champion statistics found.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Pagination header */}
              <div className="flex items-center justify-between">
                <span className="text-sm text-neutral-400">
                  {`Showing ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total} entries`}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="flat"
                    size="sm"
                    isDisabled={page <= 1}
                    onPress={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    Previous
                  </Button>
                  <Chip
                    size="sm"
                    className="bg-neutral-800/70 border border-neutral-700/50 text-neutral-300"
                  >
                    {`Page ${page} / ${totalPages}`}
                  </Chip>
                  <Button
                    variant="flat"
                    size="sm"
                    isDisabled={page >= totalPages}
                    onPress={() => setPage((p) => Math.min(totalPages, p + 1))}
                  >
                    Next
                  </Button>
                </div>
              </div>

              {/* Grid */}
              <div className="grid grid-cols-1 gap-3">
                {items.map((row, index) => {
                  const key = `${row.championName}-${row.role}`;
                  return (
                    <ChampionRow
                      key={key}
                      row={row}
                      index={index}
                      region={region}
                      name={name}
                      tag={tag}
                      isExpanded={expandedKey === key}
                      onToggle={() => handleToggle(key)}
                    />
                  );
                })}
              </div>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

interface ChampionRowProps {
  row: ChampionRoleStatItem;
  index: number;
  region: string;
  name: string;
  tag: string;
  isExpanded: boolean;
  onToggle: () => void;
}

function ChampionRow({
  row,
  index,
  region,
  name,
  tag,
  isExpanded,
  onToggle,
}: ChampionRowProps) {
  const { getChampionImageUrl, champions } = useDataDragon();

  const championData = useMemo(() => {
    if (!champions) return null;
    const normalizedRowName = normalizeChampionName(row.championName);

    const champion =
      Object.values(champions).find((champ) => {
        const normalizedChampName = normalizeChampionName(champ.name);
        const normalizedChampId = normalizeChampionName(champ.id);

        const match =
          normalizedChampName === normalizedRowName ||
          normalizedChampId === normalizedRowName;

        return match;
      }) ?? null;

    if (!champion) {
      console.error('No champion found for', normalizedRowName);
      return null;
    }

    return champion;
  }, [champions, row.championName]);

  const championNumericId = useMemo(() => {
    if (!championData) {
      console.error('No champion data found for', row.championName);
      return null;
    }
    const numeric = Number(championData.key);
    return Number.isFinite(numeric) ? numeric : null;
  }, [championData, row.championName]);

  const [heatmapMode, setHeatmapMode] = useState<'kills' | 'deaths'>('kills');

  const detailQuery = useQuery<ChampionRoleDetailResponse>({
    queryKey: [
      'v1-champion-role-detail',
      region,
      name,
      tag,
      row.championName,
      row.role,
    ],
    queryFn: async () => {
      const res = await http.get<ChampionRoleDetailResponse>(
        `/v1/${encodeURIComponent(region)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}/champions/${encodeURIComponent(row.championName)}/${encodeURIComponent(row.role)}`,
      );
      return res.data;
    },
    enabled: isExpanded,
    staleTime: 1000 * 60 * 10,
  });

  const {
    data: heatmapData,
    isLoading: isHeatmapLoading,
    isFetching: isHeatmapFetching,
  } = useQuery<HeatmapPoint[]>({
    queryKey: [
      'v1-champion-role-heatmap',
      region,
      name,
      tag,
      row.role,
      championNumericId,
      heatmapMode,
    ],
    queryFn: async () => {
      if (!championNumericId) return [];
      const res = await http.get<HeatmapPoint[]>(
        `/v1/${encodeURIComponent(region)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}/heatmap`,
        {
          params: {
            role: row.role,
            mode: heatmapMode,
            championId: championNumericId,
          },
        },
      );
      return res.data;
    },
    enabled: isExpanded && typeof championNumericId === 'number',
    staleTime: 1000 * 60 * 5,
  });

  const detail = detailQuery.data;
  const statsSource = detail?.stats ?? row;
  const aiScore = detail?.aiScore ?? row.aiScore;
  const detailLoading = detailQuery.isLoading || detailQuery.isFetching;
  const detailError = detailQuery.isError
    ? (detailQuery.error as Error | null)
    : null;
  const heatmapLoading = isHeatmapLoading || isHeatmapFetching;

  const summaryCards = [
    {
      label: 'Games',
      value: statsSource.totalMatches.toString(),
      sublabel: `${statsSource.wins}W / ${statsSource.losses}L`,
      valueClass: 'text-neutral-100',
    },
    {
      label: 'Win Rate',
      value: `${(statsSource.winRate * 100).toFixed(1)}%`,
      sublabel: 'Across recent ranked games',
      valueClass: 'text-neutral-100',
    },
    {
      label: 'Average KDA',
      value: statsSource.kda.toFixed(2),
      sublabel: `${statsSource.avgKills.toFixed(1)} / ${statsSource.avgDeaths.toFixed(1)} / ${statsSource.avgAssists.toFixed(1)}`,
      valueClass: 'text-neutral-100',
    },
    {
      label: 'RiftScore',
      value:
        aiScore !== undefined && aiScore !== null
          ? Math.round(aiScore).toString()
          : 'Pending',
      sublabel:
        aiScore !== undefined && aiScore !== null
          ? 'AI-estimated performance'
          : 'Awaiting AI evaluation',
      valueClass: getScoreTextClass(aiScore),
    },
  ];

  const metricRows = [
    {
      label: 'Average Kills',
      value: statsSource.avgKills,
      key: 'kills',
      digits: 1,
    },
    {
      label: 'Average Deaths',
      value: statsSource.avgDeaths,
      key: 'deaths',
      digits: 1,
      invert: true,
    },
    {
      label: 'Average Assists',
      value: statsSource.avgAssists,
      key: 'assists',
      digits: 1,
    },
    { label: 'CS / Min', value: statsSource.avgCspm, key: 'cspm', digits: 2 },
    {
      label: 'Gold @ 10',
      value: statsSource.avgGoldAt10,
      key: 'goldAt10',
      digits: 0,
    },
    {
      label: 'CS @ 10',
      value: statsSource.avgCsAt10,
      key: 'csAt10',
      digits: 1,
    },
    {
      label: 'Gold @ 15',
      value: statsSource.avgGoldAt15,
      key: 'goldAt15',
      digits: 0,
    },
    {
      label: 'CS @ 15',
      value: statsSource.avgCsAt15,
      key: 'csAt15',
      digits: 1,
    },
    { label: 'Damage / Min', value: statsSource.avgDpm, key: 'dpm', digits: 0 },
    {
      label: 'Damage Taken / Min',
      value: statsSource.avgDtpm,
      key: 'dtpm',
      digits: 0,
      invert: true,
    },
    { label: 'Kills / Min', value: statsSource.avgKpm, key: 'kpm', digits: 2 },
    {
      label: 'Assists / Min',
      value: statsSource.avgApm,
      key: 'apm',
      digits: 2,
    },
    {
      label: 'Deaths / Min',
      value: statsSource.avgDeathsPerMin,
      key: 'deathsPerMin',
      digits: 2,
      invert: true,
    },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.2, delay: index * 0.02 }}
      className="rounded-lg border border-neutral-700/40 bg-neutral-900/50 transition-all duration-150 hover:bg-neutral-900/70"
    >
      <button
        type="button"
        onClick={onToggle}
        className="w-full space-y-3 rounded-lg p-4 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue-500/60"
      >
        <div className="flex items-center gap-4">
          <div className="relative flex-shrink-0">
            <Avatar
              src={getChampionImageUrl(row.championName, 'square')}
              alt={row.championName}
              className="size-16 border border-neutral-600"
              radius="md"
            />
            <img
              src={getRoleIconUrl(row.role)}
              alt={row.role}
              className="absolute -bottom-1 -right-1 h-5 w-5 rounded-full border border-neutral-700 bg-neutral-800/80"
            />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-semibold text-sm text-neutral-100">
                {row.championName}
              </span>
              {aiScore !== undefined && aiScore !== null ? (
                <Chip
                  size="sm"
                  className={`${getScoreTone(aiScore)} border px-2`}
                >
                  {Math.round(aiScore)} RiftScore
                </Chip>
              ) : null}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-400">
              <span className="font-medium">
                {(row.winRate * 100).toFixed(1)}% WR
              </span>
              <span className="font-medium">{row.kda.toFixed(2)} KDA</span>
              <span className="font-medium">{row.avgDpm.toFixed(0)} DPM</span>
              <span className="font-medium">{row.avgCspm.toFixed(2)} CS/min</span>
            </div>
          </div>

          <div className="flex flex-col items-end gap-1 text-xs text-neutral-400">
            <span>
              K/D/A: {row.avgKills.toFixed(1)}/{row.avgDeaths.toFixed(1)}/
              {row.avgAssists.toFixed(1)}
            </span>
            <span>Gold@10: {row.avgGoldAt10.toFixed(0)}</span>
          </div>

          <ChevronDown
            className={`ml-2 h-4 w-4 text-neutral-500 transition-transform ${
              isExpanded ? 'rotate-180' : 'rotate-0'
            }`}
          />
        </div>

        <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-neutral-400">
          <span className="text-neutral-300">{row.role}</span>
          <span className="text-neutral-500">•</span>
          <span>{row.totalMatches} games</span>
        </div>
      </button>

      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            key="champion-row-details"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden border-t border-neutral-800/60"
          >
            <div className="space-y-6 bg-neutral-950/50 p-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {summaryCards.map((card) => (
                  <div
                    key={card.label}
                    className="rounded-lg border border-neutral-800/60 bg-neutral-900/60 p-3"
                  >
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                      {card.label}
                    </p>
                    <p
                      className={`mt-1 text-lg font-semibold ${
                        card.valueClass ?? 'text-neutral-100'
                      }`}
                    >
                      {card.value}
                    </p>
                    <p className="text-xs text-neutral-400">{card.sublabel}</p>
                  </div>
                ))}
              </div>

              <div className="grid gap-6 lg:grid-cols-2">
                <div className="space-y-6">
                  <div>
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                      <h4 className="text-sm font-semibold uppercase tracking-wide text-neutral-200">
                        AI Insights
                      </h4>
                    </div>
                    {detailLoading ? (
                      <div className="mt-3 space-y-3">
                        <div className="h-20 animate-pulse rounded-lg bg-neutral-900/60" />
                        <div className="h-28 animate-pulse rounded-lg bg-neutral-900/60" />
                      </div>
                    ) : detail ? (
                      <div className="mt-3 space-y-4">
                        <p className="text-sm text-neutral-300">
                          {detail.insights.summary}
                        </p>
                        <div className="grid gap-4 sm:grid-cols-2">
                          <div className="rounded-lg border border-emerald-800/40 bg-emerald-950/20 p-3">
                            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-emerald-300">
                              <CheckCircle2 className="h-4 w-4" />
                              Strengths
                            </div>
                            <ul className="mt-2 space-y-2 text-sm text-neutral-200">
                              {detail.insights.strengths.length > 0 ? (
                                detail.insights.strengths.map(
                                  (strength, idx) => (
                                    <li
                                      key={`strength-${
                                        // biome-ignore lint/suspicious/noArrayIndexKey: <explanation>
                                        idx
                                      }`}
                                    >
                                      {strength}
                                    </li>
                                  ),
                                )
                              ) : (
                                <li className="text-neutral-400">
                                  No standout strengths identified yet.
                                </li>
                              )}
                            </ul>
                          </div>
                          <div className="rounded-lg border border-amber-800/40 bg-amber-950/10 p-3">
                            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-amber-300">
                              <AlertTriangle className="h-4 w-4" />
                              Weaknesses
                            </div>
                            <ul className="mt-2 space-y-2 text-sm text-neutral-200">
                              {detail.insights.weaknesses.length > 0 ? (
                                detail.insights.weaknesses.map(
                                  (weakness, idx) => (
                                    <li
                                      key={`weakness-${
                                        // biome-ignore lint/suspicious/noArrayIndexKey: <explanation>
                                        idx
                                      }`}
                                    >
                                      {weakness}
                                    </li>
                                  ),
                                )
                              ) : (
                                <li className="text-neutral-400">
                                  No critical weaknesses detected.
                                </li>
                              )}
                            </ul>
                          </div>
                        </div>
                        {detail.reasoning ? (
                          <div className="rounded-lg border border-neutral-800/60 bg-neutral-900/60 p-3">
                            <p className="text-[11px] uppercase tracking-wide text-neutral-500">
                              Model Notes
                            </p>
                            <p className="mt-2 whitespace-pre-line text-sm text-neutral-300">
                              {detail.reasoning}
                            </p>
                          </div>
                        ) : null}
                      </div>
                    ) : detailError ? (
                      <p className="mt-3 text-sm text-red-400">
                        Failed to load AI insights. Please try again later.
                      </p>
                    ) : (
                      <p className="mt-3 text-sm text-neutral-400">
                        Insights will appear once matches are processed.
                      </p>
                    )}
                  </div>

                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="text-sm font-semibold uppercase tracking-wide text-neutral-200">
                        Player vs Cohort Percentiles
                      </h4>
                    </div>
                    {detailLoading ? (
                      <div className="mt-3 h-36 animate-pulse rounded-lg bg-neutral-900/60" />
                    ) : detail?.cohort ? (
                      <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-800/60">
                        <table className="min-w-full text-left text-xs text-neutral-300">
                          <thead className="bg-neutral-900/60 text-[11px] uppercase tracking-wide text-neutral-400">
                            <tr>
                              <th className="px-3 py-2 font-semibold">
                                Metric
                              </th>
                              <th className="px-3 py-2 font-semibold">
                                Player
                              </th>
                              <th className="px-3 py-2 font-semibold">P50</th>
                              <th className="px-3 py-2 font-semibold">P75</th>
                              <th className="px-3 py-2 font-semibold">P90</th>
                            </tr>
                          </thead>
                          <tbody>
                            {metricRows.map((metric) => {
                              const percentiles = getPercentilesForKey(
                                detail.cohort,
                                metric.key,
                              );
                              const evaluation = evaluatePerformance(
                                metric.value,
                                percentiles,
                                metric.invert,
                              );
                              return (
                                <tr
                                  key={metric.label}
                                  className="border-t border-neutral-800/60"
                                >
                                  <td className="px-3 py-2 text-neutral-200">
                                    {metric.label}
                                  </td>
                                  <td className="px-3 py-2">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span>
                                        {formatValue(metric.value, {
                                          digits: metric.digits,
                                        })}
                                      </span>
                                      {evaluation ? (
                                        <span className={evaluation.className}>
                                          {evaluation.label}
                                        </span>
                                      ) : null}
                                    </div>
                                  </td>
                                  <td className="px-3 py-2">
                                    {formatValue(percentiles?.p50, {
                                      digits: metric.digits,
                                    })}
                                  </td>
                                  <td className="px-3 py-2">
                                    {formatValue(percentiles?.p75, {
                                      digits: metric.digits,
                                    })}
                                  </td>
                                  <td className="px-3 py-2">
                                    {formatValue(percentiles?.p90, {
                                      digits: metric.digits,
                                    })}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    ) : detailError ? (
                      <p className="mt-3 text-sm text-red-400">
                        Unable to load cohort percentiles right now.
                      </p>
                    ) : (
                      <p className="mt-3 text-sm text-neutral-400">
                        Cohort benchmarks are being prepared.
                      </p>
                    )}
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="text-sm font-semibold uppercase tracking-wide text-neutral-200">
                      Position Heatmap
                    </h4>
                    <div className="flex items-center gap-2">
                      {(['kills', 'deaths'] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => setHeatmapMode(mode)}
                          className={`rounded-md border px-3 py-1 text-xs font-semibold uppercase tracking-wide transition-colors ${
                            heatmapMode === mode
                              ? 'border-accent-blue-400 bg-accent-blue-600/80 text-white'
                              : 'border-neutral-700/60 bg-neutral-900/60 text-neutral-300 hover:border-neutral-500'
                          }`}
                        >
                          {mode === 'kills' ? 'Kills' : 'Deaths'}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="relative w-full overflow-hidden rounded-xl border border-neutral-800/60 bg-gradient-to-br from-neutral-900 to-neutral-950">
                    <img
                      src="/map.svg"
                      alt="Summoner's Rift Map"
                      className="h-full w-full opacity-60 contrast-90"
                    />
                    {typeof championNumericId === 'number' ? (
                      <>
                        {heatmapLoading && (
                          <div className="absolute inset-0 flex items-center justify-center bg-neutral-950/70 backdrop-blur-sm">
                            <Loader2 className="h-8 w-8 animate-spin text-accent-blue-500" />
                          </div>
                        )}
                        {heatmapData && heatmapData.length > 0 ? (
                          <HeatmapOverlay
                            data={heatmapData}
                            mode={heatmapMode}
                          />
                        ) : !heatmapLoading ? (
                          <div className="absolute inset-0 flex items-center justify-center text-xs text-neutral-400">
                            No heatmap data yet.
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center bg-neutral-950/60 text-center text-sm text-neutral-400">
                        Champion data is loading — heatmap unavailable for now.
                      </div>
                    )}
                  </div>

                  <p className="text-[11px] text-neutral-500">
                    Heatmap focuses on recent ranked matches with{' '}
                    {row.championName} in the {row.role.toLowerCase()} role.
                  </p>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
