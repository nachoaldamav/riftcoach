import { MongoClient } from 'mongodb';

const uri = process.env.MONGO_URI as string;

const client = new MongoClient(uri);

export { client };
