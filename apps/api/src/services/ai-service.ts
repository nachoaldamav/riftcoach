import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import chalk from 'chalk';
import { consola } from 'consola';
import type { CohortStatsPerRole } from '../queries/cohorts-role-stats.js';
import type { PlayerStatsPerRole } from '../queries/puuid-role-stats.js';
import { getCachedData, setCachedData } from './cache-utils.js';
import type { AIBadgeResult } from './types.js';
import { BADGE_CATALOG } from './types.js';

const bedrockClient = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || 'eu-west-1',
});

function normalizePercentish(v: number | null | undefined): number | null {
  if (v == null) return null;
  return v > 1 ? v / 100 : v;
}

function toDisplayPercent(v: number | null | undefined, digits = 1): string {
  if (v == null) return 'N/A';
  return `${(v * 100).toFixed(digits)}%`;
}

function calculateSignificance(
  percentageDifference: number,
): 'much_higher' | 'higher' | 'similar' | 'lower' | 'much_lower' {
  if (percentageDifference >= 25) return 'much_higher';
  if (percentageDifference >= 10) return 'higher';
  if (percentageDifference >= -10) return 'similar';
  if (percentageDifference >= -25) return 'lower';
  return 'much_lower';
}

function computeRoleWeightsFromGames(playerRoles: PlayerStatsPerRole[]): {
  [role: string]: number;
} {
  const totalGames = playerRoles.reduce((sum, r) => sum + (r.games || 0), 0);
  const weights: { [role: string]: number } = {};
  for (const r of playerRoles) {
    if (!r.role) continue;
    const w = totalGames > 0 ? (r.games || 0) / totalGames : 0;
    weights[r.role] = w;
  }
  return weights;
}

function getWeightedMetric(
  playerRoles: PlayerStatsPerRole[],
  cohortRoles: CohortStatsPerRole[],
  metric: keyof PlayerStatsPerRole & keyof CohortStatsPerRole,
  weights: { [role: string]: number },
  percentish = false,
): { player: number | null; cohort: number | null } {
  let pSum = 0;
  let cSum = 0;
  let totalW = 0;
  for (const [role, w] of Object.entries(weights)) {
    const p = playerRoles.find((r) => r.role === role);
    const c = cohortRoles.find((r) => r.role === role);
    if (!p || !c) continue;
    let pv = p[metric] as unknown as number | null;
    let cv = c[metric] as unknown as number | null;
    if (percentish) {
      pv = normalizePercentish(pv) ?? null;
      cv = normalizePercentish(cv) ?? null;
    }
    if (pv != null && cv != null) {
      pSum += pv * w;
      cSum += cv * w;
      totalW += w;
    }
  }
  if (totalW === 0) return { player: null, cohort: null };
  return { player: pSum / totalW, cohort: cSum / totalW };
}

function formatPerRoleStatsForAI(
  playerRoles: PlayerStatsPerRole[],
  cohortRoles: CohortStatsPerRole[],
): string[] {
  const lines: string[] = [];
  const weights = computeRoleWeightsFromGames(playerRoles);
  const rolesByWeight = Object.entries(weights).sort(([, a], [, b]) => b - a);

  const keyStats: Array<{
    playerKey: keyof PlayerStatsPerRole;
    cohortKey: keyof CohortStatsPerRole;
    displayName: string;
    isPercentage?: boolean;
  }> = [
    {
      playerKey: 'kill_participation_pct_est',
      cohortKey: 'kill_participation_pct_est',
      displayName: 'Kill Participation',
      isPercentage: true,
    },
    {
      playerKey: 'avg_vision_score_per_min',
      cohortKey: 'avg_vision_score_per_min',
      displayName: 'Vision Score/Min',
    },
    { playerKey: 'avg_dpm', cohortKey: 'avg_dpm', displayName: 'Damage/Min' },
    { playerKey: 'avg_gpm', cohortKey: 'avg_gpm', displayName: 'Gold/Min' },
    {
      playerKey: 'avg_team_dmg_pct',
      cohortKey: 'avg_team_dmg_pct',
      displayName: 'Team Damage %',
      isPercentage: true,
    },
    { playerKey: 'avg_kda', cohortKey: 'avg_kda', displayName: 'KDA' },
    {
      playerKey: 'win_rate_pct_estimate',
      cohortKey: 'win_rate_pct_estimate',
      displayName: 'Win Rate',
      isPercentage: true,
    },
    {
      playerKey: 'avg_wards_killed',
      cohortKey: 'avg_wards_killed',
      displayName: 'Wards Cleared',
    },
    {
      playerKey: 'avg_early_solo_kills',
      cohortKey: 'avg_early_solo_kills',
      displayName: 'Early Solo Kills',
    },
    {
      playerKey: 'avg_cs_at10',
      cohortKey: 'avg_cs_at10',
      displayName: 'CS@10',
    },
  ];

  for (const [role, weight] of rolesByWeight) {
    if (weight < 0.05) continue;
    const p = playerRoles.find((r) => r.role === role);
    const c = cohortRoles.find((r) => r.role === role);
    if (!p || !c) continue;

    for (const stat of keyStats) {
      const pv = p[stat.playerKey] as unknown as number | null;
      const cv = c[stat.cohortKey] as unknown as number | null;
      if (pv === null || cv === null || cv === 0) continue;
      let pForMath = pv;
      let cForMath = cv;
      if (stat.isPercentage) {
        pForMath = normalizePercentish(pv) || 0;
        cForMath = normalizePercentish(cv) || 0;
      }
      const percentageDiff = ((pForMath - cForMath) / cForMath) * 100;
      const significance = calculateSignificance(percentageDiff);
      if (Math.abs(percentageDiff) >= 10 || weight >= 0.3) {
        const playerDisplay = stat.isPercentage
          ? toDisplayPercent(pForMath)
          : pForMath.toFixed(2);
        const cohortDisplay = stat.isPercentage
          ? toDisplayPercent(cForMath)
          : cForMath.toFixed(2);
        lines.push(
          `${stat.displayName}:${role} | ${playerDisplay} - ${cohortDisplay} | ${(weight * 100).toFixed(0)}% (${percentageDiff >= 0 ? '+' : ''}${percentageDiff.toFixed(1)}%, ${significance})`,
        );
      }
    }
  }

  // Weighted overall slice
  const overallStats = [
    {
      name: 'Overall Kill Participation',
      metric: 'kill_participation_pct_est' as const,
      isPercentage: true,
    },
    {
      name: 'Overall Vision Score/Min',
      metric: 'avg_vision_score_per_min' as const,
    },
    { name: 'Overall Damage/Min', metric: 'avg_dpm' as const },
    {
      name: 'Overall Win Rate',
      metric: 'win_rate_pct_estimate' as const,
      isPercentage: true,
    },
  ];

  lines.push('');
  lines.push('=== WEIGHTED OVERALL PERFORMANCE ===');
  for (const stat of overallStats) {
    const weights = computeRoleWeightsFromGames(playerRoles);
    const weighted = getWeightedMetric(
      playerRoles,
      cohortRoles,
      stat.metric,
      weights,
      !!stat.isPercentage,
    );
    if (
      weighted.player != null &&
      weighted.cohort != null &&
      Math.abs(((weighted.player - weighted.cohort) / weighted.cohort) * 100) >=
        5
    ) {
      const p = stat.isPercentage
        ? toDisplayPercent(weighted.player)
        : (weighted.player as number).toFixed(2);
      const c = stat.isPercentage
        ? toDisplayPercent(weighted.cohort)
        : (weighted.cohort as number).toFixed(2);
      const pdiff =
        ((weighted.player - weighted.cohort) / weighted.cohort) * 100;
      const sig = calculateSignificance(pdiff);
      lines.push(
        `${stat.name} | ${p} - ${c} | (${pdiff >= 0 ? '+' : ''}${pdiff.toFixed(1)}%, ${sig})`,
      );
    }
  }

  return lines;
}

function buildEnhancedPerRoleBadgePrompt(
  playerRoles: PlayerStatsPerRole[],
  cohortRoles: CohortStatsPerRole[],
): string {
  const formattedStats = formatPerRoleStatsForAI(playerRoles, cohortRoles);

  // Role insights (strengths/weaknesses)
  const weights = computeRoleWeightsFromGames(playerRoles);
  const rolesByWeight = Object.entries(weights).sort(([, a], [, b]) => b - a);
  const insights: string[] = ['=== ROLE-SPECIFIC ANALYSIS ==='];
  for (const [role, weight] of rolesByWeight) {
    if (weight < 0.05) continue;
    const p = playerRoles.find((r) => r.role === role);
    const c = cohortRoles.find((r) => r.role === role);
    if (!p || !c) continue;
    const comps = [
      {
        name: 'Kill Participation',
        player: normalizePercentish(p.kill_participation_pct_est),
        cohort: normalizePercentish(c.kill_participation_pct_est),
      },
      {
        name: 'Vision Score/Min',
        player: p.avg_vision_score_per_min,
        cohort: c.avg_vision_score_per_min,
      },
      { name: 'Damage/Min', player: p.avg_dpm, cohort: c.avg_dpm },
      { name: 'Gold/Min', player: p.avg_gpm, cohort: c.avg_gpm },
      {
        name: 'Win Rate',
        player: normalizePercentish(p.win_rate_pct_estimate),
        cohort: normalizePercentish(c.win_rate_pct_estimate),
      },
    ];
    const strengths: string[] = [];
    const weaknesses: string[] = [];
    for (const comp of comps) {
      if (comp.player != null && comp.cohort != null) {
        const diff = ((comp.player - comp.cohort) / comp.cohort) * 100;
        if (diff >= 15) strengths.push(`${comp.name} (+${diff.toFixed(1)}%)`);
        else if (diff <= -15)
          weaknesses.push(`${comp.name} (${diff.toFixed(1)}%)`);
      }
    }
    insights.push(
      `\n${role.toUpperCase()} (${Math.round(weight * 100)}% of games, ${p.games || 0} matches):`,
    );
    if (strengths.length) insights.push(`  Strengths: ${strengths.join(', ')}`);
    if (weaknesses.length)
      insights.push(`  Weaknesses: ${weaknesses.join(', ')}`);
  }

  return `You are an expert League of Legends analyst tasked with generating personalized playstyle badges for a player based on their per-role performance data and cohort comparisons.

## CRITICAL STATISTICAL INTERPRETATIONS

**ALWAYS verify the logical consistency of your badge assignments:**

1. **High values are GOOD for:** Kill Participation, Vision Score/Min, Damage/Min, Gold/Min, Win Rate, KDA, Team Damage %, Wards Cleared
2. **Low values are GOOD for:** Early Game Deaths
3. **Context matters:** A "Defensive Bastion" should have LOW deaths and HIGH survival rates, not the opposite

## BADGE ASSIGNMENT RULES

**Before assigning any badge, verify:**
- The player's stats actually support the badge's theme
- There are no contradictory statistics
- The reasoning aligns with the statistical evidence
- Focus on role-weighted performance, not overall averages

## FORMATTED PLAYER STATISTICS

**Format:** <Stat>:<Role> | <Player Value> - <Cohort Average> | <Role Weight>% (<Percentage Difference>, <Significance>)

${formattedStats.join('\n')}

${insights.join('\n')}

## AVAILABLE BADGES
${BADGE_CATALOG.map((badge) => `- **${badge.name}**: ${badge.focus}`).join('\n')}

## TASK
Analyze this player's performance using the formatted statistics above. Focus on role-weighted performance and ignore overall averages. Generate 2-4 badges that accurately reflect their playstyle.

CRITICAL: You MUST respond with ONLY valid JSON. Do not include any explanatory text, introductions, or conclusions. Start your response immediately with the opening brace "{" and end with the closing brace "}".

Return your analysis as a JSON object with this exact structure:
{
  "badges": [
    {
      "name": "Badge Name",
      "description": "Brief description of what this badge represents for this player",
      "confidence": 85,
      "reasoning": "Specific statistical evidence supporting this badge (cite actual numbers from the formatted stats)"
    }
  ],
  "summary": "2-3 sentence overview of the player's overall playstyle and key characteristics",
  "strengths": ["List of 2-3 key strengths based on the data"],
  "improvements": ["List of 2-3 areas for improvement based on the data"]
}`;
}

async function invokeModel(prompt: string): Promise<AIBadgeResult> {
  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 2000,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  };

  const command = new InvokeModelCommand({
    modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
    contentType: 'application/json',
    body: JSON.stringify(payload),
  });

  const response = await bedrockClient.send(command);
  if (!response.body) throw new Error('No response body from Bedrock');
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  const aiText = responseBody.content?.[0]?.text || '{}';
  return JSON.parse(aiText);
}

export async function generateAIBadges(
  playerRoles: PlayerStatsPerRole[],
  cohortRoles?: CohortStatsPerRole[],
): Promise<AIBadgeResult> {
  try {
    let prompt: string;
    if (cohortRoles && cohortRoles.length > 0) {
      prompt = buildEnhancedPerRoleBadgePrompt(playerRoles, cohortRoles);
    } else {
      const weights = computeRoleWeightsFromGames(playerRoles);
      const rolesByWeight = Object.entries(weights)
        .sort(([, a], [, b]) => b - a)
        .map(
          ([r, w]) =>
            `${r}: ${(w * 100).toFixed(0)}% (${playerRoles.find((p) => p.role === r)?.games || 0} matches)`,
        )
        .join('\n');
      prompt = `You are RiftCoach's playstyle scout. Review the player's per-role statistics and generate badges.\n\nRole distribution:\n${rolesByWeight}\n\nBadges Catalog:\n${BADGE_CATALOG.map((b) => `- ${b.name}: ${b.focus}`).join('\n')}\n\nCRITICAL: Respond with ONLY valid JSON { ... } as specified earlier.`;
    }

    consola.debug(
      chalk.blue('Invoking AI model for per-role badge generation...'),
    );
    const result = await invokeModel(prompt);
    consola.debug(
      chalk.green('AI per-role badge generation completed successfully'),
    );
    return result;
  } catch (error: unknown) {
    const err = error as Error;
    consola.error(
      chalk.red('Failed to generate AI badges using per-role stats:'),
      err.message,
    );
    return {
      badges: [
        {
          name: 'Consistent Player',
          description: 'Shows steady performance across matches',
          confidence: 50,
          reasoning: 'Fallback badge due to AI generation failure',
        },
      ],
      summary: 'Analysis unavailable due to technical issues',
      strengths: ['Plays regularly', 'Maintains consistent performance'],
      improvements: ['AI analysis temporarily unavailable'],
    };
  }
}

export async function getCachedAIBadges(
  playerRoles: PlayerStatsPerRole[],
  cohortRoles?: CohortStatsPerRole[],
  puuid?: string,
): Promise<AIBadgeResult> {
  if (!puuid) return generateAIBadges(playerRoles, cohortRoles);
  const cacheKey = `ai-results/per-role/season-2025/${puuid}`;
  try {
    const cached = await getCachedData<AIBadgeResult>(cacheKey);
    if (cached) {
      consola.debug(chalk.green('Using cached per-role AI badge results'));
      return cached;
    }
    const badges = await generateAIBadges(playerRoles, cohortRoles);
    await setCachedData(cacheKey, badges);
    return badges;
  } catch (error: unknown) {
    const err = error as Error;
    consola.warn(
      chalk.yellow(
        'Cache operation failed, generating per-role badges directly:',
      ),
      err.message,
    );
    return generateAIBadges(playerRoles, cohortRoles);
  }
}

// Backward-compatible aliases (if other modules import these names)
export const generateAIBadgesPerRole = generateAIBadges;
export const getCachedAIBadgesPerRole = getCachedAIBadges;
