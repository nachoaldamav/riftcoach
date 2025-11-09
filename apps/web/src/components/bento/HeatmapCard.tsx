import { http } from '@/clients/http';
import { ChampionImage } from '@/components/champion-image';
import { HeatmapOverlay } from '@/components/heatmap-overlay';
import { HeatmapIcon } from '@/components/icons/CustomIcons';
import { Card, CardBody } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarImage } from '@/components/ui/avatar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useDataDragon } from '@/providers/data-dragon-provider';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { ChevronDown, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

export interface HeatmapData {
  xBin: number;
  yBin: number;
  count: number;
  grid: number;
}

interface RoleChampStats {
  _id: string; // role key, e.g., 'MIDDLE'
  champs: Array<{
    championId: number;
    championName: string;
    games: number;
    wins: number;
    losses: number;
    winRate: number;
  }>;
}

interface HeatmapCardProps {
  region: string;
  name: string;
  tag: string;
}

export function HeatmapCard({ region, name, tag }: HeatmapCardProps) {
  const { champions, getChampionImageUrl } = useDataDragon();

  // Static role and mode lists
  const roles = [
    { key: 'TOP', label: 'Top', icon: '⚔️' },
    { key: 'JUNGLE', label: 'Jungle', icon: '🌲' },
    { key: 'MIDDLE', label: 'Middle', icon: '🏰' },
    { key: 'BOTTOM', label: 'Bottom', icon: '🏹' },
    { key: 'UTILITY', label: 'Support', icon: '🛡️' },
  ];

  const modes = [
    { key: 'kills', label: 'Kills', icon: '⚔️', color: 'success' },
    { key: 'deaths', label: 'Deaths', icon: '💀', color: 'danger' },
  ];

  const [selectedRole, setSelectedRole] = useState('BOTTOM');
  const [selectedChampion, setSelectedChampion] = useState<number | null>(null);
  const [selectedMode, setSelectedMode] = useState<'kills' | 'deaths'>('kills');
  const [hasUserSelectedRole, setHasUserSelectedRole] = useState(false);
  const [isRolePickerOpen, setIsRolePickerOpen] = useState(false);
  const [isChampionPickerOpen, setIsChampionPickerOpen] = useState(false);

  // Champion list from Data Dragon, sorted by name
  const championList = useMemo(
    () =>
      champions
        ? Object.values(champions).sort((a, b) => a.name.localeCompare(b.name))
        : [],
    [champions],
  );

  const { data: heatmapData, isLoading: isHeatmapLoading } = useQuery<
    HeatmapData[]
  >({
    queryKey: [
      'v1-heatmap',
      region,
      name,
      tag,
      selectedRole,
      selectedChampion,
      selectedMode,
    ],
    queryFn: async () => {
      const params: Record<string, string | number | boolean> = {
        role: selectedRole,
        mode: selectedMode,
      };
      if (selectedChampion !== null) {
        params.championId = selectedChampion;
      }
      const res = await http.get<HeatmapData[]>(
        `/v1/${encodeURIComponent(region)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}/heatmap`,
        {
          params,
        },
      );
      return res.data;
    },
    enabled: !!selectedRole,
  });

  const { data: champsStats } = useQuery<RoleChampStats[]>({
    queryKey: ['v1-champions-stats', region, name, tag],
    queryFn: async () => {
      const res = await http.get<RoleChampStats[]>(
        `/v1/${encodeURIComponent(region)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}/champions`,
      );
      return res.data;
    },
    staleTime: 1000 * 60 * 60 * 12,
    gcTime: 1000 * 60 * 60 * 24,
    retry: 2,
  });

  // Compute total games per role
  const roleGames = useMemo(() => {
    const map: Record<string, number> = {};
    for (const group of champsStats || []) {
      let total = 0;
      for (const c of group.champs) {
        total += c.games || 0;
      }
      map[group._id] = total;
    }
    return map;
  }, [champsStats]);

  // Disable roles with zero games
  const disabledRoleKeys = useMemo(() => {
    if (!champsStats) return [];
    return roles.filter((r) => (roleGames[r.key] || 0) === 0).map((r) => r.key);
  }, [champsStats, roleGames]);

  // Calculate the most played role based on roleGames
  const mostPlayedRole = useMemo(() => {
    if (!roleGames || Object.keys(roleGames).length === 0) return 'BOTTOM';
    return Object.entries(roleGames).reduce(
      (max, [role, games]) => (games > (roleGames[max] || 0) ? role : max),
      'BOTTOM',
    );
  }, [roleGames]);

  // Update selected role when most played role changes (only if user hasn't manually selected a role)
  useEffect(() => {
    if (
      !hasUserSelectedRole &&
      mostPlayedRole !== 'BOTTOM' &&
      !disabledRoleKeys.includes(mostPlayedRole)
    ) {
      setSelectedRole(mostPlayedRole);
    }
  }, [mostPlayedRole, hasUserSelectedRole, disabledRoleKeys]);

  // Champion games for currently selected role
  const championGamesBySelectedRole = useMemo(() => {
    const map: Record<number, number> = {};
    const entry = (champsStats || []).find((g) => g._id === selectedRole);
    if (entry) {
      for (const c of entry.champs) {
        map[c.championId] = c.games || 0;
      }
    }
    return map;
  }, [champsStats, selectedRole]);

  // Only show champions with games > 0 for the selected role (show all until stats loaded)
  const visibleChampions = useMemo(() => {
    const hasCounts = Object.keys(championGamesBySelectedRole).length > 0;
    if (!hasCounts) return championList;
    return championList.filter(
      (c) => (championGamesBySelectedRole[Number(c.key)] || 0) > 0,
    );
  }, [championList, championGamesBySelectedRole]);

  // If current role becomes disabled, pick the first available role with games
  useEffect(() => {
    if (disabledRoleKeys.includes(selectedRole)) {
      const fallback = roles.find((r) => !disabledRoleKeys.includes(r.key));
      if (fallback && fallback.key !== selectedRole) {
        setSelectedRole(fallback.key);
        setHasUserSelectedRole(true); // Mark as user selected since we're forcing a change
      }
    }
  }, [disabledRoleKeys, selectedRole]);

  // If selected champion has zero games for current role, reset it
  useEffect(() => {
    if (
      selectedChampion !== null &&
      (championGamesBySelectedRole[Number(selectedChampion)] || 0) === 0
    ) {
      setSelectedChampion(null);
    }
  }, [selectedChampion, championGamesBySelectedRole]);

  // Role icon from Community Dragon (neutral icon)
  const getRoleIconUrl = (roleKey: string) =>
    `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-clash/global/default/assets/images/position-selector/positions/icon-position-${roleKey.toLowerCase()}.png`;

  const selectedChampionData = useMemo(() => {
    if (!selectedChampion) return null;
    return championList.find((c) => c.key === String(selectedChampion)) ?? null;
  }, [selectedChampion, championList]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="h-full"
    >
      <Card className="py-0 h-full bg-neutral-900/90 backdrop-blur-sm border border-neutral-700/60 shadow-soft-lg hover:shadow-soft-xl transition-all duration-200">
        <CardBody className="p-8 space-y-6">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-gradient-to-br from-accent-purple-900/30 to-accent-blue-900/30 rounded-xl">
              <HeatmapIcon className="w-6 h-6 text-accent-purple-400" />
            </div>
            <div>
              <h3 className="text-xl font-display font-bold text-neutral-50">
                Heatmap Analysis
              </h3>
              <p className="text-sm text-neutral-400">
                Positional gameplay patterns
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Role combobox */}
            <Popover open={isRolePickerOpen} onOpenChange={setIsRolePickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="flat"
                  className="h-11 w-full flex items-center justify-between px-3 py-2 bg-neutral-800/70 border border-neutral-700 text-neutral-100"
                  aria-label="Role combobox"
                >
                  {(() => {
                    const role = roles.find((r) => r.key === selectedRole);
                    const games = role ? roleGames[role.key] || 0 : 0;
                    return (
                      <>
                        <div className="flex items-center gap-2">
                          {role ? (
                            <img
                              src={getRoleIconUrl(role.key)}
                              alt={role.label}
                              className="h-5 w-5"
                            />
                          ) : null}
                          <span>{role ? role.label : 'Select role'}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-slate-300">{games}</span>
                          <ChevronDown className="h-4 w-4 opacity-70" />
                        </div>
                      </>
                    );
                  })()}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="z-[80] p-0 w-[260px] bg-neutral-900 text-neutral-100 border border-neutral-800">
                <Command className="bg-neutral-900 text-neutral-100 z-[100]">
                  <CommandInput placeholder="Search role..." />
                  <CommandList>
                    <CommandEmpty>No roles found.</CommandEmpty>
                    <CommandGroup>
                      {roles.map((role) => (
                        <CommandItem
                          key={role.key}
                          value={role.label}
                          disabled={disabledRoleKeys.includes(role.key)}
                          onSelect={() => {
                            if (!disabledRoleKeys.includes(role.key)) {
                              setSelectedRole(role.key);
                              setHasUserSelectedRole(true);
                              setIsRolePickerOpen(false);
                            }
                          }}
                        >
                          <div className="flex w-full items-center justify-between">
                            <div className="flex items-center gap-2">
                              <img
                                src={getRoleIconUrl(role.key)}
                                alt={role.label}
                                className="h-5 w-5"
                              />
                              <span>{role.label}</span>
                            </div>
                            <span className="text-xs text-slate-300">
                              {roleGames[role.key] || 0}
                            </span>
                          </div>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>

            {/* Champion combobox */}
            <Popover
              open={isChampionPickerOpen}
              onOpenChange={setIsChampionPickerOpen}
            >
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="flat"
                  className="h-11 w-full flex items-center justify-between px-3 py-2 bg-neutral-800/70 border border-neutral-700 text-neutral-100"
                  aria-label="Champion combobox"
                >
                  <div className="flex items-center gap-2">
                    {selectedChampionData ? (
                      <>
                        <Avatar className="h-5 w-5 rounded border border-neutral-700">
                          <AvatarImage
                            src={getChampionImageUrl(selectedChampionData.id, 'square')}
                            alt={selectedChampionData.name}
                          />
                        </Avatar>
                        <span>{selectedChampionData.name}</span>
                      </>
                    ) : (
                      <span className="text-neutral-400">All champions</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-300">
                      {selectedChampion
                        ? championGamesBySelectedRole[Number(selectedChampion)] || 0
                        : visibleChampions.length}
                    </span>
                    <ChevronDown className="h-4 w-4 opacity-70" />
                  </div>
                </Button>
              </PopoverTrigger>
              <PopoverContent className="z-[80] p-0 w-[260px] bg-neutral-900 text-neutral-100 border border-neutral-800">
                <Command className="bg-neutral-900 text-neutral-100 z-[100]">
                  <CommandInput placeholder="Search champion..." />
                  <CommandList>
                    <CommandEmpty>No champions found.</CommandEmpty>
                    <CommandGroup>
                      <CommandItem
                        value="All champions"
                        onSelect={() => {
                          setSelectedChampion(null);
                          setIsChampionPickerOpen(false);
                        }}
                      >
                        <div className="flex w-full items-center justify-between">
                          <span>All champions</span>
                          <span className="text-xs text-slate-300">
                            {visibleChampions.length}
                          </span>
                        </div>
                      </CommandItem>
                      {visibleChampions.map((champ) => (
                        <CommandItem
                          key={champ.key}
                          value={champ.name}
                          onSelect={() => {
                            setSelectedChampion(Number(champ.key));
                            setIsChampionPickerOpen(false);
                          }}
                        >
                          <div className="flex w-full items-center justify-between">
                            <div className="flex items-center gap-2">
                              <Avatar className="h-6 w-6 rounded-lg border border-neutral-700">
                                <AvatarImage
                                  src={getChampionImageUrl(champ.id, 'square')}
                                  alt={champ.name}
                                />
                              </Avatar>
                              <span>{champ.name}</span>
                            </div>
                            <span className="text-xs text-slate-300">
                              {championGamesBySelectedRole[Number(champ.key)] || 0}
                            </span>
                          </div>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            <Select
              value={selectedMode}
              onValueChange={(value: 'kills' | 'deaths') => {
                setSelectedMode(value);
              }}
            >
              <SelectTrigger className="h-11 border-neutral-700 bg-neutral-800/70 text-neutral-100">
                <div className="flex items-center gap-3">
                  <span className="text-lg">
                    {modes.find((mode) => mode.key === selectedMode)?.icon ??
                      '⚔️'}
                  </span>
                  <span className="font-medium">
                    {modes.find((mode) => mode.key === selectedMode)?.label ??
                      ''}
                  </span>
                </div>
              </SelectTrigger>
              <SelectContent className="bg-neutral-900 text-neutral-100">
                {modes.map((mode) => (
                  <SelectItem key={mode.key} value={mode.key}>
                    <div className="flex items-center gap-3">
                      <span className="text-lg">{mode.icon}</span>
                      <span className="font-medium">{mode.label}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="relative w-full aspect-square bg-gradient-to-br from-neutral-800 to-neutral-900 rounded-2xl overflow-hidden border border-neutral-700/50">
            <img
              src="/map.svg"
              alt="Summoner's Rift Map"
              className="w-full h-full opacity-60 contrast-90 filter brightness-75"
            />
            {isHeatmapLoading && (
              <div className="absolute inset-0 bg-neutral-950/70 flex items-center justify-center backdrop-blur-sm">
                <div className="flex flex-col items-center gap-4">
                  <Loader2 className="w-12 h-12 text-accent-blue-500 animate-spin" />
                  <p className="text-sm font-medium text-white">
                    Analyzing gameplay patterns...
                  </p>
                </div>
              </div>
            )}
            {heatmapData && (
              <HeatmapOverlay data={heatmapData} mode={selectedMode} />
            )}

            {/* Subtle corner decoration */}
            <div className="absolute top-4 right-4 w-2 h-2 bg-accent-blue-400 rounded-full opacity-60" />
            <div className="absolute bottom-4 left-4 w-1 h-1 bg-accent-purple-400 rounded-full opacity-40" />
          </div>
        </CardBody>
      </Card>
    </motion.div>
  );
}
