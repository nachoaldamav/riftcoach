import type { Document } from 'mongodb';

export const playerHeatmap = (params: {
  puuid: string;
  role?: string; // optional; if falsy, no role filter
  championId?: number | null;
  mode?: 'kills' | 'deaths';
  includeAssistsInKills?: boolean;
  grid?: number;
  map_width?: number;
  map_height?: number;
}) => {
  const {
    puuid,
    role = '',
    championId = null,
    mode = 'kills',
    includeAssistsInKills = true,
    grid = 64,
    map_width = 14870,
    map_height = 14980,
  } = params;

  // Normalize role → alias list (post-subject resolution)
  const upper = (s: string) => s.toUpperCase();
  const roleAliases: string[] = (() => {
    if (!role) return [];
    const R = upper(role);
    switch (R) {
      case 'BOTTOM':
      case 'BOT':
      case 'ADC':
        return ['BOTTOM', 'BOT', 'ADC'];
      case 'UTILITY':
      case 'SUPPORT':
        return ['UTILITY', 'SUPPORT'];
      case 'MIDDLE':
      case 'MID':
        return ['MIDDLE', 'MID'];
      default:
        return [R];
    }
  })();

  const pipeline: Document[] = [
    // 1) Prefilter by PUUID only (do NOT filter by role here)
    { $match: { 'info.participants.puuid': puuid } },

    // 2) Resolve subject strictly by PUUID (ensures we always have participantId)
    {
      $project: {
        _id: 0,
        matchId: '$metadata.matchId',
        subject: {
          $first: {
            $filter: {
              input: '$info.participants',
              as: 'p',
              cond: { $eq: ['$$p.puuid', puuid] },
            },
          },
        },
      },
    },

    // 3) Coalesce subject role (string) we can match against
    {
      $set: {
        subjectRoleUpper: {
          $toUpper: {
            $ifNull: [
              '$subject.teamPosition',
              {
                $ifNull: [
                  '$subject.individualPosition',
                  {
                    $ifNull: [
                      '$subject.lane',
                      { $ifNull: ['$subject.role', ''] },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
    },
  ];

  // 4) Optional role filter (compile-time; avoid $size on literal)
  if (roleAliases.length > 0) {
    pipeline.push({
      $match: { $expr: { $in: ['$subjectRoleUpper', roleAliases.map(upper)] } },
    });
  }

  // 5) Optional champion filter
  if (championId !== null && championId !== undefined) {
    pipeline.push({ $match: { 'subject.championId': championId } });
  }

  // 6) Ensure subject exists
  pipeline.push({ $match: { subject: { $type: 'object' } } });

  // 7) Join timelines, unwind frames → events, filter CHAMPION_KILL by mode
  pipeline.push({
    $lookup: {
      from: 'timelines',
      let: { mid: '$matchId', pid: '$subject.participantId' },
      pipeline: [
        { $match: { $expr: { $eq: ['$metadata.matchId', '$$mid'] } } },
        { $unwind: '$info.frames' },
        {
          $unwind: {
            path: '$info.frames.events',
            preserveNullAndEmptyArrays: false,
          },
        },
        { $match: { 'info.frames.events.type': 'CHAMPION_KILL' } },
        {
          $match: {
            $expr: {
              $or: [
                {
                  $and: [
                    { $eq: [mode, 'kills'] },
                    { $eq: ['$info.frames.events.killerId', '$$pid'] },
                  ],
                },
                {
                  $and: [
                    { $eq: [mode, 'kills'] },
                    { $eq: [includeAssistsInKills, true] },
                    {
                      $in: [
                        '$$pid',
                        {
                          $ifNull: [
                            '$info.frames.events.assistingParticipantIds',
                            [],
                          ],
                        },
                      ],
                    },
                  ],
                },
                {
                  $and: [
                    { $eq: [mode, 'deaths'] },
                    { $eq: ['$info.frames.events.victimId', '$$pid'] },
                  ],
                },
              ],
            },
          },
        },
        {
          $project: {
            _id: 0,
            pos: '$info.frames.events.position',
            ts: '$info.frames.events.timestamp',
          },
        },
        { $match: { pos: { $type: 'object' } } },
      ],
      as: 'events',
    },
  });

  // 8) Explode events → binning
  pipeline.push({ $unwind: '$events' });

  // Clamp coords to map bounds
  pipeline.push({
    $set: {
      _x: { $max: [0, { $min: [map_width, '$events.pos.x'] }] },
      _y: { $max: [0, { $min: [map_height, '$events.pos.y'] }] },
    },
  });

  // Compute bins (origin bottom-left; invert Y in frontend if needed)
  pipeline.push({
    $set: {
      xBin: { $floor: { $multiply: [{ $divide: ['$_x', map_width] }, grid] } },
      yBin: { $floor: { $multiply: [{ $divide: ['$_y', map_height] }, grid] } },
    },
  });

  // Clamp bins to [0, grid-1]
  pipeline.push({
    $set: {
      xBin: { $max: [0, { $min: [grid - 1, '$xBin'] }] },
      yBin: { $max: [0, { $min: [grid - 1, '$yBin'] }] },
    },
  });

  // Aggregate counts per bin
  pipeline.push({
    $group: { _id: { x: '$xBin', y: '$yBin' }, count: { $sum: 1 } },
  });

  // Final projection
  pipeline.push({
    $project: {
      _id: 0,
      xBin: '$_id.x',
      yBin: '$_id.y',
      count: 1,
      grid: { $literal: grid },
      mode: { $literal: mode },
      roleAliases: { $literal: roleAliases },
      championId: { $literal: championId },
    },
  });

  pipeline.push({ $sort: { count: -1 } });

  return pipeline;
};
