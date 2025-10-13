import { URL } from 'node:url';
import { Redis } from 'ioredis';

const uri = new URL(process.env.REDIS_URI as string);

const redis = new Redis(Number(uri.port), uri.host, {
  password: uri.password,
  username: uri.username,
  maxRetriesPerRequest: null,
});

export { redis as connection };
