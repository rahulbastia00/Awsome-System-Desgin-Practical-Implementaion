require('dotenv').config();
const cluster = require('node:cluster');
const os = require('node:os');
const express = require('express');
const urlRoutes = require('./routes/url.routes');
const prisma = require('./config/db');
const redis = require('./config/redis');
const { startAnalyticsFlusher, flushBufferedClicks } = require('./workers/analytics.flusher');
const { startCleanupWorker, cleanupExpiredLinks } = require('./workers/cleanup.worker');

const PORT = process.env.PORT || 9090;

// Balance CPU core allocation (cap at 4 for laptop resource friendliness)
const NUM_WORKERS = Math.min(os.cpus().length, 4);

// ============================================================================
// 1. PRIMARY (MASTER) PROCESS: Load balancer, worker supervisor & task runner
// ============================================================================
if (cluster.isPrimary) {
  console.log(`\n👑 Primary Master process ${process.pid} is running`);
  console.log(`⚙️  Detected ${os.cpus().length} CPUs. Forking ${NUM_WORKERS} worker processes...`);

  // Fork worker processes
  for (let i = 0; i < NUM_WORKERS; i++) {
    cluster.fork();
  }

  // Handle worker lifecycle events
  cluster.on('online', (worker) => {
    console.log(`🟢 Worker ${worker.process.pid} is online and accepting connections`);
  });

  cluster.on('exit', (worker, code, signal) => {
    console.warn(`⚠️ Worker ${worker.process.pid} died (code: ${code}, signal: ${signal}). Spawning replacement...`);
    cluster.fork();
  });

  // Background jobs run EXCLUSIVELY on the Primary process
  // This prevents multiple workers from duplicating scheduled database work
  const flusherTimer = startAnalyticsFlusher(prisma, redis, 10000);
  const cleanupTimer = startCleanupWorker(prisma, redis, 60000);

  // Graceful shutdown for Primary process
  async function gracefulPrimaryShutdown(signal) {
    console.log(`\n👑 Primary received ${signal}. Shutting down workers and background jobs...`);
    clearInterval(flusherTimer);
    clearInterval(cleanupTimer);

    // Terminate all worker processes
    for (const id in cluster.workers) {
      if (cluster.workers[id]) {
        cluster.workers[id].process.kill(signal);
      }
    }

    try {
      console.log('🔄 Performing final primary click flush...');
      await flushBufferedClicks(prisma, redis);
      await cleanupExpiredLinks(prisma, redis);
    } catch (err) {
      console.error('Error during final cleanup on primary:', err.message);
    }

    try {
      await redis.quit();
      await prisma.$disconnect();
    } catch (err) {
      console.error('Error disconnecting resources on primary:', err.message);
    }

    console.log('✅ Primary shutdown complete.');
    process.exit(0);
  }

  process.on('SIGINT', () => gracefulPrimaryShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulPrimaryShutdown('SIGTERM'));

} else {
  // ============================================================================
  // 2. WORKER PROCESSES: Stateless HTTP request handling
  // ============================================================================
  const app = express();

  // Middleware for parsing JSON bodies
  app.use(express.json());

  // Health check & root endpoints
  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'ok',
      workerPid: process.pid,
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/', (req, res) => {
    res.status(200).json({
      message: 'Welcome to the Production URL Shortener API (Clustered & Redis-Accelerated)',
      workerPid: process.pid,
      endpoints: {
        health: 'GET /health',
        shorten: 'POST /shorten',
        redirect: 'GET /:short_code',
        analytics: 'GET /analytics/:short_code',
      },
    });
  });

  // Mount application routes
  app.use('/', urlRoutes);

  // Centralized error handling
  app.use((err, req, res, next) => {
    console.error(`[Worker ${process.pid}] Unhandled Application Error:`, err);
    res.status(500).json({
      error: 'Internal Server Error',
      message: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  });

  // All workers share the same TCP port via OS round-robin load distribution
  const server = app.listen(PORT, () => {
    console.log(`🚀 Worker ${process.pid} listening on port ${PORT}`);
  });

  // Graceful shutdown per worker
  async function gracefulWorkerShutdown(signal) {
    console.log(`[Worker ${process.pid}] Received ${signal}. Closing HTTP listener...`);
    server.close(async () => {
      try {
        await prisma.$disconnect();
      } catch (e) {
        // Ignore disconnect errors during teardown
      }
      process.exit(0);
    });
  }

  process.on('SIGINT', () => gracefulWorkerShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulWorkerShutdown('SIGTERM'));
}
