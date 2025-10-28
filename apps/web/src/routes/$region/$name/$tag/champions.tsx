import { http } from '@/clients/http';
import { useDataDragon } from '@/providers/data-dragon-provider';
import { Avatar, Button, Card, CardBody, Chip } from '@heroui/react';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { motion } from 'framer-motion';
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

function ChampionsComponent() {
  const { region, name, tag } = Route.useParams();
  const { getChampionImageUrl } = useDataDragon();

  const [page, setPage] = useState<number>(1);

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

  const softColorForScore = (score?: number) => {
    if (score === undefined || score === null) return 'bg-neutral-800/70';
    if (score >= 75)
      return 'bg-emerald-900/30 border-emerald-700/40 text-emerald-300';
    if (score >= 60) return 'bg-sky-900/30 border-sky-700/40 text-sky-300';
    if (score >= 45)
      return 'bg-amber-900/30 border-amber-700/40 text-amber-300';
    return 'bg-red-900/30 border-red-700/40 text-red-300';
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
                {items.map((row, index) => (
                  <motion.div
                    key={`${row.championName}-${row.role}-${index}`}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.2, delay: index * 0.02 }}
                    className={
                      'p-4 rounded-lg border transition-all duration-150 cursor-pointer space-y-2 bg-neutral-900/50 border-neutral-700/40 hover:bg-neutral-900/70'
                    }
                  >
                    {/* Header */}
                    <div className="flex items-center gap-2 text-xs sm:text-sm">
                      <span className="text-neutral-300">{row.role}</span>
                      <span className="text-neutral-500">•</span>
                      <span className="text-neutral-300">
                        {row.totalMatches} games
                      </span>
                    </div>

                    {/* Main row */}
                    <div className="flex items-center gap-4">
                      {/* Champion Portrait */}
                      <div className="relative flex-shrink-0">
                        <Avatar
                          src={getChampionImageUrl(row.championName, 'square')}
                          alt={row.championName}
                          className="size-16 border border-neutral-600"
                          radius="md"
                        />
                        {/* Role icon overlay */}
                        <img
                          src={getRoleIconUrl(row.role)}
                          alt={row.role}
                          className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full border border-neutral-700 bg-neutral-800/80"
                        />
                      </div>

                      {/* Stats */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-6 mb-1">
                          <span className="font-semibold text-sm text-neutral-100">
                            {row.championName}
                          </span>
                          <Chip
                            size="sm"
                            className={`${softColorForScore(row.aiScore)} border px-2`}
                          >
                            {row.aiScore !== undefined && row.aiScore !== null
                              ? `${Math.round(row.aiScore)} RiftScore`
                              : 'AI pending'}
                          </Chip>
                        </div>
                        <div className="flex items-center gap-4 text-xs text-neutral-400">
                          <span className="font-medium">
                            {(row.winRate * 100).toFixed(1)}% WR
                          </span>
                          <span className="font-medium">
                            {row.kda.toFixed(2)} KDA
                          </span>
                          <span className="font-medium">
                            {row.avgDpm.toFixed(0)} DPM
                          </span>
                          <span className="font-medium">
                            {row.avgCS.toFixed(1)} CS
                          </span>
                        </div>
                      </div>

                      {/* Kills/Deaths/Assists quick glance */}
                      <div className="flex flex-col items-end gap-1 text-xs text-neutral-400">
                        <span>
                          K/D/A: {row.avgKills.toFixed(1)}/
                          {row.avgDeaths.toFixed(1)}/{row.avgAssists.toFixed(1)}
                        </span>
                        <span>Gold@10: {row.avgGoldAt10.toFixed(0)}</span>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
