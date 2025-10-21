type ParticipantBasic = {
  participantId: number;
  puuid: string;
  summonerName: string;
  teamId: number;
  teamPosition: string;
  championId: number;
  championName: string;
  win?: boolean;
  items?: Array<number | null | undefined>;
};

export type SupportStyle =
  | 'engage'
  | 'peel'
  | 'enchanter'
  | 'poke'
  | 'tank'
  | 'roam'
  | 'unknown';

export type JungleStyle = 'engage' | 'skirmish' | 'farm' | 'control' | 'unknown';

const SUPPORT_ENGAGE = new Set<string>([
  'Leona',
  'Nautilus',
  'Rell',
  'Alistar',
  'Blitzcrank',
  'Thresh',
  'Pyke',
]);
const SUPPORT_ENCHANTER = new Set<string>([
  'Janna',
  'Lulu',
  'Karma',
  'Soraka',
  'Nami',
  'Sona',
  'Milio',
  'Renata Glasc',
]);
const SUPPORT_POKE = new Set<string>([
  'Zyra',
  'Brand',
  'Vel\'Koz',
  'Xerath',
  'Heimerdinger',
  'Ziggs',
  'Neeko',
]);
const SUPPORT_TANK = new Set<string>(['Braum', 'Tahm Kench', 'Taric']);
const SUPPORT_ROAM = new Set<string>(['Bard']);

const JUNGLE_ENGAGE = new Set<string>([
  'Jarvan IV',
  'Sejuani',
  'Rammus',
  'Zac',
  'Amumu',
  'Vi',
  'Nocturne',
  'Hecarim',
  'Skarner',
]);
const JUNGLE_SKIRMISH = new Set<string>([
  'Lee Sin',
  'Xin Zhao',
  'Kha\'Zix',
  'Kayn',
  'Viego',
  'Rengar',
  'Graves',
  'Kindred',
  'Bel\'Veth',
]);
const JUNGLE_FARM = new Set<string>([
  'Shyvana',
  'Master Yi',
  'Karthus',
  'Fiddlesticks',
]);
const JUNGLE_CONTROL = new Set<string>(['Nunu & Willump', 'Rumble', 'Ivern']);

export function classifySupportStyle(name: string | null | undefined): SupportStyle {
  const n = (name || '').trim();
  if (!n) return 'unknown';
  if (SUPPORT_ENGAGE.has(n)) return 'engage';
  if (SUPPORT_ENCHANTER.has(n)) return 'enchanter';
  if (SUPPORT_POKE.has(n)) return 'poke';
  if (SUPPORT_TANK.has(n)) return 'tank';
  if (SUPPORT_ROAM.has(n)) return 'roam';
  // Basic heuristic by tags in name
  if (/Guardian|Protector/i.test(n)) return 'peel';
  return 'unknown';
}

export function classifyJungleStyle(name: string | null | undefined): JungleStyle {
  const n = (name || '').trim();
  if (!n) return 'unknown';
  if (JUNGLE_ENGAGE.has(n)) return 'engage';
  if (JUNGLE_SKIRMISH.has(n)) return 'skirmish';
  if (JUNGLE_FARM.has(n)) return 'farm';
  if (JUNGLE_CONTROL.has(n)) return 'control';
  return 'unknown';
}

export type SynergyInfo = {
  subjectRole: string;
  partnerRole: 'UTILITY' | 'JUNGLE' | 'MIDDLE' | 'BOTTOM' | 'TOP' | 'UNKNOWN';
  partnerChampion: string | null;
  supportStyle?: SupportStyle;
  jungleStyle?: JungleStyle;
  synergyType: 'botlane_duo' | 'jungle_support' | 'mid_jungle' | 'none';
  notes: string[];
};

export function deriveSynergy(
  subject: { teamId: number; teamPosition: string; championName: string },
  participants: ParticipantBasic[],
): SynergyInfo {
  const subjectRole = (subject.teamPosition || 'UNKNOWN').toUpperCase();
  const allies = participants.filter((p) => p.teamId === subject.teamId);

  function findByRole(role: string): ParticipantBasic | null {
    return (
      allies.find((p) => (p.teamPosition || 'UNKNOWN').toUpperCase() === role) ||
      null
    );
  }

  const notes: string[] = [];

  if (subjectRole === 'BOTTOM') {
    const support = findByRole('UTILITY');
    const style = classifySupportStyle(support?.championName);
    const partnerName = support?.championName || null;
    if (style === 'engage') {
      notes.push('Leverage support engage windows for all-in trades and jungle ganks.');
    } else if (style === 'enchanter' || style === 'peel') {
      notes.push('Play for sustained trades, protect carry, and track enemy engage cooldowns.');
    } else if (style === 'poke') {
      notes.push('Poke to chip HP, then crash waves and secure plates with jungle cover.');
    } else if (style === 'tank') {
      notes.push('Hold wave near tower, bait overextensions, and punish with layered CC.');
    } else if (style === 'roam') {
      notes.push('Coordinate wave states for support roams; communicate timers to jungle/mid.');
    }
    return {
      subjectRole,
      partnerRole: 'UTILITY',
      partnerChampion: partnerName,
      supportStyle: style,
      jungleStyle: undefined,
      synergyType: 'botlane_duo',
      notes,
    };
  }

  if (subjectRole === 'JUNGLE') {
    const support = findByRole('UTILITY');
    const style = classifySupportStyle(support?.championName);
    if (style === 'engage') {
      notes.push('Path to lanes where support can chain CC; sync timers for dives.');
    } else if (style === 'enchanter' || style === 'peel') {
      notes.push('Prioritize objective setups; use shields/peel for front-to-back fights.');
    } else if (style === 'poke') {
      notes.push('Cover bot during slow pushes; look for HP advantages before starting objectives.');
    }
    return {
      subjectRole,
      partnerRole: 'UTILITY',
      partnerChampion: support?.championName || null,
      supportStyle: style,
      jungleStyle: undefined,
      synergyType: 'jungle_support',
      notes,
    };
  }

  if (subjectRole === 'MIDDLE') {
    const jungle = findByRole('JUNGLE');
    const style = classifyJungleStyle(jungle?.championName);
    if (style === 'engage') {
      notes.push('Hold wave for setup; ping jungle path and vision for mid ganks.');
    } else if (style === 'skirmish') {
      notes.push('Fight for river/prio to enable 2v2 skirmishes around objectives.');
    } else if (style === 'farm') {
      notes.push('Stabilize lane, farm plates; convert prio to dragons and camps invade.');
    }
    return {
      subjectRole,
      partnerRole: 'JUNGLE',
      partnerChampion: jungle?.championName || null,
      jungleStyle: style,
      supportStyle: undefined,
      synergyType: 'mid_jungle',
      notes,
    };
  }

  return {
    subjectRole,
    partnerRole: 'UNKNOWN',
    partnerChampion: null,
    supportStyle: undefined,
    jungleStyle: undefined,
    synergyType: 'none',
    notes,
  };
}