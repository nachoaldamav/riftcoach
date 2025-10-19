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
  
  // Podium positioning: 2nd place (index 1), 1st place (index 0), 3rd place (index 2)
  const podiumOrder = [1, 0, 2];
  const podiumPosition = podiumOrder.indexOf(index) + 1;
  
  // Different sizes and heights based on position
  const getSizeClasses = (position: number) => {
    switch (position) {
      case 1: // 1st place (center, tallest)
        return {
          container: "flex flex-col items-center text-center p-4 mt-0",
          avatar: "size-20 border-3 border-yellow-400",
          crown: "w-4 h-4",
          crownBg: "bg-gradient-to-br from-yellow-400 to-yellow-600",
          nameSize: "text-base font-bold",
          statsSize: "text-sm",
          podiumHeight: "h-16 bg-gradient-to-t from-yellow-600/20 to-yellow-400/10 border-t-2 border-yellow-400"
        };
      case 2: // 2nd place (left, medium)
        return {
          container: "flex flex-col items-center text-center p-3 mt-4",
          avatar: "size-16 border-2 border-gray-400",
          crown: "w-3 h-3",
          crownBg: "bg-gradient-to-br from-gray-400 to-gray-600",
          nameSize: "text-sm font-semibold",
          statsSize: "text-xs",
          podiumHeight: "h-12 bg-gradient-to-t from-gray-600/20 to-gray-400/10 border-t-2 border-gray-400"
        };
      case 3: // 3rd place (right, smallest)
        return {
          container: "flex flex-col items-center text-center p-3 mt-8",
          avatar: "size-14 border-2 border-amber-600",
          crown: "w-3 h-3",
          crownBg: "bg-gradient-to-br from-amber-600 to-amber-800",
          nameSize: "text-sm font-medium",
          statsSize: "text-xs",
          podiumHeight: "h-8 bg-gradient-to-t from-amber-800/20 to-amber-600/10 border-t-2 border-amber-600"
        };
      default:
        return {
          container: "flex flex-col items-center text-center p-3",
          avatar: "size-12 border-2 border-neutral-600",
          crown: "w-3 h-3",
          crownBg: "bg-gradient-to-br from-neutral-400 to-neutral-600",
          nameSize: "text-xs",
          statsSize: "text-xs",
          podiumHeight: "h-6 bg-gradient-to-t from-neutral-600/20 to-neutral-400/10 border-t-2 border-neutral-400"
        };
    }
  };

  const classes = getSizeClasses(podiumPosition);

  return (
    <motion.div
      key={champion.championId}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: index * 0.1 }}
      className="flex flex-col justify-end h-full"
    >
      <div className={classes.container}>
        <div className="relative mb-3">
          <Avatar
            src={championImageUrl}
            alt={champion.championName}
            className={classes.avatar}
            radius="lg"
          />
          <div className={`absolute -top-1 -right-1 p-1 ${classes.crownBg} rounded-full border-2 border-neutral-900`}>
            <Crown className={`${classes.crown} text-white`} />
          </div>
        </div>

        <div className="space-y-1">
          <h4 className={`${classes.nameSize} text-neutral-100 truncate max-w-[100px]`}>
            {champion.championName}
          </h4>
          <p className={`${classes.statsSize} text-neutral-300`}>
            {champion.wins}W - {champion.losses}L
          </p>
          <p className={`${classes.statsSize} text-neutral-400`}>
            {champion.avgKda.toFixed(1)} KDA
          </p>
        </div>
      </div>
      
      {/* Podium base */}
      <div className={classes.podiumHeight} />
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
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.2 }}
        className="h-full"
      >
        <Card className="h-full bg-neutral-900/90 backdrop-blur-sm border border-neutral-700/60 shadow-soft-lg hover:shadow-soft-xl transition-all duration-200">
          <CardBody className="p-8">
            <div className="animate-pulse space-y-4">
              <div className="h-6 bg-neutral-700 rounded w-1/2" />
              {Array.from({ length: 3 }, (_, i) => (
                <div
                  key={`loading-champion-skeleton-${i + 1}`}
                  className="flex items-center space-x-3"
                >
                  <div className="w-12 h-12 bg-neutral-700 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 bg-neutral-700 rounded w-3/4" />
                    <div className="h-3 bg-neutral-700 rounded w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      </motion.div>
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
            <div className="grid grid-cols-3 gap-2 h-full items-end">
              {(() => {
                const maxMastery = Math.max(
                  ...champions.map((c) => c.masteryScore),
                );
                // Reorder champions for podium: 2nd, 1st, 3rd
                const podiumOrder = [champions[1], champions[0], champions[2]].filter(Boolean);
                return podiumOrder.map((champion, displayIndex) => {
                  const originalIndex = champions.findIndex(c => c.championId === champion.championId);
                  return (
                    <MasteryItem
                      key={champion.championId}
                      champion={champion}
                      index={originalIndex}
                      maxMastery={maxMastery}
                      getWinRateColor={getWinRateColor}
                    />
                  );
                });
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
