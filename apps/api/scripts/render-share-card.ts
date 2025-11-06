import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderShareCard } from '../src/services/share-card.js';

async function main() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const outDir = path.resolve(__dirname, '../tmp');
  await mkdir(outDir, { recursive: true });

  const options = {
    playerName: '홍길동',
    tagLine: 'KR1',
    profileIconUrl:
      'https://ddragon.leagueoflegends.com/cdn/14.21.1/img/profileicon/4568.png',
    backgroundUrl:
      'https://ddragon.leagueoflegends.com/cdn/img/champion/splash/Ahri_0.jpg',
    champion: {
      name: '아리',
      games: 120,
      winRate: 58.3,
      kda: 3.45,
      splashUrl:
        'https://ddragon.leagueoflegends.com/cdn/img/champion/splash/Ahri_0.jpg',
    },
    metrics: [
      { label: '승률', player: 58.3, cohort: 51.2, suffix: '%' },
      { label: 'KDA', player: 3.45, cohort: 2.90 },
      { label: 'CS/분', player: 6.9, cohort: 6.2 },
      { label: '킬 관여율', player: 62.5, cohort: 55.1, suffix: '%' },
    ],
    badges: [
      'mid:라인전 강자',
      'ranked:랭크 전사',
      'aram:칼바람 달인',
    ],
  };

  console.log('[share-card] Rendering sample with Korean glyphs...');
  const pngData = await renderShareCard(options);
  const outFile = path.join(outDir, 'share-korean.png');
  await writeFile(outFile, pngData);
  console.log(`[share-card] Wrote: ${outFile}`);
}

main().catch((err) => {
  console.error('[share-card] Failed:', err);
  process.exit(1);
});