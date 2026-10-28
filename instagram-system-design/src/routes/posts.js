const express = require('express');
const router = express.Router();
const postController = require('../controllers/postController');
const userController = require('../controllers/userController');

// ----------------------------------------------------
// Phase 2: Object Storage Separation Routes
// ----------------------------------------------------

// 1. Step 1: POST /api/v1/posts/presign-upload
// Generates a pre-signed token & upload URL for direct local object storage upload
router.post('/posts/presign-upload', postController.getPresignedUpload);

// Step 1b: Direct Binary Upload Receiver (supports PUT or POST raw stream)
router.put('/posts/upload/:token', postController.uploadMediaBinary);
router.post('/posts/upload/:token', postController.uploadMediaBinary);

// 2. Step 2: POST /api/v1/posts
// Accepts lightweight JSON metadata (caption + media_url from step 1) and saves to PostgreSQL
router.post('/posts', postController.createPost);

// ----------------------------------------------------
// Feed & User Search
// ----------------------------------------------------

// 4. GET /api/v1/feed?page=1&limit=10
router.get('/feed', postController.getFeed);

// 8. GET /api/v1/search/users?q={query}
router.get('/search/users', userController.searchUsers);

module.exports = router;
