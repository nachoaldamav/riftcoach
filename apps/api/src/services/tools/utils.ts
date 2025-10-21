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
  const distToDiag = Math.abs(x - (1 - y));
  const nearRiver = distToDiag < 0.06;
  const lane = y > 0.66 ? 'TOP' : y < 0.33 ? 'BOTTOM' : 'MIDDLE';
  const nearLane =
    (lane === 'TOP' && x < 0.6) ||
    (lane === 'BOTTOM' && x > 0.4) ||
    lane === 'MIDDLE';
  if (nearRiver) return `${lane}_RIVER`;
  return nearLane ? `${lane}_LANE` : `${lane}_JUNGLE`;
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