const express = require('express');
const router = express.Router();
const engagementController = require('../controllers/engagementController');

// 5. POST /api/v1/posts/:post_id/like
router.post('/posts/:post_id/like', engagementController.likePost);

// 6. POST /api/v1/posts/:post_id/comment
router.post('/posts/:post_id/comment', engagementController.addComment);

// 7. GET /api/v1/posts/:post_id/comments?page=1&limit=10
router.get('/posts/:post_id/comments', engagementController.getPostComments);

module.exports = router;
