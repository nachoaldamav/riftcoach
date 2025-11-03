import { http } from '@/clients/http';
import { ScanStatusBox } from '@/components/scan-status-box';
import { Avatar, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
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
import type { RewindStatusResponse } from '@/routes/$region/$name/$tag';
import { useMutation } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import { RefreshCw, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

interface NavbarProps {
  status?: RewindStatusResponse | null;
  wsConnected?: boolean;
}

export function Navbar({ status, wsConnected = false }: NavbarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { getProfileIconUrl } = useDataDragon();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [results, setResults] = useState<
    Array<{
      id: string;
      puuid: string;
      gameName: string | null;
      tagLine: string | null;
      summonerName: string | null;
      matchId: string | null;
      score: number | null;
      platform: string | null;
      pro?: {
        isPro: boolean;
        team?: string;
        position?: string;
        slug?: string;
        name?: string;
        image?: string;
      } | null;
    }>
  >([]);
  const [iconMap, setIconMap] = useState<Record<string, string | null>>({});

  // Check if we're on a player profile page (/$region/$name/$tag pattern)
  const pathParts = location.pathname.split('/').filter(Boolean);
  const isPlayerProfilePage =
    pathParts.length >= 3 && !pathParts[0].startsWith('queue');

  const isProcessing = useMemo(() => {
    return (
      status && (status.status === 'processing' || status.status === 'listing')
    );
  }, [status]);
  const progressPercentage = useMemo(() => {
    if (!status || status.total <= 0) return 0;
    return Math.min((status.processed / status.total) * 100, 100);
  }, [status]);
  const displayNumber = useMemo(() => {
    if (!status) return 0;
    return status.position != null
      ? status.position
      : Math.round(progressPercentage);
  }, [status, progressPercentage]);

  const refreshMutation = useMutation({
    mutationFn: async () => {
      // Extract region, name, and tag from URL
      const [region, name, tag] = pathParts;
      if (!region || !name || !tag)
        throw new Error('Invalid player profile URL');

      // Trigger partial scan with force=false (partial scan)
      const res = await http.post(
        `/v1/${region}/${name}/${tag}/rewind?force=false`,
      );
      return res.data;
    },
    onSuccess: () => {
      setIsRefreshing(false);
      // Optionally show success message or redirect
    },
    onError: (err) => {
      setIsRefreshing(false);
      console.error('Failed to refresh rewind:', err);
    },
  });

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setIsSearchOpen((open) => !open);
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, []);

  const handleRefresh = () => {
    setIsRefreshing(true);
    refreshMutation.mutate();
  };

  // Debounced player search
  useEffect(() => {
    const q = searchQuery.trim();
    if (!isSearchOpen) return;
    if (q.length < 2) {
      setResults([]);
      setSearchError(null);
      setSearchLoading(false);
      return;
    }

    setSearchLoading(true);
    setSearchError(null);
    const t = setTimeout(async () => {
      try {
        const res = await http.get<{
          query: string;
          skip: number;
          limit: number;
          results: Array<{
            id: string;
            puuid: string;
            gameName: string | null;
            tagLine: string | null;
            summonerName: string | null;
            matchId: string | null;
            score: number | null;
            platform: string | null;
            pro?: {
              isPro: boolean;
              team?: string;
              position?: string;
              slug?: string;
              name?: string;
              image?: string;
            } | null;
          }>;
        }>(`/v1/players/search?q=${encodeURIComponent(q)}&limit=10`);
        setResults(res.data.results ?? []);
      } catch (err) {
        console.error('Search failed', err);
        setSearchError('Failed to search players');
      } finally {
        setSearchLoading(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [searchQuery, isSearchOpen]);

  // Fetch profile icons for visible results
  useEffect(() => {
    if (!isSearchOpen) return;
    // Only fetch icons for results that haven't been processed yet.
    // Using existence check instead of truthiness prevents re-fetching entries set to null.
    const missing = results.filter((r) => !(r.id in iconMap));
    if (missing.length === 0) return;

    const fetchIcons = async () => {
      const updates: Record<string, string | null> = {};
      await Promise.all(
        missing.map(async (r) => {
          const region = r.platform ?? '';
          const name = r.gameName ?? '';
          const tag = r.tagLine ?? '';
          if (!region || !name || !tag) {
            updates[r.id] = null;
            return;
          }
          try {
            const res = await http.get<{
              profileIconId: number;
            }>(
              `/v1/${encodeURIComponent(region)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`,
            );
            const iconUrl = getProfileIconUrl(res.data.profileIconId);
            updates[r.id] = iconUrl;
          } catch (err) {
            console.warn('Icon fetch failed', { r, err });
            updates[r.id] = null;
          }
        }),
      );
      if (Object.keys(updates).length) {
        setIconMap((prev) => ({ ...prev, ...updates }));
      }
    };
    void fetchIcons();
  }, [results, isSearchOpen, getProfileIconUrl, iconMap]);

  const handleNavigateToProfile = (r: {
    platform: string | null;
    gameName: string | null;
    tagLine: string | null;
  }) => {
    const region = r.platform ?? '';
    const name = r.gameName ?? '';
    const tag = r.tagLine ?? '';
    if (!region || !name || !tag) return;
    setIsSearchOpen(false);
    setSearchQuery('');
    setResults([]);
    navigate({ to: `/${region}/${name}/${tag}` });
  };

  // Inline component for circular progress ring
  const ProgressRing = ({ percent }: { percent: number }) => {
    const size = 28;
    const strokeWidth = 3;
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const clamped = Math.max(0, Math.min(100, percent));
    const offset = circumference * (1 - clamped / 100);
    return (
      <svg
        width={size}
        height={size}
        className="block"
        aria-hidden="true"
        focusable="false"
        role="img"
      >
        <title>{`Progress ${Math.round(percent)}%`}</title>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="rgba(148,163,184,0.35)" /* neutral-400/35 */
          strokeWidth={strokeWidth}
          fill="none"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="rgb(34,197,94)" /* emerald-500 */
          strokeWidth={strokeWidth}
          fill="none"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className="transition-[stroke-dashoffset] duration-300 ease-out"
        />
      </svg>
    );
  };

  return (
    <nav className="relative z-50 border-b border-neutral-700/50 bg-neutral-900/80 backdrop-blur-md">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          <Link
            to="/"
            className="flex items-center space-x-2 hover:opacity-80 transition-opacity"
          >
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-accent-blue-500 to-accent-blue-600" />
            <span className="text-xl font-bold text-neutral-50">Riftcoach</span>
          </Link>

          <div className="flex items-center gap-2">
            {/* Search Popover */}
            <Popover open={isSearchOpen} onOpenChange={setIsSearchOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="hidden sm:flex h-9 w-60 items-center gap-2 rounded-md border border-neutral-700 bg-neutral-800/60 px-3 text-sm text-neutral-300 hover:bg-neutral-700 focus:outline-none"
                  aria-label="Search players"
                >
                  <Search className="h-4 w-4" />
                  <span className="truncate">Search players…</span>
                  <span className="ml-auto text-[10px] text-neutral-400">
                    Ctrl K
                  </span>
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-[420px] p-0" align="end">
                <Command>
                  <CommandInput
                    value={searchQuery}
                    onValueChange={setSearchQuery}
                    placeholder="Search players by name or tag"
                    autoFocus
                  />
                  <CommandList>
                    {searchLoading ? (
                      <div className="px-3 py-2 text-sm text-neutral-400">
                        Searching…
                      </div>
                    ) : null}
                    {searchError ? (
                      <div className="px-3 py-2 text-sm text-red-400">
                        {searchError}
                      </div>
                    ) : null}
                    <CommandEmpty>No players found.</CommandEmpty>
                    {/* Pro Players group */}
                    <CommandGroup
                      heading="Pro Players"
                      className={
                        results.some((r) => r.pro?.isPro) ? '' : 'hidden'
                      }
                    >
                      {results
                        .filter((r) => r.pro?.isPro)
                        .map((r) => (
                          <CommandItem
                            key={r.id}
                            value={`${r.gameName ?? ''}#${r.tagLine ?? ''}`}
                            onSelect={() => handleNavigateToProfile(r)}
                          >
                            <Avatar className="h-6 w-6 rounded-lg border border-neutral-700 mr-2">
                              {iconMap[r.id] ? (
                                <AvatarImage
                                  src={iconMap[r.id] ?? undefined}
                                  alt={r.summonerName ?? r.gameName ?? ''}
                                />
                              ) : (
                                <div className="h-full w-full bg-neutral-700" />
                              )}
                            </Avatar>
                            <div className="flex flex-col">
                              <span className="text-neutral-100 text-sm">
                                {r.gameName && r.tagLine
                                  ? `${r.gameName}#${r.tagLine}`
                                  : (r.summonerName ?? r.gameName ?? 'Unknown')}
                                <Badge className="ml-2">PRO</Badge>
                              </span>
                              <span className="text-[11px] text-neutral-400">
                                {r.platform
                                  ? r.platform.toUpperCase()
                                  : 'UNKNOWN'}
                                {r.pro?.team || r.pro?.position ? (
                                  <>
                                    {' '}
                                    • {r.pro?.team ?? ''}
                                    {r.pro?.position
                                      ? ` • ${r.pro?.position}`
                                      : ''}
                                  </>
                                ) : null}
                              </span>
                            </div>
                          </CommandItem>
                        ))}
                    </CommandGroup>
                    {/* Regular Players group */}
                    <CommandGroup
                      heading="Players"
                      className={results.length ? '' : 'hidden'}
                    >
                      {results
                        .filter((r) => !r.pro?.isPro)
                        .map((r) => (
                          <CommandItem
                            key={r.id}
                            value={`${r.gameName ?? ''}#${r.tagLine ?? ''}`}
                            onSelect={() => handleNavigateToProfile(r)}
                          >
                            <Avatar className="h-6 w-6 rounded-lg border border-neutral-700 mr-2">
                              {iconMap[r.id] ? (
                                <AvatarImage
                                  src={iconMap[r.id] ?? undefined}
                                  alt={r.summonerName ?? r.gameName ?? ''}
                                />
                              ) : (
                                <div className="h-full w-full bg-neutral-700" />
                              )}
                            </Avatar>
                            <div className="flex flex-col">
                              <span className="text-neutral-100 text-sm">
                                {r.gameName && r.tagLine
                                  ? `${r.gameName}#${r.tagLine}`
                                  : (r.summonerName ?? r.gameName ?? 'Unknown')}
                              </span>
                              <span className="text-[11px] text-neutral-400">
                                {r.platform
                                  ? r.platform.toUpperCase()
                                  : 'UNKNOWN'}
                              </span>
                            </div>
                          </CommandItem>
                        ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>

            {isPlayerProfilePage && (
              <Button
                size="sm"
                variant="ghost"
                className="flex items-center gap-2 text-neutral-300 hover:text-white hover:bg-neutral-800 border border-neutral-700"
                onClick={handleRefresh}
                disabled={isRefreshing || !!isProcessing}
              >
                <RefreshCw
                  className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`}
                />
                {isRefreshing || !!isProcessing
                  ? 'Refreshing...'
                  : 'Refresh Data'}
              </Button>
            )}

            {/* Status Popover Trigger */}
            {isPlayerProfilePage && status && isProcessing && (
              <Popover open={isPopoverOpen} onOpenChange={setIsPopoverOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="relative h-9 w-9 rounded-md border border-neutral-700 bg-neutral-800/70 text-neutral-100 flex items-center justify-center hover:bg-neutral-700 focus:outline-none"
                    aria-label="Show scan status"
                  >
                    <ProgressRing percent={progressPercentage} />
                    <span className="absolute inset-0 grid place-items-center text-xs font-semibold">
                      {displayNumber}
                    </span>
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  className="w-80 p-0 border-transparent bg-transparent"
                  align="end"
                >
                  <ScanStatusBox
                    status={status}
                    wsConnected={wsConnected}
                    onClose={() => setIsPopoverOpen(false)}
                    inline
                  />
                </PopoverContent>
              </Popover>
            )}
          </div>
        </div>
      </div>
    </nav>
  );
}
