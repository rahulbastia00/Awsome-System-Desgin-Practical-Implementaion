const prisma = require('../prisma');
const multer = require('multer');
const path = require('path');

// ----------------------------------------------------
// Multer Disk Storage Configuration
// ----------------------------------------------------
const uploadDir = process.env.UPLOAD_DIR || './uploads';

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        // Generate unique filename: <timestamp>-<random6>.<ext>
        const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
        const ext = path.extname(file.originalname);
        cb(null, `post-${uniqueSuffix}${ext}`);
    },
});

// File filter: Accept only image and video MIME types
const fileFilter = (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
        cb(null, true);
    } else {
        cb(new Error('Unsupported file type. Only images and videos are allowed!'), false);
    }
};

const maxSizeBytes = (parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 15) * 1024 * 1024;

const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: maxSizeBytes },
});

// ----------------------------------------------------
// Controller Handlers
// ----------------------------------------------------

/**
 * 3. POST /api/v1/posts
 * Multipart/form-data:
 *   - fields: caption, user_id (or via x-user-id header)
 *   - files: media (up to 10 files)
 */
const createPost = async (req, res, next) => {
    try {
        const rawUserId = req.headers['x-user-id'] || req.body.user_id;

        if (!rawUserId) {
            return res.status(400).json({
                error: 'user_id is required via header (x-user-id) or form field (user_id)',
            });
        }

        const userId = BigInt(rawUserId);
        const { caption } = req.body;
        const files = req.files || [];

        if (files.length === 0) {
            return res.status(400).json({ error: 'At least one media file (image or video) is required.' });
        }

        // Verify creator exists
        const user = await prisma.user.findUnique({ where: { user_id: userId } });
        if (!user) {
            return res.status(404).json({ error: 'User does not exist.' });
        }

        // Map uploaded files to Media records matching the Prisma enum MediaType (PHOTO, VIDEO)
        const mediaRecords = files.map((file) => {
            const isVideo = file.mimetype.startsWith('video/');
            return {
                media_url: `/uploads/${file.filename}`,
                media_type: isVideo ? 'VIDEO' : 'PHOTO',
            };
        });

        // Create Post and related Media in a single atomic database operation
        const post = await prisma.post.create({
            data: {
                user_id: userId,
                caption: caption || null,
                media: {
                    create: mediaRecords,
                },
            },
            include: {
                media: true,
                user: {
                    select: {
                        user_id: true,
                        username: true,
                        profile_pic_url: true,
                    },
                },
            },
        });

        return res.status(201).json({
            message: 'Post created successfully',
            post,
        });
    } catch (err) {
        if (err instanceof TypeError || err.message?.includes('Cannot convert')) {
            return res.status(400).json({ error: 'Invalid user_id format. Must be an integer.' });
        }
        next(err);
    }
};

/**
 * 4. GET /api/v1/feed?page=1&limit=10
 * Returns paginated posts from authors followed by the authenticated user.
 */
const getFeed = async (req, res, next) => {
    try {
        const rawUserId = req.headers['x-user-id'] || req.query.user_id;

        if (!rawUserId) {
            return res.status(400).json({
                error: 'Authenticated user ID is required via x-user-id header or user_id query param',
            });
        }

        const userId = BigInt(rawUserId);

        // Pagination validation
        const pageNumber = Math.max(1, parseInt(req.query.page, 10) || 1);
        const pageSize = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
        const skip = (pageNumber - 1) * pageSize;

        // 1. Fetch user's followees (creators they follow)
        const followedRelations = await prisma.follower.findMany({
            where: { follower_id: userId },
            select: { followee_id: true },
        });

        const followedIds = followedRelations.map((r) => r.followee_id);

        // Include the user's own posts in their feed as well
        const feedAuthorIds = [...followedIds, userId];

        // 2. Fetch posts from these creators, ordered reverse-chronologically
        const posts = await prisma.post.findMany({
            where: {
                user_id: { in: feedAuthorIds },
            },
            skip,
            take: pageSize,
            orderBy: { created_at: 'desc' },
            include: {
                media: true,
                user: {
                    select: {
                        user_id: true,
                        username: true,
                        profile_pic_url: true,
                    },
                },
                _count: {
                    select: {
                        comments: true,
                        shares: true,
                    },
                },
            },
        });

        return res.status(200).json({
            page: pageNumber,
            limit: pageSize,
            total_items: posts.length,
            feed: posts,
        });
    } catch (err) {
        if (err instanceof TypeError || err.message?.includes('Cannot convert')) {
            return res.status(400).json({ error: 'Invalid user ID format. Must be an integer.' });
        }
        next(err);
    }
};

module.exports = {
    upload,
    createPost,
    getFeed,
};
