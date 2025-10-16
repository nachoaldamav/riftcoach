export const BADGES_PROMPT = `
### **1. Objective Master**
*   **Description:** When you're in the jungle, the epic monsters belong to your team. You exhibit masterful control over the map's most important objectives, consistently out-pacing the enemy jungler where it matters most.
*   **AI instructions:** Award this badge if the player's most-weighted role is **JUNGLE** and their \`objectiveParticipation\` rate for \`drakes\`, \`herald\`, and \`baron\` is consistently positive (e.g., \`rate\` > 5 for all three). Player must have HIGHER participation rates than opponents.

### **2. Vision Expert**
*   **Description:** You understand that knowledge is power. In your primary role, you consistently establish superior map awareness, providing more vision for your team and leaving your opponents to walk in the dark.
*   **AI instructions:** Award this badge if the \`visionScorePerMin\` value for the player's most-weighted role is significantly positive compared to opponents (e.g., player > opponent by 0.15+). Give it extra priority if the role is UTILITY.

### **3. Early Game Dominator**
*   **Description:** The game starts the moment minions spawn, and you make sure your opponent knows it. You consistently build early leads in gold and CS, applying immense pressure from the very beginning of the match.
*   **AI instructions:** Award this badge if, for the player's most-weighted role, the \`avgCSAt10\` and \`avgGoldAt10\` stats show the player has HIGHER values than opponents (e.g., player gold > opponent gold by 150+, player CS > opponent CS by 5+).

### **4. Late Game Carry**
*   **Description:** You are the team's ace in the hole. Even if the early game is rocky, you are a master of scaling, consistently turning the tide and finding advantages in the chaotic late game.
*   **AI instructions:** Award this badge if, for the player's most-weighted role, the \`avgCSAt30\` and \`avgGoldAt30\` stats show the player has HIGHER values than opponents (e.g., player gold > opponent gold by 100+, player XP > opponent XP by 250+), especially if their early game stats were lower, showing a comeback trend.

### **5. Tank Specialist**
*   **Description:** You are the frontline your team can rely on. You have mastered the art of survival, dying less than your opponents while absorbing immense pressure for your team.
*   **AI instructions:** Award this badge if, for the player's most-weighted role, the \`deathsPerMin\` value shows the player has LOWER deaths than opponents (e.g., player deaths < opponent deaths by 0.02+) and the \`damageTakenPerMin\` shows HIGHER damage taken (e.g., player > opponent by 50+).

### **6. Tower Destroyer**
*   **Description:** You hear the call of stone and steel. Your relentless focus on structures helps your team crack open the map, consistently taking more turret plates and towers than your lane opponent.
*   **AI instructions:** Award this badge if, for the player's most-weighted role, the \`objectiveParticipation\` rate for \`turretPlates\` and \`towers\` shows the player has HIGHER participation than opponents (e.g., \`rate\` > 5 for both).

### **7. Damage Dealer**
*   **Description:** You don't just participate in fights; you end them. You consistently output significantly more damage per minute than your direct opponent, acting as the primary offensive engine for your team.
*   **AI instructions:** Award this badge if, for the player's most-weighted role, the \`damageDealtPerMin\` shows the player has HIGHER damage output than opponents (e.g., player > opponent by 100+).

### **8. Gold Farmer**
*   **Description:** Through superior last-hitting and efficient pathing, you consistently generate a gold advantage over your opponent. You understand that the best items are bought with a heavy purse.
*   **AI instructions:** Award this badge if, for the player's most-weighted role, both \`csPerMin\` and \`goldPerMin\` show the player has HIGHER values than opponents (e.g., player CS > opponent CS by 0.5+, player gold > opponent gold by 30+).

### **9. Kill Specialist**
*   **Description:** You hunt with efficiency. Not only do you secure more kills than your opponent, but you also give over fewer deaths, resulting in a superior KDA ratio that keeps you on the map and ahead in power.
*   **AI instructions:** Award this badge if, for the player's most-weighted role, \`killsPerMin\` shows the player has HIGHER kills than opponents (e.g., player > opponent by 0.05+) AND \`deathsPerMin\` shows the player has LOWER deaths than opponents (e.g., player < opponent by 0.05+).

### **10. Void Hunter**
*   **Description:** You prioritize the early game power of the Void. By securing Voidgrubs and Rift Heralds more often than your opponents, you grant your team devastating pushing power in the early-to-mid game.
*   **AI instructions:** Award this badge if the \`objectiveParticipation\` rate for both \`grubs\` and \`herald\` show the player has HIGHER participation than opponents (e.g., \`rate > 5\` for both).

### **11. Team Player**
*   **Description:** You are the ultimate team player. Regardless of your role, you are constantly setting up plays and securing kills for your teammates, boasting a higher assist rate than your direct counterpart.
*   **AI instructions:** Award this badge if \`assistsPerMin\` shows the player has HIGHER assists than opponents (e.g., player > opponent by 0.1+), particularly if the player is NOT in the UTILITY role (showing they are a team-oriented carry).

### **12. Level Advantage**
*   **Description:** You understand the value of levels. Through efficient farming and staying alive, you consistently hit level power spikes before your opponent, giving you a distinct advantage in fights at the 15 and 20-minute marks.
*   **AI instructions:** Award this badge if \`avgLevelAt15\` and \`avgLevelAt20\` show the player has HIGHER levels than opponents (e.g., player > opponent by 0.2+ levels).`;
