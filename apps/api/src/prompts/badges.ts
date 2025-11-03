export const BADGES_PROMPT = `
**IMPORTANT BADGE DISTRIBUTION RULES:**
- Each player should receive 1-5 badges maximum to maintain exclusivity and meaning
- Prioritize badges that represent the player's most distinctive strengths and the most actionable improvements
- Avoid awarding badges for marginal statistical differences
- Consider the player's role when evaluating badge criteria
- If multiple badges could apply, choose the ones with the strongest statistical evidence
- When explaining badge reasons, include explicit numeric values ONLY from the metrics that define the selected badge. Cite numbers strictly from that badge’s AI instructions; do NOT pull in unrelated stats (e.g., gold/XP/timepoint metrics) unless the badge explicitly references them. Example: for "Objective Neglect", use \`avg_grubs_participation\` and \`avg_herald_participation\` diffs (e.g., -0.12, -0.15). If you cannot cite qualifying numbers for a badge, do not award it.

### **1. Objective Master**
*   **Description:** You exhibit masterful control over the map's most important objectives, consistently out-pacing your opponents where it matters most. Epic monsters and key objectives belong to your team when you're on the rift.
*   **AI instructions:** Award this badge if the player's per-match participation rate diffs are SIGNIFICANTLY POSITIVE versus opponents for \`drakes\`, \`herald\`, and \`baron\` (e.g., diff ≥ 0.1 for all three). Use per-match rates to avoid raw-count inflation from many games.

### **2. Vision Expert**
*   **Description:** You understand that knowledge is power. In your primary role, you consistently establish superior map awareness, providing more vision for your team and leaving your opponents to walk in the dark.
*   **AI instructions:** Award this badge if the \`visionScorePerMin\` value for the player's most-weighted role is significantly positive compared to opponents (e.g., player > opponent by 0.35+ for non-UTILITY roles, or 0.5+ for UTILITY roles). This badge should be RARE - only award if the player is in the top 15% of vision performance.

### **3. Early Game Dominator**
*   **Description:** The game starts the moment minions spawn, and you make sure your opponent knows it. You consistently build early leads in gold and CS, applying immense pressure from the very beginning of the match.
*   **AI instructions:** Award this badge if, for the player's most-weighted role, the \`avg_cs_at10\` and \`avg_gold_at10\` stats show the player has SIGNIFICANTLY HIGHER values than opponents (e.g., player gold > opponent gold by 500+ AND player CS > opponent CS by 20+). Both conditions must be met simultaneously. This should represent DOMINANT early game performance - only award if the player has a substantial, game-changing advantage. A 6 CS advantage is NOT sufficient. **DO NOT award this badge to players whose most-weighted role is UTILITY (support).** This badge should be RARE and only for truly dominant early game players.

### **4. Late Game Carry**
*   **Description:** You are the team's ace in the hole. Even if the early game is rocky, you are a master of scaling, consistently turning the tide and finding advantages in the chaotic late game.
*   **AI instructions:** Award this badge if, for the player's most-weighted role, the \`avg_cs_at30\` and \`avg_gold_at30\` stats show the player has HIGHER values than opponents (e.g., player gold > opponent gold by 200+, player XP > opponent XP by 300+). Consider awarding even if early game stats were lower, showing a comeback trend. This badge should be more accessible than Early Game Dominator.

### **5. Tank Specialist**
*   **Description:** You are the frontline your team can rely on. You have mastered the art of survival, dying less than your opponents while absorbing immense pressure for your team.
*   **AI instructions:** Award this badge if, for the player's most-weighted role, the \`avg_deaths\` value shows the player has LOWER deaths than opponents (e.g., player deaths < opponent deaths by 0.5+) OR the \`avg_dmg_taken_per_min\` shows HIGHER damage taken (e.g., player > opponent by 40+). Only one condition needs to be met, making this more achievable for tank players.

### **6. Tower Destroyer**
*   **Description:** You hear the call of stone and steel. Your relentless focus on structures helps your team crack open the map, consistently taking more turret plates and towers than your lane opponent.
*   **AI instructions:** Award this badge if, for the player's most-weighted role, the per-match participation rate diffs \`avg_turret_plates_participation\` and \`avg_towers_participation\` are POSITIVE and SIGNIFICANT (e.g., diff ≥ 0.1 for both). Use rates, not raw counts.

### **7. Damage Dealer**
*   **Description:** You don't just participate in fights; you end them. You consistently output significantly more damage per minute than your direct opponent, acting as the primary offensive engine for your team.
*   **AI instructions:** Award this badge if, for the player's most-weighted role, the \`avg_dpm\` shows the player has HIGHER damage output than opponents (e.g., player > opponent by 100+).

### **8. Gold Farmer**
*   **Description:** Through superior last-hitting and efficient pathing, you consistently generate a gold advantage over your opponent. You understand that the best items are bought with a heavy purse.
*   **AI instructions:** Award this badge if, for the player's most-weighted role, both \`avg_cs_total\` and \`avg_gpm\` show the player has HIGHER values than opponents (e.g., player CS > opponent CS by 10+, player gold > opponent gold by 25+). Slightly more accessible thresholds to encourage farming excellence.

### **9. Kill Specialist**
*   **Description:** You hunt with efficiency. Not only do you secure more kills than your opponent, but you also give over fewer deaths, resulting in a superior KDA ratio that keeps you on the map and ahead in power.
*   **AI instructions:** Award this badge if, for the player's most-weighted role, \`avg_kills\` shows the player has HIGHER kills than opponents (e.g., player > opponent by 1.0+) OR (\`avg_kills\` > opponent by 0.5+ AND \`avg_deaths\` < opponent by 0.5+). More flexible conditions to reward different types of kill efficiency.

### **10. Void Hunter**
*   **Description:** You prioritize the early game power of the Void. By securing Voidgrubs and Rift Heralds more often than your opponents, you grant your team devastating pushing power in the early-to-mid game.
*   **AI instructions:** Award this badge if the per-match participation rate diffs \`avg_grubs_participation\` and \`avg_herald_participation\` are POSITIVE and SIGNIFICANT (e.g., diff ≥ 0.1 for both). Use rates, not raw counts.

### **11. Team Player**
*   **Description:** You are the ultimate team player. Regardless of your role, you are constantly setting up plays and securing kills for your teammates, boasting a higher assist rate than your direct counterpart.
*   **AI instructions:** Award this badge if \`avg_assists\` shows the player has SIGNIFICANTLY HIGHER assists than opponents (e.g., player > opponent by 2.0+) AND the player has a low death rate (avg_deaths < opponent by 0.5+). This badge should represent exceptional team contribution, not just slightly higher assists. Particularly prioritize if the player is NOT in the UTILITY role.

### **12. Level Advantage**
*   **Description:** You understand the value of levels. Through efficient farming and staying alive, you consistently hit level power spikes before your opponent, giving you a distinct advantage in fights at the 15 and 20-minute marks.
*   **AI instructions:** Award this badge if \`avg_level_at15\` and \`avg_level_at20\` show the player has SIGNIFICANTLY HIGHER levels than opponents (e.g., player > opponent by 1.0+ levels at both 15 and 20 minute marks). The player must be at least one full level ahead to demonstrate true level advantage.

### **13. Consistent Performer**
*   **Description:** You are the rock your team can count on. Your performance rarely fluctuates, maintaining steady stats across multiple games with minimal variance in your key metrics.
*   **AI instructions:** Award this badge if the player's percentile data shows consistent performance across p50, p75, and p90 for kills, deaths, assists, and CS. Look for small gaps between percentiles (e.g., p90 kills - p50 kills < 3.0, similar patterns for other stats). This indicates reliable, consistent gameplay rather than feast-or-famine performance.

### **14. High Win Rate Champion**
*   **Description:** Victory follows in your wake. You have mastered the art of winning, consistently securing more victories than defeats across your matches.
*   **AI instructions:** Award this badge if the player's \`win_rate_pct_estimate\` is significantly higher than average (e.g., winRate > 65%). This badge should be rare and only awarded to players who demonstrate exceptional win consistency over a meaningful sample size (games > 20).

### **15. Atakhan Slayer**
*   **Description:** The newest epic monster bows to your might. You have shown exceptional control over Atakhan, the latest addition to the Rift's epic monsters, securing this powerful objective for your team.
*   **AI instructions:** Award this badge if the \`avg_atakhan_participation\` shows the player has SIGNIFICANTLY HIGHER participation than opponents (e.g., player > opponent by 0.3+). This badge should be exclusive to players who consistently participate in Atakhan takedowns.

### **16. Experience Hoarder**
*   **Description:** Knowledge is power, and experience is knowledge. You consistently outpace your opponents in experience gain, reaching higher levels and unlocking abilities before they do.
*   **AI instructions:** Award this badge if the player shows HIGHER XP values than opponents across multiple time points (e.g., \`avg_xp_at15\` > opponent by 500+ AND \`avg_xp_at20\` > opponent by 700+). This represents superior experience management and map presence.

### **17. Mid Game Specialist**
*   **Description:** The transition from early to late game is where you shine brightest. You excel at capitalizing on the mid-game power spikes and team fights that define the outcome of matches.
*   **AI instructions:** Award this badge if the player shows strong performance specifically in the 15-20 minute window. Look for \`avg_gold_at15\` and \`avg_level_at15\` being competitive, but \`avg_gold_at20\` and \`avg_level_at20\` being SIGNIFICANTLY HIGHER than opponents (e.g., gold advantage grows from <200 at 15min to >400 at 20min).

### **18. Damage Sponge**
*   **Description:** You are the immovable object that enemy teams crash against. Your ability to absorb punishment while staying alive makes you an invaluable frontline presence.
*   **AI instructions:** Award this badge if \`avg_dmg_taken_per_min\` shows the player takes SIGNIFICANTLY MORE damage than opponents (e.g., player > opponent by 100+) while maintaining LOWER \`avg_deaths\` (e.g., player < opponent by 0.5+). Both conditions must be met to show effective tanking.

### **19. Scaling Monster**
*   **Description:** Time is your greatest ally. While others peak early, you continue growing stronger as the game progresses, becoming an unstoppable force in extended matches.
*   **AI instructions:** Award this badge if the player shows clear scaling patterns: \`avg_gold_at30\` and \`avg_cs_at30\` are SIGNIFICANTLY HIGHER than opponents (e.g., gold > opponent by 500+, CS > opponent by 30+) even if early game stats (\`avg_gold_at10\`, \`avg_cs_at10\`) were lower or equal.

### **20. Versatile Champion Pool**
*   **Description:** Adaptation is your strength. You have demonstrated proficiency across multiple champions, making you unpredictable and difficult to ban out or counter.
*   **AI instructions:** Award this badge if the \`champions\` data shows the player has played 5+ different champions with relatively balanced play rates (no single champion >40% of games) and maintains good performance across multiple picks. This badge rewards champion diversity and adaptability.

### **21. Vision Improvement Needed**
*   **Description:** Your teams can benefit from more consistent vision control. Increasing warding and denial will unlock safer paths and better objective setups.
*   **AI instructions:** Award if the player's most-weighted role shows LOWER \`visionScorePerMin\` than opponents by ≥0.35 for non-UTILITY roles or ≥0.5 for UTILITY.

### **22. Early Game Struggles**
*   **Description:** Your lane phase often starts on the back foot. Tightening early CS, trades, and wave control will set up stronger mid games.
*   **AI instructions:** For the most-weighted role (exclude UTILITY): \`avg_cs_at10\` ≤ opponent by 15+ AND \`avg_gold_at10\` ≤ opponent by 400+.

### **23. Objective Neglect**
*   **Description:** Neutral objectives swing games. Improving early rotations and setups around Voidgrubs and Herald can shift map pressure.
*   **AI instructions:** per-match participation rate diffs \`avg_grubs_participation\` and \`avg_herald_participation\` are NEGATIVE and SIGNIFICANT (e.g., diff ≤ -0.1 for both). Use rates, not raw counts.

### **24. Damage Output Gap**
*   **Description:** Teamfights need a stronger contribution. Look for better target selection, uptime, and itemization to raise your output.
*   **AI instructions:** For the most-weighted role: \`avg_dpm\` ≤ opponent by 100+.

### **25. Farm Efficiency Gap**
*   **Description:** Small CS and gold deficits compound over time. Focus on last-hitting consistency and efficient pathing to convert time into gold.
*   **AI instructions:** For the most-weighted role: \`avg_cs_total\` ≤ opponent by 10+ AND \`avg_gpm\` ≤ opponent by 25+.

### **26. Tower Pressure Gap**
*   **Description:** Early plate and tower pressure is low relative to lane opponents. Sharpen wave control and rotation timing to crack structures.
*   **AI instructions:** per-match participation rate diffs \`avg_turret_plates_participation\` and \`avg_towers_participation\` are NEGATIVE and SIGNIFICANT (e.g., diff ≤ -0.1 for both). Use rates, not raw counts.

### **27. Death Discipline**
*   **Description:** Too many deaths are stalling your impact and resets. Improve risk assessment, vision usage, and disengage timing.
*   **AI instructions:** For the most-weighted role: \`avg_deaths\` ≥ opponent by 0.7+.

### **28. Low-Value Deaths**
*   **Description:** You die more than your opponent without absorbing much pressure. Improve spacing, vision, and fight selection to reduce unnecessary deaths.
*   **AI instructions:** \`avg_deaths\` ≥ opponent by 0.5+ AND \`avg_dmg_taken_per_min\` ≤ opponent by +20 (i.e., not significantly higher damage taken).

### **29. Mid Game Dip**
*   **Description:** Momentum slips between 15–20 minutes. Strengthen rotations, objective trading, and tempo to convert early setups.
*   **AI instructions:** \`avg_gold_at15\` within ±150 of opponents AND \`avg_gold_at20\` ≤ opponent by 300+.

### **30. Scaling Issues**
*   **Description:** Late-game economy and CS trail opponents. Refine wave assignment and side-lane timings to scale reliably.
*   **AI instructions:** \`avg_gold_at30\` ≤ opponent by 400+ OR \`avg_cs_at30\` ≤ opponent by 25+; additionally, early game not severely losing (\`avg_gold_at10\` > -200 AND \`avg_cs_at10\` > -10).

### **31. Team Contribution Gap**
*   **Description:** Skirmishes resolve without your consistent setup or follow-up. Look for higher assist participation and safer play.
*   **AI instructions:** \`avg_assists\` ≤ opponent by 2.0+ AND \`avg_deaths\` ≥ opponent by 0.3+ (prioritize non-UTILITY roles).

### **32. Level Tempo Lag**
*   **Description:** Hitting key levels behind opponents limits fight readiness. Improve farm uptime and deathless windows to keep pace.
*   **AI instructions:** \`avg_level_at15\` ≤ opponent by 1.0+ AND \`avg_level_at20\` ≤ opponent by 1.0+.

### **33. Experience Gap**
*   **Description:** XP deficits delay spikes and objectives. Emphasize efficient farming patterns and proactive map movements.
*   **AI instructions:** \`avg_xp_at15\` ≤ opponent by 500+ AND \`avg_xp_at20\` ≤ opponent by 700+.`;
