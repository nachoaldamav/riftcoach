import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import consola from 'consola';
import { bedrockClient } from '../clients/bedrock.js';

export type ChampionInsight = {
  championId: number;
  championName: string;
  totalGames: number;
  winRate: number;
  recentWinRate: number;
  avgKda: number;
  consistencyScore: number;
  performanceTrend: unknown;
  roles: string[];
  daysSinceLastPlayed: number;
};

export type ChampionInsightsAIResponse = {
  summary: string;
  trends: Array<{
    type: 'improvement' | 'decline' | 'stable';
    metric: string;
    description: string;
    confidence: number;
  }>;
  recommendations: Array<{
    category: 'champion_pool' | 'playstyle' | 'focus_areas';
    title: string;
    description: string;
    priority: 'high' | 'medium' | 'low';
  }>;
  confidence: number;
};

export async function generateChampionInsights(
  championData: ChampionInsight[],
): Promise<ChampionInsightsAIResponse> {
  const topChampions = championData.slice(0, 5);
  const analysisData = {
    totalChampions: championData.length,
    topPerformers: topChampions.map((champ) => ({
      name: champ.championName,
      games: champ.totalGames,
      winRate: champ.winRate,
      recentWinRate: champ.recentWinRate,
      avgKda: champ.avgKda,
      consistencyScore: champ.consistencyScore,
      trends: champ.performanceTrend,
      roles: champ.roles,
      daysSinceLastPlayed: champ.daysSinceLastPlayed,
    })),
    overallStats: {
      totalGames: championData.reduce(
        (sum, champ) => sum + champ.totalGames,
        0,
      ),
      avgWinRate:
        championData.reduce(
          (sum, champ) => sum + champ.winRate * champ.totalGames,
          0,
        ) / championData.reduce((sum, champ) => sum + champ.totalGames, 0),
      avgKda:
        championData.reduce(
          (sum, champ) => sum + champ.avgKda * champ.totalGames,
          0,
        ) / championData.reduce((sum, champ) => sum + champ.totalGames, 0),
    },
  };

  const prompt = `Analyze this League of Legends player's champion performance data and provide insights:

${JSON.stringify(analysisData, null, 2)}

Based on this data, provide a JSON response with:
1. A brief summary of the player's champion performance
2. Performance trends (improvement/decline/stable) for key metrics
3. Actionable recommendations for champion pool, playstyle, and focus areas
4. Overall confidence score (0-100)

Focus on:
- Recent performance trends vs overall performance
- Champion diversity and specialization
- Consistency across different champions
- Areas for improvement based on the data

Respond with valid JSON only in this exact format:
{
  "summary": "Brief overview of player's champion performance",
  "trends": [
    {
      "type": "improvement|decline|stable",
      "metric": "metric name",
      "description": "trend description",
      "confidence": 85
    }
  ],
  "recommendations": [
    {
      "category": "champion_pool|playstyle|focus_areas",
      "title": "recommendation title",
      "description": "detailed recommendation",
      "priority": "high|medium|low"
    }
  ],
  "confidence": 85
}`;

  const instruction = `<s>[INST] ${prompt} [/INST]`;

  const payload = {
    prompt: instruction,
    max_tokens: 2000,
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

  const firstBrace = cleanedText.indexOf('{');
  const lastBrace = cleanedText.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleanedText = cleanedText.slice(firstBrace, lastBrace + 1);
  }

  try {
    const parsed = JSON.parse(cleanedText);

    return {
      summary: parsed.summary || 'Analysis of champion performance completed.',
      trends: Array.isArray(parsed.trends) ? parsed.trends.slice(0, 5) : [],
      recommendations: Array.isArray(parsed.recommendations)
        ? parsed.recommendations.slice(0, 4)
        : [],
      confidence: Math.min(Math.max(parsed.confidence || 75, 0), 100),
    };
  } catch (error) {
    consola.error('Error parsing AI insights response:', error);

    return generateFallbackInsights(championData);
  }
}

export function generateFallbackInsights(
  championData: Array<{
    championName: string;
    totalGames: number;
    winRate: number;
    daysSinceLastPlayed: number;
  }>,
): ChampionInsightsAIResponse {
  const topChamp = championData[0];
  const recentlyPlayed = championData.filter(
    (champ) => champ.daysSinceLastPlayed <= 7,
  );

  return {
    summary: `Analysis of ${championData.length} champions shows ${topChamp?.championName || 'your top champion'} as your strongest performer with ${topChamp?.winRate || 0}% win rate.`,
    trends: [
      {
        type: 'stable',
        metric: 'Champion Performance',
        description: 'Consistent performance across your champion pool',
        confidence: 70,
      },
    ],
    recommendations: [
      {
        category: 'champion_pool',
        title: 'Focus on Main Champions',
        description: `Continue playing ${topChamp?.championName || 'your best champions'} to maintain your current performance level.`,
        priority: 'medium',
      },
    ],
    confidence: 70,
  };
}
