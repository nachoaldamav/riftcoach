import { http } from '@/clients/http';
import { useDataDragon } from '@/providers/data-dragon-provider';
import type { ShareMetric } from '@/utils/profile-share-card';
import { Avatar, Button, Select, SelectItem } from '@heroui/react';
import { useQuery } from '@tanstack/react-query';
import { Download, Loader2, Share2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

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
  const {
    champions,
    version,
    getProfileIconUrl,
    getChampionImageUrl,
    getChampionById,
  } = useDataDragon();
  const [isOpen, setIsOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [downloadBlob, setDownloadBlob] = useState<Blob | null>(null);
  const activeObjectUrl = useRef<string | null>(null);

  // Overrides for champion and skin
  const [selectedChampionOverrideKey, setSelectedChampionOverrideKey] =
    useState<string | null>(null);
  const [selectedSkinOverrideNum, setSelectedSkinOverrideNum] = useState<
    number | null
  >(null);

  const championList = useMemo(
    () =>
      champions
        ? Object.values(champions).sort((a, b) => a.name.localeCompare(b.name))
        : [],
    [champions],
  );

  const selectedChampionData = useMemo(() => {
    if (!selectedChampionOverrideKey) return null;
    return getChampionById(selectedChampionOverrideKey) ?? null;
  }, [selectedChampionOverrideKey, getChampionById]);

  interface ChampionSkin {
    num: number;
    name: string;
  }
  interface DDragonChampionData {
    data: Record<string, { skins: Array<{ num: number; name?: string }> }>;
  }
  const { data: skinOptions } = useQuery<ChampionSkin[]>({
    queryKey: ['ddragon-champion-skins', version, selectedChampionData?.id],
    enabled: Boolean(version && selectedChampionData?.id && isOpen),
    queryFn: async () => {
      const champId = selectedChampionData?.id;
      if (!champId) return [];
      const res = await fetch(
        `https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion/${champId}.json`,
      );
      const json = (await res.json()) as DDragonChampionData;
      const skins: Array<{ num: number; name?: string }> =
        json?.data?.[champId]?.skins ?? [];
      return skins.map((s) => ({
        num: Number(s.num),
        name: String(s.name ?? 'Default'),
      }));
    },
    staleTime: 1000 * 60 * 60 * 24,
  });

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

  const championSplashUrlBase = useMemo(() => {
    if (!topChampion) return DEFAULT_BACKGROUND;
    const splash = getChampionImageUrl(topChampion.championId, 'centered');
    return splash || DEFAULT_BACKGROUND;
  }, [getChampionImageUrl, topChampion]);

  const effectiveSplashUrl = useMemo(() => {
    if (selectedChampionData) {
      const base = getChampionImageUrl(selectedChampionData.id, 'centered');
      const num = selectedSkinOverrideNum ?? 0;
      if (!base) return DEFAULT_BACKGROUND;
      return base.replace(/_\d+\.jpg$/, `_${num}.jpg`);
    }
    return championSplashUrlBase;
  }, [
    getChampionImageUrl,
    selectedChampionData,
    selectedSkinOverrideNum,
    championSplashUrlBase,
  ]);

  const metrics = useMemo<ShareMetric[]>(() => {
    const data = overviewData?.spiderChartData ?? [];
    if (!data.length) {
      if (!overviewData) return [];
      return [
        {
          label: 'Win Rate',
          player: overviewData.winRate,
          cohort: overviewData.winRate,
          suffix: '%',
        },
        {
          label: 'Average KDA',
          player: overviewData.avgKda,
          cohort: overviewData.avgKda,
        },
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
      if (normalized.includes('per min') || normalized.includes('per minute'))
        return '';
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
    // If we already have a preview, skip regeneration to avoid UI stalls
    if (previewUrl) return;
    if (
      !overviewData ||
      (!topChampion && !championInsights) ||
      !profileIconUrl
    ) {
      return;
    }

    let cancelled = false;
    async function buildCard() {
      setIsGenerating(true);
      setGenerationError(null);

      try {
        const overrideInsights = selectedChampionData
          ? ((championInsights?.championData ?? []).find(
              (c) => c.championId === Number(selectedChampionData.key),
            ) ?? null)
          : null;
        const championName =
          selectedChampionData?.name ??
          topChampion?.championName ??
          'League Champion';
        const games =
          overrideInsights?.totalGames ?? topChampion?.totalGames ?? 0;
        const winRate =
          overrideInsights?.winRate ??
          topChampion?.winRate ??
          overviewData?.winRate ??
          0;
        const kda =
          overrideInsights?.avgKda ??
          topChampion?.avgKda ??
          overviewData?.avgKda ??
          0;
        const shareBadges = badges?.map((b) => b.title) ?? [];
        // Call server-side generator
        const apiBase =
          import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') ?? '';
        const endpoint = `${apiBase}/v1/${encodeURIComponent(region)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}/share-card`;
        const payload = {
          playerName: summoner.name ?? name,
          tagLine: tag,
          profileIconUrl,
          backgroundUrl: effectiveSplashUrl || DEFAULT_BACKGROUND,
          champion: {
            name: championName,
            games,
            winRate,
            kda,
            splashUrl: effectiveSplashUrl || DEFAULT_BACKGROUND,
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
                {
                  label: 'Average KDA',
                  player: overviewData?.avgKda ?? 0,
                  cohort: overviewData?.avgKda ?? 0,
                },
              ],
          badges: shareBadges.length ? shareBadges : undefined,
        };

        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const errText = await res.text();
          throw new Error(
            `Share-card generation failed: ${res.status} ${res.statusText} ${errText}`,
          );
        }
        const pngBlob = await res.blob();
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
          setGenerationError(
            'We could not build the share card. Please try again.',
          );
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
    effectiveSplashUrl,
    badges,
    metrics,
    summoner.name,
    name,
    tag,
    previewUrl,
    selectedChampionData,
    region,
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
        variant="light"
        aria-label="Share profile"
        className="p-2 rounded-full border border-neutral-700/60 text-neutral-300 hover:text-neutral-100 hover:bg-neutral-800"
        onPress={() => {
          setIsOpen(true);
        }}
      >
        <Share2 className="h-4 w-4" />
      </Button>

      {isOpen && typeof document !== 'undefined'
        ? createPortal(
            <div className="fixed inset-0 z-[70]">
              <div
                className="absolute inset-0 bg-black/70 backdrop-blur-sm"
                role="button"
                tabIndex={0}
                aria-label="Close share preview"
                onClick={() => setIsOpen(false)}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Escape' ||
                    event.key === 'Enter' ||
                    event.key === ' '
                  ) {
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
                    <span className="text-lg font-semibold text-neutral-50">
                      Shareable Highlight Card
                    </span>
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
                        className="relative w-full rounded-3xl border border-accent-blue-400/20 bg-gradient-to-br from-accent-blue-500/10 via-accent-purple-500/10 to-transparent p-4 shadow-[0_35px_65px_-30px_rgba(59,130,246,0.45)]"
                        style={{ transform: 'rotateX(6deg) rotateY(-8deg)' }}
                      >
                        <div className="relative overflow-hidden rounded-2xl bg-black/60">
                          {isGenerating ? (
                            <div className="flex h-[360px] items-center justify-center">
                              <Loader2 className="h-10 w-10 animate-spin text-accent-blue-400" />
                            </div>
                          ) : generationError ? (
                            <div className="flex h-[360px] flex-col items-center justify-center gap-3 px-6 text-center">
                              <span className="text-sm text-red-400">
                                {generationError}
                              </span>
                              <Button
                                size="sm"
                                variant="flat"
                                className="bg-red-500/10 text-red-200 hover:bg-red-500/20"
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
                        We blend your most played champion, cohort comparisons,
                        and AI playstyle traits into a ready-to-share image.
                        Download it to drop into Discord, Twitter, or anywhere
                        you show off your Riftcoach progress.
                      </p>
                    </div>

                    <div className="rounded-xl border border-neutral-800 bg-neutral-900/70 p-4 text-sm text-neutral-300">
                      <p className="font-semibold text-neutral-200">Includes</p>
                      <ul className="mt-2 list-disc space-y-1 pl-5 text-neutral-400">
                        <li>
                          Player icon, Riot tag, and featured champion splash
                          art
                        </li>
                        <li>Key performance metrics versus your cohort</li>
                        <li>Top AI-identified playstyle badges</li>
                      </ul>
                    </div>

                    {/* Overrides */}
                    <div className="rounded-xl border border-neutral-800 bg-neutral-900/70 p-4">
                      <p className="text-sm font-semibold text-neutral-200">
                        Overrides
                      </p>
                      <div className="mt-3 grid gap-3 md:grid-cols-2">
                        <Select
                          aria-label="Champion override"
                          label="Champion"
                          size="sm"
                          className="bg-neutral-800/50"
                          selectedKeys={
                            selectedChampionOverrideKey
                              ? [selectedChampionOverrideKey]
                              : []
                          }
                          onSelectionChange={(keys) => {
                            const val = Array.from(keys)[0] as
                              | string
                              | undefined;
                            setSelectedChampionOverrideKey(val ?? null);
                            setSelectedSkinOverrideNum(null);
                            setPreviewUrl(null);
                            setDownloadBlob(null);
                          }}
                          renderValue={(items) => {
                            const item = items[0];
                            const champ = championList.find(
                              (c) => c.key === item?.key,
                            );
                            if (!champ) return null;
                            return (
                              <div className="flex items-center gap-2">
                                <Avatar
                                  src={getChampionImageUrl(champ.id, 'square')}
                                  className="w-5 h-5"
                                  radius="sm"
                                />
                                <span>{champ.name}</span>
                              </div>
                            );
                          }}
                        >
                          {championList.map((champ) => (
                            <SelectItem
                              key={champ.key}
                              textValue={champ.name}
                              startContent={
                                <Avatar
                                  src={getChampionImageUrl(champ.id, 'square')}
                                  className="w-5 h-5"
                                  radius="sm"
                                />
                              }
                            >
                              {champ.name}
                            </SelectItem>
                          ))}
                        </Select>

                        <Select
                          aria-label="Skin override"
                          label="Skin"
                          size="sm"
                          isDisabled={!selectedChampionData}
                          selectedKeys={
                            selectedSkinOverrideNum !== null
                              ? [String(selectedSkinOverrideNum)]
                              : []
                          }
                          onSelectionChange={(keys) => {
                            const val = Array.from(keys)[0] as
                              | string
                              | undefined;
                            const num = val ? Number(val) : null;
                            setSelectedSkinOverrideNum(
                              Number.isFinite(Number(num)) ? Number(num) : null,
                            );
                            setPreviewUrl(null);
                            setDownloadBlob(null);
                          }}
                          className="bg-neutral-800/50"
                          renderValue={(items) => {
                            const id = items[0]?.key
                              ? Number(items[0].key)
                              : null;
                            const skin = (skinOptions ?? []).find(
                              (s) => s.num === id,
                            );
                            return skin ? <span>{skin.name}</span> : null;
                          }}
                        >
                          {(skinOptions ?? [{ num: 0, name: 'Default' }]).map(
                            (skin) => (
                              <SelectItem
                                key={String(skin.num)}
                                textValue={skin.name}
                              >
                                {skin.name}
                              </SelectItem>
                            ),
                          )}
                        </Select>
                      </div>
                      <div className="mt-3">
                        <Button
                          size="sm"
                          variant="flat"
                          className="bg-neutral-800/50 text-neutral-200 hover:bg-neutral-700"
                          onPress={() => {
                            setSelectedChampionOverrideKey(null);
                            setSelectedSkinOverrideNum(null);
                            setPreviewUrl(null);
                            setDownloadBlob(null);
                          }}
                        >
                          Reset overrides
                        </Button>
                      </div>
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
                        {isGenerating
                          ? 'Rendering preview…'
                          : previewUrl
                            ? 'Ready to share'
                            : 'Loading data'}
                      </span>
                    </div>
                  </div>
                </div>
              </dialog>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
