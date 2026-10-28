const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const STREAM_KEY = process.env.POSTS_STREAM_KEY || 'stream:posts';
const CONSUMER_GROUP = process.env.POSTS_CONSUMER_GROUP || 'post_processors';

// Shared Redis client for publishing
const redisClient = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    const delay = Math.min(times * 100, 3000);
    return delay;
  },
  enableReadyCheck: false,
  lazyConnect: true, // Don't crash immediately if Redis is still starting up
});

redisClient.on('connect', () => {
  console.log(`[Redis] Connected successfully to ${REDIS_URL}`);
});

redisClient.on('error', (err) => {
  console.error('[Redis Error]:', err.message);
});

// Auto connect in background
redisClient.connect().catch(() => {});

/**
 * Initializes a Redis consumer group for the given stream if it does not already exist.
 * 'MKSTREAM' creates the stream automatically if it has not received messages yet.
 */
async function initConsumerGroup(streamKey = STREAM_KEY, groupName = CONSUMER_GROUP) {
  try {
    await redisClient.xgroup('CREATE', streamKey, groupName, '$', 'MKSTREAM');
    console.log(`[Redis Stream] Created consumer group "${groupName}" on "${streamKey}"`);
  } catch (err) {
    if (err.message && err.message.includes('BUSYGROUP')) {
      // Group already exists, which is normal on server restarts
      return;
    }
    console.warn(`[Redis Stream] Notice while creating consumer group: ${err.message}`);
  }
}

/**
 * Publishes a POST_CREATED event to Redis Stream.
 * @param {Object} eventData - { post_id, user_id, caption, media, created_at }
 */
async function publishPostCreatedEvent(eventData) {
  try {
    const serializedData = JSON.stringify(eventData);
    const messageId = await redisClient.xadd(
      STREAM_KEY,
      '*', // Auto-generate Redis Stream timestamp ID (e.g. 1730000000-0)
      'eventType', 'POST_CREATED',
      'payload', serializedData,
      'timestamp', Date.now().toString()
    );

    return messageId;
  } catch (err) {
    console.error('[Redis Stream Publish Failed]:', err.message);
    // Do not throw here so that the main user HTTP response doesn't fail if stream is temporarily degraded
    return null;
  }
}

module.exports = {
  redisClient,
  initConsumerGroup,
  publishPostCreatedEvent,
  STREAM_KEY,
  CONSUMER_GROUP,
};
