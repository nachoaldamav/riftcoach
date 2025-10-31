import { http } from '@/clients/http';
import { ProfileShareButton } from '@/components/profile-share-button';
import { useDataDragon } from '@/providers/data-dragon-provider';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody } from '@/components/ui/card';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useQuery } from '@tanstack/react-query';
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
  isBadgesFetching?: boolean;
}

export function ProfileHeader({
  summoner,
  region,
  name,
  tag,
  badges,
  isBadgesLoading,
  isIdle,
  isBadgesFetching,
}: ProfileHeaderProps) {
  const { getProfileIconUrl } = useDataDragon();

  // Role icon helper (same logic as champions page)
  const getRoleIconUrl = (roleKey: string) => {
    if (roleKey === 'ALL')
      return 'https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-clash/global/default/assets/images/position-selector/positions/icon-position-fill.png';
    return `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-clash/global/default/assets/images/position-selector/positions/icon-position-${roleKey.toLowerCase()}.png`;
  };

  type ProCheckResponse = {
    isPro: boolean;
    team?: string;
    position?: string;
    slug?: string;
    name?: string;
    image?: string;
  };

  const { data: proInfo } = useQuery<ProCheckResponse>({
    queryKey: ['esports-pro-check', name, tag],
    queryFn: async () => {
      const res = await http.get<ProCheckResponse>(
        `/v1/esports/pro-check?name=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag)}`,
      );
      return res.data;
    },
    staleTime: 1000 * 60 * 10,
  });

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6 }}
      className="mb-8"
    >
      <Card className="bg-neutral-900/90 backdrop-blur-sm border border-neutral-700/60 shadow-soft-lg relative">
        <CardBody className="p-0">
          <div className="flex items-center gap-6 h-36">
            {/* Profile Icon */}
            <div className="relative mx-6">
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
                <span className="text-xl text-neutral-400">#{tag}</span>
                <ProfileShareButton
                  region={region}
                  name={name}
                  tag={tag}
                  summoner={{
                    name: summoner.name,
                    profileIconId: summoner.profileIconId,
                  }}
                  badges={badges?.map((b) => ({ title: b.title }))}
                />
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
                <TooltipProvider>
                  <div className="flex flex-wrap gap-3">
                    {badges.map((b, idx) => (
                      <Tooltip key={`${b.title}-hdr-${idx}`}>
                        <TooltipTrigger asChild>
                          <div className="relative overflow-hidden rounded-full">
                            <Badge
                              className={`${
                                (b.polarity ?? 'neutral') === 'good'
                                  ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-700 hover:bg-emerald-200 dark:hover:bg-emerald-800/40'
                                  : (b.polarity ?? 'neutral') === 'bad'
                                    ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-700 hover:bg-red-200 dark:hover:bg-red-800/40'
                                    : 'bg-slate-200 dark:bg-slate-800 text-slate-800 dark:text-slate-200 border border-slate-300 dark:border-slate-700 hover:bg-slate-300 dark:hover:bg-slate-700/40'
                              } font-semibold transition-colors duration-150 cursor-default px-4 py-2 relative`}
                            >
                              {b.title}
                            </Badge>
                            {isBadgesFetching && (
                              <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/20 to-transparent" />
                            )}
                          </div>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs bg-black/95 border border-white/10 text-neutral-100">
                          <div className="space-y-2">
                            <p className="text-sm font-semibold text-neutral-100">
                              {b.title}
                            </p>
                            <p className="text-xs text-neutral-300 leading-relaxed">
                              {b.reason}
                            </p>
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    ))}
                  </div>
                </TooltipProvider>
              ) : null}
            </div>

            {/* Pro player info blended into header (no link, no CTA) */}
            {proInfo?.isPro && proInfo.slug && (
              <div
                // biome-ignore lint/a11y/useSemanticElements: needs to be a div
                role="figure"
                aria-label={`Pro info for ${proInfo.name ?? name}`}
                className="relative overflow-hidden h-28 sm:h-36 min-w-[280px] w-[320px]"
              >
                {/* Background team logo for subtle branding */}
                <img
                  src={`https://d1wwggj2y1tr8j.cloudfront.net/${proInfo.slug}/logo.png`}
                  alt="team logo background"
                  className="pointer-events-none absolute left-10 top-0 h-full w-1/2 object-contain opacity-20 grayscale"
                />

                {/* Player portrait on the right with gradient fade */}
                {proInfo.image ? (
                  <img
                    src={`https://d1wwggj2y1tr8j.cloudfront.net/${proInfo.slug}/${proInfo.image}`}
                    alt={`${proInfo.name ?? name}`}
                    loading="lazy"
                    className="pointer-events-none absolute right-0 top-0 h-full w-[42%] object-cover object-center z-20"
                  />
                ) : null}
                <div className="absolute inset-y-0 right-0 w-[42%] bg-gradient-to-l from-neutral-900/80 to-transparent" />

                {/* Role icon */}

                {/* Content */}
                <div className="relative z-10 flex h-full items-end pl-12 pr-4 pb-4">
                  <div className="flex-1">
                    <div className="text-xl sm:text-2xl font-bold text-neutral-50 tracking-tight inline-flex gap-2 items-center">
                      {proInfo.position ? (
                        <img
                          src={getRoleIconUrl(proInfo.position)}
                          alt={`${proInfo.position} role icon`}
                          className="size-6"
                        />
                      ) : null}{' '}
                      {proInfo.name ?? name}
                    </div>
                    <div className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-300">
                      {name}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </CardBody>
      </Card>
    </motion.div>
  );
}
