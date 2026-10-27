const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');

// Registration helper
router.post('/', userController.createUser);

// Search endpoint (/api/v1/users/search?q=...)
router.get('/search', userController.searchUsers);

// Profile endpoint (/api/v1/users/:user_id)
router.get('/:user_id', userController.getUserProfile);

// Follow endpoint (/api/v1/users/:user_id/follow)
router.post('/:user_id/follow', userController.followUser);

module.exports = router;
