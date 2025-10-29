import 'dotenv/config';

export const config = {
port: parseInt(process.env.PORT || '8080', 10),
host: process.env.HOST || '0.0.0.0',
redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
// TTL bounds to avoid abuse
ttl: {
minSeconds: 1,
maxSeconds: 60 * 60 * 24 * 30 // 30 days
},
};