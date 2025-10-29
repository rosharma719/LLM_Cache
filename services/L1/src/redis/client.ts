import Redis from 'ioredis';
import { config } from '../config';

let client: Redis | null = null;

export function getRedis(): Redis {
  if (!client) {
    client = new Redis(config.redisUrl, {
      lazyConnect: false,
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
  }
  return client;
}
