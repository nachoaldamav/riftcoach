import { useDataDragon } from '@/providers/data-dragon-provider';
import { rewindBadgesQueryOptions } from '@/queries/get-rewind-badges';
import {
  type RewindProfile,
  fetchRewindProfile,
  rewindProfileQueryOptions,
} from '@/queries/get-rewind-profile';
import { Badge, Card, CardBody } from '@heroui/react';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { motion } from 'framer-motion';

export const Route = createFileRoute('/rewind/$id')({
  loader: async ({ params }) => {
    const { id } = params;

    if (!id) {
      throw new Error('Rewind job ID is required');
    }

    try {
      const profile = await fetchRewindProfile(id);

      return {
        id,
        profile,
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to load rewind profile.';

      return {
        id,
        profile: null as RewindProfile | null,
        error: message,
      };
    }
  },
  head: ({ loaderData }) => {
    const profile = loaderData?.profile ?? null;

    const title = profile
      ? `Riftcoach | ${profile.gameName}#${profile.tagLine} Year in Review`
      : 'Riftcoach | League of Legends Year in Review';
    const description = profile
      ? `Explore ${profile.gameName}#${profile.tagLine}'s personalized League of Legends rewind with performance highlights, role insights, and achievements.`
      : 'Explore your personalized League of Legends rewind with performance highlights, role insights, and achievements.';

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
  component: RewindPage,
});

function RewindPage() {
  const { id } = Route.useParams();
  const { getProfileIconUrl } = useDataDragon();
  const { profile: initialProfile } = Route.useLoaderData() as {
    id: string;
    profile: RewindProfile | null;
    error?: string;
  };

  // Fetch profile data
  const profileQueryOptions = rewindProfileQueryOptions(id);
  const {
    data: profile,
    isLoading: profileLoading,
    error: profileError,
  } = useQuery({
    ...profileQueryOptions,
    initialData: initialProfile ?? undefined,
  });

  // Fetch badges data
  const {
    data: badges,
    isLoading: badgesLoading,
    error: badgesError,
  } = useQuery(rewindBadgesQueryOptions(id));

  const isLoading = profileLoading || badgesLoading;
  const hasError = profileError || badgesError;

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center">
        <div className="text-center space-y-4">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-400 mx-auto" />
          <p className="text-slate-300">Loading your year in review...</p>
        </div>
      </div>
    );
  }

  if (hasError) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center">
        <div className="text-center space-y-4">
          <p className="text-red-400">Failed to load your year in review</p>
          <p className="text-slate-400">Please try again later</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      <div className="relative">
        {/* Background Effects */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-blue-900/20 via-transparent to-transparent" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom_right,_var(--tw-gradient-stops))] from-purple-900/20 via-transparent to-transparent" />

        {/* Content */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8 }}
          className="relative z-10 px-4 py-12"
        >
          <div className="max-w-6xl mx-auto space-y-8">
            {/* Header Section */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.2 }}
              className="text-center space-y-4"
            >
              <h1 className="text-4xl md:text-6xl font-bold bg-gradient-to-r from-blue-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">
                Year in Review
              </h1>
              <p className="text-xl text-slate-300 max-w-2xl mx-auto">
                Discover your League of Legends journey through data-driven
                insights and achievements
              </p>
            </motion.div>

            {/* Profile Section */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.4 }}
            >
              <Card className="bg-slate-800/50 border-slate-700/50 backdrop-blur-sm">
                <CardBody className="p-8">
                  <div className="flex items-center space-x-6">
                    {/* Profile Icon */}
                    <div className="relative">
                      <img
                        src={getProfileIconUrl(profile?.profileIconId || 1)}
                        alt="Profile Icon"
                        className="w-24 h-24 rounded-full border-4 border-blue-400/50"
                      />
                      <div className="absolute -bottom-2 -right-2 bg-blue-500 text-white text-sm font-bold px-2 py-1 rounded-full">
                        {profile?.summonerLevel || 0}
                      </div>
                    </div>

                    {/* Profile Info */}
                    <div className="flex-1">
                      <div className="inline-flex items-center justify-start gap-2">
                        <h2 className="text-3xl font-bold text-white mb-2">
                          {profile?.gameName}
                        </h2>
                        <p className="text-2xl text-slate-300/75">
                          #{profile?.tagLine}
                        </p>
                      </div>

                      {/* Quick Stats */}
                      <div className="grid grid-cols-3 gap-4">
                        <div className="text-center">
                          <div className="text-2xl font-bold text-blue-400">
                            {badges?.playerPerRole?.reduce(
                              (total, role) => total + role.games,
                              0,
                            ) || 0}
                          </div>
                          <div className="text-sm text-slate-400">
                            Total Games
                          </div>
                        </div>
                        <div className="text-center">
                          <div className="text-2xl font-bold text-green-400">
                            {badges?.playerPerRole &&
                            badges.playerPerRole.length > 0
                              ? Math.round(
                                  (badges.playerPerRole.reduce(
                                    (sum, role) =>
                                      sum +
                                      role.win_rate_pct_estimate * role.games,
                                    0,
                                  ) /
                                    badges.playerPerRole.reduce(
                                      (sum, role) => sum + role.games,
                                      0,
                                    )) *
                                    100,
                                )
                              : 0}
                            %
                          </div>
                          <div className="text-sm text-slate-400">Win Rate</div>
                        </div>
                        <div className="text-center">
                          <div className="text-2xl font-bold text-purple-400">
                            {badges?.playerPerRole &&
                            badges.playerPerRole.length > 0
                              ? (
                                  badges.playerPerRole.reduce(
                                    (sum, role) =>
                                      sum + role.avg_kda * role.games,
                                    0,
                                  ) /
                                  badges.playerPerRole.reduce(
                                    (sum, role) => sum + role.games,
                                    0,
                                  )
                                ).toFixed(2)
                              : '0.00'}
                          </div>
                          <div className="text-sm text-slate-400">
                            Average KDA
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </CardBody>
              </Card>
            </motion.div>

            {/* Playstyle Badges Section */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.6 }}
            >
              <Card className="bg-slate-800/50 border-slate-700/50 backdrop-blur-sm">
                <CardBody className="p-8">
                  <h3 className="text-2xl font-bold text-white mb-6">
                    Your Playstyle
                  </h3>
                  {badges && badges.badges.length > 0 ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {badges.badges.map((badge, index) => (
                        <motion.div
                          key={badge.name}
                          initial={{ opacity: 0, scale: 0.9 }}
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{
                            duration: 0.4,
                            delay: 0.8 + index * 0.1,
                          }}
                          className="bg-slate-700/50 rounded-lg p-4 border border-slate-600/50"
                        >
                          <div className="flex items-center space-x-3">
                            <div className="w-12 h-12 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center">
                              <span className="text-white font-bold text-lg">
                                {badge.name.charAt(0).toUpperCase()}
                              </span>
                            </div>
                            <div className="flex-1">
                              <h4 className="font-semibold text-white">
                                {badge.name}
                              </h4>
                              <p className="text-sm text-slate-400">
                                {badge.description}
                              </p>
                              <Badge
                                variant="flat"
                                color="primary"
                                className="mt-2"
                              >
                                Playstyle Badge
                              </Badge>
                            </div>
                          </div>
                        </motion.div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-center py-8">
                      <p className="text-slate-400">
                        No playstyle badges available yet
                      </p>
                    </div>
                  )}
                </CardBody>
              </Card>
            </motion.div>

            {/* Coming Soon Section */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.8 }}
              className="text-center py-12"
            >
              <div className="bg-gradient-to-r from-blue-500/10 to-purple-500/10 rounded-2xl p-8 border border-blue-500/20">
                <h3 className="text-3xl font-bold text-white mb-4">
                  More Insights Coming Soon
                </h3>
                <p className="text-slate-300 mb-6 max-w-2xl mx-auto">
                  We're working on bringing you detailed match analysis,
                  champion mastery insights, performance trends, and much more
                  to complete your year in review.
                </p>
                <div className="flex justify-center space-x-4">
                  <Badge
                    variant="flat"
                    color="primary"
                    className="text-blue-400"
                  >
                    Match Analysis
                  </Badge>
                  <Badge
                    variant="flat"
                    color="secondary"
                    className="text-purple-400"
                  >
                    Champion Insights
                  </Badge>
                  <Badge
                    variant="flat"
                    color="warning"
                    className="text-pink-400"
                  >
                    Performance Trends
                  </Badge>
                </div>
              </div>
            </motion.div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
