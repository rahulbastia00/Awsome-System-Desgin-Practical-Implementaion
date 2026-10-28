const prisma = require('../prisma');
const { redisClient } = require('../config/redisQueue');

const FEED_KEY_PREFIX = 'feed:';
const MAX_FEED_LENGTH = 800; // Cap follower timeline to latest 800 posts
const FEED_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

/**
 * Fan-Out-on-Write (Push Model):
 * Pushes a new post directly into the Redis timeline lists of all followers (and author).
 * @param {Object} postData - { post_id, user_id, caption, media, created_at, user }
 */
async function fanOutPostToFollowers(postData) {
  const startTime = Date.now();
  const authorId = BigInt(postData.user_id);

  // 1. Fetch author details if not already present
  let author = postData.user;
  if (!author) {
    const dbAuthor = await prisma.user.findUnique({
      where: { user_id: authorId },
      select: { user_id: true, username: true, profile_pic_url: true },
    });
    if (dbAuthor) {
      author = {
        user_id: dbAuthor.user_id.toString(),
        username: dbAuthor.username,
        profile_pic_url: dbAuthor.profile_pic_url,
      };
    }
  }

  // 2. Format complete post object for timeline storage
  const timelineItem = {
    post_id: postData.post_id.toString(),
    user_id: postData.user_id.toString(),
    caption: postData.caption || null,
    media: postData.media || [],
    like_count: postData.like_count || 0,
    created_at: postData.created_at || new Date().toISOString(),
    user: author || { user_id: postData.user_id.toString() },
  };

  const serializedItem = JSON.stringify(timelineItem);

  // 3. Query all followers of this creator from PostgreSQL
  const followerRecords = await prisma.follower.findMany({
    where: { followee_id: authorId },
    select: { follower_id: true },
  });

  // Include followers AND the author themselves (creators see their own posts)
  const recipientIds = [authorId, ...followerRecords.map((r) => r.follower_id)];

  // 4. Batch push using Redis pipeline for ultra-high throughput
  const pipeline = redisClient.pipeline();

  for (const recipientId of recipientIds) {
    const feedKey = `${FEED_KEY_PREFIX}${recipientId.toString()}`;
    // LPUSH adds to front (newest first)
    pipeline.lpush(feedKey, serializedItem);
    // LTRIM caps list to max length to prevent unbounded memory growth
    pipeline.ltrim(feedKey, 0, MAX_FEED_LENGTH - 1);
    // Refresh TTL
    pipeline.expire(feedKey, FEED_TTL_SECONDS);
  }

  await pipeline.exec();

  const durationMs = Date.now() - startTime;
  return {
    recipients_count: recipientIds.length,
    duration_ms: durationMs,
  };
}

/**
 * Cache-Aside Feed Retrieval:
 * Reads paginated timeline from Redis (LRANGE).
 * If cold cache / miss, falls back to PostgreSQL (fan-out on read) and warms Redis.
 * @param {Object} options - { userId, page, limit }
 */
async function getUserTimeline({ userId, page = 1, limit = 10 }) {
  const pageNumber = Math.max(1, parseInt(page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(limit, 10) || 10));
  const feedKey = `${FEED_KEY_PREFIX}${userId.toString()}`;

  const startIndex = (pageNumber - 1) * pageSize;
  const stopIndex = startIndex + pageSize - 1;

  // 1. Try reading timeline slice from Redis list (O(N) slice)
  const cachedItems = await redisClient.lrange(feedKey, startIndex, stopIndex);

  if (cachedItems && cachedItems.length > 0) {
    const posts = cachedItems.map((raw) => {
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    });

    return {
      source: 'redis_cache',
      page: pageNumber,
      limit: pageSize,
      total_items: posts.length,
      feed: posts,
    };
  }

  // 2. Cache Miss: Fall back to PostgreSQL
  const currentUserId = BigInt(userId);

  // Fetch followees
  const followedRelations = await prisma.follower.findMany({
    where: { follower_id: currentUserId },
    select: { followee_id: true },
  });

  const feedAuthorIds = [...followedRelations.map((r) => r.followee_id), currentUserId];

  // Fetch posts from database
  const dbPosts = await prisma.post.findMany({
    where: { user_id: { in: feedAuthorIds } },
    skip: startIndex,
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
        select: { comments: true, shares: true },
      },
    },
  });

  // 3. Cache Warming: If page 1 had a cache miss, asynchronously warm Redis feed
  if (pageNumber === 1 && dbPosts.length > 0) {
    const warmPipeline = redisClient.pipeline();
    // RPUSH to append in reverse chronological order
    for (const post of dbPosts) {
      const formatted = {
        post_id: post.post_id.toString(),
        user_id: post.user_id.toString(),
        caption: post.caption,
        media: post.media,
        like_count: post.like_count,
        created_at: post.created_at.toISOString(),
        user: post.user,
      };
      warmPipeline.rpush(feedKey, JSON.stringify(formatted));
    }
    warmPipeline.expire(feedKey, FEED_TTL_SECONDS);
    warmPipeline.exec().catch(() => {});
  }

  return {
    source: 'postgres_fallback',
    page: pageNumber,
    limit: pageSize,
    total_items: dbPosts.length,
    feed: dbPosts,
  };
}

module.exports = {
  fanOutPostToFollowers,
  getUserTimeline,
  FEED_KEY_PREFIX,
  MAX_FEED_LENGTH,
};
