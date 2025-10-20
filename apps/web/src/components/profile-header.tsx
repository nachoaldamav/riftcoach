import { useDataDragon } from '@/providers/data-dragon-provider';
import { Card, CardBody, Chip, Tooltip } from '@heroui/react';
import { motion } from 'framer-motion';
import { Loader2 } from 'lucide-react';

interface SummonerSummary {
  id: string;
  name: string;
  profileIconId: number;
  summonerLevel: number;
}

interface BadgeItem {
  title: string;
  reason: string;
  polarity?: 'good' | 'bad' | 'neutral';
}

interface ProfileHeaderProps {
  summoner: SummonerSummary;
  region: string;
  name: string;
  tag: string;
  badges?: BadgeItem[];
  isBadgesLoading?: boolean;
  isIdle?: boolean;
}

export function ProfileHeader({ summoner, region, name, tag, badges, isBadgesLoading, isIdle }: ProfileHeaderProps) {
  const { getProfileIconUrl } = useDataDragon();

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6 }}
      className="mb-8"
    >
      <Card className="bg-neutral-900/90 backdrop-blur-sm border border-neutral-700/60 shadow-soft-lg">
        <CardBody className="p-6">
          <div className="flex items-center gap-6">
            {/* Profile Icon */}
            <div className="relative">
              <img
                src={getProfileIconUrl(summoner.profileIconId)}
                alt="Profile Icon"
                className="w-20 h-20 rounded-xl border-2 border-accent-blue-400/50"
              />
              <div className="absolute -bottom-2 -right-2 bg-accent-blue-500 text-white text-sm font-bold px-2 py-1 rounded-full">
                {summoner.summonerLevel}
              </div>
            </div>

            {/* Profile Info */}
            <div className="flex-1">
              <div className="flex items-baseline gap-2 mb-2">
                <h1 className="text-3xl font-display font-bold text-neutral-50">
                  {name}
                </h1>
                <span className="text-xl text-neutral-400">
                  #{tag}
                </span>
              </div>
              {/* Badges row (replacing region/level row) */}
              {isBadgesLoading && isIdle ? (
                <div className="flex items-center gap-3 px-4 py-2 bg-accent-blue-50 dark:bg-accent-blue-900/20 rounded-full border border-accent-blue-200 dark:border-accent-blue-800 w-fit">
                  <Loader2 className="w-4 h-4 text-accent-blue-600 dark:text-accent-blue-400 animate-spin" />
                  <span className="text-sm font-medium text-accent-blue-700 dark:text-accent-blue-300">
                    AI is analyzing your playstyle...
                  </span>
                </div>
              ) : badges && badges.length > 0 ? (
                <div className="flex flex-wrap gap-3">
                  {badges.map((b, idx) => (
                    <Tooltip
                      key={`${b.title}-hdr-${idx}`}
                      content={
                        <div className="max-w-xs text-left p-3">
                          <p className="text-sm font-semibold text-neutral-100 mb-2">{b.title}</p>
                          <p className="text-xs text-neutral-300 leading-relaxed">{b.reason}</p>
                        </div>
                      }
                      placement="top"
                      className="bg-black/95 border border-white/10 shadow-soft-lg"
                    >
                      <Chip
                        variant="flat"
                        color="default"
                        size="md"
                        className={`${(b.polarity ?? 'neutral') === 'good'
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
        </CardBody>
      </Card>
    </motion.div>
  );
}