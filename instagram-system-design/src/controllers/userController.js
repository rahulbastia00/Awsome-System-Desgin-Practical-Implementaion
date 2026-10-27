const prisma = require('../prisma');
const bcrypt = require('bcrypt');

/**
 * Helper: Register a new user (for testing & seeding)
 * POST /api/v1/users
 */
const createUser = async (req, res, next) => {
    try {
        const { username, full_name, email, password, profile_pic_url } = req.body;

        if (!username || !email || !password || !full_name) {
            return res.status(400).json({ error: 'Missing required fields: username, full_name, email, password' });
        }

        const saltRounds = 10;
        const password_hash = await bcrypt.hash(password, saltRounds);

        const newUser = await prisma.user.create({
            data: {
                username,
                full_name,
                email,
                password_hash,
                profile_pic_url: profile_pic_url || null,
            },
            select: {
                user_id: true,
                username: true,
                full_name: true,
                email: true,
                profile_pic_url: true,
                created_at: true,
            },
        });

        return res.status(201).json({
            message: 'User registered successfully',
            user: newUser,
        });
    } catch (err) {
        next(err);
    }
};

/**
 * 1. GET /api/v1/users/:user_id
 * Retrieves user profile alongside follower, following, and post counts.
 */
const getUserProfile = async (req, res, next) => {
    try {
        const { user_id } = req.params;

        const targetId = BigInt(user_id);

        // Fetch user info along with aggregation counts in a single query
        const user = await prisma.user.findUnique({
            where: { user_id: targetId },
            select: {
                user_id: true,
                username: true,
                full_name: true,
                email: true,
                profile_pic_url: true,
                created_at: true,
                _count: {
                    select: {
                        followers: true,  // people who follow this user
                        following: true,  // people this user follows
                        posts: true,      // total posts created
                    },
                },
            },
        });

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        return res.status(200).json({
            user_id: user.user_id,
            username: user.username,
            full_name: user.full_name,
            email: user.email,
            profile_pic_url: user.profile_pic_url,
            created_at: user.created_at,
            counts: {
                followers: user._count.followers,
                following: user._count.following,
                posts: user._count.posts,
            },
        });
    } catch (err) {
        if (err instanceof TypeError || err.message?.includes('Cannot convert')) {
            return res.status(400).json({ error: 'Invalid user_id format. Must be an integer.' });
        }
        next(err);
    }
};

/**
 * 2. POST /api/v1/users/:user_id/follow
 * Follows target user (followee_id).
 * The follower ID is passed via header `x-user-id` or body `follower_id`.
 */
const followUser = async (req, res, next) => {
    try {
        const followee_id = BigInt(req.params.user_id);
        const rawFollowerId = req.headers['x-user-id'] || req.body.follower_id;

        if (!rawFollowerId) {
            return res.status(400).json({
                error: 'Follower user ID must be provided via x-user-id header or follower_id in body',
            });
        }

        const follower_id = BigInt(rawFollowerId);

        // Prevent following oneself
        if (follower_id === followee_id) {
            return res.status(400).json({ error: 'You cannot follow yourself' });
        }

        // Verify target followee exists
        const targetUser = await prisma.user.findUnique({ where: { user_id: followee_id } });
        if (!targetUser) {
            return res.status(404).json({ error: 'Target user to follow does not exist' });
        }

        // Upsert relationship to prevent duplicates and make the operation idempotent
        const followRecord = await prisma.follower.upsert({
            where: {
                follower_id_followee_id: {
                    follower_id,
                    followee_id,
                },
            },
            update: {}, // if already following, no changes needed
            create: {
                follower_id,
                followee_id,
                engagement_score: 1.0,
            },
        });

        return res.status(200).json({
            message: `Successfully followed ${targetUser.username}`,
            follow: followRecord,
        });
    } catch (err) {
        if (err instanceof TypeError || err.message?.includes('Cannot convert')) {
            return res.status(400).json({ error: 'Invalid user ID format. Must be an integer.' });
        }
        next(err);
    }
};

/**
 * 8. GET /api/v1/search/users?q={query}
 * Case-insensitive search on username and full_name with pagination.
 */
const searchUsers = async (req, res, next) => {
    try {
        const { q, page = 1, limit = 10 } = req.query;

        if (!q || q.trim() === '') {
            return res.status(400).json({ error: 'Query parameter q is required' });
        }

        const pageNumber = Math.max(1, parseInt(page, 10) || 1);
        const pageSize = Math.min(50, Math.max(1, parseInt(limit, 10) || 10));
        const skip = (pageNumber - 1) * pageSize;

        const users = await prisma.user.findMany({
            where: {
                OR: [
                    { username: { contains: q.trim(), mode: 'insensitive' } },
                    { full_name: { contains: q.trim(), mode: 'insensitive' } },
                ],
            },
            skip,
            take: pageSize,
            select: {
                user_id: true,
                username: true,
                full_name: true,
                profile_pic_url: true,
            },
        });

        return res.status(200).json({
            page: pageNumber,
            limit: pageSize,
            results: users,
        });
    } catch (err) {
        next(err);
    }
};

module.exports = {
    createUser,
    getUserProfile,
    followUser,
    searchUsers,
};
