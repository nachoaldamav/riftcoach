import { http } from '@/clients/http';
import { useDataDragon } from '@/providers/data-dragon-provider';
import { generateProfileShareCard, type ShareMetric } from '@/utils/profile-share-card';
import { Button } from '@heroui/react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Loader2, Share2, X } from 'lucide-react';

interface SummonerSummary {
  profileIconId: number;
  name: string;
}

interface ProfileShareButtonProps {
  region: string;
  name: string;
  tag: string;
  summoner: SummonerSummary;
  badges?: Array<{ title: string }>;
}

interface OverviewData {
  winRate: number;
  avgKda: number;
  avgDamagePerMin: number;
  avgVisionPerMin: number;
  spiderChartData: Array<{
    metric: string;
    player: number;
    opponent: number;
    playerActual?: number;
    opponentActual?: number;
  }>;
}

interface ChampionInsightsResponse {
  championData: Array<{
    championId: number;
    championName: string;
    totalGames: number;
    winRate: number;
    avgKda: number;
  }>;
}

const DEFAULT_BACKGROUND =
  'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/assets/loadouts/summonerbacks/2024_preseason_hunter_premium_summoner_back.jpg';

export function ProfileShareButton({
  region,
  name,
  tag,
  summoner,
  badges,
}: ProfileShareButtonProps) {
  const { getProfileIconUrl, getChampionImageUrl } = useDataDragon();
  const [isOpen, setIsOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [downloadBlob, setDownloadBlob] = useState<Blob | null>(null);
  const activeObjectUrl = useRef<string | null>(null);

  const profileIconUrl = useMemo(() => {
    const url = getProfileIconUrl(summoner.profileIconId);
    return url || '/logo512.png';
  }, [getProfileIconUrl, summoner.profileIconId]);

  const { data: overviewData } = useQuery({
    queryKey: ['player-overview', region, name, tag, 'ALL', 'share-card'],
    enabled: isOpen,
    queryFn: async (): Promise<OverviewData> => {
      const res = await http.get<OverviewData>(
        `/v1/${encodeURIComponent(region)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}/overview`,
      );
      return res.data;
    },
    staleTime: 1000 * 60 * 10,
  });

  const { data: championInsights } = useQuery({
    queryKey: ['champion-insights', region, name, tag, 'share-card'],
    enabled: isOpen,
    queryFn: async (): Promise<ChampionInsightsResponse> => {
      const res = await http.get<ChampionInsightsResponse>(
        `/v1/${encodeURIComponent(region)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}/champion-insights`,
      );
      return res.data;
    },
    staleTime: 1000 * 60 * 10,
  });

  const topChampion = useMemo(() => {
    const data = championInsights?.championData ?? [];
    if (!data.length) return null;
    return [...data].sort((a, b) => b.totalGames - a.totalGames)[0];
  }, [championInsights?.championData]);

  const championSplashUrl = useMemo(() => {
    if (!topChampion) return DEFAULT_BACKGROUND;
    const splash = getChampionImageUrl(topChampion.championId, 'splash');
    return splash || DEFAULT_BACKGROUND;
  }, [getChampionImageUrl, topChampion]);

  const metrics = useMemo<ShareMetric[]>(() => {
    const data = overviewData?.spiderChartData ?? [];
    if (!data.length) {
      if (!overviewData) return [];
      return [
        { label: 'Win Rate', player: overviewData.winRate, cohort: overviewData.winRate, suffix: '%' },
        { label: 'Average KDA', player: overviewData.avgKda, cohort: overviewData.avgKda },
        {
          label: 'Damage Per Minute',
          player: overviewData.avgDamagePerMin,
          cohort: overviewData.avgDamagePerMin,
        },
      ];
    }

    const suffixForMetric = (label: string) => {
      const normalized = label.toLowerCase();
      if (normalized.includes('rate')) return '%';
      if (normalized.includes('vision')) return '';
      if (normalized.includes('per min') || normalized.includes('per minute')) return '';
      return '';
    };

    return data.slice(0, 3).map((entry) => ({
      label: entry.metric,
      player: entry.playerActual ?? entry.player,
      cohort: entry.opponentActual ?? entry.opponent,
      suffix: suffixForMetric(entry.metric),
    }));
  }, [overviewData]);

  useEffect(() => {
    if (!isOpen) return;
    if (!overviewData || (!topChampion && !championInsights) || !profileIconUrl) {
      return;
    }

    let cancelled = false;
    async function buildCard() {
      setIsGenerating(true);
      setGenerationError(null);

      try {
        const championName = topChampion?.championName ?? 'League Champion';
        const games = topChampion?.totalGames ?? 0;
        const winRate = topChampion?.winRate ?? overviewData.winRate ?? 0;
        const kda = topChampion?.avgKda ?? overviewData.avgKda ?? 0;
        const shareBadges = badges?.map((b) => b.title) ?? [];

        const { pngBlob } = await generateProfileShareCard({
          playerName: summoner.name ?? name,
          tagLine: tag,
          profileIconUrl,
          backgroundUrl: championSplashUrl || DEFAULT_BACKGROUND,
          champion: {
            name: championName,
            games,
            winRate,
            kda,
            splashUrl: championSplashUrl || DEFAULT_BACKGROUND,
          },
          metrics: metrics.length
            ? metrics
            : [
                { label: 'Win Rate', player: overviewData.winRate ?? 0, cohort: overviewData.winRate ?? 0, suffix: '%' },
                { label: 'Average KDA', player: overviewData.avgKda ?? 0, cohort: overviewData.avgKda ?? 0 },
              ],
          badges: shareBadges.length ? shareBadges : undefined,
        });

        const blobUrl = URL.createObjectURL(pngBlob);
        if (activeObjectUrl.current) {
          URL.revokeObjectURL(activeObjectUrl.current);
        }

        if (!cancelled) {
          activeObjectUrl.current = blobUrl;
          setPreviewUrl(blobUrl);
          setDownloadBlob(pngBlob);
        }
      } catch (error) {
        console.error('Failed to generate share card', error);
        if (!cancelled) {
          setGenerationError('We could not build the share card. Please try again.');
        }
      } finally {
        if (!cancelled) {
          setIsGenerating(false);
        }
      }
    }

    void buildCard();

    return () => {
      cancelled = true;
    };
  }, [
    isOpen,
    overviewData,
    topChampion,
    championInsights,
    profileIconUrl,
    championSplashUrl,
    badges,
    metrics,
    summoner.name,
    name,
    tag,
  ]);

  useEffect(() => {
    return () => {
      if (activeObjectUrl.current) {
        URL.revokeObjectURL(activeObjectUrl.current);
      }
    };
  }, []);

  const handleDownload = () => {
    if (!downloadBlob) return;
    const url = URL.createObjectURL(downloadBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${name}-${tag}-riftcoach.png`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <Button
        size="sm"
        variant="flat"
        className="bg-accent-blue-500/10 border border-accent-blue-400/40 text-accent-blue-100 hover:bg-accent-blue-500/20"
        startContent={<Share2 className="h-4 w-4" />}
        onPress={() => {
          setIsOpen(true);
        }}
      >
        Share Profile
      </Button>

      {isOpen ? (
        <div className="fixed inset-0 z-[70]">
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            role="button"
            tabIndex={0}
            aria-label="Close share preview"
            onClick={() => setIsOpen(false)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') {
                setIsOpen(false);
              }
            }}
          />
          <dialog
            open
            className="absolute left-1/2 top-1/2 flex w-[95vw] max-w-5xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-neutral-700/70 bg-neutral-950/95 shadow-2xl"
            aria-label="Share profile preview"
            onCancel={(event) => {
              event.preventDefault();
              setIsOpen(false);
            }}
          >
            <div className="flex items-center justify-between border-b border-neutral-800 px-6 py-4">
              <div className="flex flex-col">
                <span className="text-lg font-semibold text-neutral-50">Shareable Highlight Card</span>
                <span className="text-xs uppercase tracking-[0.25em] text-neutral-400">
                  Preview &amp; download
                </span>
              </div>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="rounded-full border border-neutral-700/60 p-2 text-neutral-300 transition hover:bg-neutral-800 hover:text-neutral-50"
                aria-label="Close share preview"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid gap-6 px-6 py-6 md:grid-cols-[1.4fr_1fr]">
              <div className="flex flex-col items-center justify-center">
                <div className="group relative w-full max-w-3xl perspective-1000">
                  <div
                    className="relative w-full transform-gpu rounded-3xl border border-accent-blue-400/20 bg-gradient-to-br from-accent-blue-500/10 via-accent-purple-500/10 to-transparent p-4 shadow-[0_35px_65px_-30px_rgba(59,130,246,0.45)] transition-transform duration-700 group-hover:-rotate-2 group-hover:scale-[1.01]"
                    style={{ transform: 'rotateX(6deg) rotateY(-8deg)' }}
                  >
                    <div className="relative overflow-hidden rounded-2xl bg-black/60">
                      {isGenerating ? (
                        <div className="flex h-[360px] items-center justify-center">
                          <Loader2 className="h-10 w-10 animate-spin text-accent-blue-400" />
                        </div>
                      ) : generationError ? (
                        <div className="flex h-[360px] flex-col items-center justify-center gap-3 px-6 text-center">
                          <span className="text-sm text-red-400">{generationError}</span>
                          <Button
                            size="sm"
                            variant="flat"
                            className="bg-red-500/10 text-red-200 hover:bg-red-500/20"
                            onPress={() => {
                              setGenerationError(null);
                              setIsGenerating(false);
                              setPreviewUrl(null);
                              setDownloadBlob(null);
                              void (async () => {
                                setIsGenerating(true);
                                try {
                                  const { pngBlob } = await generateProfileShareCard({
                                    playerName: summoner.name ?? name,
                                    tagLine: tag,
                                    profileIconUrl,
                                    backgroundUrl: championSplashUrl || DEFAULT_BACKGROUND,
                                    champion: {
                                      name: topChampion?.championName ?? 'League Champion',
                                      games: topChampion?.totalGames ?? 0,
                                      winRate: topChampion?.winRate ?? overviewData?.winRate ?? 0,
                                      kda: topChampion?.avgKda ?? overviewData?.avgKda ?? 0,
                                      splashUrl: championSplashUrl || DEFAULT_BACKGROUND,
                                    },
                                    metrics: metrics.length
                                      ? metrics
                                      : [
                                          {
                                            label: 'Win Rate',
                                            player: overviewData?.winRate ?? 0,
                                            cohort: overviewData?.winRate ?? 0,
                                            suffix: '%',
                                          },
                                        ],
                                    badges: badges?.map((b) => b.title) ?? undefined,
                                  });
                                  const blobUrl = URL.createObjectURL(pngBlob);
                                  if (activeObjectUrl.current) {
                                    URL.revokeObjectURL(activeObjectUrl.current);
                                  }
                                  activeObjectUrl.current = blobUrl;
                                  setPreviewUrl(blobUrl);
                                  setDownloadBlob(pngBlob);
                                } catch (error) {
                                  console.error('Failed to regenerate share card', error);
                                  setGenerationError('Still having trouble. Try refreshing the page.');
                                } finally {
                                  setIsGenerating(false);
                                }
                              })();
                            }}
                          >
                            Try again
                          </Button>
                        </div>
                      ) : previewUrl ? (
                        <img
                          src={previewUrl}
                          alt="Shareable profile card preview"
                          className="h-auto w-full"
                          loading="lazy"
                        />
                      ) : (
                        <div className="flex h-[360px] items-center justify-center text-sm text-neutral-400">
                          Preparing preview...
                        </div>
                      )}
                    </div>
                    <div className="pointer-events-none absolute inset-0 rounded-3xl border border-white/5" />
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-5">
                <div>
                  <h3 className="text-base font-semibold text-neutral-100">
                    Share highlights with your friends or team
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-neutral-400">
                    We blend your most played champion, cohort comparisons, and AI playstyle traits into a ready-to-share image.
                    Download it to drop into Discord, Twitter, or anywhere you show off your Riftcoach progress.
                  </p>
                </div>

                <div className="rounded-xl border border-neutral-800 bg-neutral-900/70 p-4 text-sm text-neutral-300">
                  <p className="font-semibold text-neutral-200">Includes</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-neutral-400">
                    <li>Player icon, Riot tag, and featured champion splash art</li>
                    <li>Key performance metrics versus your cohort</li>
                    <li>Top AI-identified playstyle badges</li>
                  </ul>
                </div>

                <div className="mt-auto flex flex-wrap items-center gap-3">
                  <Button
                    startContent={<Download className="h-4 w-4" />}
                    color="primary"
                    className="bg-accent-blue-500 text-white hover:bg-accent-blue-600"
                    isDisabled={!previewUrl || isGenerating}
                    onPress={handleDownload}
                  >
                    Download PNG
                  </Button>
                  <Button
                    variant="light"
                    className="text-neutral-300 hover:text-neutral-100"
                    onPress={() => setIsOpen(false)}
                  >
                    Close
                  </Button>
                  <span className="text-xs uppercase tracking-[0.2em] text-neutral-500">
                    {isGenerating ? 'Rendering preview…' : previewUrl ? 'Ready to share' : 'Loading data'}
                  </span>
                </div>
              </div>
            </div>
          </dialog>
        </div>
      ) : null}
    </>
  );
}
