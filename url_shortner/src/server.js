require('dotenv').config();
const express = require('express');
const urlRoutes = require('./routes/url.routes');
const prisma = require('./config/db');
const redis = require('./config/redis');
const { startAnalyticsFlusher, flushBufferedClicks } = require('./workers/analytics.flusher');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware for parsing JSON request bodies
app.use(express.json());

// 1. Health check & system endpoints MUST go BEFORE wildcard /:short_code
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.status(200).json({
    message: 'Welcome to the URL Shortener API (Redis-Accelerated)',
    endpoints: {
      health: 'GET /health',
      shorten: 'POST /shorten',
      redirect: 'GET /:short_code',
      analytics: 'GET /analytics/:short_code',
    },
  });
});

// 2. Mount URL Shortener routes (contains the wildcard /:short_code)
app.use('/', urlRoutes);

// Centralized error-handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled Application Error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

// Start background flusher worker (flushes buffered Redis clicks every 10 seconds)
const flusherTimer = startAnalyticsFlusher(prisma, redis, 10000);

// Start HTTP server
const server = app.listen(PORT, () => {
  console.log(`🚀 URL Shortener Service running on port ${PORT}`);
  console.log(`📡 Base URL: ${process.env.BASE_URL || `http://localhost:${PORT}`}`);
});

// Graceful shutdown handling
async function gracefulShutdown(signal) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  clearInterval(flusherTimer);

  server.close(async () => {
    try {
      console.log('🔄 Performing final click buffer flush to database...');
      await flushBufferedClicks(prisma, redis);
    } catch (e) {
      console.error('Error during final flush:', e.message);
    }

    try {
      await redis.quit();
      console.log('⚡ Redis connection closed.');
    } catch (e) {
      console.error('Error closing Redis:', e.message);
    }

    try {
      await prisma.$disconnect();
      console.log('🐘 PostgreSQL pool closed.');
    } catch (e) {
      console.error('Error closing Prisma:', e.message);
    }

    console.log('✅ Shutdown complete. Process exiting.');
    process.exit(0);
  });
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
