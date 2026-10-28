require('dotenv').config();
const Redis = require('ioredis');
const { initConsumerGroup, STREAM_KEY, CONSUMER_GROUP } = require('../config/redisQueue');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const CONSUMER_NAME = process.env.CONSUMER_NAME || `worker-${process.pid}`;

const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null, // Required for long-polling blocking reads (BLOCK)
  retryStrategy(times) {
    return Math.min(times * 150, 3000);
  },
});

let isRunning = true;

/**
 * Simulates asynchronous downstream tasks:
 * 1. Image transcoding / thumbnail generation
 * 2. Feed cache fan-out preparation
 * 3. Search index update & engagement auditing
 */
async function processPostCreatedEvent(messageId, payload) {
  const startTime = Date.now();
  console.log(`\n======================================================`);
  console.log(`[Worker ${CONSUMER_NAME}] 📥 Processing Stream Event [${messageId}]`);
  console.log(`------------------------------------------------------`);
  console.log(`Post ID:     ${payload.post_id}`);
  console.log(`User ID:     ${payload.user_id}`);
  console.log(`Caption:     ${payload.caption || '(none)'}`);
  console.log(`Media Files: ${payload.media?.length || 0} item(s)`);
  if (payload.media) {
    payload.media.forEach((m, idx) => {
      console.log(`   [${idx + 1}] Type: ${m.media_type} | URL: ${m.media_url}`);
    });
  }

  // Simulate heavy background asynchronous workload (transcoding, fan-out, notifications)
  console.log(`[Worker ${CONSUMER_NAME}] ⚙️  Simulating asynchronous thumbnail generation & feed fan-out...`);
  await new Promise((resolve) => setTimeout(resolve, 800));

  const durationMs = Date.now() - startTime;
  console.log(`[Worker ${CONSUMER_NAME}] ✅ Successfully processed Post ID ${payload.post_id} in ${durationMs}ms`);
  console.log(`======================================================\n`);
}

/**
 * Main worker loop using Redis Streams Consumer Groups (XREADGROUP)
 */
async function startWorker() {
  console.log(`[Worker] Initializing postWorker (${CONSUMER_NAME})...`);
  console.log(`[Worker] Connecting to Redis at ${REDIS_URL}`);
  console.log(`[Worker] Stream: "${STREAM_KEY}" | Consumer Group: "${CONSUMER_GROUP}"`);

  // Ensure stream and consumer group exist
  await initConsumerGroup(STREAM_KEY, CONSUMER_GROUP);

  console.log(`[Worker] 🚀 Listening for new stream events via XREADGROUP...`);

  while (isRunning) {
    try {
      // BLOCK for up to 2000ms waiting for new messages ('>' denotes undelivered messages)
      const response = await redis.xreadgroup(
        'GROUP',
        CONSUMER_GROUP,
        CONSUMER_NAME,
        'BLOCK',
        2000,
        'COUNT',
        10,
        'STREAMS',
        STREAM_KEY,
        '>'
      );

      if (!response) {
        // Timeout with no new events, loop again
        continue;
      }

      for (const [stream, messages] of response) {
        for (const [messageId, fields] of messages) {
          // Convert Redis flat array [key1, val1, key2, val2, ...] to an object
          const fieldMap = {};
          for (let i = 0; i < fields.length; i += 2) {
            fieldMap[fields[i]] = fields[i + 1];
          }

          const eventType = fieldMap.eventType;
          let payload = {};
          try {
            payload = JSON.parse(fieldMap.payload || '{}');
          } catch {
            payload = { raw: fieldMap.payload };
          }

          if (eventType === 'POST_CREATED') {
            await processPostCreatedEvent(messageId, payload);
          } else {
            console.log(`[Worker] Unknown eventType received: ${eventType}`);
          }

          // Acknowledge the message (XACK) so Redis knows it has been processed
          await redis.xack(STREAM_KEY, CONSUMER_GROUP, messageId);
        }
      }
    } catch (err) {
      if (!isRunning) break;
      console.error('[Worker Error]:', err.message);
      // Wait briefly before retrying on network/connection drop
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

// Graceful worker termination
const stopWorker = async (signal) => {
  console.log(`\n[Worker] Received ${signal}. Shutting down worker gracefully...`);
  isRunning = false;
  try {
    await redis.quit();
    console.log('[Worker] Redis connection closed.');
  } catch {}
  process.exit(0);
};

process.on('SIGINT', () => stopWorker('SIGINT'));
process.on('SIGTERM', () => stopWorker('SIGTERM'));

startWorker().catch((err) => {
  console.error('[Worker Fatal Error]:', err);
  process.exit(1);
});
