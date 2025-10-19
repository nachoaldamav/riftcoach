import { http } from '@/clients/http';
import { MatchHistoryIcon } from '@/components/icons/CustomIcons';
import { useChampionImage } from '@/providers/data-dragon-provider';
import { Avatar, Card, CardBody, Chip } from '@heroui/react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { Clock, Shield, Sword, Target } from 'lucide-react';

interface RecentMatch {
  matchId: string;
  gameCreation: number;
  gameDuration: number;
  gameMode: string;
  queueId: number;
  player: {
    championId: number;
    championName: string;
    teamPosition: string;
    kills: number;
    deaths: number;
    assists: number;
    cs: number;
    gold: number;
    damage: number;
    visionScore: number;
    win: boolean;
    items: number[];
  };
  opponent?: {
    championId: number;
    championName: string;
    kills: number;
    deaths: number;
    assists: number;
  };
  kda: number;
  csPerMin: number;
  goldPerMin: number;
  damagePerMin: number;
  visionPerMin: number;
}

interface RecentMatchesCardProps {
  region: string;
  name: string;
  tag: string;
}

interface MatchItemProps {
  match: RecentMatch;
  index: number;
  formatGameDuration: (seconds: number) => string;
  getTimeAgo: (timestamp: number) => string;
}

function MatchItem({
  match,
  index,
  formatGameDuration,
  getTimeAgo,
}: MatchItemProps) {
  const championImageUrl = useChampionImage(match.player.championId, 'square');

  return (
    <motion.div
      key={match.matchId}
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.2, delay: index * 0.05 }}
      className="flex items-center gap-4 p-4 bg-neutral-800/50 rounded-xl border border-neutral-700/50 hover:bg-neutral-800/70 transition-all duration-150"
    >
      <div className="relative flex-shrink-0">
        <Avatar
          src={championImageUrl}
          alt={match.player.championName}
          className="w-16 h-16 border-2 border-neutral-700"
          radius="lg"
        />
        <div
          className={`absolute -top-1 -right-1 w-5 h-5 rounded-full border-2 border-neutral-900 ${
            match.player.win ? 'bg-accent-emerald-500' : 'bg-red-500'
          }`}
        />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-1">
          <span className="font-semibold text-sm text-neutral-100 truncate">
            {match.player.championName}
          </span>
          <span className="text-xs font-medium text-neutral-400">
            {getTimeAgo(match.gameCreation)}
          </span>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-neutral-400">
              {match.player.kills}/{match.player.deaths}/{match.player.assists}
            </span>
            <span className="text-xs text-neutral-500">•</span>
            <span className="text-xs text-neutral-500">
              {formatGameDuration(match.gameDuration)}
            </span>
          </div>

          <div
            className={`px-2 py-1 rounded-md text-xs font-semibold ${
              match.player.win
                ? 'bg-accent-emerald-900/30 text-accent-emerald-400'
                : 'bg-red-900/30 text-red-400'
            }`}
          >
            {match.player.win ? 'Victory' : 'Defeat'}
          </div>
        </div>
      </div>
    </motion.div>
  );
}

export function RecentMatchesCard({
  region,
  name,
  tag,
}: RecentMatchesCardProps) {
  const { data: matches, isLoading } = useQuery({
    queryKey: ['recent-matches', region, name, tag],
    queryFn: async () => {
      const res = await http.get<RecentMatch[]>(
        `/v1/${encodeURIComponent(region)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}/recent-matches?limit=5`,
      );
      return res.data;
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
  if (isLoading || !matches) {
    return (
      <Card className="h-full">
        <CardBody className="p-6">
          <div className="animate-pulse space-y-4">
            <div className="h-6 bg-gray-300 rounded w-1/2" />
            {Array.from({ length: 3 }, (_, i) => (
              <div
                key={`loading-match-skeleton-${i + 1}`}
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

  const formatGameDuration = (seconds: number) => {
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m`;
  };

  const getTimeAgo = (timestamp: number) => {
    const now = Date.now();
    const diff = now - timestamp;
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    return 'Recently';
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: 0.1 }}
      className="h-full"
    >
      <Card className="h-full bg-neutral-900/90 backdrop-blur-sm border border-neutral-700/60 shadow-soft-lg hover:shadow-soft-xl transition-all duration-200">
        <CardBody className="p-8 h-full flex flex-col">
          <div className="flex items-center gap-4 mb-6 shrink-0">
            <div className="p-3 bg-gradient-to-br from-accent-blue-900/30 to-accent-purple-900/30 rounded-xl">
              <MatchHistoryIcon className="w-6 h-6 text-accent-blue-400" />
            </div>
            <div>
              <h3 className="text-xl font-display font-bold text-neutral-50">
                Recent Matches
              </h3>
              <p className="text-sm text-neutral-400">
                Latest game performance
              </p>
            </div>
          </div>

          <div className="space-y-3 flex-1 min-h-0 overflow-y-auto scrollbar-thin scrollbar-thumb-neutral-600">
            {matches.slice(0, 5).map((match, index) => (
              <MatchItem
                key={match.matchId}
                match={match}
                index={index}
                formatGameDuration={formatGameDuration}
                getTimeAgo={getTimeAgo}
              />
            ))}
          </div>

          {matches.length === 0 && (
            <div className="text-center py-8 text-gray-500">
              <Target className="w-12 h-12 mx-auto mb-2 opacity-50" />
              <p>No recent matches found</p>
            </div>
          )}
        </CardBody>
      </Card>
    </motion.div>
  );
}
