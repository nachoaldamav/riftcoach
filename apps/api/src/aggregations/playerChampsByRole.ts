import { ALLOWED_QUEUE_IDS } from '@riftcoach/shared.constants';

export const playerChampsByRole = (puuid: string) => [
  // 1) Only matches where this summoner participated (fast when indexed)
  {
    $match: {
      'info.participants.puuid': puuid,
    },
  },

  // Only allowed queues
  { $match: { 'info.queueId': { $in: ALLOWED_QUEUE_IDS } } },

  // Sort by most recent matches and limit to 50
  { $sort: { 'info.gameCreation': -1 } },
  { $limit: 50 },

  // 2) Keep only participants to shrink the document
  {
    $project: {
      _id: 0,
      participants: '$info.participants',
    },
  },

  // 3) Flatten participants
  { $unwind: '$participants' },

  // 4) Keep only the target summoner’s row
  { $match: { 'participants.puuid': puuid } },

  // 5) Normalize the role:
  //    Prefer teamPosition (TOP/JUNGLE/MIDDLE/BOTTOM/UTILITY),
  //    else derive from lane/role (DUO_CARRY -> BOTTOM, DUO_SUPPORT -> UTILITY),
  //    else fallback to lane, else UNKNOWN.
  {
    $addFields: {
      _tp: { $toUpper: { $ifNull: ['$participants.teamPosition', ''] } },
      _lane: { $toUpper: { $ifNull: ['$participants.lane', ''] } },
      _r: { $toUpper: { $ifNull: ['$participants.role', ''] } },
    },
  },
  {
    $addFields: {
      role: {
        $switch: {
          branches: [
            {
              case: {
                $in: ['$_tp', ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY']],
              },
              then: '$_tp',
            },
          ],
          default: 'UNKNOWN',
        },
      },
    },
  },

  // 6) Group by (role, championId) and tally games/wins
  {
    $group: {
      _id: {
        role: '$role',
        championId: '$participants.championId',
      },
      championName: { $last: '$participants.championName' },
      games: { $sum: 1 },
      wins: { $sum: { $cond: ['$participants.win', 1, 0] } },
    },
  },

  // 7) Derive losses & winRate
  {
    $addFields: {
      losses: { $subtract: ['$games', '$wins'] },
      winRate: {
        $cond: [{ $gt: ['$games', 0] }, { $divide: ['$wins', '$games'] }, null],
      },
    },
  },

  // 8) Order by role asc, then most games desc
  { $sort: { '_id.role': 1, games: -1 } },

  // 9) Regroup to produce one document per role with an ordered champs array
  {
    $group: {
      _id: '$_id.role',
      champs: {
        $push: {
          championId: '$_id.championId',
          championName: '$championName',
          games: '$games',
          wins: '$wins',
          losses: '$losses',
          winRate: '$winRate',
        },
      },
    },
  },

  // 11) Sort roles in a familiar order (optional)
  {
    $addFields: {
      _roleOrder: {
        $indexOfArray: [
          ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY', 'UNKNOWN'],
          '$role',
        ],
      },
    },
  },
  { $sort: { _roleOrder: 1 } },
  { $project: { _roleOrder: 0 } },
];
