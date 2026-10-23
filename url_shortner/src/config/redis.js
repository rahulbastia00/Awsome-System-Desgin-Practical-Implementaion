const Redis = require('ioredis');

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

// Singleton Redis client instance
const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    // Reconnect with exponential backoff capped at 2 seconds
    return Math.min(times * 50, 2000);
  },
});

redis.on('connect', () => {
  console.log('⚡ Connected to Redis successfully');
});

redis.on('error', (err) => {
  console.error('❌ Redis Connection Error:', err.message);
});

module.exports = redis;
