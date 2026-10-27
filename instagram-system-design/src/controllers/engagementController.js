const prisma = require('../prisma');

/**
 * 5. POST /api/v1/posts/:post_id/like
 * Atomically increments the like_count on the Post record.
 */
const likePost = async (req, res, next) => {
    try {
        const { post_id } = req.params;
        const postId = BigInt(post_id);

        // Atomically increment like_count in Postgres
        const updatedPost = await prisma.post.update({
            where: { post_id: postId },
            data: {
                like_count: {
                    increment: 1,
                },
            },
            select: {
                post_id: true,
                like_count: true,
            },
        });

        return res.status(200).json({
            message: 'Post liked successfully',
            post_id: updatedPost.post_id,
            like_count: updatedPost.like_count,
        });
    } catch (err) {
        if (err.code === 'P2025') {
            return res.status(404).json({ error: 'Post not found' });
        }
        if (err instanceof TypeError || err.message?.includes('Cannot convert')) {
            return res.status(400).json({ error: 'Invalid post_id format. Must be an integer.' });
        }
        next(err);
    }
};

/**
 * 6. POST /api/v1/posts/:post_id/comment
 * Adds a new comment from an authenticated user.
 */
const addComment = async (req, res, next) => {
    try {
        const { post_id } = req.params;
        const postId = BigInt(post_id);

        const rawUserId = req.headers['x-user-id'] || req.body.user_id;
        const { content } = req.body;

        if (!rawUserId) {
            return res.status(400).json({
                error: 'user_id is required via header (x-user-id) or body field (user_id)',
            });
        }

        if (!content || content.trim() === '') {
            return res.status(400).json({ error: 'Comment content cannot be empty' });
        }

        const userId = BigInt(rawUserId);

        // Ensure target post exists
        const postExists = await prisma.post.findUnique({
            where: { post_id: postId },
            select: { post_id: true },
        });

        if (!postExists) {
            return res.status(404).json({ error: 'Post not found' });
        }

        // Create the comment record
        const comment = await prisma.comment.create({
            data: {
                post_id: postId,
                user_id: userId,
                content: content.trim(),
            },
            include: {
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
            message: 'Comment added successfully',
            comment,
        });
    } catch (err) {
        if (err.code === 'P2025' || err.code === 'P2003') {
            return res.status(404).json({ error: 'Post or User not found' });
        }
        if (err instanceof TypeError || err.message?.includes('Cannot convert')) {
            return res.status(400).json({ error: 'Invalid ID format. Must be an integer.' });
        }
        next(err);
    }
};

/**
 * 7. GET /api/v1/posts/:post_id/comments?page=1&limit=10
 * Retrieves paginated comments for a specific post.
 */
const getPostComments = async (req, res, next) => {
    try {
        const { post_id } = req.params;
        const postId = BigInt(post_id);

        // Pagination parameters
        const pageNumber = Math.max(1, parseInt(req.query.page, 10) || 1);
        const pageSize = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
        const skip = (pageNumber - 1) * pageSize;

        // Fetch total comment count and paginated list in parallel
        const [totalComments, comments] = await prisma.$transaction([
            prisma.comment.count({
                where: { post_id: postId },
            }),
            prisma.comment.findMany({
                where: { post_id: postId },
                skip,
                take: pageSize,
                orderBy: { created_at: 'asc' }, // Chronological thread
                include: {
                    user: {
                        select: {
                            user_id: true,
                            username: true,
                            profile_pic_url: true,
                        },
                    },
                },
            }),
        ]);

        return res.status(200).json({
            post_id: postId,
            page: pageNumber,
            limit: pageSize,
            total_comments: totalComments,
            comments,
        });
    } catch (err) {
        if (err instanceof TypeError || err.message?.includes('Cannot convert')) {
            return res.status(400).json({ error: 'Invalid post_id format. Must be an integer.' });
        }
        next(err);
    }
};

module.exports = {
    likePost,
    addComment,
    getPostComments,
};
