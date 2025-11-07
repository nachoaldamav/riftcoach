import { http } from '@/clients/http';
import { BentoGrid, BentoItem } from '@/components/bento/BentoGrid';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody } from '@/components/ui/card';
import { useDataDragon } from '@/providers/data-dragon-provider';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { motion } from 'framer-motion';
import {
  Coins,
  Flame,
  ShieldHalf,
  Skull,
  Snowflake,
  Swords,
  Trophy,
} from 'lucide-react';
import { type ReactNode, useMemo } from 'react';

export const Route = createFileRoute('/$region/$name/$tag/aram')({
  component: AramOverview,
});

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

interface AramStatsResponse {
  totalGames: number;
  wins: number;
  losses: number;
  winRate: number;
  totalKills: number;
  totalDeaths: number;
  totalAssists: number;
  averageKills: number;
  averageDeaths: number;
  averageAssists: number;
  kda: number;
  totalDamageDealt: number;
  averageDamageDealt: number;
  totalDamageTaken: number;
  averageDamageTaken: number;
  totalDamageMitigated: number;
  averageDamageMitigated: number;
  totalDamageTakenAndMitigated: number;
  averageDamageTakenAndMitigated: number;
  totalGoldEarned: number;
  averageGoldEarned: number;
  totalTimePlayed: number;
  averageGameDuration: number;
  averageDamagePerMinute: number;
  averageGoldPerMinute: number;
  firstGameTimestamp: number | null;
  lastGameTimestamp: number | null;
  timeframeStart: number;
  timeframeEnd: number;
}

interface AramChampionSummary {
  championId: number;
  championName: string;
  games: number;
  wins: number;
  losses: number;
  winRate: number;
  avgKills: number;
  avgDeaths: number;
  avgAssists: number;
  avgKda: number;
  avgDamageDealt: number;
  avgDamageTakenAndMitigated: number;
  avgGoldEarned: number;
  avgDamagePerMinute: number;
  avgGoldPerMinute: number;
  lastGameTimestamp?: number;
}

interface AramNemesisSummary {
  championId: number;
  championName: string;
  deaths: number;
  share: number;
}

const formatNumber = (value: number, options?: Intl.NumberFormatOptions) =>
  new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 0,
    ...options,
  }).format(Number.isFinite(value) ? value : 0);

const formatCompactNumber = (value: number) =>
  new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(Number.isFinite(value) ? value : 0);

const formatPercent = (value: number, fractionDigits = 1) =>
  `${Number.isFinite(value) ? value.toFixed(fractionDigits) : '0.0'}%`;

const formatSeconds = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds - minutes * 60);
  return `${minutes}m ${remaining.toString().padStart(2, '0')}s`;
};

const formatDate = (timestamp?: number | null) => {
  if (!timestamp) return null;
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
};

type StatsCardProps = {
  stats?: AramStatsResponse;
  isLoading: boolean;
};

function AramStatsCard({ stats, isLoading }: StatsCardProps) {
  const fallbackSince = useMemo(() => Date.now() - ONE_YEAR_MS, []);

  if (isLoading && !stats) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="h-full"
      >
        <Card className="py-0 h-full bg-neutral-900/90 backdrop-blur-sm border border-neutral-700/60 shadow-soft-lg">
          <CardBody className="p-8">
            <div className="animate-pulse space-y-6">
              <div className="flex items-center justify-between">
                <div className="space-y-2">
                  <div className="h-6 w-40 rounded bg-neutral-700" />
                  <div className="h-4 w-56 rounded bg-neutral-800" />
                </div>
                <div className="size-12 rounded-full bg-neutral-800" />
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {Array.from({ length: 4 }).map((_, idx) => (
                  <div
                    key={`stat-skeleton-${idx}`}
                    className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-4"
                  >
                    <div className="h-5 w-3/4 rounded bg-neutral-800" />
                    <div className="mt-3 h-7 w-1/2 rounded bg-neutral-700" />
                  </div>
                ))}
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                {Array.from({ length: 4 }).map((_, idx) => (
                  <div
                    key={`metric-skeleton-${idx}`}
                    className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4"
                  >
                    <div className="h-5 w-24 rounded bg-neutral-800" />
                    <div className="mt-3 h-6 w-32 rounded bg-neutral-700" />
                    <div className="mt-2 h-4 w-20 rounded bg-neutral-800" />
                  </div>
                ))}
              </div>
            </div>
          </CardBody>
        </Card>
      </motion.div>
    );
  }

  const totalGames = stats?.totalGames ?? 0;
  const timeframeStart = stats?.timeframeStart ?? fallbackSince;
  const timeframeLabel = formatDate(timeframeStart) ?? 'the past year';
  const lastGameLabel = formatDate(stats?.lastGameTimestamp);

  if (!stats || totalGames === 0) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="h-full"
      >
        <Card className="py-0 h-full bg-neutral-900/90 backdrop-blur-sm border border-dashed border-neutral-700/60 shadow-soft-lg">
          <CardBody className="p-8 flex flex-col items-center justify-center text-center gap-4">
            <Snowflake className="size-12 text-blue-300" />
            <div>
              <h2 className="text-xl font-semibold text-neutral-100">No ARAM adventures yet</h2>
              <p className="text-sm text-neutral-400">
                We couldn&apos;t find any ARAM matches since {timeframeLabel}. Jump into the Howling Abyss and come back for a
                year-in-review!
              </p>
            </div>
          </CardBody>
        </Card>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="h-full"
    >
      <Card className="py-0 h-full bg-neutral-900/90 backdrop-blur-sm border border-neutral-700/60 shadow-soft-lg">
        <CardBody className="p-8 space-y-6">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <h2 className="text-xl font-semibold text-neutral-100">ARAM year in review</h2>
              <p className="text-sm text-neutral-400">
                Tracking matches since {timeframeLabel}
                {lastGameLabel ? ` · Last game on ${lastGameLabel}` : ''}
              </p>
            </div>
            <div className="rounded-full bg-blue-500/10 p-3 border border-blue-500/20">
              <Snowflake className="size-6 text-blue-300" />
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatHighlight
              label="Games"
              value={formatNumber(totalGames)}
              icon={<Trophy className="size-5 text-amber-400" />}
            />
            <StatHighlight
              label="Win rate"
              value={formatPercent(stats.winRate)}
              icon={<Swords className="size-5 text-emerald-400" />}
            />
            <StatHighlight
              label="Average KDA"
              value={stats.kda.toFixed(2)}
              subtext={`${stats.averageKills.toFixed(1)}/${stats.averageDeaths.toFixed(1)}/${stats.averageAssists.toFixed(1)}`}
            />
            <StatHighlight
              label="Avg game length"
              value={formatSeconds(stats.averageGameDuration)}
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <MetricHighlight
              icon={<Flame className="size-5 text-orange-400" />}
              title="Damage dealt"
              primary={formatCompactNumber(stats.totalDamageDealt)}
              secondary={`${formatCompactNumber(stats.averageDamageDealt)} avg / game`}
              tertiary={`${formatNumber(stats.averageDamagePerMinute, {
                maximumFractionDigits: 1,
              })} dmg / min`}
            />
            <MetricHighlight
              icon={<ShieldHalf className="size-5 text-sky-300" />}
              title="Damage taken + mitigated"
              primary={formatCompactNumber(stats.totalDamageTakenAndMitigated)}
              secondary={`${formatCompactNumber(stats.averageDamageTakenAndMitigated)} avg / game`}
              tertiary={`${formatCompactNumber(stats.totalDamageMitigated)} mitigated total`}
            />
            <MetricHighlight
              icon={<Coins className="size-5 text-yellow-300" />}
              title="Gold earned"
              primary={formatCompactNumber(stats.totalGoldEarned)}
              secondary={`${formatCompactNumber(stats.averageGoldEarned)} avg / game`}
              tertiary={`${formatNumber(stats.averageGoldPerMinute, {
                maximumFractionDigits: 1,
              })} gold / min`}
            />
            <MetricHighlight
              icon={<Swords className="size-5 text-rose-300" />}
              title="Team impact"
              primary={`${formatNumber(stats.totalKills)} / ${formatNumber(stats.totalAssists)}`}
              secondary={`Kills · Assists across all games`}
              tertiary={`${formatNumber(stats.totalDeaths)} total deaths`}
            />
          </div>
        </CardBody>
      </Card>
    </motion.div>
  );
}

type ChampionsCardProps = {
  champions: AramChampionSummary[];
  isLoading: boolean;
  timeframeStart?: number;
};

function MostPlayedChampionsCard({ champions, isLoading, timeframeStart }: ChampionsCardProps) {
  const { getChampionImageUrl } = useDataDragon();
  const fallbackSince = useMemo(() => Date.now() - ONE_YEAR_MS, []);
  const hasData = champions.length > 0;
  const sinceLabel = formatDate(timeframeStart ?? fallbackSince) ?? 'the past year';

  if (isLoading && !hasData) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.1 }}
        className="h-full"
      >
        <Card className="py-0 h-full bg-neutral-900/90 backdrop-blur-sm border border-neutral-700/60 shadow-soft-lg">
          <CardBody className="p-8 space-y-4">
            <div className="flex items-center justify-between">
              <div className="space-y-2">
                <div className="h-6 w-48 rounded bg-neutral-700" />
                <div className="h-4 w-40 rounded bg-neutral-800" />
              </div>
              <div className="size-10 rounded-full bg-neutral-800" />
            </div>
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, idx) => (
                <div
                  key={`champion-skeleton-${idx}`}
                  className="flex items-center gap-4 rounded-xl border border-neutral-800 bg-neutral-900/40 p-4"
                >
                  <div className="size-14 rounded-xl bg-neutral-800" />
                  <div className="flex-1 space-y-2">
                    <div className="h-5 w-32 rounded bg-neutral-800" />
                    <div className="h-4 w-24 rounded bg-neutral-800" />
                  </div>
                  <div className="h-6 w-16 rounded bg-neutral-800" />
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: 0.1 }}
      className="h-full"
    >
      <Card className="py-0 h-full bg-neutral-900/90 backdrop-blur-sm border border-neutral-700/60 shadow-soft-lg">
        <CardBody className="p-8 space-y-5">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <h3 className="text-lg font-semibold text-neutral-100">Most played champions</h3>
              <p className="text-sm text-neutral-400">Top picks in ARAM since {sinceLabel}</p>
            </div>
            <div className="rounded-full bg-amber-500/10 p-2.5 border border-amber-500/20">
              <Trophy className="size-5 text-amber-300" />
            </div>
          </div>

          {hasData ? (
            <div className="space-y-4">
              {champions.map((champion, index) => {
                const imageUrl = getChampionImageUrl(champion.championId, 'square');
                const placement = index + 1;
                return (
                  <div
                    key={`${champion.championId}-${champion.championName}`}
                    className="flex items-center gap-4 rounded-xl border border-neutral-800 bg-neutral-900/40 p-4 hover:border-neutral-600/80 transition-colors"
                  >
                    <div className="relative">
                      <img
                        src={imageUrl}
                        alt={champion.championName}
                        className="size-14 rounded-xl object-cover"
                      />
                      <Badge className="absolute -top-2 -left-2 bg-blue-500/90 text-white px-2 py-0.5 text-xs font-semibold">
                        #{placement}
                      </Badge>
                    </div>
                    <div className="flex-1 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <p className="text-base font-semibold text-neutral-100">
                            {champion.championName}
                          </p>
                          <p className="text-xs text-neutral-400">
                            {champion.games} games · {formatPercent(champion.winRate)} WR
                          </p>
                        </div>
                        <div className="text-right text-sm text-neutral-300">
                          <p>{formatCompactNumber(champion.avgDamageDealt)} dmg / game</p>
                          <p className="text-xs text-neutral-400">
                            {formatCompactNumber(champion.avgDamageTakenAndMitigated)} taken+mitigated
                          </p>
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-xs text-neutral-300">
                        <div>K/D/A {champion.avgKills.toFixed(1)}/{champion.avgDeaths.toFixed(1)}/{champion.avgAssists.toFixed(1)}</div>
                        <div>{champion.avgKda.toFixed(2)} KDA</div>
                        <div>{formatNumber(champion.avgGoldPerMinute, { maximumFractionDigits: 1 })} gold / min</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-neutral-800 bg-neutral-900/30 p-6 text-center">
              <Trophy className="size-10 text-neutral-500" />
              <div>
                <p className="text-sm font-medium text-neutral-200">No ARAM champion history yet</p>
                <p className="text-xs text-neutral-400">
                  Play some ARAM games to reveal your go-to picks and how they perform.
                </p>
              </div>
            </div>
          )}
        </CardBody>
      </Card>
    </motion.div>
  );
}

type NemesisCardProps = {
  nemeses: AramNemesisSummary[];
  isLoading: boolean;
  totalDeaths?: number;
  timeframeStart?: number;
};

function NemesisCard({ nemeses, isLoading, totalDeaths = 0, timeframeStart }: NemesisCardProps) {
  const { getChampionImageUrl } = useDataDragon();
  const fallbackSince = useMemo(() => Date.now() - ONE_YEAR_MS, []);
  const hasData = nemeses.length > 0;
  const sinceLabel = formatDate(timeframeStart ?? fallbackSince) ?? 'the past year';

  if (isLoading && !hasData) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.2 }}
        className="h-full"
      >
        <Card className="py-0 h-full bg-neutral-900/90 backdrop-blur-sm border border-neutral-700/60 shadow-soft-lg">
          <CardBody className="p-8 space-y-4">
            <div className="flex items-center justify-between">
              <div className="space-y-2">
                <div className="h-6 w-44 rounded bg-neutral-700" />
                <div className="h-4 w-36 rounded bg-neutral-800" />
              </div>
              <div className="size-10 rounded-full bg-neutral-800" />
            </div>
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, idx) => (
                <div
                  key={`nemesis-skeleton-${idx}`}
                  className="flex items-center gap-4 rounded-xl border border-neutral-800 bg-neutral-900/40 p-4"
                >
                  <div className="size-12 rounded-xl bg-neutral-800" />
                  <div className="flex-1 space-y-2">
                    <div className="h-5 w-28 rounded bg-neutral-800" />
                    <div className="h-4 w-20 rounded bg-neutral-800" />
                  </div>
                  <div className="h-6 w-14 rounded bg-neutral-800" />
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: 0.2 }}
      className="h-full"
    >
      <Card className="py-0 h-full bg-neutral-900/90 backdrop-blur-sm border border-neutral-700/60 shadow-soft-lg">
        <CardBody className="p-8 space-y-5">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <h3 className="text-lg font-semibold text-neutral-100">Nemesis watch</h3>
              <p className="text-sm text-neutral-400">
                Champions who scored the most kills on you since {sinceLabel}
              </p>
            </div>
            <div className="rounded-full bg-rose-500/10 p-2.5 border border-rose-500/20">
              <Skull className="size-5 text-rose-300" />
            </div>
          </div>

          {hasData ? (
            <div className="space-y-3">
              {nemeses.map((nemesis) => {
                const imageUrl = getChampionImageUrl(nemesis.championId, 'square');
                const sharePercent = nemesis.share * 100;
                return (
                  <div
                    key={`${nemesis.championId}-${nemesis.championName}`}
                    className="flex items-center gap-4 rounded-xl border border-neutral-800 bg-neutral-900/40 p-4 hover:border-neutral-600/80 transition-colors"
                  >
                    <img
                      src={imageUrl}
                      alt={nemesis.championName}
                      className="size-12 rounded-xl object-cover"
                    />
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-semibold text-neutral-100">
                          {nemesis.championName}
                        </p>
                        <span className="text-sm font-medium text-neutral-200">
                          {formatNumber(nemesis.deaths)} times
                        </span>
                      </div>
                      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-neutral-800">
                        <div
                          className="h-full bg-rose-500"
                          style={{ width: `${Math.min(sharePercent, 100)}%` }}
                        />
                      </div>
                      <div className="mt-2 flex items-center justify-between text-xs text-neutral-400">
                        <span>{formatPercent(sharePercent, 1)} of your tracked ARAM deaths</span>
                        <span>{totalDeaths ? `${formatNumber(totalDeaths)} total deaths` : '—'}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-neutral-800 bg-neutral-900/30 p-6 text-center">
              <Skull className="size-10 text-neutral-500" />
              <div>
                <p className="text-sm font-medium text-neutral-200">
                  {totalDeaths > 0 ? 'No nemesis data yet' : 'No nemeses detected'}
                </p>
                <p className="text-xs text-neutral-400">
                  {totalDeaths > 0
                    ? 'We need more detailed ARAM timelines to surface your biggest threats.'
                    : `You haven\'t logged any ARAM deaths since ${sinceLabel}. Keep dancing around those skillshots!`}
                </p>
              </div>
            </div>
          )}
        </CardBody>
      </Card>
    </motion.div>
  );
}

type StatHighlightProps = {
  label: string;
  value: string;
  subtext?: string;
  icon?: ReactNode;
};

function StatHighlight({ label, value, subtext, icon }: StatHighlightProps) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs uppercase tracking-wide text-neutral-400">{label}</p>
        {icon ? <span>{icon}</span> : null}
      </div>
      <p className="mt-2 text-2xl font-semibold text-neutral-100">{value}</p>
      {subtext ? <p className="mt-1 text-xs text-neutral-400">{subtext}</p> : null}
    </div>
  );
}

type MetricHighlightProps = {
  icon: ReactNode;
  title: string;
  primary: string;
  secondary: string;
  tertiary?: string;
};

function MetricHighlight({ icon, title, primary, secondary, tertiary }: MetricHighlightProps) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4 space-y-2">
      <div className="flex items-center gap-3">
        <div className="rounded-full bg-neutral-800/80 p-2 border border-neutral-700/80">{icon}</div>
        <div>
          <p className="text-sm font-semibold text-neutral-100">{title}</p>
          <p className="text-xs text-neutral-400">{secondary}</p>
        </div>
      </div>
      <p className="text-2xl font-semibold text-neutral-100">{primary}</p>
      {tertiary ? <p className="text-xs text-neutral-400">{tertiary}</p> : null}
    </div>
  );
}

function AramOverview() {
  const { region, name, tag } = Route.useParams();

  const statsQuery = useQuery({
    queryKey: ['aram-stats', region, name, tag],
    queryFn: async () => {
      const res = await http.get<AramStatsResponse>(
        `/v1/${encodeURIComponent(region)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}/aram/stats`,
      );
      return res.data;
    },
    staleTime: 1000 * 60 * 5,
  });

  const championsQuery = useQuery({
    queryKey: ['aram-champions', region, name, tag],
    queryFn: async () => {
      const res = await http.get<AramChampionSummary[]>(
        `/v1/${encodeURIComponent(region)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}/aram/champions`,
      );
      return res.data;
    },
    staleTime: 1000 * 60 * 5,
  });

  const nemesisQuery = useQuery({
    queryKey: ['aram-nemesis', region, name, tag],
    queryFn: async () => {
      const res = await http.get<AramNemesisSummary[]>(
        `/v1/${encodeURIComponent(region)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}/aram/nemesis`,
      );
      return res.data;
    },
    staleTime: 1000 * 60 * 5,
  });

  const stats = statsQuery.data;
  const champions = championsQuery.data ?? [];
  const nemeses = nemesisQuery.data ?? [];

  const isStatsLoading = statsQuery.isLoading && !stats;
  const isChampionsLoading = championsQuery.isLoading && champions.length === 0;
  const isNemesisLoading = nemesisQuery.isLoading && nemeses.length === 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.1 }}
      className="space-y-8"
    >
      <BentoGrid className="max-w-none">
        <BentoItem span="lg">
          <AramStatsCard stats={stats} isLoading={isStatsLoading} />
        </BentoItem>
        <BentoItem span="md">
          <MostPlayedChampionsCard
            champions={champions}
            isLoading={isChampionsLoading}
            timeframeStart={stats?.timeframeStart}
          />
        </BentoItem>
        <BentoItem span="md">
          <NemesisCard
            nemeses={nemeses}
            isLoading={isNemesisLoading}
            totalDeaths={stats?.totalDeaths}
            timeframeStart={stats?.timeframeStart}
          />
        </BentoItem>
      </BentoGrid>
    </motion.div>
  );
}
