const express = require('express');
const router = express.Router();
const postController = require('../controllers/postController');
const userController = require('../controllers/userController');

// 3. POST /api/v1/posts (Accepts up to 10 files under 'media' field name)
router.post('/posts', postController.upload.array('media', 10), postController.createPost);

// 4. GET /api/v1/feed?page=1&limit=10
router.get('/feed', postController.getFeed);

// 8. GET /api/v1/search/users?q={query}
router.get('/search/users', userController.searchUsers);

module.exports = router;
