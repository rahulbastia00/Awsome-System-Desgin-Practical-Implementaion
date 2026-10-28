const prisma = require('../prisma');
const localObjectStorage = require('../services/localObjectStorage');
const redisQueue = require('../config/redisQueue');

// ----------------------------------------------------
// Controller Handlers
// ----------------------------------------------------

/**
 * 1. POST /api/v1/posts/presign-upload
 * Step 1 of Object Storage Separation:
 * Client requests a secure, pre-signed upload URL for local storage.
 * Body can contain:
 *   - { filename: "vacation.jpg", file_type: "image/jpeg" }
 *   - OR { files: [ { filename: "...", file_type: "..." }, ... ] }
 */
const getPresignedUpload = async (req, res, next) => {
  try {
    const rawUserId = req.headers['x-user-id'] || req.body.user_id;
    const { filename, file_type, files } = req.body;

    // Handle batch pre-signing if an array of files is provided
    if (Array.isArray(files) && files.length > 0) {
      const presignedList = files.map((f) =>
        localObjectStorage.createPresignedUpload({
          filename: f.filename,
          fileType: f.file_type || f.fileType,
          userId: rawUserId,
        })
      );
      return res.status(200).json({ uploads: presignedList });
    }

    if (!filename && !file_type) {
      return res.status(400).json({
        error: 'Please provide filename and file_type (e.g., image/jpeg, video/mp4) or a files array',
      });
    }

    const presigned = localObjectStorage.createPresignedUpload({
      filename,
      fileType: file_type,
      userId: rawUserId,
    });

    return res.status(200).json(presigned);
  } catch (err) {
    next(err);
  }
};

/**
 * Direct Binary Upload Endpoint:
 * PUT or POST /api/v1/posts/upload/:token
 * Step 1b: Client uploads the raw binary stream directly to local storage.
 * Bypasses application event loop overhead and JSON parsers.
 */
const uploadMediaBinary = async (req, res, next) => {
  try {
    const { token } = req.params;
    const result = await localObjectStorage.streamUploadToDisk(req, token);

    return res.status(200).json({
      message: 'Binary file uploaded successfully to object storage',
      ...result,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * 2. POST /api/v1/posts
 * Step 2 of Object Storage Separation:
 * Accepts JSON metadata (caption and media array containing media_url & media_type).
 * Saves Post and Media records to PostgreSQL via Prisma.
 */
const createPost = async (req, res, next) => {
  try {
    const rawUserId = req.headers['x-user-id'] || req.body.user_id;

    if (!rawUserId) {
      return res.status(400).json({
        error: 'user_id is required via header (x-user-id) or JSON body field (user_id)',
      });
    }

    const userId = BigInt(rawUserId);
    const { caption, media } = req.body;

    // Validate media array
    if (!Array.isArray(media) || media.length === 0) {
      return res.status(400).json({
        error: 'media must be a non-empty array of objects with media_url and media_type',
      });
    }

    // Verify creator exists in database
    const user = await prisma.user.findUnique({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User does not exist.' });
    }

    // Verify that every referenced media file actually exists in local object storage
    for (const item of media) {
      if (!item.media_url) {
        return res.status(400).json({ error: 'Each media item must have a valid media_url' });
      }
      if (!localObjectStorage.fileExists(item.media_url)) {
        return res.status(400).json({
          error: `Media file ${item.media_url} not found in object storage. Did you complete the pre-signed upload step?`,
        });
      }
    }

    // Prepare normalized media records for Prisma
    const mediaRecords = media.map((item) => ({
      media_url: item.media_url,
      media_type: item.media_type === 'VIDEO' ? 'VIDEO' : 'PHOTO',
    }));

    // Atomically create Post and Media rows
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

    // Phase 3: Decouple background work by pushing POST_CREATED event to Redis Stream
    const streamPayload = {
      post_id: post.post_id.toString(),
      user_id: post.user_id.toString(),
      caption: post.caption,
      media: post.media.map((m) => ({
        media_id: m.media_id.toString(),
        media_url: m.media_url,
        media_type: m.media_type,
      })),
      created_at: post.created_at.toISOString(),
    };

    const streamMessageId = await redisQueue.publishPostCreatedEvent(streamPayload);

    return res.status(201).json({
      message: 'Post created successfully',
      post,
      stream_event_id: streamMessageId,
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
  getPresignedUpload,
  uploadMediaBinary,
  createPost,
  getFeed,
};
