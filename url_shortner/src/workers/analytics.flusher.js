/**
 * Scans Redis for buffered click counts and flushes them to PostgreSQL.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {import('ioredis').Redis} redis
 */
async function flushBufferedClicks(prisma, redis) {
  try {
    let cursor = '0';
    const keysToProcess = [];

    // Use SCAN instead of KEYS to avoid blocking Redis event loop in production
    do {
      const [nextCursor, matchedKeys] = await redis.scan(cursor, 'MATCH', 'clicks:*', 'COUNT', 100);
      cursor = nextCursor;
      if (matchedKeys && matchedKeys.length > 0) {
        keysToProcess.push(...matchedKeys);
      }
    } while (cursor !== '0');

    if (keysToProcess.length === 0) {
      return;
    }

    // Process keys concurrently
    const updatePromises = keysToProcess.map(async (key) => {
      const shortCode = key.replace('clicks:', '');

      // Atomically read and delete the key in Redis (or get and del)
      // ioredis supports getdel in Redis 6.2+
      let countStr;
      if (typeof redis.getdel === 'function') {
        countStr = await redis.getdel(key);
      } else {
        // Fallback for older redis versions using multi pipeline
        const [getRes] = await redis.multi().get(key).del(key).exec();
        countStr = getRes ? getRes[1] : null;
      }

      const count = parseInt(countStr, 10);
      if (count && count > 0) {
        try {
          await prisma.url.update({
            where: { shortCode },
            data: {
              clicks: { increment: count },
              lastAccessed: new Date(),
            },
          });
        } catch (dbErr) {
          // If the record was deleted or not found, log gracefully
          console.error(`Failed to flush clicks for shortCode '${shortCode}':`, dbErr.message);
        }
      }
    });

    await Promise.all(updatePromises);
  } catch (error) {
    console.error('Error during click flusher execution:', error.message);
  }
}

/**
 * Starts recurring background click flusher.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {import('ioredis').Redis} redis
 * @param {number} intervalMs
 * @returns {NodeJS.Timeout}
 */
function startAnalyticsFlusher(prisma, redis, intervalMs = 10000) {
  const timer = setInterval(() => {
    flushBufferedClicks(prisma, redis);
  }, intervalMs);

  // Unref timer so it doesn't hold open the event loop during shutdown
  if (timer.unref) {
    timer.unref();
  }

  console.log(`⏱️ Analytics flusher worker started (interval: ${intervalMs}ms)`);
  return timer;
}

module.exports = {
  flushBufferedClicks,
  startAnalyticsFlusher,
};
