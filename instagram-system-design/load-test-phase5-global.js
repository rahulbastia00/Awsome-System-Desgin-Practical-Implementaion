const autocannon = require('autocannon');

/**
 * Phase 5 Global Stress-Test Suite: Multi-Vector Mixed Workload
 * Simulates real-world production traffic matching Section 6 & 7:
 * - 40% Media Pre-Signing (POST /api/v1/posts/presign-upload)
 * - 10% Post Creation (POST /api/v1/posts)
 * - 40% Timeline Feed Reads (GET /api/v1/feed - Hybrid Redis/Celebrity)
 * - 10% Post Engagement Likes (POST /api/v1/posts/:id/like)
 */
async function runPhase5GlobalStressTest() {
  console.log('================================================================');
  console.log('🚀 Starting Phase 5 Global Multi-Vector Production Stress Test');
  console.log('================================================================');
  console.log('Traffic Distribution:');
  console.log('  40% Pre-Signed Media Generation');
  console.log('  10% JSON Post Creation & Async Redis Stream Publishing');
  console.log('  40% Hybrid Celebrity/Normal Timeline Feed Reads');
  console.log('  10% Atomic Engagement Likes');
  console.log('Concurrency: 50 connections | Duration: 20 seconds\n');

  // Weighted requests array (10 items = 40% / 10% / 40% / 10%)
  const requests = [
    // 1. [40% - 1/4] Pre-sign upload
    {
      method: 'POST',
      path: '/api/v1/posts/presign-upload',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': '1',
      },
      body: JSON.stringify({ filename: 'photo1.jpg', file_type: 'image/jpeg' }),
    },
    // 2. [40% - 1/4] Feed Read (Alice)
    {
      method: 'GET',
      path: '/api/v1/feed?page=1&limit=10',
      headers: { 'x-user-id': '1' },
    },
    // 3. [40% - 2/4] Pre-sign upload
    {
      method: 'POST',
      path: '/api/v1/posts/presign-upload',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': '2',
      },
      body: JSON.stringify({ filename: 'video1.mp4', file_type: 'video/mp4' }),
    },
    // 4. [10% - 1/1] Post Creation (Async Event Queuing)
    {
      method: 'POST',
      path: '/api/v1/posts',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': '2',
      },
      body: JSON.stringify({
        caption: 'Global Stress Test post created under high concurrency!',
        media: [
          {
            media_url: '/uploads/dummy-test.jpg',
            media_type: 'PHOTO',
          },
        ],
      }),
    },
    // 5. [40% - 2/4] Feed Read (Bob)
    {
      method: 'GET',
      path: '/api/v1/feed?page=1&limit=10',
      headers: { 'x-user-id': '2' },
    },
    // 6. [40% - 3/4] Pre-sign upload
    {
      method: 'POST',
      path: '/api/v1/posts/presign-upload',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': '1',
      },
      body: JSON.stringify({ filename: 'carousel_item.png', file_type: 'image/png' }),
    },
    // 7. [10% - 1/1] Engagement Like (Atomic Increment)
    {
      method: 'POST',
      path: '/api/v1/posts/1/like',
      headers: { 'x-user-id': '1' },
    },
    // 8. [40% - 3/4] Feed Read (Alice Page 2)
    {
      method: 'GET',
      path: '/api/v1/feed?page=2&limit=10',
      headers: { 'x-user-id': '1' },
    },
    // 9. [40% - 4/4] Pre-sign upload
    {
      method: 'POST',
      path: '/api/v1/posts/presign-upload',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': '2',
      },
      body: JSON.stringify({ filename: 'story.jpg', file_type: 'image/jpeg' }),
    },
    // 10. [40% - 4/4] Feed Read (Alice Hybrid Feed)
    {
      method: 'GET',
      path: '/api/v1/feed?page=1&limit=10',
      headers: { 'x-user-id': '1' },
    },
  ];

  const instance = autocannon({
    url: 'http://localhost:3000',
    connections: 50,
    duration: 20,
    requests,
  });

  autocannon.track(instance, { renderProgressBar: true });

  instance.on('done', (result) => {
    console.log('\n================================================================');
    console.log('📊 Phase 5 Global Stress-Test Completed!');
    console.log('================================================================');
    console.log(`Requests/sec:          ${result.requests.average}`);
    console.log(`Latency (average):     ${result.latency.average} ms`);
    console.log(`Latency (p99):         ${result.latency.p99} ms`);
    console.log(`Total Requests:        ${result.requests.total}`);
    console.log(`Successful 2xx:        ${result['2xx']}`);
    console.log(`Non-2xx / Errors:      ${result.non2xx + result.errors + result.timeouts}`);
    console.log('================================================================\n');
  });
}

runPhase5GlobalStressTest();
