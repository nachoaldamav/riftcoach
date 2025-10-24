import { http } from '@/clients/http';
import { useDataDragon } from '@/providers/data-dragon-provider';
import {
  Autocomplete,
  AutocompleteItem,
  Avatar,
  Button,
  Card,
  CardBody,
  Chip,
  Select,
  SelectItem,
} from '@heroui/react';
import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { motion } from 'framer-motion';
import { Clock } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

export const Route = createFileRoute('/$region/$name/$tag/matches')({
  component: MatchesComponent,
});

interface RecentMatch {
  matchId: string;
  gameCreation: number;
  gameDuration: number;
  gameMode: string;
  queueId: number;
  player: {
    championId: number;
    championName: string;
    summonerName?: string;
    riotIdGameName?: string;
    riotIdTagline?: string;
    teamPosition: string;
    kills: number;
    deaths: number;
    assists: number;
    cs: number;
    gold: number;
    damage: number;
    visionScore: number;
    win: boolean;
    spells?: { s1?: number; s2?: number };
    runes?: { primaryStyle?: number; subStyle?: number; keystone?: number };
    items: number[];
  };
  opponent?: {
    championId: number;
    championName: string;
    kills: number;
    deaths: number;
    assists: number;
  };
  allies?: Array<{
    championId: number;
    championName: string;
    summonerName?: string;
    riotIdGameName?: string;
    riotIdTagline?: string;
  }>;
  enemies?: Array<{
    championId: number;
    championName: string;
    summonerName?: string;
    riotIdGameName?: string;
    riotIdTagline?: string;
  }>;
  kda: number;
  csPerMin: number;
  goldPerMin: number;
  damagePerMin: number;
  visionPerMin: number;
}

const QUEUE_OPTIONS = [
  { key: 'ALL', label: 'All Queues' },
  { key: '420', label: 'Ranked Solo/Duo' },
  { key: '440', label: 'Ranked Flex' },
  { key: '400', label: 'Normal Draft' },
];

const ROLE_OPTIONS = [
  { key: 'ALL', label: 'All Roles' },
  { key: 'TOP', label: 'Top' },
  { key: 'JUNGLE', label: 'Jungle' },
  { key: 'MIDDLE', label: 'Mid' },
  { key: 'BOTTOM', label: 'Bot' },
  { key: 'UTILITY', label: 'Support' },
];

// Role icon from Community Dragon
const getRoleIconUrl = (roleKey: string) => {
  if (roleKey === 'ALL')
    return 'https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-clash/global/default/assets/images/position-selector/positions/icon-position-fill.png';
  return `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-clash/global/default/assets/images/position-selector/positions/icon-position-${roleKey.toLowerCase()}.png`;
};

function MatchesComponent() {
  const { region, name, tag } = Route.useParams();
  const {
    champions,
    getChampionImageUrl,
    getItemImageUrl,
    getSummonerSpellIconUrl,
    getRuneStyleIconUrl,
    getRunePerkIconUrl,
  } = useDataDragon();

  const [selectedQueue, setSelectedQueue] = useState<string>('ALL');
  const [selectedRole, setSelectedRole] = useState<string>('ALL');
  const [selectedChampionKey, setSelectedChampionKey] = useState<string | null>(
    null,
  );
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(10);

  const championList = useMemo(
    () =>
      champions
        ? Object.values(champions).sort((a, b) => a.name.localeCompare(b.name))
        : [],
    [champions],
  );

  const { data: matches, isLoading } = useQuery({
    queryKey: [
      'matches',
      region,
      name,
      tag,
      selectedQueue,
      selectedRole,
      selectedChampionKey,
      pageSize,
    ],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (selectedQueue !== 'ALL') params.set('queue', selectedQueue);
      if (selectedRole !== 'ALL') params.set('role', selectedRole);
      if (selectedChampionKey) params.set('champion', selectedChampionKey);
      params.set('limit', String(pageSize * 5));
      const res = await http.get<{ results: RecentMatch[] }>(
        `/v1/${encodeURIComponent(region)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}/matches?${params.toString()}`,
      );
      return res.data.results;
    },
    staleTime: 1000 * 60 * 5,
  });

  const filteredMatches = useMemo(() => {
    if (!matches) return [] as RecentMatch[];
    return matches.filter((m) => {
      const queueOk =
        selectedQueue === 'ALL' || m.queueId === Number(selectedQueue);
      const roleOk =
        selectedRole === 'ALL' || m.player.teamPosition === selectedRole;
      const champOk =
        !selectedChampionKey ||
        String(m.player.championId) === selectedChampionKey;
      return queueOk && roleOk && champOk;
    });
  }, [matches, selectedQueue, selectedRole, selectedChampionKey]);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(filteredMatches.length / pageSize)),
    [filteredMatches.length, pageSize],
  );

  const paginatedMatches = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredMatches.slice(start, start + pageSize);
  }, [filteredMatches, page, pageSize]);

  // Clamp page within available range
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
    if (page < 1) setPage(1);
  }, [totalPages, page]);

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
    <div className="space-y-6">
      <Card className="bg-neutral-900/90 backdrop-blur-sm border border-neutral-700/60 shadow-soft-lg">
        <CardBody className="p-6">
          <div className="flex flex-wrap items-center gap-4">
            {/* Queue Filter */}
            <Select
              aria-label="Queue"
              selectedKeys={[selectedQueue]}
              onSelectionChange={(keys) => {
                const val = Array.from(keys)[0] as string;
                setSelectedQueue(val);
                setPage(1);
              }}
              className="max-w-xs"
              label="Queue"
              size="sm"
            >
              {QUEUE_OPTIONS.map((q) => (
                <SelectItem key={q.key} textValue={q.label}>
                  {q.label}
                </SelectItem>
              ))}
            </Select>

            {/* Role Filter */}
            <Select
              aria-label="Role"
              selectedKeys={[selectedRole]}
              onSelectionChange={(keys) => {
                const val = Array.from(keys)[0] as string;
                setSelectedRole(val);
                setPage(1);
              }}
              className="max-w-xs"
              label="Role"
              size="sm"
              selectionMode="single"
              renderValue={(items) => {
                const item = items[0];
                const role = ROLE_OPTIONS.find((r) => r.key === item?.key);
                if (!role) return null;
                const iconUrl = getRoleIconUrl(role.key);
                return (
                  <div className="flex items-center gap-2">
                    {iconUrl ? (
                      <img src={iconUrl} alt={role.label} className="w-4 h-4" />
                    ) : null}
                    <span>{role.label}</span>
                  </div>
                );
              }}
            >
              {ROLE_OPTIONS.map((role) => {
                const iconUrl = getRoleIconUrl(role.key);
                return (
                  <SelectItem
                    key={role.key}
                    textValue={role.label}
                    startContent={
                      iconUrl ? (
                        <img
                          src={iconUrl}
                          alt={role.label}
                          className="w-4 h-4"
                        />
                      ) : null
                    }
                  >
                    <span>{role.label}</span>
                  </SelectItem>
                );
              })}
            </Select>

            {/* Champion Filter */}
            <Autocomplete
              aria-label="Champion"
              className="max-w-md"
              label="Champion"
              size="sm"
              allowsCustomValue
              defaultSelectedKey={selectedChampionKey ?? undefined}
              onSelectionChange={(key) => {
                const val = key as string | null;
                setSelectedChampionKey(val);
                setPage(1);
              }}
              onInputChange={(value) => {
                if (!value) {
                  setSelectedChampionKey(null);
                  setPage(1);
                }
              }}
              placeholder="Search champion"
            >
              {championList.map((champ) => (
                <AutocompleteItem
                  key={champ.key}
                  textValue={champ.name}
                  startContent={
                    <Avatar
                      src={getChampionImageUrl(champ.id, 'square')}
                      className="w-6 h-6"
                      radius="sm"
                    />
                  }
                >
                  {champ.name}
                </AutocompleteItem>
              ))}
            </Autocomplete>

            {/* Page Size */}
            <Select
              aria-label="Page Size"
              selectedKeys={[String(pageSize)]}
              onSelectionChange={(keys) => {
                const val = Number(Array.from(keys)[0]);
                setPageSize(val);
                setPage(1);
              }}
              className="max-w-[140px]"
              label="Page Size"
              size="sm"
            >
              <SelectItem key="10" textValue="10">
                10
              </SelectItem>
              <SelectItem key="20" textValue="20">
                20
              </SelectItem>
              <SelectItem key="30" textValue="30">
                30
              </SelectItem>
              <SelectItem key="50" textValue="50">
                50
              </SelectItem>
            </Select>

            {/* Clear Filters */}
            <Button
              variant="flat"
              size="sm"
              onPress={() => {
                setSelectedQueue('ALL');
                setSelectedRole('ALL');
                setSelectedChampionKey(null);
              }}
            >
              Clear filters
            </Button>

            {/* Active filters chips */}
            <div className="flex items-center gap-2 ml-auto">
              {selectedQueue !== 'ALL' && (
                <Chip size="sm" color="primary" variant="flat">
                  {QUEUE_OPTIONS.find((q) => q.key === selectedQueue)?.label}
                </Chip>
              )}
              {selectedRole !== 'ALL' && (
                <Chip size="sm" color="secondary" variant="flat">
                  {ROLE_OPTIONS.find((r) => r.key === selectedRole)?.label}
                </Chip>
              )}
              {selectedChampionKey && (
                <Chip size="sm" color="success" variant="flat">
                  {
                    championList.find((c) => c.key === selectedChampionKey)
                      ?.name
                  }
                </Chip>
              )}
            </div>
          </div>
        </CardBody>
      </Card>

      {/* Matches List */}
      <Card className="bg-neutral-900/90 backdrop-blur-sm border border-neutral-700/60 shadow-soft-lg">
        <CardBody className="p-6 space-y-4">
          {isLoading || !matches ? (
            <div className="animate-pulse space-y-4">
              <div className="h-6 bg-neutral-800 rounded w-1/3" />
              {Array.from({ length: 6 }, (_, i) => (
                <div
                  key={`loading-match-skeleton-${i + 1}`}
                  className="flex items-center space-x-3"
                >
                  <div className="w-12 h-12 bg-neutral-800 rounded-xl" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 bg-neutral-800 rounded w-3/4" />
                    <div className="h-3 bg-neutral-800 rounded w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          ) : filteredMatches.length === 0 ? (
            <div className="flex items-center justify-center py-12">
              <div className="text-center">
                <p className="text-neutral-300">
                  No matches found for filters.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-neutral-400">
                  {`Showing ${Math.min((page - 1) * pageSize + 1, filteredMatches.length)}–${Math.min(page * pageSize, filteredMatches.length)} of ${filteredMatches.length} matches`}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="flat"
                    size="sm"
                    isDisabled={page <= 1}
                    onPress={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    Previous
                  </Button>
                  <Chip
                    size="sm"
                    className="bg-neutral-800/70 border border-neutral-700/50 text-neutral-300"
                  >
                    {`Page ${page} / ${totalPages}`}
                  </Chip>
                  <Button
                    variant="flat"
                    size="sm"
                    isDisabled={page >= totalPages}
                    onPress={() => setPage((p) => Math.min(totalPages, p + 1))}
                  >
                    Next
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3">
                {paginatedMatches.map((match, index) => (
                  <Link
                    key={match.matchId}
                    to="/$region/$name/$tag/match/$matchId"
                    params={{ region, name, tag, matchId: match.matchId }}
                    className="block"
                  >
                    <motion.div
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.2, delay: index * 0.02 }}
                      className={`p-4 rounded-lg border transition-all duration-150 cursor-pointer space-y-2 ${
                        match.player.win
                          ? 'bg-accent-emerald-950/20 border-accent-emerald-800/30 hover:bg-accent-emerald-950/30'
                          : 'bg-red-950/20 border-red-800/30 hover:bg-red-950/30'
                      }`}
                    >
                      {/* Header: result + meta */}
                      <div className="flex items-center gap-2 text-xs sm:text-sm">
                        <span
                          className={`font-semibold ${match.player.win ? 'text-accent-emerald-400' : 'text-red-400'}`}
                        >
                          {match.player.win ? 'Victory' : 'Defeat'}
                        </span>
                        <span className="text-neutral-500">•</span>
                        <span className="text-neutral-300">
                          {match.queueId === 420
                            ? 'Ranked Solo'
                            : match.queueId === 440
                              ? 'Ranked Flex'
                              : match.queueId === 400
                                ? 'Normal Draft'
                                : 'Queue'}
                        </span>
                        <span className="text-neutral-500">•</span>
                        <span className="text-neutral-300">
                          {Math.floor(match.gameDuration / 60)}:
                          {String(match.gameDuration % 60).padStart(2, '0')}
                        </span>
                        <span className="text-neutral-500">•</span>
                        <span className="text-neutral-300">
                          {getTimeAgo(match.gameCreation)}
                        </span>
                      </div>

                      {/* Main row */}
                      <div className="flex items-center gap-4">
                        {/* Champion Portrait */}
                        <div className="relative flex-shrink-0">
                          <Avatar
                            src={getChampionImageUrl(
                              match.player.championId,
                              'square',
                            )}
                            alt={match.player.championName}
                            className="size-16 border border-neutral-600"
                            radius="md"
                          />
                        </div>

                        {/* Spells and Runes */}
                        <div className="flex flex-col gap-1 flex-shrink-0">
                          {/* Summoner Spells */}
                          <div className="flex gap-1">
                            <img
                              src={getSummonerSpellIconUrl(
                                match.player.spells?.s1,
                              )}
                              alt="Spell 1"
                              className="w-5 h-5 rounded border border-neutral-600 bg-neutral-800"
                            />
                            <img
                              src={getSummonerSpellIconUrl(
                                match.player.spells?.s2,
                              )}
                              alt="Spell 2"
                              className="w-5 h-5 rounded border border-neutral-600 bg-neutral-800"
                            />
                          </div>
                          {/* Runes */}
                          <div className="flex gap-1">
                            {match.player.runes?.keystone ? (
                              <img
                                src={getRunePerkIconUrl(
                                  match.player.runes?.keystone,
                                )}
                                alt="Keystone"
                                className="w-5 h-5 rounded border border-neutral-600 bg-neutral-800"
                              />
                            ) : (
                              <div className="w-5 h-5 rounded border border-neutral-600 bg-neutral-800" />
                            )}
                            {match.player.runes?.subStyle ? (
                              <img
                                src={getRuneStyleIconUrl(
                                  match.player.runes?.subStyle,
                                )}
                                alt="Secondary Rune"
                                className="w-5 h-5 rounded border border-neutral-600 bg-neutral-800"
                              />
                            ) : (
                              <div className="w-5 h-5 rounded border border-neutral-600 bg-neutral-800" />
                            )}
                          </div>
                        </div>

                        {/* Stats */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-6 mb-1">
                            <span className="font-semibold text-sm text-neutral-100">
                              {Number(match.kda).toFixed(1)} KDA
                            </span>
                            <span className="font-semibold text-sm text-neutral-100">
                              {Number(match.csPerMin).toFixed(1)} CS/Min.
                            </span>
                          </div>
                          <div className="flex items-center gap-3 text-xs text-neutral-400">
                            <span className="font-medium">
                              {match.player.kills}/{match.player.deaths}/
                              {match.player.assists}
                            </span>
                            <span>•</span>
                            <span>{match.player.cs} CS</span>
                          </div>
                        </div>

                        {/* Items */}
                        <div className="flex items-center gap-1 flex-shrink-0">
                          {Array.from({ length: 6 }, (_, i) => {
                            const itemId = match.player.items?.[i];
                            const hasItem = itemId && itemId > 0;
                            return (
                              <div
                                key={`item-${match.matchId}-${i}`}
                                className="size-9 rounded border border-neutral-600 bg-neutral-800 overflow-hidden"
                              >
                                {hasItem ? (
                                  <img
                                    src={getItemImageUrl(itemId)}
                                    alt={`Item ${itemId}`}
                                    className="w-full h-full object-cover"
                                  />
                                ) : null}
                              </div>
                            );
                          })}
                        </div>

                        {/* Trinket */}
                        <div className="flex-shrink-0">
                          {match.player.items?.[6] &&
                          match.player.items[6] > 0 ? (
                            <div className="size-9 rounded border border-neutral-600 bg-neutral-800 overflow-hidden">
                              <img
                                src={getItemImageUrl(match.player.items[6])}
                                alt={`Trinket ${match.player.items[6]}`}
                                className="w-full h-full object-cover"
                              />
                            </div>
                          ) : (
                            <div className="w-6 h-6 rounded border border-neutral-600 bg-neutral-800" />
                          )}
                        </div>

                        {/* Rosters */}
                        {match.allies && match.enemies ? (
                          <div className="ml-4 grid grid-cols-2 gap-x-6">
                            <div className="space-y-1">
                              {match.allies.slice(0, 5).map((p, idx) => (
                                <div
                                  key={`ally-${idx}-${p.championId}-${p.riotIdGameName ?? p.summonerName ?? p.championName}`}
                                  className="flex items-center gap-2"
                                >
                                  <img
                                    src={getChampionImageUrl(
                                      p.championId,
                                      'square',
                                    )}
                                    alt={p.championName}
                                    className="w-5 h-5 rounded border border-neutral-600 bg-neutral-800"
                                  />
                                  <span
                                    className={`text-xs truncate max-w-[8rem] ${
                                      (
                                        p.riotIdGameName &&
                                          p.riotIdTagline &&
                                          p.riotIdGameName ===
                                            match.player.riotIdGameName &&
                                          p.riotIdTagline ===
                                            match.player.riotIdTagline
                                      ) ||
                                      (
                                        p.summonerName &&
                                          p.summonerName ===
                                            match.player.summonerName
                                      )
                                        ? 'text-neutral-100 font-semibold'
                                        : 'text-neutral-300'
                                    }`}
                                  >
                                    {(p.riotIdGameName
                                      ? `${p.riotIdGameName}`
                                      : (p.summonerName ?? p.championName)
                                    ).slice(0, 10)}
                                  </span>
                                </div>
                              ))}
                            </div>
                            <div className="space-y-1">
                              {match.enemies.slice(0, 5).map((p, idx) => (
                                <div
                                  key={`enemy-${idx}-${p.championId}-${p.riotIdGameName ?? p.summonerName ?? p.championName}`}
                                  className="flex items-center gap-2"
                                >
                                  <img
                                    src={getChampionImageUrl(
                                      p.championId,
                                      'square',
                                    )}
                                    alt={p.championName}
                                    className="w-5 h-5 rounded border border-neutral-600 bg-neutral-800"
                                  />
                                  <span className="text-xs truncate max-w-[8rem] text-neutral-300">
                                    {(p.riotIdGameName
                                      ? `${p.riotIdGameName}`
                                      : (p.summonerName ?? p.championName)
                                    ).slice(0, 10)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </motion.div>
                  </Link>
                ))}
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm text-neutral-400">
                  {`Showing ${Math.min((page - 1) * pageSize + 1, filteredMatches.length)}–${Math.min(page * pageSize, filteredMatches.length)} of ${filteredMatches.length} matches`}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="flat"
                    size="sm"
                    isDisabled={page <= 1}
                    onPress={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    Previous
                  </Button>
                  <Chip
                    size="sm"
                    className="bg-neutral-800/70 border border-neutral-700/50 text-neutral-300"
                  >
                    {`Page ${page} / ${totalPages}`}
                  </Chip>
                  <Button
                    variant="flat"
                    size="sm"
                    isDisabled={page >= totalPages}
                    onPress={() => setPage((p) => Math.min(totalPages, p + 1))}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
