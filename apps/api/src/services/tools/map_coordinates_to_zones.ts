import type { ToolSpec } from './types.js';
import { detectTeamSide, isEnemyHalf, zoneLabel } from './utils.js';

export const mapCoordinatesToZonesTool: ToolSpec = {
  name: 'map_coordinates_to_zones',
  description:
    'Map Summoner’s Rift coordinates to semantic zones (lane, river, jungle) and enemy territory awareness.',
  schema: {
    type: 'object',
    properties: {
      coordinates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
          required: ['x', 'y'],
          additionalProperties: false,
        },
        minItems: 1,
        maxItems: 24,
      },
      teamId: { type: 'integer' },
    },
    required: ['coordinates'],
    additionalProperties: false,
  },
  async execute(input) {
    const coords = Array.isArray((input as { coordinates?: unknown }).coordinates)
      ? ((input as { coordinates?: unknown }).coordinates as Array<{ x: number; y: number }>).map((c) => ({
          x: Number(c.x),
          y: Number(c.y),
        }))
      : [];
    const rawTeamId = (input as { teamId?: unknown }).teamId;
    const teamId = typeof rawTeamId === 'number' && Number.isFinite(rawTeamId)
      ? Math.trunc(rawTeamId)
      : null;
    const side = detectTeamSide(teamId ?? undefined);
    const mapped = coords.map((coord) => ({
      ...coord,
      zone: zoneLabel(coord),
      enemyHalf: isEnemyHalf(coord, side),
    }));
    return { teamId, mapped };
  },
};