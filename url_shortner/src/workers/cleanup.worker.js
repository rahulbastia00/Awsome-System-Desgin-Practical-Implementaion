/**
 * Periodic background worker to clean up expired links from PostgreSQL.
 * Keeps table size lean and prevents accumulation of dead rows.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {import('ioredis').Redis} redis
 */
async function cleanupExpiredLinks(prisma, redis) {
  try {
    const now = new Date();

    // 1. Find expired records to purge associated Redis cache keys
    const expiredRecords = await prisma.url.findMany({
      where: {
        expiresAt: {
          lt: now,
        },
      },
      select: {
        shortCode: true,
      },
      take: 500, // Batch limit to avoid overwhelming memory/db
    });

    if (expiredRecords.length === 0) {
      return;
    }

    const shortCodes = expiredRecords.map((r) => r.shortCode);

    // 2. Delete expired records from PostgreSQL
    const deleteResult = await prisma.url.deleteMany({
      where: {
        shortCode: {
          in: shortCodes,
        },
      },
    });

    // 3. Invalidate any leftover Redis keys (cache consistency)
    const pipeline = redis.pipeline();
    shortCodes.forEach((code) => {
      pipeline.del(`link:${code}`);
      pipeline.del(`clicks:${code}`);
    });
    await pipeline.exec();

    console.log(`🧹 Cleanup Worker: Purged ${deleteResult.count} expired links.`);
  } catch (error) {
    console.error('Error during expired links cleanup:', error.message);
  }
}

/**
 * Starts the periodic background cleanup runner.
 * Recommended to run only on the Primary/Master process.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {import('ioredis').Redis} redis
 * @param {number} intervalMs
 * @returns {NodeJS.Timeout}
 */
function startCleanupWorker(prisma, redis, intervalMs = 60000) {
  // Run an immediate sweep on boot
  cleanupExpiredLinks(prisma, redis);

  // Then schedule periodically
  const timer = setInterval(() => {
    cleanupExpiredLinks(prisma, redis);
  }, intervalMs);

  if (timer.unref) {
    timer.unref();
  }

  console.log(`🧹 Expired links cleanup worker started (interval: ${intervalMs}ms)`);
  return timer;
}

module.exports = {
  cleanupExpiredLinks,
  startCleanupWorker,
};
