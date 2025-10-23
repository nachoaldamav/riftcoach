import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { DDragon } from '@fightmegg/riot-api';
import { collections } from '@riftcoach/clients.mongodb';
import type { Item } from '@riftcoach/shared.lol-types';
import consola from 'consola';
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

function isCompletedItem(item: Item): boolean {
  if (item.tags?.includes('Boots')) {
    return (item.depth ?? 0) >= 2;
  }
  return (item.depth ?? 0) >= 3;
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
- Prefer high-presence items for the given champion/role and match context.

  Rules:
  - NEVER invent item names or IDs. Only use items present in the provided lists/maps.
  - ID/Name Mapping: If you know the name, translate to ID via nameToId. If you know the ID, verify via idToName.
  - BOOTS REPLACEMENT RULE: When replacing an item with the "Boots" tag, you MUST replace it with another item that also has the "Boots" tag. NEVER replace boots with non-boots items. Similarly, NEVER replace non-boots items with boots items.
  - Suggest up to 3 changes.
  - PRIORITIZE EMPTY SLOTS: Add items to empty slots first.
  - STRICT REPLACEMENT POLICY: If no empty slots exist, you may ONLY replace items that are explicitly listed as "replaceable completed items" in the constraints section. NEVER replace component items, starter items, trinkets, or consumables.
  - Boots can only be replaced with other boots of same tier (not lower or higher) and can only replace other boots.
  - USE COMMON BUILDS: Only suggest items that appear in the provided "Available Completed Items from Common Builds" list.
  - TREAT NON-COMPLETED ITEMS AS EMPTY: If a slot contains a non-completed item (component, starter, trinket, consumable), consider it EMPTY for the purpose of suggestions. Fill these before replacing completed items.
  - ITEM GROUP UNIQUENESS: Do NOT include more than ONE item from the same DDragon 'group' (e.g., 'LastWhisper'). If a group is already present, you may swap within that group (e.g., Mortal Reminder ↔ Lord Dominik's Regards) but MUST NOT add a second item of the same group.
  - ITEM COMPATIBILITY: Respect item category compatibility and avoid mutually exclusive or redundant combinations.
  - OUTPUT FORMAT: Respond with ONLY a valid JSON object. Do NOT include any reasoning tags, comments, or explanations outside the JSON structure. The JSON must contain exactly two fields: suggestions[] and overallAnalysis (string).
  - JSON VALIDATION: Ensure your response is valid JSON that can be parsed directly. No extra text before or after the JSON object.
  - ITEM GROUPS: You can only include one item from each group (e.g. Fatality, Manaflow, Boots), but you are allowed to add more than one item from the same group to the same slot.

  ADDITIONAL CONTEXT FOR ID LINKING:
  - Use the following DDragon maps to translate between item names and IDs for the referenced items (player, allies, enemies, common builds).
  - idToName: ${JSON.stringify(idToNameMap)}
  - nameToId: ${JSON.stringify(nameToIdMap)}
  - metaById: ${JSON.stringify(metaById)}

  ITEM GROUPS:
  Annul: Verdant Barrier, Banshee's Veil, Edge of Night
  Blight: Abyssal Mask, Blighting Jewel, Bloodletter's Curse, Cryptbloom, Terminus, Void Staff
  Boots: Berserker's Greaves, Boots, Boots of Swiftness, Ionian Boots of Lucidity, Mercury's Treads, Plated Steelcaps, Slightly Magical Boots, Sorcerer's Shoes, Symbiotic Soles, Synchronized Souls, Zephyr
  Dirk: Serrated Dirk
  Elixir: Elixir of Iron, Elixir of Sorcery, Elixir of Wrath
  Eternity: Catalyst of Aeons, Rod of Ages
  Fatality: Last Whisper, Black Cleaver, Lord Dominik's Regards, Mortal Reminder, Serylda's Grudge, Terminus
  Glory: Dark Seal, Mejai's Soulstealer
  Guardian: Guardian's Blade, Guardian's Hammer, Guardian's Horn, Guardian's Orb
  Hydra: Tiamat, Profane Hydra, Ravenous Hydra, Stridebreaker, Titanic Hydra
  Immolate: Bami's Cinder, Sunfire Aegis, Hollow Radiance
  Jungle/Support: Bounty of Worlds, Bloodsong, Celestial Opposition, Dream Maker, Gustwalker Hatchling, Mosstomper Seedling, Scorchclaw Pup, Solstice Sleigh, Zaz'Zak's Realmspike
  Lifeline: Archangel's Staff, Hexdrinker, Immortal Shieldbow, Maw of Malmortius, Seraph's Embrace, Sterak's Gage
  Manaflow: Archangel's Staff, Fimbulwinter, Manamune, Muramana, Seraph's Embrace, Tear of the Goddess, Winter's Approach
  Momentum: Dead Man's Plate, Trailblazer
  Potion: Health Potion, Refillable Potion
  Quicksilver: Mercurial Scimitar, Quicksilver Sash
  Sightstone: Watchful Wardstone, Vigilant Wardstone
  Spellblade: Sheen, Bloodsong, Iceborn Gauntlet, Lich Bane, Trinity Force
  Starter: Doran's Blade, Doran's Ring, Doran's Shield, Gustwalker Hatchling, Mosstomper Seedling, Scorchclaw Pup, World Atlas, Runic Compass
  Stasis: Seeker's Armguard, Shattered Armguard, Zhonya's Hourglass
  Trinket: Farsight Alteration, Oracle Lens, Stealth Ward

  TIER 3 BOOTS:
  Armored Advance
  Chainlaced Crushers
  Crimson Lucidity
  Forever Forward
  Gunmetal Greaves
  Spellslinger's Shoes
  Swiftmarch
  Symbiotic Soles
`;
}

export function generateUserPrompt(
  contextData: ContextData,
  itemsData: Record<string, ItemData>,
  emptySlots: ItemSlotKey[],
  replaceableItems: ReplaceableItem[],
  presence: Array<{ id: string; name: string; pct: number }>,
): string {
  const presenceStr = presence
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 20)
    .map((p) => `${p.name} (${Math.round(p.pct)}%)`)
    .join(', ');

  return `Context:
  - Champion: ${contextData.subject.championName} (${contextData.subject.teamPosition})\n- Current Build: ${contextData.subject.currentBuild.map((item) => item.name).join(', ')}\n- Current Item Slots: ${Object.entries(
    contextData.subject.itemSlots,
  )
    .map(
      ([slot, itemId]) =>
        `${slot}: ${itemId === 0 ? 'Empty' : itemsData[String(itemId)]?.name || 'Unknown'}`,
    )
    .join(
      ', ',
    )}\n- Match Duration: ${Math.floor((contextData.match.gameDuration || 0) / 60)} minutes\n- Performance: ${contextData.subject.performance.kills}/${contextData.subject.performance.deaths}/${contextData.subject.performance.assists} KDA\n- Result: ${contextData.subject.performance.win ? 'Victory' : 'Defeat'}\n\nEnemy Team Composition:\n${contextData.enemies.map((enemy) => `- ${enemy.championName} (${enemy.teamPosition}): ${enemy.build.map((item) => item.name).join(', ')}`).join('\n')}\n\nCommon Successful Builds for this Champion/Role:\n${contextData.commonBuilds
    .sort((a, b) => b.items.length - a.items.length)
    .slice(0, 10)
    .map(
      (build, i) =>
        `Build ${i + 1}: ${build.items.map((item) => item.name).join(', ')}`,
    )
    .join(
      '\n',
    )}\n\nItem Presence (Champion/Role): ${presenceStr}\n\nAvailable Completed Items from Common Builds: ${contextData.availableItems.map((item) => item.name).join(', ')}\n\nConstraints:\n- Empty slots available: ${emptySlots.length > 0 ? emptySlots.join(', ') : 'None'}\n- Replaceable completed items (ONLY these may be replaced if no empty slots): ${replaceableItems.length > 0 ? replaceableItems.map((item) => `${item.name} (${item.slot})`).join(', ') : 'None - no items can be replaced'}\n\nRespond with JSON like:\n{\n  \"suggestions\": [\n    {\n      \"action\": \"add_to_slot\",\n      \"targetSlot\": \"item2\",\n      \"suggestedItemId\": \"3033\",\n      \"suggestedItemName\": \"Lord Dominik's Regards\",\n      \"reasoning\": \"Fills empty slot with high armor penetration to counter the enemy's heavy armor composition.\"\n    },\n    {\n      \"action\": \"replace_item\",\n      \"replaceItemId\": \"unknown_glowing_mote\",\n      \"replaceItemName\": \"Glowing Mote\",\n      \"targetSlot\": \"item4\",\n      \"suggestedItemId\": \"3006\",\n      \"suggestedItemName\": \"Berserker's Greaves\",\n      \"reasoning\": \"Replaces starter consumable with boots to provide attack speed and movement speed.\"\n    },\n    {\n      \"action\": \"replace_item\",\n      \"replaceItemId\": \"unknown_long_sword\",\n      \"replaceItemName\": \"Long Sword\",\n      \"targetSlot\": \"item5\",\n      \"suggestedItemId\": \"6675\",\n      \"suggestedItemName\": \"The Collector\",\n      \"reasoning\": \"Upgrades starter item to a high-damage execution item while keeping core items.\"\n    }\n  ],\n  \"overallAnalysis\": \"The build now adds needed armor penetration, proper boots, and stronger damage execution while keeping core items.\"\n}`;
}

export async function getItemSuggestionsFromAI(
  systemPrompt: string,
  userPrompt: string,
): Promise<{
  suggestions: Array<{
    action: string;
    targetSlot?: string;
    suggestedItemId?: string;
    suggestedItemName?: string;
    replaceItemId?: string;
    replaceItemName?: string;
    reasoning: string;
  }>;
  overallAnalysis: string;
} | null> {
  consola.debug('System prompt:', systemPrompt);
  consola.debug('User prompt:', userPrompt);

  let itemSuggestions = null;
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
      // First try to parse the content directly as JSON
      try {
        itemSuggestions = JSON.parse(content.split('</reasoning>')[1]);
      } catch (directParseError) {
        // If direct parsing fails, try to extract JSON from the content
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            // Clean up common issues in the extracted JSON
            let cleanedJson = jsonMatch[0];

            // Remove any reasoning tags or comments that might be embedded
            cleanedJson = cleanedJson.replace(
              /<reasoning>[\s\S]*?<\/reasoning>/g,
              '',
            );
            cleanedJson = cleanedJson.replace(/\/\*[\s\S]*?\*\//g, '');
            cleanedJson = cleanedJson.replace(/\/\/.*$/gm, '');

            // Try to fix common JSON issues
            cleanedJson = cleanedJson.replace(/,(\s*[}\]])/g, '$1'); // Remove trailing commas

            itemSuggestions = JSON.parse(cleanedJson);
          } catch (parseError) {
            consola.warn('Failed to parse extracted JSON:', parseError);
            consola.warn('Raw content:', content);
            itemSuggestions = {
              suggestions: [],
              overallAnalysis: 'Failed to parse AI response. Please try again.',
            };
          }
        } else {
          itemSuggestions = {
            suggestions: [],
            overallAnalysis: content,
          };
        }
      }
    }
  } catch (error) {
    consola.error('Failed to get item suggestions from OpenAI:', error);
  }

  return itemSuggestions;
}

// Main service function that orchestrates the entire builds analysis
export async function generateBuildSuggestions(
  match: MatchBuilds,
  subjectParticipant: Player,
): Promise<{
  suggestions: Array<{
    action: string;
    targetSlot?: string;
    suggestedItemId?: string;
    suggestedItemName?: string;
    replaceItemId?: string;
    replaceItemName?: string;
    reasoning: string;
  }>;
  overallAnalysis: string;
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

  // Get empty slots and replaceable items
  const emptySlots = getEmptySlots(
    contextData.subject.itemSlots as ItemSlots,
    itemsMap,
  );
  const replaceableItems = getReplaceableItems(
    contextData.subject.itemSlots as ItemSlots,
    itemsData,
    itemsMap,
  );

  // Generate prompts (with DDragon ID/name mapping)
  const systemPrompt = generateSystemPrompt(itemsData);
  const userPrompt = generateUserPrompt(
    contextData,
    itemsData,
    emptySlots,
    replaceableItems,
    presence,
  );

  // Get AI suggestions
  const itemSuggestions = await getItemSuggestionsFromAI(
    systemPrompt,
    userPrompt,
  );

  // Enforce group uniqueness constraint post-processing
  if (itemSuggestions && Array.isArray(itemSuggestions.suggestions)) {
    const nameToId: Record<string, string> = Object.fromEntries(
      Object.entries(itemsData).map(([id, it]) => [it.name, id]),
    );
    const getGroup = (idStr: string | undefined): string | null => {
      if (!idStr) return null;
      return (
        itemsData[idStr]?.group ??
        (itemsMap[idStr] as unknown as { group?: string })?.group ??
        null
      );
    };

    const groupCounts: Record<string, number> = {};
    const slots = contextData.subject.itemSlots as ItemSlots;
    for (const [, itemId] of Object.entries(slots)) {
      if (!itemId || itemId === 0) continue;
      const gid = String(itemId);
      const g = getGroup(gid);
      if (g) groupCounts[g] = (groupCounts[g] ?? 0) + 1;
    }

    const resolvedSuggestions = itemSuggestions.suggestions
      .map((s) => {
        const suggestedIdRaw = s.suggestedItemId ?? null;
        const suggestedId =
          (suggestedIdRaw && /^[0-9]+$/.test(suggestedIdRaw)
            ? suggestedIdRaw
            : null) ??
          (s.suggestedItemName ? nameToId[s.suggestedItemName] : null);
        const replaceIdRaw = s.replaceItemId ?? null;
        const replaceId =
          (replaceIdRaw && /^[0-9]+$/.test(replaceIdRaw)
            ? replaceIdRaw
            : null) ?? (s.replaceItemName ? nameToId[s.replaceItemName] : null);
        return { ...s, suggestedId, replaceId };
      })
      .filter((s) => {
        const sg = getGroup(s.suggestedId ?? undefined);
        if (!sg) return true;
        if (s.action === 'add_to_slot') {
          if ((groupCounts[sg] ?? 0) > 0) return false;
          groupCounts[sg] = (groupCounts[sg] ?? 0) + 1;
          return true;
        } else if (s.action === 'replace_item') {
          const rg = getGroup(s.replaceId ?? undefined);
          if ((groupCounts[sg] ?? 0) > 0 && sg !== (rg ?? null)) {
            return false; // would create a duplicate group
          }
          // apply change: decrement replaced group, increment suggested group
          if (rg) groupCounts[rg] = Math.max(0, (groupCounts[rg] ?? 0) - 1);
          groupCounts[sg] = (groupCounts[sg] ?? 0) + 1;
          return true;
        }
        return true;
      })
      .slice(0, 3);

    if (resolvedSuggestions.length !== itemSuggestions.suggestions.length) {
      itemSuggestions.suggestions = resolvedSuggestions;
      itemSuggestions.overallAnalysis = `${itemSuggestions.overallAnalysis} (Adjusted to enforce unique item group rule.)`;
    }
  }

  return itemSuggestions;
}
