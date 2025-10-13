import type { RiotAPITypes } from '@fightmegg/riot-api';
import { MongoClient } from 'mongodb';

const uri = process.env.MONGO_URI as string;

const client = new MongoClient(uri);

const collections = {
  matches: client
    .db('riftcoach')
    .collection<RiotAPITypes.MatchV5.MatchDTO>('matches'),
  timelines: client
    .db('riftcoach')
    .collection<RiotAPITypes.MatchV5.MatchTimelineDTO>('timelines'),
};

export { client, collections };
