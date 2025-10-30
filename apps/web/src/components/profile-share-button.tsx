import { http } from '@/clients/http';
import { useDataDragon } from '@/providers/data-dragon-provider';
import type { Champion } from '@/types/data-dragon';
import type { ShareMetric } from '@/utils/profile-share-card';
import { Avatar, Button } from '@heroui/react';
import * as Portal from '@radix-ui/react-portal';
import { useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
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

// Custom ComboBox component with HeroUI styling
interface ComboBoxProps<
  T = { key: string; name: string; [key: string]: unknown },
> {
  label: string;
  placeholder?: string;
  items: T[];
  selectedKey?: string | null;
  onSelectionChange: (key: string | null) => void;
  isDisabled?: boolean;
  renderItem?: (item: T) => React.ReactNode;
  renderValue?: (item: T) => React.ReactNode;
  getItemKey?: (item: T) => string;
  getItemName?: (item: T) => string;
}

function CustomComboBox<
  T = { key: string; name: string; [key: string]: unknown },
>({
  label,
  placeholder = 'Select an option',
  items,
  selectedKey,
  onSelectionChange,
  isDisabled = false,
  renderItem,
  renderValue,
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  getItemKey = (item: T) => (item as any).key || (item as any).id,
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  getItemName = (item: T) => (item as any).name,
}: ComboBoxProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const parentRef = useRef<HTMLDivElement>(null);

  const selectedItem = items.find((item) => getItemKey(item) === selectedKey);

  // TanStack Virtual configuration
  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 40,
    overscan: 5,
  });

  const handleToggle = useCallback(() => {
    if (!isDisabled) {
      if (!isOpen && buttonRef.current) {
        setButtonRect(buttonRef.current.getBoundingClientRect());
      }
      setIsOpen(!isOpen);
    }
  }, [isDisabled, isOpen]);

  const handleSelect = useCallback(
    (key: string) => {
      onSelectionChange(key);
      setIsOpen(false);
    },
    [onSelectionChange],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        handleToggle();
      } else if (event.key === 'Escape') {
        setIsOpen(false);
      }
    },
    [handleToggle],
  );

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        isOpen &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node) &&
        parentRef.current &&
        !parentRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () =>
        document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  return (
    <div className="relative">
      {/* biome-ignore lint/a11y/noLabelWithoutControl: <explanation> */}
      <label className="block text-sm font-medium text-neutral-200 mb-1">
        {label}
      </label>
      <div className="relative">
        <button
          ref={buttonRef}
          type="button"
          className={`
            flex items-center justify-between w-full px-3 py-2 text-sm text-left
            bg-neutral-800/50 border border-neutral-700 rounded-lg
            ${isDisabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:border-neutral-600 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-neutral-900'}
          `}
          onClick={handleToggle}
          onKeyDown={handleKeyDown}
          disabled={isDisabled}
          aria-label={`${label} dropdown`}
          aria-expanded={isOpen}
          aria-haspopup="listbox"
        >
          <div className="flex-1 text-left">
            {selectedItem && renderValue ? (
              renderValue(selectedItem)
            ) : selectedItem ? (
              <span className="text-neutral-200">
                {getItemName(selectedItem)}
              </span>
            ) : (
              <span className="text-neutral-400">{placeholder}</span>
            )}
          </div>
          <ChevronDown
            className={`h-4 w-4 text-neutral-400 transition-transform ${
              isOpen ? 'rotate-180' : ''
            }`}
          />
        </button>
      </div>

      {isOpen && buttonRect && (
        <Portal.Root container={document.body}>
          <div
            className="fixed z-[9999] bg-neutral-800 border border-neutral-700 rounded-lg shadow-lg"
            style={{
              top: buttonRect.bottom + window.scrollY + 4,
              left: buttonRect.left + window.scrollX,
              width: buttonRect.width,
              maxHeight: '240px',
            }}
          >
            <div
              ref={parentRef}
              className="overflow-auto"
              style={{ height: `${Math.min(240, items.length * 40)}px` }}
            >
              <div
                style={{
                  height: `${rowVirtualizer.getTotalSize()}px`,
                  width: '100%',
                  position: 'relative',
                }}
              >
                {rowVirtualizer.getVirtualItems().map((virtualItem) => {
                  const item = items[virtualItem.index];
                  if (!item) return null;

                  return (
                    // biome-ignore lint/a11y/useKeyWithClickEvents: <explanation>
                    <div
                      key={virtualItem.key}
                      className={`
                        absolute top-0 left-0 w-full px-3 py-2 text-sm cursor-pointer transition-colors
                        ${
                          selectedKey === getItemKey(item)
                            ? 'bg-blue-600 text-white'
                            : 'text-neutral-200 hover:bg-neutral-700'
                        }
                      `}
                      style={{
                        height: `${virtualItem.size}px`,
                        transform: `translateY(${virtualItem.start}px)`,
                      }}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        handleSelect(getItemKey(item));
                      }}
                      onClick={() => handleSelect(getItemKey(item))}
                    >
                      {renderItem ? renderItem(item) : getItemName(item)}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </Portal.Root>
      )}
    </div>
  );
}

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
        variant="light"
        aria-label="Share profile"
        className="p-2 rounded-full border border-neutral-700/60 text-neutral-300 hover:text-neutral-100 hover:bg-neutral-800"
        onPress={() => {
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
                <div className={`relative w-full rounded-3xl border border-accent-blue-400/20 bg-gradient-to-br from-accent-blue-500/10 via-accent-purple-500/10 to-transparent p-4 ${isGenerating ? '' : 'shadow-[0_35px_65px_-30px_rgba(59,130,246,0.45)]'}`}>
                  <div className="relative overflow-hidden rounded-2xl bg-black/60">
                    {isGenerating ? (
                      <div className="flex h-[360px] items-center justify-center">
                        <Loader2 className="h-10 w-10 motion-safe:animate-spin text-accent-blue-400" />
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
                          onPress={() => {
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
                      <div className="flex h-[360px] items-center justify-center text-sm text-neutral-400">
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

              <div className="rounded-xl border border-neutral-800 bg-neutral-900/70 p-4 text-sm text-neutral-300">
                <p className="font-semibold text-neutral-200">Includes</p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-neutral-400">
                  <li>Player icon, Riot tag, and champion splash art</li>
                  <li>Key performance metrics versus your cohort</li>
                  <li>Top AI-identified playstyle badges</li>
                </ul>
              </div>

              {/* Overrides - deferred rendering */}
              {showOverrides && (
                <div className="rounded-xl border border-neutral-800 bg-neutral-900/70 p-4">
                  <p className="text-sm font-semibold text-neutral-200">
                    Overrides
                  </p>
                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    <CustomComboBox
                      label="Champion"
                      placeholder="Select a champion"
                      items={[
                        { id: 'DEFAULT', name: 'Default' },
                        ...championList.map((c) => ({ id: c.id, name: c.name })),
                      ]}
                      selectedKey={selectedChampionOverrideKey ?? 'DEFAULT'}
                      onSelectionChange={handleChampionChange}
                      getItemKey={(champ) => champ.id}
                      getItemName={(champ) => champ.name}
                      renderValue={(champ) => (
                        champ.id === 'DEFAULT' ? (
                          <span>Default</span>
                        ) : (
                          <div className="flex items-center gap-2">
                            <Avatar
                              src={getChampionImageUrl(champ.id, 'square')}
                              className="w-5 h-5"
                              radius="sm"
                            />
                            <span>{champ.name}</span>
                          </div>
                        )
                      )}
                      renderItem={(champ) => (
                        <div className="flex items-center gap-2">
                          <span>{champ.name}</span>
                        </div>
                      )}
                    />

                    <CustomComboBox
                      label="Skin"
                      placeholder="Select a skin"
                      items={(skinOptions ?? [{ num: 0, name: 'Default' }]).map(
                        (skin) => ({
                          key: String(skin.num),
                          name: skin.name,
                          num: skin.num,
                        }),
                      )}
                      selectedKey={String(selectedSkinOverrideNum ?? 0)}
                      onSelectionChange={handleSkinChange}
                      isDisabled={!selectedChampionData}
                      renderValue={(skin) => <span>{skin.name}</span>}
                      renderItem={(skin) => <span>{skin.name}</span>}
                    />
                  </div>
                  <div className="mt-3">
                    <Button
                      size="sm"
                      variant="flat"
                      className="bg-neutral-800/50 text-neutral-200 hover:bg-neutral-700"
                      onPress={handleResetOverrides}
                    >
                      Reset overrides
                    </Button>
                  </div>
                </div>
              )}

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
                  onPress={onClose}
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
      </div>
    </Portal.Root>
  ) : null;
});
