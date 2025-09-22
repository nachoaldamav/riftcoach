import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import { athenaClient } from "./athena-client.js";

const app = new Hono();

app.get("/", async (c) => {
  return c.json({
    message: "Hello World",
  });
});

app.get("/athena/champ-avg/:season/:patch/:champion/:role", async (c) => {
  try {
    const { season, patch, champion, role } = c.req.param();

    // Input validation and sanitization
    const sanitizedSeason = parseInt(season);
    if (
      isNaN(sanitizedSeason) ||
      sanitizedSeason < 2014 ||
      sanitizedSeason > 2026
    ) {
      return c.json({ error: "Invalid season parameter" }, 400);
    }

    const sanitizedChampion = parseInt(champion);
    if (
      isNaN(sanitizedChampion) ||
      sanitizedChampion < 1 ||
      sanitizedChampion > 1000
    ) {
      return c.json({ error: "Invalid champion parameter" }, 400);
    }

    // Validate patch format (should be numeric like "15", "14", etc.)
    const sanitizedPatch = parseInt(patch);
    if (isNaN(sanitizedPatch) || sanitizedPatch < 1 || sanitizedPatch > 50) {
      return c.json({ error: "Invalid patch parameter" }, 400);
    }

    // Validate role (whitelist approach)
    const validRoles = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];
    if (!validRoles.includes(role.toUpperCase())) {
      return c.json({ error: "Invalid role parameter" }, 400);
    }
    const sanitizedRole = role.toUpperCase();

    // Use parameterized query approach with validated inputs
    const query = `
    SELECT
      role,
      season,
      SUM(players) AS total_players,
      SUM(games) AS total_games,
      -- Weighted Averages
      SUM(kp_p95 * games) / SUM(games) AS season_avg_kp,
      SUM(vis_per_min_p95 * games) / SUM(games) AS season_avg_vis_per_min,
      SUM(wclear_per_min_p95 * games) / SUM(games) AS season_avg_wclear_per_min,
      SUM(dpg_p95 * games) / SUM(games) AS season_avg_dpg,
      SUM(cs10_p95 * games) / SUM(games) AS season_avg_cs10,
      SUM(csfull_p95 * games) / SUM(games) AS season_avg_csfull,
      SUM(drake_participation_mean * games) / SUM(games) AS season_avg_drake_participation,
      SUM(herald_participation_mean * games) / SUM(games) AS season_avg_herald_participation,
      SUM(baron_participation_mean * games) / SUM(games) AS season_avg_baron_participation,
      SUM(obj_participation_mean * games) / SUM(games) AS season_avg_obj_participation
    FROM
      lol.cohorts_role_champ_snap
    WHERE
      season = ${sanitizedSeason}
      AND patch LIKE '${sanitizedPatch}.%'
      AND queue IN (400, 420, 440)
      AND championid = ${sanitizedChampion}
      AND role = '${sanitizedRole}'
      AND cs10_mean > 0
    GROUP BY
      role,
      season;
  `;

    const start = Date.now();
    const results = await athenaClient.query<{
      role: string;
      season: string;
      total_players: number;
      total_games: number;
      season_avg_kp: number;
      season_avg_vis_per_min: number;
      season_avg_wclear_per_min: number;
      season_avg_dpg: number;
      season_avg_cs10: number;
      season_avg_csfull: number;
      season_avg_drake_participation: number;
      season_avg_herald_participation: number;
      season_avg_baron_participation: number;
      season_avg_obj_participation: number;
    }>(query);
    const end = Date.now();
    console.log(`Query took ${(end - start).toFixed(2)}ms`);
    return c.json(results.data[0] ?? {});
  } catch (error) {
    console.error("Error querying Athena:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

export const handler = handle(app);
