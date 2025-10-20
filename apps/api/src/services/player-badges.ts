import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import consola from 'consola';
import { bedrockClient } from '../clients/bedrock.js';
import { BADGES_PROMPT } from '../prompts/badges.js';
import compareRoleStats from '../utils/compare-role-stats.js';

export type NormalizedBadge = {
  title: string;
  description: string;
  reason: string;
  polarity: 'good' | 'bad' | 'neutral';
};

export type NormalizedBadgesResponse = {
  badges: NormalizedBadge[];
};

const negativeTitles = new Set([
  'Vision Improvement Needed',
  'Early Game Struggles',
  'Objective Neglect',
  'Damage Output Gap',
  'Farm Efficiency Gap',
  'Tower Pressure Gap',
  'Death Discipline',
  'Positioning Cleanup',
  'Mid Game Dip',
  'Scaling Issues',
  'Team Contribution Gap',
  'Level Tempo Lag',
  'Experience Gap',
]);

export function normalizeBadgesResponse(
  input: unknown,
): NormalizedBadgesResponse {
  const out: NormalizedBadgesResponse = { badges: [] };
  if (!input || typeof input !== 'object') return out;
  const anyObj = input as Record<string, unknown>;
  const badgesRaw = anyObj.badges;
  if (!Array.isArray(badgesRaw)) return out;

  const normalizePolarity = (
    title: string,
    val: unknown,
  ): 'good' | 'bad' | 'neutral' => {
    const s = String(val ?? '')
      .toLowerCase()
      .trim();
    if (s === 'good' || s === 'bad' || s === 'neutral')
      return s as 'good' | 'bad' | 'neutral';
    return negativeTitles.has(title) ? 'bad' : 'good';
  };

  const mapped = badgesRaw
    .map((b: unknown) => {
      const obj = (b ?? {}) as Record<string, unknown>;
      const title = String(obj.title ?? obj.name ?? '').trim();
      const description = String(obj.description ?? '').trim();
      const reason = String(obj.reason ?? obj.reasoning ?? '').trim();
      const polarity = normalizePolarity(title, obj.polarity);
      if (!title && !description && !reason) return null;
      return {
        title: title || 'Badge',
        description: description || '',
        reason: reason || '',
        polarity,
      } as NormalizedBadge;
    })
    .filter(Boolean) as NormalizedBadge[];

  out.badges = mapped;
  return out;
}

export function computeRoleWeights(stats: Array<Record<string, unknown>>): {
  weights: Record<string, number>;
  primaryRole: string | null;
} {
  const counts: Record<string, number> = {};
  let total = 0;
  for (const row of stats) {
    const role = String(row.position ?? 'UNKNOWN');
    const rc = Number(row.rowsCount ?? 0) || 0;
    counts[role] = (counts[role] ?? 0) + rc;
    total += rc;
  }
  const weights: Record<string, number> = {};
  let primaryRole: string | null = null;
  let best = Number.NEGATIVE_INFINITY;
  for (const [role, rc] of Object.entries(counts)) {
    const pct = total > 0 ? Math.round((rc / total) * 10000) / 100 : 0;
    weights[role] = pct;
    if (rc > best) {
      best = rc;
      primaryRole = role;
    }
  }
  return { weights, primaryRole };
}

export function buildBadgesPromptFromStats(
  myStats: Array<Record<string, unknown>>,
  enemyStats: Array<Record<string, unknown>>,
): string {
  const comparisons = compareRoleStats(myStats, enemyStats);

  const header =
    "You are RiftCoach's League of Legends badge generator. Analyze the player's per-role performance versus direct opponents and award 1–5 badges that best fit their playstyle.";

  const rules =
    "Rules:\n- Use the following badge catalog and instructions.\n- Treat the player's most-weighted role strictly as the provided 'Primary Role'. Do NOT infer or vary it.\n- You may award badges for other roles if evidence is strong, but never call other roles 'most-weighted'.\n- Prioritize badges only when stats clearly support them; avoid contradictory picks.\n- Output MUST be ONLY valid JSON with one top-level key: badges.\n- badges must be an array of 1–5 objects.\n- Each badge object MUST have keys exactly: title, description, reason, polarity.\n- polarity must be one of: good | bad | neutral\n- For each badge, the 'reason' MUST include at least one explicit numeric value from the metrics that define the selected badge. Cite numbers strictly from that badge’s AI instructions; do NOT pull in unrelated stats (e.g., gold/XP/timepoint metrics) unless the badge explicitly references them. Avoid generic words like 'higher' or 'lower' without numbers.\n- Use the catalog 'name' as the badge title.\n- CRITICAL REASONING STYLE: Write the 'reason' field in a conversational, engaging tone that feels like a coach talking to the player. Avoid robotic statistical reporting.\n- Include specific numbers but weave them into natural language that celebrates achievements or explains performance patterns.\n- GOOD reasoning example: 'You consistently outfarmed your lane opponents, with a +6.3 CS advantage at 10 minutes - that extra farming translates to real gold advantages that fuel your item spikes.'\n- BAD reasoning example: 'Player avgCSAt10 is 71.7 vs opponents 65.4 showing higher CS advantage.'\n- Make it personal and motivational while being factually accurate with the statistics.\n- CRITICAL: When stating comparisons, ensure logical consistency - if player has LOWER values in positive metrics (CS, gold, etc.), they are performing WORSE, not better.";

  const formatHint =
    "Input data format:\n- statComparisons: Pre-computed differences between player and opponent stats by role. Each role contains nested stats where numeric values represent the difference (player - opponent).\n- POSITIVE differences mean player is BETTER, NEGATIVE differences mean player is WORSE\n- Use these pre-computed differences directly - DO NOT manually calculate differences from raw stats\n- Example: if avgCSAt10 shows +6.3, the player averages 6.3 more CS at 10 minutes than opponents\n- Example: if avgGoldAt10 shows +265, the player averages 265 more gold at 10 minutes than opponents\n- Example: if deathsPerMin shows -0.05, the player dies 0.05 less per minute than opponents (BETTER)\n\nREASONING TONE GUIDELINES:\n- Address the player directly using 'you' and 'your'\n- Use encouraging language that highlights their strengths\n- Transform dry statistics into meaningful insights about their playstyle\n- Example transformations:\n  * 'avgCSAt10: +6.3' → 'You consistently outfarm your opponents early, securing an extra 6.3 CS by 10 minutes'\n  * 'goldPerMin: +0.45' → 'Your efficient farming translates to an extra 45 gold per minute advantage'\n  * 'visionScorePerMin: +0.4' → 'You light up the map with 40% more vision than your opponents'\n- Focus on what the numbers mean for their gameplay impact, not just the raw comparison.";

  const catalog = BADGES_PROMPT;

  const jsonOnly =
    'CRITICAL OUTPUT FORMAT:\n- Respond with ONLY valid JSON\n- NO reasoning chains, NO <reasoning> tags, NO explanations\n- NO markdown formatting, NO code blocks\n- Start immediately with \'{\' and end with \'\'}\'\n- Structure: { "badges": [{"title": "...", "description": "...", "reason": "...", "polarity": "good|bad|neutral"}] }\n- Must contain 1-5 badge objects\n- Each badge must have all four fields: title, description, reason, polarity';

  const weightsAndPrimary = computeRoleWeights(myStats);
  const roleWeights = weightsAndPrimary.weights;
  const primaryRole = weightsAndPrimary.primaryRole ?? 'UNKNOWN';

  return [
    header,
    '',
    'Player Role Weights (% by rowsCount):',
    JSON.stringify(roleWeights),
    '',
    `Primary Role (most-weighted): ${String(primaryRole)}`,
    '',
    rules,
    '',
    formatHint,
    '',
    'Badge Catalog & Instructions:',
    catalog,
    '',
    jsonOnly,
    '',
    'Statistical Comparisons (Player vs Opponents - Pre-computed Differences):',
    JSON.stringify(comparisons, null, 2),
  ].join('\n');
}

export async function invokeBadgesModel(prompt: string): Promise<{
  badges: Array<{
    title?: string;
    name?: string;
    description?: string;
    reason?: string;
    reasoning?: string;
    polarity?: string;
  }>;
}> {
  const instruction = `<s>[INST] ${prompt} [/INST]`;

  const payload = {
    prompt: instruction,
    max_tokens: 1500,
    temperature: 0.3,
    top_p: 0.9,
    top_k: 50,
  };

  const command = new InvokeModelCommand({
    modelId: 'mistral.mixtral-8x7b-instruct-v0:1',
    contentType: 'application/json',
    body: JSON.stringify(payload),
  });

  const response = await bedrockClient.send(command);
  if (!response.body) throw new Error('No response body from Bedrock');
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  const aiText = responseBody.outputs?.[0]?.text || '{}';

  let cleanedText = aiText;

  cleanedText = cleanedText.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '');

  const firstBrace = cleanedText.indexOf('{');
  const lastBrace = cleanedText.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleanedText = cleanedText.slice(firstBrace, lastBrace + 1);
  }

  try {
    const parsed = JSON.parse(cleanedText);
    if (
      parsed.badges &&
      Array.isArray(parsed.badges) &&
      parsed.badges.length >= 1 &&
      parsed.badges.length <= 5
    ) {
      return parsed;
    }
    throw new Error('Invalid badge structure');
  } catch (error) {
    consola.error('Error parsing AI response:', aiText);
    consola.error('Cleaned text:', cleanedText);
    consola.error('Parse error:', error);

    return {
      badges: [
        {
          title: 'Consistent Player',
          description: 'Shows steady performance across matches',
          reason: 'Fallback badge due to AI generation failure',
          polarity: 'neutral',
        },
        {
          title: 'Team Player',
          description: 'Contributes effectively to team objectives',
          reason: 'Fallback badge due to AI generation failure',
          polarity: 'neutral',
        },
      ],
    };
  }
}
