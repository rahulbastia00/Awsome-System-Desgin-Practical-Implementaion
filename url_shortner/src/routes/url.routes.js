const express = require('express');
const router = express.Router();
const { shortenUrl, redirectUrl, getAnalytics } = require('../controllers/url.controller');

// 1. Creation endpoint
router.post('/shorten', shortenUrl);

// 2. Analytics endpoint (declared BEFORE /:short_code to prevent route collision)
router.get('/analytics/:short_code', getAnalytics);

// 3. Redirection endpoint
router.get('/:short_code', redirectUrl);

module.exports = router;
