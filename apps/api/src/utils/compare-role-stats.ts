type AnyObject = Record<string, unknown>;

export interface RoleComparison {
  position: string;
  weight: { player: number; opponents: number };
  stats: AnyObject; // mirrored shape of original stats, but numeric leaves become just the diff value (number)
}

function isNumeric(val: unknown): val is number {
  return typeof val === 'number' && Number.isFinite(val);
}

function round(val: number | null, decimals = 2): number | null {
  if (val === null || !Number.isFinite(val)) return null;
  const p = 10 ** decimals;
  return Math.round(val * p) / p;
}

function computeWeights(docs: AnyObject[]): Record<string, number> {
  const total = docs.reduce(
    (sum, d) => sum + (Number(d.rowsCount ?? 0) || 0),
    0,
  );
  if (total <= 0) return {};
  return docs.reduce<Record<string, number>>((acc, d) => {
    const role = String(d.position ?? 'UNKNOWN');
    const rc = Number(d.rowsCount ?? 0) || 0;
    acc[role] = round((rc / total) * 100, 2) ?? 0;
    return acc;
  }, {});
}

/**
 * Build a deep diff structure that mirrors the original stats shape.
 * Numeric leaves become { player, opponents, diff }.
 * Non-numeric leaves are copied verbatim when both sides match object shape;
 * arrays are not diffed here and should be handled separately if needed.
 */
function buildDiffOnly(player: unknown, opponents: unknown): unknown {
  // Numeric leaves: return the diff value when both are numeric, otherwise omit
  if (isNumeric(player) && isNumeric(opponents)) {
    return round(Number(player) - Number(opponents), 2);
  }
  if (isNumeric(player) || isNumeric(opponents)) {
    // One side missing or non-numeric – no meaningful diff
    return undefined;
  }

  // Handle plain objects
  if (player && typeof player === 'object' && !Array.isArray(player)) {
    const pObj = player as AnyObject;
    const oObj =
      opponents && typeof opponents === 'object' && !Array.isArray(opponents)
        ? (opponents as AnyObject)
        : ({} as AnyObject);
    const keys = new Set<string>([...Object.keys(pObj), ...Object.keys(oObj)]);
    const out: AnyObject = {};
    for (const key of keys) {
      const child = buildDiffOnly(pObj[key], oObj[key]);
      if (child !== undefined) out[key] = child as unknown;
    }
    // If no numeric diffs inside, omit this branch
    return Object.keys(out).length > 0 ? out : undefined;
  }

  // Arrays or other non-numeric primitives: omit
  return undefined;
}

function indexByPosition<T extends AnyObject>(rows: T[]): Record<string, T> {
  return rows.reduce<Record<string, T>>((acc, row) => {
    const pos = String(row.position ?? 'UNKNOWN');
    acc[pos] = row;
    return acc;
  }, {});
}

/**
 * Compare role stats between player and opponents while preserving structure.
 *
 * - weights are computed independently for player and opponent datasets from rowsCount.
 * - stats are mirrored from the player/opponents role objects, with numeric leaf values
 *   wrapped into { player, opponents, diff }.
 * - champions arrays are exposed under `champions` with player/opponents values.
 */
export function compareRoleStats(
  playerRoles: AnyObject[],
  opponentRoles: AnyObject[],
): RoleComparison[] {
  const playerIdx = indexByPosition(playerRoles);
  const oppIdx = indexByPosition(opponentRoles);
  const roles = new Set<string>([
    ...Object.keys(playerIdx),
    ...Object.keys(oppIdx),
  ]);
  const playerWeights = computeWeights(playerRoles);
  const opponentWeights = computeWeights(opponentRoles);

  const result: RoleComparison[] = [];
  for (const role of roles) {
    const p = playerIdx[role];
    const o = oppIdx[role];
    const stats = (buildDiffOnly(p, o) ?? {}) as AnyObject;

    result.push({
      position: role,
      weight: {
        player: playerWeights[role] ?? 0,
        opponents: opponentWeights[role] ?? 0,
      },
      stats,
    });
  }

  return result;
}

export default compareRoleStats;
