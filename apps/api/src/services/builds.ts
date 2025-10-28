import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { DDragon, RiotAPITypes } from '@fightmegg/riot-api';
import { collections } from '@riftcoach/clients.mongodb';
import type { Item } from '@riftcoach/shared.lol-types';
import consola from 'consola';
import type { Document } from 'mongodb';
import { bedrockClient } from '../clients/bedrock.js';

// Types
type ItemSlotKey = 'item0' | 'item1' | 'item2' | 'item3' | 'item4' | 'item5';
type ItemSlots = Record<ItemSlotKey, number>;

interface ItemData {
  id: string;
  name: string;
  plaintext: string | null;
  description: string | null;
  tags: string[];
  gold: { total?: number; base?: number; sell?: number } | null;
  depth: number | null;
  from: string[];
  into: string[];
  stats: Record<string, number> | null;
  group: string | null;
}

interface BuildItemRef {
  id: string;
  name: string;
  tags: string[];
  depth: number | null;
  gold: { total?: number; base?: number; sell?: number } | null;
  from: string[];
  into: string[];
  description: string | null;
  stats: Record<string, number> | null;
  group: string | null;
}

interface ReplaceableItem {
  id: string;
  name: string;
  slot: ItemSlotKey;
  isCompleted: boolean;
}

type CommonBuildDoc = { _id: number[] };

interface ContextPerformance {
  kills: number;
  deaths: number;
  assists: number;
  goldEarned: number;
  totalDamageDealt: number;
  totalDamageDealtToChampions: number;
  win: boolean;
}

interface ContextEnemy {
  championName: string;
  teamPosition: string;
  puuid: string;
  performance: ContextPerformance;
  build: BuildItemRef[];
  itemSlots: ItemSlots;
}

interface ContextSubject {
  championName?: string;
  teamPosition?: string;
  puuid?: string;
  currentBuild: BuildItemRef[];
  performance: ContextPerformance;
  itemSlots: ItemSlots;
}

interface ContextData {
  match: {
    gameMode: string;
    gameDuration: number;
    gameVersion: string;
    gameCreation: number;
  };
  subject: ContextSubject;
  allies: ContextEnemy[];
  enemies: ContextEnemy[];
  commonBuilds: Array<{ items: BuildItemRef[] }>;
  availableItems: ItemData[];
}

interface Player {
  puuid: string;
  championName: string;
  role: string;
  kills?: number;
  deaths?: number;
  assists?: number;
  goldEarned?: number;
  totalDamageDealt?: number;
  stats?: {
    totalDamageDealtToChampions?: number;
  };
  win?: boolean;
  finalBuild?: Record<string, unknown>;
  item0?: number;
  item1?: number;
  item2?: number;
  item3?: number;
  item4?: number;
  item5?: number;
}

interface MatchBuilds {
  gameVersion: string;
  gameMode: string;
  gameDuration: number;
  gameCreation: number;
  allies: Player[];
  enemies: Player[];
}

// Build-order recommendation entry (time-sorted purchase order)
interface BuildOrderEntry {
  order: number;
  itemId: string;
  itemName: string;
  reasoning: string;
}

function isCompletedItem(item: Item): boolean {
  if (!item.from?.length) return false;
  if (item.consumed) return false;
  if (item.tags?.includes('Boots')) {
    return (item.depth ?? 0) >= 2;
  }
  const isCompleted = (item.depth ?? 0) >= 3 || !item.into?.length;
  consola.debug(
    `${item.name} isCompleted: ${isCompleted} (depth: ${item.depth})`,
  );
  return isCompleted;
}

function getEmptySlots(
  itemSlots: ItemSlots,
  itemsMap: Record<string, Item>,
): ItemSlotKey[] {
  return (Object.entries(itemSlots) as [ItemSlotKey, number][])
    .filter(([, itemId]) => {
      if (itemId === 0) return true;
      const item = itemsMap[String(itemId)];
      if (!item) return false;
      return !isCompletedItem(item);
    })
    .map(([slot]) => slot);
}

function getReplaceableItems(
  itemSlots: ItemSlots,
  itemsData: Record<string, ItemData>,
  itemsMap: Record<string, Item>,
): ReplaceableItem[] {
  const replaceableItems: ReplaceableItem[] = [];

  for (const [slot, itemId] of Object.entries(itemSlots) as [
    ItemSlotKey,
    number,
  ][]) {
    if (itemId === 0) continue; // Skip empty slots

    const itemIdStr = String(itemId);
    const item = itemsMap[itemIdStr];
    const itemData = itemsData[itemIdStr];

    if (!item || !itemData) continue;

    // Only allow replacement of completed items (depth >= 3, or boots with depth >= 2)
    const isCompleted = itemData.tags?.includes('Boots')
      ? (itemData.depth ?? 0) >= 2
      : (itemData.depth ?? 0) >= 3;

    // Don't replace starter items, consumables, or trinkets
    const isStarterOrConsumable =
      itemData.tags?.includes('Consumable') ||
      itemData.tags?.includes('Trinket') ||
      (itemData.gold?.total ?? 0) < 500;

    if (isCompleted && !isStarterOrConsumable) {
      replaceableItems.push({
        slot,
        id: itemIdStr,
        name: itemData.name,
        isCompleted: true,
      });
    }
  }

  return replaceableItems;
}

// Main service functions
export async function getDDragonItemsData() {
  const ddragon = new DDragon();
  const itemsMapResponse = await ddragon.items();
  const itemsMap = itemsMapResponse.data as Record<string, Item>;
  const ddragonCompletedItems = Object.keys(itemsMap).filter((itemId) =>
    isCompletedItem(itemsMap[itemId]),
  );

  return { itemsMap, ddragonCompletedItems };
}

export async function getCommonChampionRoleBuilds(
  championName: string,
  role: string,
): Promise<CommonBuildDoc[]> {
  const result = await collections.matches
    .aggregate([
      {
        $sort: {
          'info.gameCreation': -1,
        },
      },
      {
        $match: {
          'info.participants.championName': championName,
          'info.participants.teamPosition': role,
          'info.participants.win': true,
          'info.queueId': {
            $in: [420, 430, 440],
          },
          'info.gameDuration': {
            // 15 minutes
            $gt: 15 * 60,
          },
        },
      },
      {
        $limit: 100,
      },
      {
        $unwind: '$info.participants',
      },
      {
        $match: {
          'info.participants.championName': championName,
          'info.participants.teamPosition': role,
        },
      },
      {
        $project: {
          itemIds: [
            '$info.participants.item0',
            '$info.participants.item1',
            '$info.participants.item2',
            '$info.participants.item3',
            '$info.participants.item4',
            '$info.participants.item5',
            '$info.participants.item6',
          ],
        },
      },
      {
        $addFields: {
          filteredItemIds: {
            $filter: {
              input: '$itemIds',
              as: 'item',
              cond: {
                $and: [
                  {
                    $ne: ['$$item', null],
                  },
                  {
                    $ne: ['$$item', 0],
                  },
                ],
              },
            },
          },
        },
      },
      {
        $addFields: {
          sortedItemIds: {
            $sortArray: {
              input: '$filteredItemIds',
              sortBy: 1,
            },
          },
        },
      },
      {
        $group: {
          _id: '$sortedItemIds',
        },
      },
    ])
    .toArray();

  return result as CommonBuildDoc[];
}

export function createItemsDataMapping(
  allItemIds: Set<string>,
  itemsMap: Record<string, Item>,
): Record<string, ItemData> {
  const itemsData: Record<string, ItemData> = {};

  for (const id of allItemIds) {
    const item = itemsMap[id];
    if (item) {
      itemsData[id] = {
        id: id,
        name: item.name || 'Unknown',
        plaintext: item.plaintext || null,
        description: item.description || null,
        tags: item.tags || [],
        gold: item.gold || null,
        depth: item.depth || null,
        from: item.from || [],
        into: item.into || [],
        stats:
          (item as unknown as { stats?: Record<string, number> }).stats || null,
        group: (item as unknown as { group?: string }).group || null,
      };
    }
  }

  return itemsData;
}

export function collectAllItemIds(
  subjectParticipant: Player,
  allies: Player[],
  enemies: Player[],
  commonChampionRoleBuilds: CommonBuildDoc[],
): Set<string> {
  const allItemIds = new Set<string>();

  // Subject items
  for (const id of Object.keys(subjectParticipant.finalBuild || {})) {
    allItemIds.add(id);
  }

  const subjectItems = [
    subjectParticipant.item0,
    subjectParticipant.item1,
    subjectParticipant.item2,
    subjectParticipant.item3,
    subjectParticipant.item4,
    subjectParticipant.item5,
  ];

  for (const id of subjectItems) {
    if (id && id !== 0) {
      allItemIds.add(String(id));
    }
  }

  // Allies items (excluding the subject to avoid duplication)
  for (const ally of allies) {
    if (ally.puuid === subjectParticipant.puuid) continue;

    for (const id of Object.keys(ally.finalBuild || {})) {
      allItemIds.add(id);
    }

    const allyItems = [
      ally.item0,
      ally.item1,
      ally.item2,
      ally.item3,
      ally.item4,
      ally.item5,
    ];

    for (const id of allyItems) {
      if (id && id !== 0) {
        allItemIds.add(String(id));
      }
    }
  }

  // Enemy items
  for (const enemy of enemies) {
    for (const id of Object.keys(enemy.finalBuild || {})) {
      allItemIds.add(id);
    }

    const enemyItems = [
      enemy.item0,
      enemy.item1,
      enemy.item2,
      enemy.item3,
      enemy.item4,
      enemy.item5,
    ];

    for (const id of enemyItems) {
      if (id && id !== 0) {
        allItemIds.add(String(id));
      }
    }
  }

  // Common build items
  for (const build of commonChampionRoleBuilds) {
    if (Array.isArray(build._id)) {
      for (const id of build._id) {
        allItemIds.add(String(id));
      }
    }
  }

  return allItemIds;
}

export async function getChampionRoleItemPresence(
  championName: string,
  role: string,
): Promise<{
  counts: { itemId: number; count: number }[];
  totalMatches: number;
}> {
  const docs = await collections.matches
    .aggregate([
      { $sort: { 'info.gameCreation': -1 } },
      {
        $match: {
          'info.participants.championName': championName,
          'info.participants.teamPosition': role,
          'info.participants.win': true,
          'info.queueId': { $in: [420, 430, 440] },
          'info.gameDuration': { $gt: 15 * 60 },
        },
      },
      { $limit: 100 },
      { $unwind: '$info.participants' },
      {
        $match: {
          'info.participants.championName': championName,
          'info.participants.teamPosition': role,
        },
      },
      {
        $project: {
          itemIds: [
            '$info.participants.item0',
            '$info.participants.item1',
            '$info.participants.item2',
            '$info.participants.item3',
            '$info.participants.item4',
            '$info.participants.item5',
            '$info.participants.item6',
          ],
        },
      },
      {
        $addFields: {
          filteredItemIds: {
            $filter: {
              input: '$itemIds',
              as: 'item',
              cond: {
                $and: [{ $ne: ['$$item', null] }, { $ne: ['$$item', 0] }],
              },
            },
          },
        },
      },
    ])
    .toArray();

  const counts = new Map<number, number>();
  const totalMatches = docs.length;

  for (const doc of docs as Array<{ filteredItemIds?: number[] }>) {
    const ids = Array.isArray(doc.filteredItemIds) ? doc.filteredItemIds : [];
    // Use a Set to avoid double-counting the same item twice within one match
    const uniqueIds = new Set<number>(ids);
    for (const id of uniqueIds) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }

  return {
    counts: Array.from(counts.entries()).map(([itemId, count]) => ({
      itemId,
      count,
    })),
    totalMatches,
  };
}

// Aggregates time-sorted purchase columns for a champion/role across matches,
// mirroring the /v1/builds-order route logic.
export async function getChampionRoleBuildOrderColumns(
  championName: string,
  role: string,
  options?: {
    maxOrder?: number;
    minDurationSec?: number;
    maxDurationSec?: number;
    sortDirection?: 1 | -1; // gameCreation order
    queueId?: number;
    winFilter?: 'true' | 'false' | undefined;
    completedItemIdsNumeric?: number[]; // optional override
  },
): Promise<
  Array<{
    order: number | { $numberLong: string };
    items: Array<{
      itemId: number;
      games: number;
      winrate: number;
      pickrate: number;
      name?: string | null;
      icon?: string | null;
    }>;
  }>
> {
  const maxOrder = options?.maxOrder ?? 6;
  const minDuration = options?.minDurationSec ?? 600;
  const maxDuration = options?.maxDurationSec ?? 4800;
  const sortDirection = options?.sortDirection ?? -1;

  // Build completed item list from DDragon if not provided
  let completedItemIds: number[] = options?.completedItemIdsNumeric ?? [];
  let itemMeta = new Map<number, { name: string; icon?: string }>();
  if (!completedItemIds.length) {
    const ddragon = new DDragon();
    const itemsRaw = await ddragon.items();
    const entries = Object.entries(itemsRaw.data) as Array<
      [string, RiotAPITypes.DDragon.DDragonItemDTO]
    >;
    function isCompletedItem(item: RiotAPITypes.DDragon.DDragonItemDTO) {
      if (!item.from?.length) return false;
      const consumed = (item as { consumed?: boolean }).consumed;
      if (consumed) return false;
      if (item.tags?.includes('Boots')) {
        return (item.depth ?? 0) >= 2;
      }
      const isCompleted = (item.depth ?? 0) >= 3 || !item.into?.length;
      return isCompleted;
    }
    completedItemIds = entries
      .filter(([, item]) => isCompletedItem(item))
      .map(([id]) => Number(id));
    itemMeta = new Map<number, { name: string; icon?: string }>(
      entries.map(([id, i]) => [
        Number(id),
        {
          name: i.name,
          icon: (i.image as { full?: string } | undefined)?.full,
        },
      ]),
    );
  }

  const earlyMatch: Document = {
    'info.participants': {
      $elemMatch: {
        championName: championName,
        teamPosition: role,
      },
    },
    'info.gameDuration': { $gte: minDuration, $lte: maxDuration },
  };
  if (options?.queueId !== undefined)
    earlyMatch['info.queueId'] = options.queueId;
  if (options?.winFilter === 'true' || options?.winFilter === 'false') {
    earlyMatch['info.participants.win'] = options.winFilter === 'true';
  }

  const pipeline: Document[] = [
    { $match: earlyMatch },
    { $sort: { 'info.gameCreation': sortDirection } },
    {
      $project: {
        metadata: 1,
        'info.gameCreation': 1,
        participant: {
          $first: {
            $filter: {
              input: '$info.participants',
              as: 'p',
              cond: {
                $and: [
                  { $eq: ['$$p.championName', championName] },
                  { $eq: ['$$p.teamPosition', role] },
                ],
              },
            },
          },
        },
      },
    },
    { $match: { participant: { $type: 'object' } } },
    { $limit: 5000 },
    {
      $lookup: {
        from: 'timelines',
        let: { mid: '$metadata.matchId', pid: '$participant.participantId' },
        pipeline: [
          { $match: { $expr: { $eq: ['$metadata.matchId', '$$mid'] } } },
          {
            $project: {
              events: {
                $reduce: {
                  input: '$info.frames',
                  initialValue: [],
                  in: { $concatArrays: ['$$value', '$$this.events'] },
                },
              },
            },
          },
          { $unwind: '$events' },
          {
            $match: {
              'events.type': 'ITEM_PURCHASED',
              $expr: { $eq: ['$events.participantId', '$$pid'] },
              'events.itemId': { $in: completedItemIds },
            },
          },
          {
            $project: {
              _id: 0,
              ts: '$events.timestamp',
              itemId: '$events.itemId',
            },
          },
          { $sort: { ts: 1 } },
          { $limit: maxOrder },
        ],
        as: 'build',
      },
    },
    { $match: { build: { $ne: [] } } },
    {
      $addFields: {
        build: {
          $reduce: {
            input: '$build',
            initialValue: { seen: [], out: [] },
            in: {
              seen: {
                $cond: [
                  { $in: ['$$this.itemId', '$$value.seen'] },
                  '$$value.seen',
                  { $concatArrays: ['$$value.seen', ['$$this.itemId']] },
                ],
              },
              out: {
                $cond: [
                  { $in: ['$$this.itemId', '$$value.seen'] },
                  '$$value.out',
                  { $concatArrays: ['$$value.out', ['$$this']] },
                ],
              },
            },
          },
        },
      },
    },
    { $set: { build: '$build.out' } },
    { $unwind: { path: '$build', includeArrayIndex: 'order' } },
    {
      $group: {
        _id: {
          champion: '$participant.championName',
          role: '$participant.teamPosition',
          order: '$order',
          itemId: '$build.itemId',
        },
        games: { $sum: 1 },
        wins: { $sum: { $cond: ['$participant.win', 1, 0] } },
      },
    },
    {
      $group: {
        _id: {
          champion: '$_id.champion',
          role: '$_id.role',
          order: '$_id.order',
        },
        totalGames: { $sum: '$games' },
        items: {
          $push: { itemId: '$_id.itemId', games: '$games', wins: '$wins' },
        },
      },
    },
    {
      $project: {
        _id: 0,
        champion: '$_id.champion',
        role: '$_id.role',
        order: { $add: ['$_id.order', 1] },
        items: {
          $map: {
            input: '$items',
            as: 'i',
            in: {
              itemId: '$$i.itemId',
              games: '$$i.games',
              winrate: {
                $cond: [
                  { $gt: ['$$i.games', 0] },
                  { $divide: ['$$i.wins', '$$i.games'] },
                  0,
                ],
              },
              pickrate: {
                $cond: [
                  { $gt: ['$totalGames', 0] },
                  { $divide: ['$$i.games', '$totalGames'] },
                  0,
                ],
              },
            },
          },
        },
      },
    },
    {
      $set: {
        items: { $sortArray: { input: '$items', sortBy: { pickrate: -1 } } },
      },
    },
    { $sort: { order: 1 } },
  ];

  const rows = await collections.matches
    .aggregate<{
      champion: string;
      role: string;
      order: { $numberLong: string } | number;
      items: Array<{
        itemId: number;
        games: number;
        winrate: number;
        pickrate: number;
      }>;
    }>(pipeline, { allowDiskUse: true })
    .toArray();

  // Enrich items with names/icons for readability
  const columns = rows.map((r) => ({
    order: r.order,
    items: r.items.map((x) => ({
      ...x,
      name: itemMeta.get(x.itemId)?.name ?? String(x.itemId),
      icon: itemMeta.get(x.itemId)?.icon ?? null,
    })),
  }));

  return columns;
}

export function createContextData(
  match: MatchBuilds,
  subjectParticipant: Player,
  itemsData: Record<string, ItemData>,
  commonChampionRoleBuilds: CommonBuildDoc[],
  ddragonCompletedItems: string[],
): ContextData {
  const subjectBuildItemIds = Object.keys(
    subjectParticipant.finalBuild || {},
  ).map((id) => Number(id));

  // Derive available completed items strictly from common builds
  const commonItemIds = new Set<string>();
  for (const build of commonChampionRoleBuilds) {
    if (Array.isArray(build._id)) {
      for (const id of build._id) {
        commonItemIds.add(String(id));
      }
    }
  }

  const availableItems = Array.from(commonItemIds)
    .filter((id) => ddragonCompletedItems.includes(id))
    .map((id) => itemsData[id])
    .filter(Boolean) as ItemData[];

  return {
    match: {
      gameMode: match.gameMode || 'CLASSIC',
      gameDuration: match.gameDuration || 1800,
      gameVersion: match.gameVersion || '14.23.1',
      gameCreation: match.gameCreation,
    },
    subject: {
      championName: subjectParticipant?.championName,
      teamPosition: subjectParticipant?.role,
      puuid: subjectParticipant?.puuid,
      currentBuild: subjectBuildItemIds.map((id) => ({
        id: String(id),
        name: itemsData[String(id)]?.name || 'Unknown',
        tags: itemsData[String(id)]?.tags || [],
        depth: itemsData[String(id)]?.depth || null,
        gold: itemsData[String(id)]?.gold || null,
        from: itemsData[String(id)]?.from || [],
        into: itemsData[String(id)]?.into || [],
        description: itemsData[String(id)]?.description || null,
        stats: itemsData[String(id)]?.stats || null,
        group: itemsData[String(id)]?.group || null,
      })),
      performance: {
        kills: subjectParticipant?.kills || 0,
        deaths: subjectParticipant?.deaths || 0,
        assists: subjectParticipant?.assists || 0,
        goldEarned: subjectParticipant?.goldEarned || 0,
        totalDamageDealt: subjectParticipant?.totalDamageDealt || 0,
        totalDamageDealtToChampions:
          subjectParticipant?.stats?.totalDamageDealtToChampions || 0,
        win: subjectParticipant?.win || false,
      },
      itemSlots: {
        item0: subjectParticipant?.item0 || 0,
        item1: subjectParticipant?.item1 || 0,
        item2: subjectParticipant?.item2 || 0,
        item3: subjectParticipant?.item3 || 0,
        item4: subjectParticipant?.item4 || 0,
        item5: subjectParticipant?.item5 || 0,
      },
    },
    allies: match.allies
      .filter((ally: Player) => ally.puuid !== subjectParticipant.puuid)
      .map((ally: Player) => ({
        championName: ally.championName,
        teamPosition: ally.role,
        puuid: ally.puuid,
        performance: {
          kills: ally.kills || 0,
          deaths: ally.deaths || 0,
          assists: ally.assists || 0,
          goldEarned: ally.goldEarned || 0,
          totalDamageDealt: ally.totalDamageDealt || 0,
          totalDamageDealtToChampions:
            ally.stats?.totalDamageDealtToChampions || 0,
          win: ally.win || false,
        },
        build: Object.keys(ally.finalBuild ?? {}).map((id) => ({
          id: String(id),
          name: itemsData[String(id)]?.name || 'Unknown',
          tags: itemsData[String(id)]?.tags || [],
          depth: itemsData[String(id)]?.depth || null,
          gold: itemsData[String(id)]?.gold || null,
          from: itemsData[String(id)]?.from || [],
          into: itemsData[String(id)]?.into || [],
          description: itemsData[String(id)]?.description || null,
          stats: itemsData[String(id)]?.stats || null,
          group: itemsData[String(id)]?.group || null,
        })),
        itemSlots: {
          item0: ally.item0 || 0,
          item1: ally.item1 || 0,
          item2: ally.item2 || 0,
          item3: ally.item3 || 0,
          item4: ally.item4 || 0,
          item5: ally.item5 || 0,
        },
      })),
    enemies: match.enemies.map((enemy: Player) => ({
      championName: enemy.championName,
      teamPosition: enemy.role,
      puuid: enemy.puuid,
      performance: {
        kills: enemy.kills || 0,
        deaths: enemy.deaths || 0,
        assists: enemy.assists || 0,
        goldEarned: enemy.goldEarned || 0,
        totalDamageDealt: enemy.totalDamageDealt || 0,
        totalDamageDealtToChampions:
          enemy.stats?.totalDamageDealtToChampions || 0,
        win: enemy.win || false,
      },
      build: Object.keys(enemy.finalBuild ?? {}).map((id) => ({
        id: String(id),
        name: itemsData[String(id)]?.name || 'Unknown',
        tags: itemsData[String(id)]?.tags || [],
        depth: itemsData[String(id)]?.depth || null,
        gold: itemsData[String(id)]?.gold || null,
        from: itemsData[String(id)]?.from || [],
        into: itemsData[String(id)]?.into || [],
        description: itemsData[String(id)]?.description || null,
        stats: itemsData[String(id)]?.stats || null,
        group: itemsData[String(id)]?.group || null,
      })),
      itemSlots: {
        item0: enemy.item0 || 0,
        item1: enemy.item1 || 0,
        item2: enemy.item2 || 0,
        item3: enemy.item3 || 0,
        item4: enemy.item4 || 0,
        item5: enemy.item5 || 0,
      },
    })),
    commonBuilds: (commonChampionRoleBuilds as CommonBuildDoc[])
      .map((build) => ({
        items: Array.isArray(build._id)
          ? build._id
              .filter((id: number) =>
                ddragonCompletedItems.includes(String(id)),
              )
              .map((id: number) => ({
                id: String(id),
                name: itemsData[String(id)]?.name || 'Unknown',
                tags: itemsData[String(id)]?.tags || [],
                depth: itemsData[String(id)]?.depth || null,
                gold: itemsData[String(id)]?.gold || null,
                from: itemsData[String(id)]?.from || [],
                into: itemsData[String(id)]?.into || [],
                description: itemsData[String(id)]?.description || null,
                stats: itemsData[String(id)]?.stats || null,
                group: itemsData[String(id)]?.group || null,
              }))
          : [],
      }))
      .sort((a, b) => b.items.length - a.items.length),
    availableItems,
  };
}

export function generateSystemPrompt(
  itemsData: Record<string, ItemData>,
): string {
  const idToNameMap: Record<string, string> = {};
  const nameToIdMap: Record<string, string> = {};
  const metaById: Record<
    string,
    {
      name: string;
      description: string | null;
      depth: number | null;
      tags: string[];
      stats: Record<string, number> | null;
      group: string | null;
    }
  > = {};

  for (const [id, item] of Object.entries(itemsData)) {
    idToNameMap[id] = item.name;
    nameToIdMap[item.name] = id;
    metaById[id] = {
      name: item.name,
      description: item.description,
      depth: item.depth,
      tags: item.tags,
      stats: item.stats,
      group: item.group,
    };
  }

  return `You are an expert League of Legends itemization assistant.
- You must reference items by their DDragon IDs and names provided.
- Recommend a time-sorted PURCHASE ORDER (first → last), not slot replacements.

Hard rules:
- NEVER invent item names or IDs; use only those provided.
- Map IDs/names via idToName/nameToId and verify against metaById.
- Use ONLY completed items present in the "Available Completed Items" list.
- Respect item group uniqueness (e.g., only one from 'LastWhisper' group at any time).
- Boots policy:
  • Do not add more than one pair of boots.
  • Boots upgrades must stay within boots variants; do not replace boots with non-boots.
- Prefer items with higher pickrate for the given purchase ORDER column when reasonable.
- Consider champion/role context, ally/enemy compositions, and match duration.

Output format:
- Return a single valid JSON object with fields:
  {
    "buildOrder": [
      { "order": 1, "itemId": "3006", "itemName": "Berserker's Greaves", "reasoning": "..." },
      { "order": 2, "itemId": "6673", "itemName": "Immortal Shieldbow", "reasoning": "..." },
      { "order": 3, "itemId": "3036", "itemName": "Lord Dominik's Regards", "reasoning": "..." }
    ],
    "overallAnalysis": "..."
  }
- No extra text, tags, or comments outside the JSON.

ID maps for validation:
- idToName: ${JSON.stringify(idToNameMap)}
- nameToId: ${JSON.stringify(nameToIdMap)}
- metaById: ${JSON.stringify(metaById)}
`;
}

export function generateUserPrompt(
  contextData: ContextData,
  itemsData: Record<string, ItemData>,
  columns: Array<{
    order: number | { $numberLong: string };
    items: Array<{
      itemId: number;
      games: number;
      winrate: number;
      pickrate: number;
      name?: string | null;
      icon?: string | null;
    }>;
  }>,
  presence: Array<{ id: string; name: string; pct: number }>,
): string {
  const presenceStr = presence
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 20)
    .map((p) => `${p.name} (${Math.round(p.pct)}%)`)
    .join(', ');

  const orderSummary = columns
    .map((col) => {
      const order =
        typeof col.order === 'object' && '$numberLong' in col.order
          ? Number(col.order.$numberLong)
          : Number(col.order);
      const top = (col.items || [])
        .slice(0, 6)
        .map(
          (i) =>
            `${i.name ?? String(i.itemId)} (${Math.round(i.pickrate * 100)}% pick, ${Math.round(i.winrate * 100)}% win)`,
        )
        .join(', ');
      return `Order ${order}: ${top}`;
    })
    .join('\n');

  return `Context:
  - Champion: ${contextData.subject.championName} (${contextData.subject.teamPosition})
  - Match Duration: ${Math.floor((contextData.match.gameDuration || 0) / 60)} minutes
  - Performance: ${contextData.subject.performance.kills}/${contextData.subject.performance.deaths}/${contextData.subject.performance.assists} KDA
  - Result: ${contextData.subject.performance.win ? 'Victory' : 'Defeat'}

Ally Team:
${contextData.allies.map((ally) => `- ${ally.championName} (${ally.teamPosition}): ${ally.build.map((item) => item.name).join(', ')}`).join('\n')}

Enemy Team:
${contextData.enemies.map((enemy) => `- ${enemy.championName} (${enemy.teamPosition}): ${enemy.build.map((item) => item.name).join(', ')}`).join('\n')}

Available Completed Items (from common builds): ${contextData.availableItems.map((item) => item.name).join(', ')}
Item Presence (Champion/Role): ${presenceStr}

Time-Sorted Build Columns (population pick order → item options):
${orderSummary}

Task:
- Recommend a PURCHASE ORDER (1..N) tailored to this match. Prefer high-pick items per column when sensible; justify deviations based on comps and performance.
- Respect boots policy and uniqueness of item groups.

Return JSON with 'buildOrder' and 'overallAnalysis' only.`;
}

export async function getItemSuggestionsFromAI(
  systemPrompt: string,
  userPrompt: string,
): Promise<{
  buildOrder: BuildOrderEntry[];
  overallAnalysis: string;
} | null> {
  consola.debug('System prompt:', systemPrompt);
  consola.debug('User prompt:', userPrompt);

  let buildOrderResult: {
    buildOrder: BuildOrderEntry[];
    overallAnalysis: string;
  } | null = null;
  try {
    const command = new InvokeModelCommand({
      modelId: 'openai.gpt-oss-120b-1:0',
      body: JSON.stringify({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_completion_tokens: 9000,
        temperature: 0.7,
      }),
      contentType: 'application/json',
      accept: 'application/json',
    });

    const response = await bedrockClient.send(command);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));

    const content = responseBody?.choices?.[0]?.message?.content;
    if (typeof content === 'string') {
      // Extract JSON object from content
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const cleanedJson = jsonMatch[0]
            .replace(/<reasoning>[\s\S]*?<\/reasoning>/g, '')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/gm, '')
            .replace(/,(\s*[}\]])/g, '$1');
          const parsed = JSON.parse(cleanedJson);
          const buildOrder: BuildOrderEntry[] = Array.isArray(
            parsed?.buildOrder,
          )
            ? parsed.buildOrder.map((e: any) => ({
                order: Number(e.order),
                itemId: String(e.itemId),
                itemName: String(e.itemName),
                reasoning: String(e.reasoning ?? ''),
              }))
            : [];
          const overallAnalysis: string = String(parsed?.overallAnalysis ?? '');
          buildOrderResult = { buildOrder, overallAnalysis };
        } catch (parseError) {
          consola.warn('Failed to parse AI JSON for buildOrder:', parseError);
          consola.warn('Raw content:', content);
          buildOrderResult = {
            buildOrder: [],
            overallAnalysis: 'Failed to parse AI response. Please try again.',
          };
        }
      } else {
        // No JSON object found; treat entire content as analysis
        buildOrderResult = { buildOrder: [], overallAnalysis: content };
      }
    }
  } catch (error) {
    consola.error('Failed to get build order from model:', error);
  }

  return buildOrderResult;
}

// Main service function that orchestrates the entire builds analysis
export async function generateBuildSuggestions(
  match: MatchBuilds,
  subjectParticipant: Player,
): Promise<{
  buildOrder: Array<{
    order: number;
    itemId: number;
    itemName: string;
    reasoning: string;
  }>;
  overallAnalysis: string;
  suggestions: Array<{
    action: string;
    targetSlot?: string;
    suggestedItemId?: string;
    suggestedItemName?: string;
    replaceItemId?: string;
    replaceItemName?: string;
    reasoning: string;
  }>;
} | null> {
  // Get DDragon data
  const { itemsMap, ddragonCompletedItems } = await getDDragonItemsData();

  // Get common champion role builds
  const commonChampionRoleBuilds = await getCommonChampionRoleBuilds(
    subjectParticipant.championName,
    subjectParticipant.role,
  );

  // Collect all item IDs (including allies)
  const allItemIds = collectAllItemIds(
    subjectParticipant,
    match.allies,
    match.enemies,
    commonChampionRoleBuilds,
  );

  // Create items data mapping
  const itemsData = createItemsDataMapping(allItemIds, itemsMap);

  // Create context data (available items restricted to common builds)
  const contextData = createContextData(
    match,
    subjectParticipant,
    itemsData,
    commonChampionRoleBuilds,
    ddragonCompletedItems,
  );

  // Item presence for champ/role
  const { counts: presenceCounts, totalMatches } =
    await getChampionRoleItemPresence(
      subjectParticipant.championName,
      subjectParticipant.role,
    );
  // Compute percentages only for completed items
  const presence = presenceCounts
    .filter(({ itemId }) => ddragonCompletedItems.includes(String(itemId)))
    .map(({ itemId, count }) => ({
      id: String(itemId),
      name: itemsData[String(itemId)]?.name || 'Unknown',
      pct: Math.round((count / Math.max(1, totalMatches)) * 100),
    }));

  // Aggregate time-sorted build columns (population pick order)
  const completedItemIdsNumeric = ddragonCompletedItems.map((id) => Number(id));
  const columns = await getChampionRoleBuildOrderColumns(
    subjectParticipant.championName,
    subjectParticipant.role,
    {
      maxOrder: 6,
      minDurationSec: 600,
      maxDurationSec: 4800,
      sortDirection: -1,
      completedItemIdsNumeric,
    },
  );

  // Generate prompts (with DDragon ID/name mapping)
  const systemPrompt = generateSystemPrompt(itemsData);
  const userPrompt = generateUserPrompt(
    contextData,
    itemsData,
    columns,
    presence,
  );

  // Get AI build order recommendation
  const aiBuildOrder = await getItemSuggestionsFromAI(systemPrompt, userPrompt);

  if (!aiBuildOrder) return null;

  // Enforce group uniqueness across the recommended build order
  const getGroup = (idStr: string | undefined): string | null => {
    if (!idStr) return null;
    return (
      itemsData[idStr]?.group ??
      (itemsMap[idStr] as unknown as { group?: string })?.group ??
      null
    );
  };

  const seenGroups: Record<string, number> = {};
  const sanitized = aiBuildOrder.buildOrder.filter((entry) => {
    const g = getGroup(entry.itemId);
    if (!g) return true;
    const allowedCount = 1; // enforce single unique per group (e.g., LastWhisper)
    const cur = seenGroups[g] ?? 0;
    if (cur >= allowedCount) return false;
    seenGroups[g] = cur + 1;
    return true;
  });

  const buildOrderOut = sanitized.map((e) => ({
    order: Number(e.order),
    itemId: Number(e.itemId),
    itemName: e.itemName,
    reasoning: e.reasoning,
  }));

  return {
    buildOrder: buildOrderOut,
    overallAnalysis: aiBuildOrder.overallAnalysis,
    // maintain legacy field for UI compatibility
    suggestions: [],
  };
}
