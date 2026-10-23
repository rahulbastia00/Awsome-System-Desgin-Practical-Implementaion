const prisma = require('../config/db');
const { isValidUrl } = require('../utils/validator');
const { generateShortCode } = require('../utils/base62');

/**
 * POST /shorten
 * Shortens a long URL with optional custom alias and expiration
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
            // 3. Generate random unique Base62 short code (with retry safety)
            let attempts = 0;
            const MAX_ATTEMPTS = 5;

            while (attempts < MAX_ATTEMPTS) {
                const candidate = generateShortCode(7);
                const exists = await prisma.url.findUnique({
                    where: { shortCode: candidate },
                });

                if (!exists) {
                    shortCode = candidate;
                    break;
                }
                attempts++;
            }

            if (!shortCode) {
                return res.status(500).json({
                    error: 'Failed to generate a unique short code. Please try again.',
                });
            }
        }

        // 4. Save to Database via Prisma ORM
        const newRecord = await prisma.url.create({
            data: {
                shortCode,
                longUrl: long_url,
                userId: user_id || null,
                expiresAt: parsedExpiresAt,
            },
        });

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
 * Redirects to the original URL if valid and not expired
 */
async function redirectUrl(req, res, next) {
    try {
        const { short_code } = req.params;

        // 1. Find URL by unique shortCode
        const record = await prisma.url.findUnique({
            where: { shortCode: short_code },
        });

        if (!record) {
            return res.status(404).json({ error: 'Short URL not found.' });
        }

        // 2. Expiration Check
        if (record.expiresAt && new Date() > record.expiresAt) {
            return res.status(410).json({ error: 'This short link has expired.' });
        }

        // 3. Atomic click increment & last_accessed update
        await prisma.url.update({
            where: { shortCode: short_code },
            data: {
                clicks: { increment: 1 },
                lastAccessed: new Date(),
            },
        });

        // 4. HTTP 302 Found redirect
        return res.redirect(302, record.longUrl);
    } catch (error) {
        next(error);
    }
}

/**
 * GET /analytics/:short_code
 * Retrieves access statistics for a short link
 */
async function getAnalytics(req, res, next) {
    try {
        const { short_code } = req.params;

        const record = await prisma.url.findUnique({
            where: { shortCode: short_code },
            select: {
                shortCode: true,
                clicks: true,
                createdAt: true,
                lastAccessed: true,
            },
        });

        if (!record) {
            return res.status(404).json({ error: 'Short URL not found.' });
        }

        return res.status(200).json({
            short_code: record.shortCode,
            total_clicks: Number(record.clicks), // Convert BigInt to Number for JSON serialization
            created_at: record.createdAt,
            last_accessed: record.lastAccessed,
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
