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
  tags: string[];
  gold: { total?: number; base?: number; sell?: number } | null;
  depth: number | null;
  from: string[];
  into: string[];
}

interface BuildItemRef {
  id: string;
  name: string;
  tags: string[];
  depth: number | null;
  gold: { total?: number; base?: number; sell?: number } | null;
  from: string[];
  into: string[];
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

// Helper functions for item analysis
function isStarterOrConsumableItem(item: Item): boolean {
  const starterTags = ['Consumable', 'Trinket'];
  return (
    starterTags.some((tag) => item.tags?.includes(tag)) ||
    (item.gold?.total ?? 0) < 500
  );
}

function isCompletedItem(item: Item): boolean {
  if (item.tags?.includes('Boots')) {
    return (item.depth ?? 0) >= 2;
  }
  return (item.depth ?? 0) >= 3;
}

function getEmptySlots(itemSlots: ItemSlots): ItemSlotKey[] {
  return (Object.entries(itemSlots) as [ItemSlotKey, number][])
    .filter(([, itemId]) => itemId === 0)
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
        tags: item.tags || [],
        gold: item.gold || null,
        depth: item.depth || null,
        from: item.from || [],
        into: item.into || [],
      };
    }
  }

  return itemsData;
}

export function collectAllItemIds(
  subjectParticipant: Player,
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
    commonBuilds: (commonChampionRoleBuilds as CommonBuildDoc[]).map(
      (build) => ({
        items: Array.isArray(build._id)
          ? build._id.map((id: number) => ({
              id: String(id),
              name: itemsData[String(id)]?.name || 'Unknown',
              tags: itemsData[String(id)]?.tags || [],
              depth: itemsData[String(id)]?.depth || null,
              gold: itemsData[String(id)]?.gold || null,
              from: itemsData[String(id)]?.from || [],
              into: itemsData[String(id)]?.into || [],
            }))
          : [],
      }),
    ),
    availableItems: Object.values(itemsData).filter((item) =>
      ddragonCompletedItems.includes(item.id),
    ),
  };
}

export function generateSystemPrompt(): string {
  return `You are a League of Legends itemization expert.
  
  ITEM METADATA UNDERSTANDING:
  - depth: Item tier (1=basic, 2=advanced, 3=legendary, 4=mythic)
  - tags: Item categories (e.g., "Boots", "Armor", "Damage", "Health")
  - from: Component items needed to build this item
  - into: Items this can be upgraded into
  - gold: Item cost information
  
  ITEM CATEGORIZATION RULES:
  - Components: depth 1-2, have "into" field with upgrade paths
  - Completed Items: depth 3+, typically no "into" field
  - Boots: have "Boots" tag, only one pair allowed
  - Starter Items: low cost, early game items
  - Consumables: temporary effects (potions, wards)
  - Empowered Boots: boots with depth 3+
  
  CRITICAL ITEM SUGGESTION RULES:
  - ONLY SUGGEST COMPLETED ITEMS: You may ONLY suggest items that are explicitly listed in the "Available Completed Items from Common Builds" section. NEVER suggest component items like Last Whisper, B.F. Sword, Pickaxe, Chain Vest, Bramble Vest, etc.
  - BOOTS REPLACEMENT RULE: When replacing an item with the "Boots" tag, you MUST replace it with another item that also has the "Boots" tag. NEVER replace boots with non-boots items. Similarly, NEVER replace non-boots items with boots items.
  - Suggest up to 3 changes.
  - PRIORITIZE EMPTY SLOTS: Add items to empty slots first.
  - STRICT REPLACEMENT POLICY: If no empty slots exist, you may ONLY replace items that are explicitly listed as "replaceable completed items" in the constraints section. NEVER replace component items, starter items, trinkets, or consumables.
  - Boots can only be replaced with other boots of same tier (not lower or higher).
  - USE COMMON BUILDS: Only suggest items that appear in the provided "Available Completed Items from Common Builds" list.
  - ITEM COMPATIBILITY: Respect item category compatibility and avoid mutually exclusive or redundant combinations.
  - OUTPUT FORMAT: Respond with ONLY a valid JSON object. Do NOT include any reasoning tags, comments, or explanations outside the JSON structure. The JSON must contain exactly two fields: suggestions[] and overallAnalysis (string).
  - JSON VALIDATION: Ensure your response is valid JSON that can be parsed directly. No extra text before or after the JSON object.`;
}

export function generateUserPrompt(
  contextData: ContextData,
  itemsData: Record<string, ItemData>,
  emptySlots: ItemSlotKey[],
  replaceableItems: ReplaceableItem[],
): string {
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
    .slice(0, 5)
    .map(
      (build, i) =>
        `Build ${i + 1}: ${build.items.map((item) => item.name).join(', ')}`,
    )
    .join(
      '\n',
    )}\n\nAvailable Completed Items from Common Builds: ${contextData.availableItems.map((item) => item.name).join(', ')}\n\nConstraints:\n- Empty slots available: ${emptySlots.length > 0 ? emptySlots.join(', ') : 'None'}\n- Replaceable completed items (ONLY these may be replaced if no empty slots): ${replaceableItems.length > 0 ? replaceableItems.map((item) => `${item.name} (${item.slot})`).join(', ') : 'None - no items can be replaced'}\n\nRespond with JSON like:\n{\n  \"suggestions\": [\n    {\n      \"action\": \"add_to_slot\",\n      \"targetSlot\": \"item2\",\n      \"suggestedItemId\": \"3033\",\n      \"suggestedItemName\": \"Lord Dominik's Regards\",\n      \"reasoning\": \"Fills empty slot with high armor penetration to counter the enemy's heavy armor composition.\"\n    },\n    {\n      \"action\": \"replace_item\",\n      \"replaceItemId\": \"unknown_glowing_mote\",\n      \"replaceItemName\": \"Glowing Mote\",\n      \"targetSlot\": \"item4\",\n      \"suggestedItemId\": \"3006\",\n      \"suggestedItemName\": \"Berserker's Greaves\",\n      \"reasoning\": \"Replaces starter consumable with boots to provide attack speed and movement speed.\"\n    },\n    {\n      \"action\": \"replace_item\",\n      \"replaceItemId\": \"unknown_long_sword\",\n      \"replaceItemName\": \"Long Sword\",\n      \"targetSlot\": \"item5\",\n      \"suggestedItemId\": \"6675\",\n      \"suggestedItemName\": \"The Collector\",\n      \"reasoning\": \"Upgrades starter item to a high-damage execution item while keeping core items.\"\n    }\n  ],\n  \"overallAnalysis\": \"The build now adds needed armor penetration, proper boots, and stronger damage execution while keeping core items.\"\n}`;
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

  // Collect all item IDs
  const allItemIds = collectAllItemIds(
    subjectParticipant,
    match.enemies,
    commonChampionRoleBuilds,
  );

  // Create items data mapping
  const itemsData = createItemsDataMapping(allItemIds, itemsMap);

  // Create context data
  const contextData = createContextData(
    match,
    subjectParticipant,
    itemsData,
    commonChampionRoleBuilds,
    ddragonCompletedItems,
  );

  // Get empty slots and replaceable items
  const emptySlots = getEmptySlots(contextData.subject.itemSlots as ItemSlots);
  const replaceableItems = getReplaceableItems(
    contextData.subject.itemSlots as ItemSlots,
    itemsData,
    itemsMap,
  );

  // Generate prompts
  const systemPrompt = generateSystemPrompt();
  const userPrompt = generateUserPrompt(
    contextData,
    itemsData,
    emptySlots,
    replaceableItems,
  );

  // Get AI suggestions
  const itemSuggestions = await getItemSuggestionsFromAI(
    systemPrompt,
    userPrompt,
  );

  return itemSuggestions;
}
