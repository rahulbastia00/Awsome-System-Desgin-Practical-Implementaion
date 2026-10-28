const prisma = require('../prisma');
const { redisClient } = require('../config/redisQueue');

const FEED_KEY_PREFIX = 'feed:';
const CELEBRITY_FEED_PREFIX = 'celebrity_feed:';
const CELEBRITIES_SET_KEY = 'set:celebrities';
const CELEBRITY_FOLLOWS_PREFIX = 'user_celebrity_follows:';

const MAX_FEED_LENGTH = 800; // Cap follower timeline to latest 800 posts
const FEED_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const CELEBRITY_THRESHOLD = parseInt(process.env.CELEBRITY_THRESHOLD, 10) || 10000;

/**
 * Phase 5 Hybrid Fan-Out Strategy (Section 6.2):
 * - For normal users: Fan-out-on-write (LPUSH to all followers' feeds).
 * - For celebrities (> CELEBRITY_THRESHOLD followers): Skip fan-out to followers
 *   to avoid massive write amplification. Write ONLY to the celebrity's timeline.
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

  // 3. Check follower count to classify whether author is an influencer/celebrity
  const followerCount = await prisma.follower.count({
    where: { followee_id: authorId },
  });

  const isCelebrity = followerCount >= CELEBRITY_THRESHOLD;

  // ----------------------------------------------------
  // CELEBRITY PATH (Avoid Write Amplification)
  // ----------------------------------------------------
  if (isCelebrity) {
    const celebKey = `${CELEBRITY_FEED_PREFIX}${authorId.toString()}`;
    const authorFeedKey = `${FEED_KEY_PREFIX}${authorId.toString()}`;

    const celebPipeline = redisClient.pipeline();
    // Record in global celebrity set for fast lookup
    celebPipeline.sadd(CELEBRITIES_SET_KEY, authorId.toString());
    // Store in celebrity dedicated feed list
    celebPipeline.lpush(celebKey, serializedItem);
    celebPipeline.ltrim(celebKey, 0, MAX_FEED_LENGTH - 1);
    celebPipeline.expire(celebKey, FEED_TTL_SECONDS);
    // Also update author's own timeline
    celebPipeline.lpush(authorFeedKey, serializedItem);
    celebPipeline.ltrim(authorFeedKey, 0, MAX_FEED_LENGTH - 1);
    celebPipeline.expire(authorFeedKey, FEED_TTL_SECONDS);

    await celebPipeline.exec();

    const durationMs = Date.now() - startTime;
    return {
      is_celebrity: true,
      skipped_fanout: true,
      follower_count: followerCount,
      recipients_count: 1,
      duration_ms: durationMs,
    };
  }

  // ----------------------------------------------------
  // NORMAL USER PATH (Fan-Out-on-Write)
  // ----------------------------------------------------
  const followerRecords = await prisma.follower.findMany({
    where: { followee_id: authorId },
    select: { follower_id: true },
  });

  const recipientIds = [authorId, ...followerRecords.map((r) => r.follower_id)];

  const pipeline = redisClient.pipeline();
  for (const recipientId of recipientIds) {
    const feedKey = `${FEED_KEY_PREFIX}${recipientId.toString()}`;
    pipeline.lpush(feedKey, serializedItem);
    pipeline.ltrim(feedKey, 0, MAX_FEED_LENGTH - 1);
    pipeline.expire(feedKey, FEED_TTL_SECONDS);
  }

  await pipeline.exec();

  const durationMs = Date.now() - startTime;
  return {
    is_celebrity: false,
    skipped_fanout: false,
    follower_count: followerCount,
    recipients_count: recipientIds.length,
    duration_ms: durationMs,
  };
}

/**
 * Helper: Find which celebrities a specific user follows.
 * Cached in Redis for 10 minutes to minimize DB queries during feed reads.
 */
async function getFollowedCelebrities(userId) {
  const cacheKey = `${CELEBRITY_FOLLOWS_PREFIX}${userId}`;
  const cached = await redisClient.get(cacheKey);

  if (cached) {
    try {
      return JSON.parse(cached);
    } catch {}
  }

  // Query database for followees who meet the celebrity follower count threshold
  const celebrities = await prisma.user.findMany({
    where: {
      followers: {
        some: {
          follower_id: BigInt(userId),
        },
      },
      _count: {
        followers: {
          gte: CELEBRITY_THRESHOLD,
        },
      },
    },
    select: { user_id: true },
  });

  const celebrityIds = celebrities.map((c) => c.user_id.toString());
  await redisClient.set(cacheKey, JSON.stringify(celebrityIds), 'EX', 600); // 10 min TTL

  return celebrityIds;
}

/**
 * Phase 5 Hybrid Feed Retrieval (Section 6.2):
 * Dynamically merges:
 *   1. Pushed feed from Redis list (`feed:{userId}`)
 *   2. Pulled posts from followed celebrity lists (`celebrity_feed:{celebId}`)
 * Sorts merged stream in-memory by created_at DESC and slices the requested page.
 * Falls back to PostgreSQL if Redis cache is cold.
 */
async function getUserTimeline({ userId, page = 1, limit = 10 }) {
  const pageNumber = Math.max(1, parseInt(page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(limit, 10) || 10));
  const feedKey = `${FEED_KEY_PREFIX}${userId.toString()}`;

  // 1. Fetch pushed posts from normal followees from Redis
  // Read extra items to ensure clean merge sorting window
  const fetchLimit = Math.max(pageSize * 3, 50);
  const cachedPushed = await redisClient.lrange(feedKey, 0, fetchLimit - 1);

  let normalPosts = [];
  let isCacheHit = false;

  if (cachedPushed && cachedPushed.length > 0) {
    isCacheHit = true;
    normalPosts = cachedPushed
      .map((item) => {
        try {
          return JSON.parse(item);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } else {
    // Cold cache fallback for normal followees
    const currentUserId = BigInt(userId);
    const followedRelations = await prisma.follower.findMany({
      where: { follower_id: currentUserId },
      select: { followee_id: true },
    });

    const feedAuthorIds = [...followedRelations.map((r) => r.followee_id), currentUserId];

    const dbPosts = await prisma.post.findMany({
      where: { user_id: { in: feedAuthorIds } },
      take: fetchLimit,
      orderBy: { created_at: 'desc' },
      include: {
        media: true,
        user: {
          select: { user_id: true, username: true, profile_pic_url: true },
        },
      },
    });

    normalPosts = dbPosts.map((p) => ({
      post_id: p.post_id.toString(),
      user_id: p.user_id.toString(),
      caption: p.caption,
      media: p.media,
      like_count: p.like_count,
      created_at: p.created_at.toISOString(),
      user: p.user,
    }));

    // Warm Redis feed list for this user
    if (normalPosts.length > 0) {
      const warmPipeline = redisClient.pipeline();
      for (const p of normalPosts) {
        warmPipeline.rpush(feedKey, JSON.stringify(p));
      }
      warmPipeline.expire(feedKey, FEED_TTL_SECONDS);
      warmPipeline.exec().catch(() => {});
    }
  }

  // 2. Pull latest posts from followed celebrities (Fan-out-on-read)
  const followedCelebrityIds = await getFollowedCelebrities(userId);
  let celebrityPosts = [];

  if (followedCelebrityIds.length > 0) {
    const celebPipeline = redisClient.pipeline();
    for (const celebId of followedCelebrityIds) {
      celebPipeline.lrange(`${CELEBRITY_FEED_PREFIX}${celebId}`, 0, 19);
    }
    const celebResults = await celebPipeline.exec();

    if (celebResults) {
      for (const [err, rawList] of celebResults) {
        if (!err && Array.isArray(rawList)) {
          for (const item of rawList) {
            try {
              celebrityPosts.push(JSON.parse(item));
            } catch {}
          }
        }
      }
    }
  }

  // 3. In-Memory K-Way Merge & Deduplication
  const postMap = new Map();

  // Combine normal and celebrity posts
  for (const post of [...normalPosts, ...celebrityPosts]) {
    if (post && post.post_id && !postMap.has(post.post_id)) {
      postMap.set(post.post_id, post);
    }
  }

  const mergedList = Array.from(postMap.values());

  // Sort descending by created_at timestamp
  mergedList.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  // Slice paginated window
  const startIndex = (pageNumber - 1) * pageSize;
  const paginatedFeed = mergedList.slice(startIndex, startIndex + pageSize);

  return {
    source: isCacheHit ? 'hybrid_redis_merge' : 'hybrid_postgres_fallback',
    strategy: 'hybrid_fanout (push_normal + pull_celebrities)',
    celebrities_followed: followedCelebrityIds.length,
    celebrity_posts_merged: celebrityPosts.length,
    page: pageNumber,
    limit: pageSize,
    total_items: paginatedFeed.length,
    feed: paginatedFeed,
  };
}

module.exports = {
  fanOutPostToFollowers,
  getUserTimeline,
  getFollowedCelebrities,
  FEED_KEY_PREFIX,
  CELEBRITY_FEED_PREFIX,
  CELEBRITY_THRESHOLD,
};
