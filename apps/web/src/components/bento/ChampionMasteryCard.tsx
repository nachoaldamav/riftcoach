import { http } from '@/clients/http';
import { MasteryIcon } from '@/components/icons/CustomIcons';
import { useChampionImage } from '@/providers/data-dragon-provider';
import { Avatar, Card, CardBody } from '@heroui/react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { Crown, Star } from 'lucide-react';

interface ChampionMasteryData {
  championId: number;
  championName: string;
  gamesPlayed: number;
  wins: number;
  losses: number;
  winRate: number;
  avgKda: number;
  avgKills: number;
  avgDeaths: number;
  avgAssists: number;
  avgCs: number;
  avgDamage: number;
  avgGold: number;
  avgVisionScore: number;
  multikills: {
    pentaKills: number;
    quadraKills: number;
    tripleKills: number;
    doubleKills: number;
  };
  largestKillingSpree: number;
  lastPlayed: number;
  masteryScore: number;
}

interface ChampionMasteryCardProps {
  region: string;
  name: string;
  tag: string;
}

interface MasteryItemProps {
  champion: ChampionMasteryData;
  index: number;
  maxMastery: number;
  getWinRateColor: (winRate: number) => 'success' | 'warning' | 'danger';
}

function MasteryItem({ champion, index }: MasteryItemProps) {
  const championImageUrl = useChampionImage(champion.championId, 'square');

  return (
    <motion.div
      key={champion.championId}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: index * 0.05 }}
      className="flex flex-col items-center text-center p-3"
    >
      <div className="relative mb-3">
        <Avatar
          src={championImageUrl}
          alt={champion.championName}
          className="size-15 border-2 border-neutral-600"
          radius="lg"
        />
        {index === 0 && (
          <div className="absolute -top-1 -right-1 p-1 bg-gradient-to-br from-yellow-400 to-yellow-600 rounded-full border-2 border-neutral-900">
            <Crown className="w-3 h-3 text-white" />
          </div>
        )}
      </div>

      <div className="space-y-1">
        <h4 className="font-semibold text-sm text-neutral-100 truncate max-w-[80px]">
          {champion.championName}
        </h4>
        <p className="text-xs text-neutral-300">
          {champion.wins}W - {champion.losses}L
        </p>
        <p className="text-xs text-neutral-400">
          {champion.avgKda.toFixed(1)} KDA
        </p>
      </div>
    </motion.div>
  );
}

export function ChampionMasteryCard({
  region,
  name,
  tag,
}: ChampionMasteryCardProps) {
  const { data: champions, isLoading } = useQuery({
    queryKey: ['champion-mastery', region, name, tag],
    queryFn: async () => {
      const res = await http.get<ChampionMasteryData[]>(
        `/v1/${encodeURIComponent(region)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}/champion-mastery?limit=3`,
      );
      return res.data;
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
  if (isLoading || !champions) {
    return (
      <Card className="h-full">
        <CardBody className="p-6">
          <div className="animate-pulse space-y-4">
            <div className="h-6 bg-gray-300 rounded w-1/2" />
            {Array.from({ length: 3 }, (_, i) => (
              <div
                key={`loading-champion-skeleton-${i + 1}`}
                className="flex items-center space-x-3"
              >
                <div className="w-12 h-12 bg-gray-300 rounded-full" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 bg-gray-300 rounded w-3/4" />
                  <div className="h-3 bg-gray-300 rounded w-1/2" />
                </div>
              </div>
            ))}
          </div>
        </CardBody>
      </Card>
    );
  }

  const getWinRateColor = (winRate: number) => {
    if (winRate >= 60) return 'success';
    if (winRate >= 50) return 'warning';
    return 'danger';
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: 0.2 }}
      className="h-full"
    >
      <Card className="h-full bg-neutral-900/90 backdrop-blur-sm border border-neutral-700/60 shadow-soft-lg hover:shadow-soft-xl transition-all duration-200">
        <CardBody className="p-8 h-full flex flex-col">
          <div className="flex items-center gap-4 mb-6 shrink-0">
            <div className="p-3 bg-gradient-to-br from-accent-purple-900/30 to-accent-emerald-900/30 rounded-xl">
              <MasteryIcon className="w-6 h-6 text-accent-purple-400" />
            </div>
            <div>
              <h3 className="text-xl font-display font-bold text-neutral-50">
                Champion Performance
              </h3>
              <p className="text-sm text-neutral-400">
                Top performing champions
              </p>
            </div>
          </div>

          <div className="flex-1 min-h-0 relative">
            <div className="grid grid-cols-3 gap-4">
              {(() => {
                const maxMastery = Math.max(
                  ...champions.map((c) => c.masteryScore),
                );
                return champions
                  .slice(0, 3)
                  .map((champion, index) => (
                    <MasteryItem
                      key={champion.championId}
                      champion={champion}
                      index={index}
                      maxMastery={maxMastery}
                      getWinRateColor={getWinRateColor}
                    />
                  ));
              })()}
            </div>
          </div>

          {champions.length === 0 && (
            <div className="text-center py-8 text-gray-500">
              <Star className="w-12 h-12 mx-auto mb-2 opacity-50" />
              <p>No champion data found</p>
            </div>
          )}
        </CardBody>
      </Card>
    </motion.div>
  );
}
