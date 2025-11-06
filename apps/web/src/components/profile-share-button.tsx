import { http } from '@/clients/http';
import { Avatar, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useDataDragon } from '@/providers/data-dragon-provider';
import type { Champion } from '@/types/data-dragon';
import type { ShareMetric } from '@/utils/profile-share-card';
import * as Portal from '@radix-ui/react-portal';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Download, Loader2, Share2, X } from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react';

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

// Removed custom combobox in favor of Shadcn Popover + Command combobox

export function ProfileShareButton({
  region,
  name,
  tag,
  summoner,
  badges,
}: ProfileShareButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        aria-label="Share profile"
        className="rounded-full border border-neutral-700/60 p-2 text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100"
        onClick={() => {
          startTransition(() => setIsOpen(true));
        }}
      >
        <Share2 className="h-4 w-4" />
      </Button>

      {isOpen ? (
        <ProfileShareModal
          region={region}
          name={name}
          tag={tag}
          summoner={summoner}
          badges={badges}
          onClose={() => setIsOpen(false)}
        />
      ) : null}

      {isPending ? <span className="sr-only">Opening share modal…</span> : null}
    </>
  );
}

interface ProfileShareModalProps extends ProfileShareButtonProps {
  onClose: () => void;
}

const ProfileShareModal = memo(function ProfileShareModal({
  region,
  name,
  tag,
  summoner,
  badges,
  onClose,
}: ProfileShareModalProps) {
  const {
    champions,
    version,
    getProfileIconUrl,
    getChampionImageUrl,
    getChampionById,
  } = useDataDragon();

  const [isGenerating, setIsGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [downloadBlob, setDownloadBlob] = useState<Blob | null>(null);
  const [selectedChampionOverrideKey, setSelectedChampionOverrideKey] =
    useState<string | null>(null);
  const [selectedSkinOverrideNum, setSelectedSkinOverrideNum] = useState<
    number | null
  >(null);
  const [championList, setChampionList] = useState<Champion[]>([]);
  const [showOverrides, setShowOverrides] = useState(false);
  const [isChampionPickerOpen, setIsChampionPickerOpen] = useState(false);
  const [isSkinPickerOpen, setIsSkinPickerOpen] = useState(false);

  const [, startTransition] = useTransition();
  const activeObjectUrl = useRef<string | null>(null);
  const cardGenerationTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Defer champion list calculation to avoid blocking initial render
  useEffect(() => {
    if (!champions) {
      setChampionList([]);
      return;
    }

    startTransition(() => {
      const sorted = Object.values(champions).sort((a, b) =>
        a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }),
      );
      setChampionList(sorted);
    });
  }, [champions]);

  // Defer showing override controls slightly
  useEffect(() => {
    const timer = setTimeout(() => setShowOverrides(true), 100);
    return () => clearTimeout(timer);
  }, []);

  const selectedChampionData = useMemo(() => {
    if (!selectedChampionOverrideKey) return null;
    return getChampionById(selectedChampionOverrideKey) ?? null;
  }, [selectedChampionOverrideKey, getChampionById]);

  const profileIconUrl = useMemo(() => {
    const url = getProfileIconUrl(summoner.profileIconId);
    return url || '/logo512.png';
  }, [getProfileIconUrl, summoner.profileIconId]);

  const { data: overviewData } = useQuery({
    queryKey: ['player-overview', region, name, tag, 'ALL', 'share-card'],
    enabled: true,
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
    enabled: true,
    queryFn: async (): Promise<ChampionInsightsResponse> => {
      const res = await http.get<ChampionInsightsResponse>(
        `/v1/${encodeURIComponent(region)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}/champion-insights`,
      );
      return res.data;
    },
    staleTime: 1000 * 60 * 10,
  });

  const { data: skinOptions } = useQuery<Array<{ num: number; name: string }>>({
    queryKey: ['ddragon-champion-skins', version, selectedChampionData?.id],
    enabled: Boolean(version && selectedChampionData?.id),
    queryFn: async () => {
      const champId = selectedChampionData?.id;
      if (!champId || !version) return [];
      const res = await fetch(
        `https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion/${champId}.json`,
      );
      const json = (await res.json()) as {
        data: Record<
          string,
          {
            skins: Array<{ num: number; name?: string }>;
          }
        >;
      };
      const skins = json?.data?.[champId]?.skins ?? [];
      return skins.map((s) => ({
        num: Number(s.num),
        name: String(s.name ?? 'Default'),
      }));
    },
    staleTime: 1000 * 60 * 60 * 24,
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
      return '';
    };

    return data.slice(0, 3).map((entry) => ({
      label: entry.metric,
      player: entry.playerActual ?? entry.player,
      cohort: entry.opponentActual ?? entry.opponent,
      suffix: suffixForMetric(entry.metric),
    }));
  }, [overviewData]);

  // Debounced card generation
  useEffect(() => {
    if (!overviewData) return;
    if (!profileIconUrl) return;
    if (!topChampion && !championInsights) return;
    if (previewUrl) return;

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

    // Debounce card generation by 150ms to avoid blocking initial render
    cardGenerationTimerRef.current = setTimeout(() => {
      void buildCard();
    }, 150);

    return () => {
      cancelled = true;
      if (cardGenerationTimerRef.current) {
        clearTimeout(cardGenerationTimerRef.current);
      }
    };
  }, [
    overviewData,
    profileIconUrl,
    topChampion,
    championInsights,
    selectedChampionData,
    effectiveSplashUrl,
    metrics,
    badges,
    previewUrl,
    name,
    tag,
    region,
    summoner.name,
  ]);

  // Cleanup URL
  useEffect(() => {
    return () => {
      if (activeObjectUrl.current) {
        URL.revokeObjectURL(activeObjectUrl.current);
      }
    };
  }, []);

  const handleDownload = useCallback(() => {
    if (!downloadBlob) return;
    const url = URL.createObjectURL(downloadBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${name}-${tag}-riftcoach.png`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [downloadBlob, name, tag]);

  const handleResetOverrides = useCallback(() => {
    setSelectedChampionOverrideKey(null);
    setSelectedSkinOverrideNum(null);
    setPreviewUrl(null);
    setDownloadBlob(null);
  }, []);

  const handleChampionChange = useCallback((key: string | null) => {
    setSelectedChampionOverrideKey(key);
    setSelectedSkinOverrideNum(null);
    setPreviewUrl(null);
    setDownloadBlob(null);
  }, []);

  const handleSkinChange = useCallback((key: string | null) => {
    const num = key ? Number(key) : null;
    setSelectedSkinOverrideNum(
      Number.isFinite(Number(num)) ? Number(num) : null,
    );
    setPreviewUrl(null);
    setDownloadBlob(null);
  }, []);

  return typeof document !== 'undefined' ? (
    <Portal.Root>
      <div className="fixed inset-0 z-[70]">
        <div
          className="absolute inset-0 bg-black/70"
          role="button"
          tabIndex={0}
          aria-label="Close share preview"
          onClick={onClose}
          onKeyDown={(event) => {
            if (
              event.key === 'Escape' ||
              event.key === 'Enter' ||
              event.key === ' '
            ) {
              onClose();
            }
          }}
        />
        <dialog
          open
          className="absolute left-1/2 top-1/2 flex w-[95vw] max-w-5xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-neutral-700/70 bg-neutral-950/95 shadow-2xl"
          aria-label="Share profile preview"
          onCancel={(event) => {
            event.preventDefault();
            onClose();
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
              onClick={onClose}
              className="rounded-full border border-neutral-700/60 p-2 text-neutral-300 transition hover:bg-neutral-800 hover:text-neutral-50"
              aria-label="Close share preview"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="grid gap-6 px-6 py-6 md:grid-cols-[1.4fr_1fr]">
            {/* LEFT: preview */}
            <div className="flex flex-col items-center justify-center">
              <div className="relative w-full max-w-3xl">
                <div
                  className={`relative w-full rounded-3xl border border-accent-blue-400/20 bg-gradient-to-br from-accent-blue-500/10 via-accent-purple-500/10 to-transparent p-4 ${isGenerating ? '' : 'shadow-[0_35px_65px_-30px_rgba(59,130,246,0.45)]'}`}
                >
                  <div className="relative overflow-hidden rounded-2xl bg-black/60 min-h-[250px]">
                    {isGenerating ? (
                      <div className="flex h-full min-h-[250px] items-center justify-center">
                        <Loader2 className="h-10 w-10 motion-safe:animate-spin text-white" />
                      </div>
                    ) : generationError ? (
                      <div className="flex h-full min-h-[250px] flex-col items-center justify-center gap-3 px-6 text-center">
                        <span className="text-sm text-red-400">
                          {generationError}
                        </span>
                        <Button
                          size="sm"
                          variant="flat"
                          className="bg-red-500/10 text-red-200 hover:bg-red-500/20"
                          onClick={() => {
                            setPreviewUrl(null);
                            setDownloadBlob(null);
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
                        decoding="async"
                      />
                    ) : (
                      <div className="flex h-full min-h-[360px] items-center justify-center text-sm text-neutral-400">
                        Preparing preview...
                      </div>
                    )}
                  </div>
                  <div className="pointer-events-none absolute inset-0 rounded-3xl border border-white/5" />
                </div>
              </div>
            </div>

            {/* RIGHT: info + overrides */}
            <div className="flex flex-col gap-5">
              <div>
                <h3 className="text-base font-semibold text-neutral-100">
                  Share highlights with your friends or team
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-neutral-400">
                  We blend your most played champion, cohort comparisons, and AI
                  playstyle traits into a ready-to-share image.
                </p>
              </div>

              {/* Overrides - deferred rendering */}
              <div
                className={`rounded-xl border border-neutral-800 bg-neutral-900/70 p-4 transition-all duration-300 ${
                  showOverrides
                    ? 'opacity-100 translate-y-0'
                    : 'opacity-0 translate-y-2 pointer-events-none h-0 overflow-hidden p-0 border-0'
                }`}
              >
                <p className="text-sm font-semibold text-neutral-200">
                  Overrides
                </p>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  {/* Champion Combobox (Shadcn) */}
                  <div className="relative">
                    {/* biome-ignore lint/a11y/noLabelWithoutControl: <explanation> */}
                    <label className="block text-sm font-medium text-neutral-200 mb-1">
                      Champion
                    </label>
                    <Popover
                      open={isChampionPickerOpen}
                      onOpenChange={setIsChampionPickerOpen}
                    >
                      <PopoverTrigger asChild>
                        <Button
                          type="button"
                          variant="flat"
                          className="flex w-full items-center justify-between px-3 py-2 text-sm bg-neutral-800/50 border border-neutral-700 text-neutral-200 hover:bg-neutral-700"
                          aria-label="Champion combobox"
                        >
                          <div className="flex items-center gap-2">
                            {selectedChampionData ? (
                              <>
                                <Avatar className="h-5 w-5 rounded border border-neutral-700">
                                  <AvatarImage
                                    src={getChampionImageUrl(
                                      selectedChampionData.id,
                                      'square',
                                    )}
                                    alt={selectedChampionData.name}
                                  />
                                </Avatar>
                                <span>{selectedChampionData.name}</span>
                              </>
                            ) : (
                              <span className="text-neutral-400">
                                Select a champion
                              </span>
                            )}
                          </div>
                          <ChevronDown className="h-4 w-4 opacity-70" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="z-[80] p-0 w-[260px] bg-neutral-900 text-neutral-100 border border-neutral-800">
                        <Command className="bg-neutral-900 text-neutral-100 z-[100]">
                          <CommandInput placeholder="Search champion..." />
                          <CommandList>
                            <CommandEmpty>No champions found.</CommandEmpty>
                            <CommandGroup>
                              <CommandItem
                                onSelect={() => {
                                  handleChampionChange(null);
                                  setIsChampionPickerOpen(false);
                                }}
                              >
                                <div className="flex items-center gap-2">
                                  <span>Default</span>
                                </div>
                              </CommandItem>
                              {championList.map((champ) => (
                                <CommandItem
                                  key={champ.id}
                                  value={champ.name}
                                  onSelect={() => {
                                    handleChampionChange(champ.id);
                                    setIsChampionPickerOpen(false);
                                  }}
                                >
                                  <div className="flex items-center gap-2">
                                    <Avatar className="h-6 w-6 rounded-lg border border-neutral-700">
                                      <AvatarImage
                                        src={getChampionImageUrl(
                                          champ.id,
                                          'square',
                                        )}
                                        alt={champ.name}
                                      />
                                    </Avatar>
                                    <span>{champ.name}</span>
                                  </div>
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                  </div>

                  {/* Skin Combobox (Shadcn) */}
                  <div className="relative">
                    {/* biome-ignore lint/a11y/noLabelWithoutControl: <explanation> */}
                    <label className="block text-sm font-medium text-neutral-200 mb-1">
                      Skin
                    </label>
                    <Popover
                      open={Boolean(selectedChampionData) && isSkinPickerOpen}
                      onOpenChange={setIsSkinPickerOpen}
                    >
                      <PopoverTrigger asChild>
                        <Button
                          type="button"
                          variant="flat"
                          disabled={!selectedChampionData}
                          className="flex w-full items-center justify-between px-3 py-2 text-sm bg-neutral-800/50 border border-neutral-700 text-neutral-200 hover:bg-neutral-700 disabled:opacity-50 disabled:cursor-not-allowed"
                          aria-label="Skin combobox"
                        >
                          <div className="flex items-center gap-2">
                            <span>
                              {(() => {
                                const currentNum = selectedSkinOverrideNum ?? 0;
                                const currentSkin = (
                                  skinOptions ?? [{ num: 0, name: 'Default' }]
                                ).find((s) => s.num === currentNum);
                                return currentSkin?.name ?? 'Select a skin';
                              })()}
                            </span>
                          </div>
                          <ChevronDown className="h-4 w-4 opacity-70" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="z-[80] p-0 w-[260px] bg-neutral-900 text-neutral-100 border border-neutral-800">
                        <Command className="bg-neutral-900 text-neutral-100">
                          <CommandInput placeholder="Search skin..." />
                          <CommandList>
                            <CommandEmpty>No skins found.</CommandEmpty>
                            <CommandGroup>
                              {(
                                skinOptions ?? [{ num: 0, name: 'Default' }]
                              ).map((skin) => (
                                <CommandItem
                                  key={skin.num}
                                  value={skin.name}
                                  onSelect={() => {
                                    handleSkinChange(String(skin.num));
                                    setIsSkinPickerOpen(false);
                                  }}
                                >
                                  <span>{skin.name}</span>
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                  </div>
                </div>
                <div className="mt-3">
                  <Button
                    size="sm"
                    variant="flat"
                    className="bg-neutral-800/50 text-neutral-200 hover:bg-neutral-700"
                    onClick={handleResetOverrides}
                  >
                    Reset overrides
                  </Button>
                </div>
              </div>

              <div className="mt-auto flex flex-wrap items-center gap-3">
                <Button
                  className="flex items-center gap-2 bg-accent-blue-500 text-white hover:bg-accent-blue-600"
                  disabled={!previewUrl || isGenerating}
                  onClick={handleDownload}
                >
                  <Download className="h-4 w-4" />
                  Download PNG
                </Button>
                <Button
                  variant="ghost"
                  className="text-neutral-300 hover:text-neutral-100"
                  onClick={onClose}
                >
                  Close
                </Button>
                <span className="text-xs uppercase tracking-[0.2em] text-neutral-500 whitespace-nowrap">
                  {isGenerating
                    ? 'Generating…'
                    : previewUrl
                      ? 'Ready to share'
                      : 'Loading data'}
                </span>
              </div>
            </div>
          </div>
        </dialog>
      </div>
    </Portal.Root>
  ) : null;
});
