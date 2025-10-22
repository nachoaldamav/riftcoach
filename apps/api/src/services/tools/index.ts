import type { Tool } from '@aws-sdk/client-bedrock-runtime';
import { fetchDDragonChampionsTool } from './fetch_ddragon_champions.js';
import { fetchDDragonItemsTool } from './fetch_ddragon_items.js';
import { mapCoordinatesToZonesTool } from './map_coordinates_to_zones.js';
import { queryAverageChampionRoleStatsTool } from './query_average_champion_role_stats.js';
import { queryCommonChampionBuildsTool } from './query_common_champion_builds.js';
import { queryPlayerRoleMetricsTool } from './query_player_role_metrics.js';
import type { ToolSpec } from './types.js';

export const toolDefinitions: ToolSpec[] = [
  fetchDDragonItemsTool,
  fetchDDragonChampionsTool,
  queryAverageChampionRoleStatsTool,
  queryCommonChampionBuildsTool,
  queryPlayerRoleMetricsTool,
  mapCoordinatesToZonesTool,
];

export function buildToolConfig(): { tools: Tool[] } {
  return {
    tools: toolDefinitions.map(
      (tool) =>
        ({
          toolSpec: {
            name: tool.name,
            description: tool.description,
            inputSchema: {
              json: tool.schema,
            },
          },
        }) as Tool,
    ),
  };
}
