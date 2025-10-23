import consola from 'consola';
import type { DDragonChampion } from '../../utils/ddragon-champions.js';

// Map utils duplicated from match-insights (no logic change)
export type TeamSide = 'BLUE' | 'RED';

export function normCoordinate(v: number): number {
  const min = 0;
  const max = 15000;
  const clamped = Math.max(min, Math.min(max, v));
  return clamped / max;
}

export function detectTeamSide(teamId?: number | null): TeamSide {
  return teamId === 100 ? 'BLUE' : 'RED';
}

export function zoneLabel(pos?: { x: number; y: number } | null): string {
  if (!pos) return 'unknown';
  const x = normCoordinate(pos.x);
  const y = normCoordinate(pos.y);

  const dist = (cx: number, cy: number) => {
    const dx = x - cx;
    const dy = y - cy;
    return Math.hypot(dx, dy);
  };

  const BLUE_NEXUS = { x: 0.08, y: 0.08 };
  const RED_NEXUS = { x: 0.92, y: 0.92 };
  const NEXUS_RADIUS = 0.11;
  const BASE_RADIUS = 0.17;

  if (dist(BLUE_NEXUS.x, BLUE_NEXUS.y) <= NEXUS_RADIUS) return 'BLUE_NEXUS';
  if (dist(RED_NEXUS.x, RED_NEXUS.y) <= NEXUS_RADIUS) return 'RED_NEXUS';
  if (dist(BLUE_NEXUS.x, BLUE_NEXUS.y) <= BASE_RADIUS) return 'BLUE_BASE';
  if (dist(RED_NEXUS.x, RED_NEXUS.y) <= BASE_RADIUS) return 'RED_BASE';

  const BARON_PIT = { x: 0.32, y: 0.73 };
  const DRAGON_PIT = { x: 0.68, y: 0.27 };
  const PIT_RADIUS = 0.05;

  if (dist(BARON_PIT.x, BARON_PIT.y) <= PIT_RADIUS) return 'BARON_PIT';
  if (dist(DRAGON_PIT.x, DRAGON_PIT.y) <= PIT_RADIUS) return 'DRAGON_PIT';

  const rotAcross = (y - x) / Math.SQRT2;
  const rotAlong = (x + y - 1) / Math.SQRT2;
  const distToRiver = Math.abs(rotAlong) * Math.SQRT2;

  if (distToRiver <= 0.045) {
    if (rotAcross > 0.14) return 'TOP_RIVER';
    if (rotAcross < -0.14) return 'BOTTOM_RIVER';
    return 'MIDDLE_RIVER';
  }

  const absAcross = Math.abs(rotAcross);
  const MID_LANE_BAND = 0.1;
  const LANE_BAND = 0.33;
  const MID_JUNGLE_BAND = 0.2;

  if (absAcross <= MID_LANE_BAND) return 'MIDDLE_LANE';
  if (rotAcross >= LANE_BAND) return 'TOP_LANE';
  if (rotAcross <= -LANE_BAND) return 'BOTTOM_LANE';
  if (absAcross <= MID_JUNGLE_BAND) return 'MIDDLE_JUNGLE';
  return rotAcross > 0 ? 'TOP_JUNGLE' : 'BOTTOM_JUNGLE';
}

export function isEnemyHalf(
  pos: { x: number; y: number } | null,
  side: TeamSide,
): boolean {
  if (!pos) return false;
  const x = normCoordinate(pos.x);
  const y = normCoordinate(pos.y);
  const s = x + y;
  return side === 'BLUE' ? s > 1.02 : s < 0.98;
}

// Champion ability hint builder duplicated from match-insights (no logic change)
export function buildAbilityHintFromDDragon(ch: DDragonChampion): string {
  const texts: string[] = [];
  if (ch.passive?.sanitizedDescription)
    texts.push(ch.passive.sanitizedDescription);
  if (ch.passive?.description) texts.push(ch.passive.description);
  for (const s of ch.spells ?? []) {
    if (s?.sanitizedDescription) texts.push(s.sanitizedDescription as string);
    else if (s?.description) texts.push(s.description as string);
    else if (s?.tooltip) texts.push(s.tooltip as string);
  }
  const blob = texts.join(' ').toLowerCase();
  const hasHeal = /(\bheal\b|\bheals\b|healing|restore|regenerat)/i.test(blob);
  const hasShield = /\bshield/i.test(blob);
  const mentionsGW = /(grievous|anti-?heal)/i.test(blob);
  const parts: string[] = [];
  if (hasHeal) parts.push('Has healing/sustain.');
  if (hasShield) parts.push('Has shields.');
  if (!hasHeal && !hasShield) parts.push('No heal/shield in kit.');
  parts.push(
    mentionsGW
      ? 'Validate anti-heal claims in context; prefer items.'
      : 'No ability applies Grievous Wounds; anti-heal via items only.',
  );
  return parts.join(' ');
}