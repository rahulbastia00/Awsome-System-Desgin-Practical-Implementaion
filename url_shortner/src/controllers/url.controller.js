const prisma = require('../config/db');
const redis = require('../config/redis');
const { isValidUrl } = require('../utils/validator');
const { getNextShortCode } = require('../utils/base62');

const DEFAULT_CACHE_TTL_SECONDS = 86400; // 24 hours

/**
 * Calculates Redis TTL considering expiration date.
 * If URL expires sooner than default TTL, clamp to remaining seconds.
 * Returns null if the URL has already expired.
 *
 * @param {Date|null} expiresAt
 * @returns {number|null}
 */
function calculateCacheTtl(expiresAt) {
  if (!expiresAt) {
    return DEFAULT_CACHE_TTL_SECONDS;
  }

  const remainingSeconds = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000);
  if (remainingSeconds <= 0) {
    return null; // Already expired, do not cache
  }

  return Math.min(remainingSeconds, DEFAULT_CACHE_TTL_SECONDS);
}

/**
 * POST /shorten
 * Shortens a long URL with optional custom alias, atomic ID generation, and Redis cache warming
 */
async function shortenUrl(req, res, next) {
  try {
    const { long_url, custom_alias, expires_at, user_id } = req.body;

    // 1. Validation
    if (!long_url || !isValidUrl(long_url)) {
      return res.status(400).json({
        error: 'Invalid URL. Please provide a well-formed HTTP or HTTPS URL.',
      });
    }

    let parsedExpiresAt = null;
    if (expires_at) {
      parsedExpiresAt = new Date(expires_at);
      if (isNaN(parsedExpiresAt.getTime()) || parsedExpiresAt <= new Date()) {
        return res.status(400).json({
          error: 'Invalid expires_at. It must be a valid future ISO-8601 date string.',
        });
      }
    }

    let shortCode = custom_alias ? custom_alias.trim() : null;

    // 2. Custom Alias Handling
    if (shortCode) {
      // Check if alias already exists
      const existing = await prisma.url.findUnique({
        where: { shortCode },
      });

      if (existing) {
        return res.status(409).json({
          error: `The alias '${shortCode}' is already taken. Please choose another.`,
        });
      }
    } else {
      // 3. Collision-free Base62 code generated via Redis atomic counter
      shortCode = await getNextShortCode(redis);
    }

    // 4. Persist to PostgreSQL via Prisma ORM
    const newRecord = await prisma.url.create({
      data: {
        shortCode,
        longUrl: long_url,
        userId: user_id || null,
        expiresAt: parsedExpiresAt,
      },
    });

    // 5. Cache Warming with Expiration-Aware TTL (Cache Consistency)
    const cacheTtl = calculateCacheTtl(parsedExpiresAt);
    if (cacheTtl) {
      await redis.setex(`link:${shortCode}`, cacheTtl, long_url);
    }

    const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

    return res.status(201).json({
      short_url: `${baseUrl}/${newRecord.shortCode}`,
      long_url: newRecord.longUrl,
      expires_at: newRecord.expiresAt,
      created_at: newRecord.createdAt,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /:short_code
 * Redirects to the original URL via Redis Cache-Aside + Expiration Consistency + Decoupled Click Buffering
 */
async function redirectUrl(req, res, next) {
  try {
    const { short_code } = req.params;

    // 1. Cache-Aside: Check Redis first
    const cachedLongUrl = await redis.get(`link:${short_code}`);

    if (cachedLongUrl) {
      // CACHE HIT: Fire-and-forget in-memory click increment
      redis.incr(`clicks:${short_code}`).catch((err) => {
        console.error('Redis click buffer error:', err.message);
      });

      // Immediate 302 Redirect without hitting PostgreSQL!
      return res.redirect(302, cachedLongUrl);
    }

    // 2. CACHE MISS: Query PostgreSQL via Prisma
    const record = await prisma.url.findUnique({
      where: { shortCode: short_code },
    });

    if (!record) {
      return res.status(404).json({ error: 'Short URL not found.' });
    }

    // 3. Expiration Check & Cache Invalidation
    if (record.expiresAt && new Date() > record.expiresAt) {
      // Purge any stale cache entry for consistency
      await redis.del(`link:${short_code}`);
      return res.status(410).json({ error: 'This short link has expired.' });
    }

    // 4. Warm Redis Cache with remaining TTL
    const cacheTtl = calculateCacheTtl(record.expiresAt);
    if (cacheTtl) {
      await redis.setex(`link:${short_code}`, cacheTtl, record.longUrl);
    }

    // 5. Fire-and-forget in-memory click increment
    redis.incr(`clicks:${short_code}`).catch((err) => {
      console.error('Redis click buffer error:', err.message);
    });

    // 6. HTTP 302 Found redirect
    return res.redirect(302, record.longUrl);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /analytics/:short_code
 * Returns combined statistics: stored DB clicks + pending buffered Redis clicks
 */
async function getAnalytics(req, res, next) {
  try {
    const { short_code } = req.params;

    // 1. Fetch persistent state from PostgreSQL
    const record = await prisma.url.findUnique({
      where: { shortCode: short_code },
      select: {
        shortCode: true,
        clicks: true,
        createdAt: true,
        lastAccessed: true,
        expiresAt: true,
      },
    });

    if (!record) {
      return res.status(404).json({ error: 'Short URL not found.' });
    }

    // 2. Fetch pending in-memory clicks buffered in Redis
    const bufferedClicksStr = await redis.get(`clicks:${short_code}`);
    const bufferedClicks = parseInt(bufferedClicksStr || '0', 10);

    const totalClicks = Number(record.clicks) + bufferedClicks;

    return res.status(200).json({
      short_code: record.shortCode,
      total_clicks: totalClicks,
      stored_clicks: Number(record.clicks),
      buffered_clicks: bufferedClicks,
      created_at: record.createdAt,
      last_accessed: record.lastAccessed,
      expires_at: record.expiresAt,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  shortenUrl,
  redirectUrl,
  getAnalytics,
};
