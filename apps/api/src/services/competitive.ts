import { PlatformId, type RiotAPITypes } from '@fightmegg/riot-api';

export interface Team {
  team: string;
  slug: string;
  players: Player[];
}

export interface Player {
  name: string;
  position: string;
  summonerName: string;
  summonerTag: string;
  region: RiotAPITypes.LoLRegion;
  image: string;
}

export const teams: Team[] = [
  {
    team: '100 Thieves',
    slug: '100t',
    players: [
      {
        name: 'Dhokla',
        position: 'TOP',
        summonerName: 'Dhokla',
        summonerTag: 'NA1',
        region: PlatformId.NA1,
        image: 'dhokla.png',
      },
      {
        name: 'River',
        position: 'JUNGLE',
        summonerName: 'Imposter syndrom',
        summonerTag: '000',
        region: PlatformId.NA1,
        image: 'river.png',
      },
      {
        name: 'Quid',
        position: 'MIDDLE',
        summonerName: 'tree%20frog',
        summonerTag: '100',
        region: PlatformId.NA1,
        image: 'quid.png',
      },
      {
        name: 'FBI',
        position: 'BOTTOM',
        summonerName: 'ADCADC123',
        summonerTag: 'NA1',
        region: PlatformId.NA1,
        image: 'fbi.png',
      },
      {
        name: 'Eyla',
        position: 'UTILITY',
        summonerName: 'Cartethyia',
        summonerTag: '100',
        region: PlatformId.NA1,
        image: 'eyla.png',
      },
    ],
  },
  {
    team: 'CTBC Flying Oyster',
    slug: 'ctbc-flying-oyster',
    players: [
      // dpm.lol/pro/Driver — dadvdid#KR1
      {
        name: 'Driver',
        position: 'TOP',
        summonerName: 'dadvdid',
        summonerTag: 'KR1',
        region: PlatformId.KR,
        image: 'driver.png',
      },
      // dpm.lol/pro/JunJia — asdjipadsjip#KR1
      {
        name: 'JunJia',
        position: 'JUNGLE',
        summonerName: 'asdjipadsjip',
        summonerTag: 'KR1',
        region: PlatformId.KR,
        image: 'junjia.png',
      },
      // dpm.lol/pro/HongQ — tfhto#KR1
      {
        name: 'HongQ',
        position: 'MIDDLE',
        summonerName: 'tfhto',
        summonerTag: 'KR1',
        region: PlatformId.KR,
        image: 'hongq.png',
      },
      // dpm.lol/pro/Doggo — xinsuixiaogou#6666
      {
        name: 'Doggo',
        position: 'BOTTOM',
        summonerName: 'xinsuixiaogou',
        summonerTag: '6666',
        region: PlatformId.KR,
        image: 'doggo.png',
      },
      // dpm.lol/pro/Kaiwing — ersopf#KR1
      {
        name: 'Kaiwing',
        position: 'UTILITY',
        summonerName: 'ersopf',
        summonerTag: 'KR1',
        region: PlatformId.KR,
        image: 'kaiwing.png',
      },
      // dpm.lol/pro/Rest — ieada#KR1
      {
        name: 'Rest',
        position: 'TOP',
        summonerName: 'ieada',
        summonerTag: 'KR1',
        region: PlatformId.KR,
        image: 'rest.png',
      },
    ],
  },
  {
    team: 'FlyQuest',
    slug: 'fly-quest',
    players: [
      // dpm.lol/pro/Bwipo — red little bird#1810
      {
        name: 'Bwipo',
        position: 'TOP',
        summonerName: 'red little bird',
        summonerTag: '1810',
        region: PlatformId.KR,
        image: 'bwipo.png',
      },
      // dpm.lol/pro/Inspired — Inspireeed#EUW
      {
        name: 'Inspired',
        position: 'JUNGLE',
        summonerName: 'Inspireeed',
        summonerTag: 'EUW',
        region: PlatformId.EUW1,
        image: 'inspired.png',
      },
      // dpm.lol/pro/Quad — Quad#123
      {
        name: 'Quad',
        position: 'MIDDLE',
        summonerName: 'FLY Quad',
        summonerTag: '123',
        region: PlatformId.KR,
        image: 'quad.png',
      },
      // (Massu page lists accounts on dpm; leaving NA by default if not present)
      {
        name: 'Massu',
        position: 'BOTTOM',
        summonerName: 'KaiGyt',
        summonerTag: '0187',
        region: PlatformId.NA1,
        image: 'massu.png',
      },
      // dpm.lol/esport/players/Busio typically NA/EUW; keep NA default
      {
        name: 'Busio',
        position: 'UTILITY',
        summonerName: 'Busio JNG',
        summonerTag: 'NA1',
        region: PlatformId.NA1,
        image: 'busio.png',
      },
    ],
  },
  {
    team: 'Fnatic',
    slug: 'fnatic',
    players: [
      // dpm.lol/pro/Oscarinin — chopper lover#EUW
      {
        name: 'Oscarinin',
        position: 'TOP',
        summonerName: 'chopper lover',
        summonerTag: 'EUW',
        region: PlatformId.EUW1,
        image: 'oscarinin.png',
      },
      // dpm.lol/pro/Razork — Razørk Activoo#razzz
      {
        name: 'Razork',
        position: 'JUNGLE',
        summonerName: 'Razørk Activoo',
        summonerTag: 'razzz',
        region: PlatformId.EUW1,
        image: 'razork.png',
      },
      // dpm.lol/pro/Poby — XPoby#0207
      {
        name: 'Poby',
        position: 'MIDDLE',
        summonerName: 'XPoby',
        summonerTag: '0207',
        region: PlatformId.EUW1,
        image: 'poby.png',
      },
      // dpm.lol/pro/Upset — asdfasdf#0308
      {
        name: 'Upset',
        position: 'BOTTOM',
        summonerName: 'asdfasdf',
        summonerTag: '0308',
        region: PlatformId.EUW1,
        image: 'upset.png',
      },
      // dpm.lol/pro/Mikyx — FNC Mikyx#1998
      {
        name: 'Mikyx',
        position: 'UTILITY',
        summonerName: 'FNC Mikyx',
        summonerTag: '1998',
        region: PlatformId.EUW1,
        image: 'mikyx.png',
      },
    ],
  },
  {
    team: 'G2 Esports',
    slug: 'g2',
    players: [
      // dpm.lol/pro/BrokenBlade — G2 BrokenBlade#1918
      {
        name: 'BrokenBlade',
        position: 'TOP',
        summonerName: 'G2 BrokenBlade',
        summonerTag: '1918',
        region: PlatformId.EUW1,
        image: 'brokenblade.png',
      },
      // dpm.lol/pro/SkewMond — G2 SkewMond#3327
      {
        name: 'SkewMond',
        position: 'JUNGLE',
        summonerName: 'G2 SkewMond',
        summonerTag: '3327',
        region: PlatformId.EUW1,
        image: 'skewmond.png',
      },
      // (Caps from dpm.lol — G2 Caps#1323)
      {
        name: 'Caps',
        position: 'MIDDLE',
        summonerName: 'G2 Caps',
        summonerTag: '1323',
        region: PlatformId.EUW1,
        image: 'caps.png',
      },
      // dpm.lol/pro/Hans Sama — G2 Hans Sama#12838
      {
        name: 'Hans Sama',
        position: 'BOTTOM',
        summonerName: 'G2 Hans Sama',
        summonerTag: '12838',
        region: PlatformId.EUW1,
        image: 'hanssama.png',
      },
      // dpm.lol/pro/Labrov — G2 Labrov#8085
      {
        name: 'Labrov',
        position: 'UTILITY',
        summonerName: 'G2 Labrov',
        summonerTag: '8085',
        region: PlatformId.EUW1,
        image: 'labrov.png',
      },
    ],
  },
  {
    team: 'Gen.G',
    slug: 'geng',
    players: [
      // dpm.lol/pro/Kiin — kiin#KR1
      {
        name: 'Kiin',
        position: 'TOP',
        summonerName: 'kiin',
        summonerTag: 'KR1',
        region: PlatformId.KR,
        image: 'kiin.png',
      },
      // dpm.lol/pro/Canyon — JUGKlNG#kr
      {
        name: 'Canyon',
        position: 'JUNGLE',
        summonerName: 'JUGKlNG',
        summonerTag: 'kr',
        region: PlatformId.KR,
        image: 'canyon.png',
      },
      // dpm.lol/pro/Chovy — 허거덩#0303
      {
        name: 'Chovy',
        position: 'MIDDLE',
        summonerName: '허거덩',
        summonerTag: '0303',
        region: PlatformId.KR,
        image: 'chovy.png',
      },
      // dpm.lol/pro/Ruler — 귀찮게하지마#KR3 (note: roster naming follows user list)
      {
        name: 'Ruler',
        position: 'BOTTOM',
        summonerName: '귀찮게하지마',
        summonerTag: 'KR3',
        region: PlatformId.KR,
        image: 'ruler.png',
      },
      // dpm.lol/pro/Duro — Duro#Gen
      {
        name: 'Duro',
        position: 'UTILITY',
        summonerName: 'Duro',
        summonerTag: 'Gen',
        region: PlatformId.KR,
        image: 'duro.png',
      },
    ],
  },
  {
    team: 'Hanwha Life Esports',
    slug: 'hle',
    players: [
      // dpm.lol/pro/Zeus — 우제초이#Kr2
      {
        name: 'Zeus',
        position: 'TOP',
        summonerName: '우제초이',
        summonerTag: 'Kr2',
        region: PlatformId.KR,
        image: 'zeus.png',
      },
      // dpm.lol/pro/Peanut — Peanut#kr11
      {
        name: 'Peanut',
        position: 'JUNGLE',
        summonerName: 'Peanut',
        summonerTag: 'kr11',
        region: PlatformId.KR,
        image: 'peanut.png',
      },
      // dpm.lol/pro/Zeka — dlwldms#iuiu
      {
        name: 'Zeka',
        position: 'MIDDLE',
        summonerName: 'dlwldms',
        summonerTag: 'iuiu',
        region: PlatformId.KR,
        image: 'zeka.png',
      },
      // dpm.lol/pro/Viper — Blue#KR33
      {
        name: 'Viper',
        position: 'BOTTOM',
        summonerName: 'Blue',
        summonerTag: 'KR33',
        region: PlatformId.KR,
        image: 'viper.png',
      },
      // dpm.lol/pro/Delight — 플레이리스트겨울#KR1
      {
        name: 'Delight',
        position: 'UTILITY',
        summonerName: '플레이리스트겨울',
        summonerTag: 'KR1',
        region: PlatformId.KR,
        image: 'delight.png',
      },
    ],
  },
  {
    team: 'KT Rolster',
    slug: 'kt-rolster',
    players: [
      // dpm.lol/pro/PerfecT — 작두콩차#꿀유자차
      {
        name: 'PerfecT',
        position: 'TOP',
        summonerName: '작두콩차',
        summonerTag: '꿀유자차',
        region: PlatformId.KR,
        image: 'perfect.png',
      },
      // dpm.lol/pro/Cuzz — Cuzz#KR123
      {
        name: 'Cuzz',
        position: 'JUNGLE',
        summonerName: 'Cuzz',
        summonerTag: 'KR123',
        region: PlatformId.KR,
        image: 'cuzz.png',
      },
      // dpm.lol/pro/Bdd — 아구몬#0509
      {
        name: 'Bdd',
        position: 'MIDDLE',
        summonerName: '아구몬',
        summonerTag: '0509',
        region: PlatformId.KR,
        image: 'bdd.png',
      },
      // dpm.lol/pro/deokdam — New York#dream
      {
        name: 'deokdam',
        position: 'BOTTOM',
        summonerName: 'New York',
        summonerTag: 'dream',
        region: PlatformId.KR,
        image: 'deokdam.png',
      },
      // dpm.lol/pro/Peter — 아름다운 나라#K T
      {
        name: 'Peter',
        position: 'UTILITY',
        summonerName: '아름다운 나라',
        summonerTag: 'K T',
        region: PlatformId.KR,
        image: 'peter.png',
      },
    ],
  },
  {
    team: 'Movistar KOI',
    slug: 'mkoi',
    players: [
      // dpm.lol shows EUW bootcamp accounts
      {
        name: 'Myrwn',
        position: 'TOP',
        summonerName: 'California Gurls',
        summonerTag: 'MRWN',
        region: PlatformId.EUW1,
        image: 'myrwn.png',
      },
      {
        name: 'Elyoya',
        position: 'JUNGLE',
        summonerName: 'komanche uchiha',
        summonerTag: 'elite',
        region: PlatformId.EUW1,
        image: 'elyoya.png',
      },
      {
        name: 'Jojopyun',
        position: 'MIDDLE',
        summonerName: '2001 05 09',
        summonerTag: '2001',
        region: PlatformId.EUW1,
        image: 'jojopyun.png',
      },
      {
        name: 'Supa',
        position: 'BOTTOM',
        summonerName: 'tukaan',
        summonerTag: 'tukan',
        region: PlatformId.EUW1,
        image: 'supa.png',
      },
      {
        name: 'Alvaro',
        position: 'UTILITY',
        summonerName: 'alvaaroo',
        summonerTag: 'MKOI',
        region: PlatformId.EUW1,
        image: 'alvaro.png',
      },
    ],
  },
  {
    team: 'PSG Talon',
    slug: 'psg-talon',
    players: [
      // dpm.lol/pro/Azhi — X9l#0220
      {
        name: 'Azhi',
        position: 'TOP',
        summonerName: 'X9l',
        summonerTag: '0220',
        region: PlatformId.KR,
        image: 'azhi.png',
      },
      // dpm.lol/pro/Karsa — ケルベロス#KR11
      {
        name: 'Karsa',
        position: 'JUNGLE',
        summonerName: 'ケルベロス',
        summonerTag: 'KR11',
        region: PlatformId.KR,
        image: 'karsa.png',
      },
      // dpm.lol/pro/Maple — 楓棠珍珠奶茶#psg (EUW)
      {
        name: 'Maple',
        position: 'MIDDLE',
        summonerName: '楓棠珍珠奶茶',
        summonerTag: 'psg',
        region: PlatformId.EUW1,
        image: 'mapple.png',
      },
      // dpm.lol/pro/Betty — ar1#psg (EUW)
      {
        name: 'Betty',
        position: 'BOTTOM',
        summonerName: 'ar1',
        summonerTag: 'psg',
        region: PlatformId.EUW1,
        image: 'betty.png',
      },
      // dpm.lol/pro/Woody — CerezoRosa#KR11
      {
        name: 'Woody',
        position: 'UTILITY',
        summonerName: 'CerezoRosa',
        summonerTag: 'KR11',
        region: PlatformId.KR,
        image: 'woody.png',
      },
    ],
  },
  {
    team: 'T1',
    slug: 't1',
    players: [
      // dpm.lol/pro/Doran — 어리고싶다#KR1
      {
        name: 'Doran',
        position: 'TOP',
        summonerName: '어리고싶다',
        summonerTag: 'KR1',
        region: PlatformId.KR,
        image: 'doran.png',
      },
      // dpm.lol/pro/Oner — 오 너#111
      {
        name: 'Oner',
        position: 'JUNGLE',
        summonerName: '오 너',
        summonerTag: '111',
        region: PlatformId.KR,
        image: 'oner.png',
      },
      // dpm.lol/pro/Faker — Hide on bush#KR1 (also T1 Faker#19020 is a known alt)
      {
        name: 'Faker',
        position: 'MIDDLE',
        summonerName: 'Hide on bush',
        summonerTag: 'KR1',
        region: PlatformId.KR,
        image: 'faker.png',
      },
      // dpm.lol — T1 Gumayusi#KR1
      {
        name: 'Gumayusi',
        position: 'BOTTOM',
        summonerName: 'T1 Gumayusi',
        summonerTag: 'KR1',
        region: PlatformId.KR,
        image: 'gumayusi.png',
      },
      // dpm.lol/pro/Keria — 역천괴#ker3
      {
        name: 'Keria',
        position: 'UTILITY',
        summonerName: '역천괴',
        summonerTag: 'ker3',
        region: PlatformId.KR,
        image: 'keria.png',
      },
    ],
  },
  {
    team: 'Team Secret Whales',
    slug: 'team-secret-whales',
    players: [
      // dpm.lol/pro/Hiro — Annie Koumouk#2027 (EUW)
      {
        name: 'Hiro02',
        position: 'TOP',
        summonerName: 'Annie Koumouk',
        summonerTag: '2027',
        region: PlatformId.EUW1,
        image: 'hiro02.png',
      },
      // dpm.lol shows multiple Pun profiles; use KR or VN — prefer KR if grinding
      {
        name: 'Pun',
        position: 'JUNGLE',
        summonerName: '606',
        summonerTag: 'pun',
        region: PlatformId.VN2,
        image: 'pun.png',
      },
      // dpm.lol/pro/Hizto — asdfghjzxc#KR2
      {
        name: 'Hizto',
        position: 'MIDDLE',
        summonerName: 'asdfghjzxc',
        summonerTag: 'KR2',
        region: PlatformId.KR,
        image: 'hizto.png',
      },
      // dpm.lol/pro/Dire — gaubeo202#KR1
      {
        name: 'Dire',
        position: 'BOTTOM',
        summonerName: 'gaubeo202',
        summonerTag: 'KR1',
        region: PlatformId.KR,
        image: 'dire.png',
      },
      // dpm.lol/pro/Eddie — 75hueidde#TSW
      {
        name: 'Eddie',
        position: 'UTILITY',
        summonerName: '75hueidde',
        summonerTag: 'TSW',
        region: PlatformId.KR,
        image: 'eddie.png',
      },
    ],
  },
  {
    team: 'Vivo Keyd Stars',
    slug: 'vivo-keyd',
    players: [
      // dpm.lol/pro/Boal — odoriko#BR2 (BR)
      {
        name: 'Boal',
        position: 'TOP',
        summonerName: 'odoriko',
        summonerTag: 'BR2',
        region: PlatformId.BR1,
        image: 'boal.png',
      },
      // dpm.lol/esport/players/Disamis — (account not clearly listed; keep BR region placeholder)
      {
        name: 'Disamis',
        position: 'JUNGLE',
        summonerName: 'Disamis',
        summonerTag: 'BR1',
        region: PlatformId.BR1,
        image: 'disamis.png',
      },
      // dpm.lol/pro/Mireu — VKS Mireu#LTAS
      {
        name: 'Mireu',
        position: 'MIDDLE',
        summonerName: 'VKS Mireu',
        summonerTag: 'LTAS',
        region: PlatformId.BR1,
        image: 'mireu.png',
      },
      // dpm.lol/VKS Morttheus#LTAS
      {
        name: 'Morttheus',
        position: 'BOTTOM',
        summonerName: 'VKS Morttheus',
        summonerTag: 'LTAS',
        region: PlatformId.BR1,
        image: 'morttheus.png',
      },
      // dpm.lol/pro/Trymbi — VKS Trymbi#LTAS
      {
        name: 'Trymbi',
        position: 'UTILITY',
        summonerName: 'VKS Trymbi',
        summonerTag: 'LTAS',
        region: PlatformId.BR1,
        image: 'trymbi.png',
      },
    ],
  },
];
