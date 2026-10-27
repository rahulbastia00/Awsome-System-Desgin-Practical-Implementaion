const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// Patch BigInt so JSON.stringify() doesn't throw a TypeError
BigInt.prototype.toJSON = function () {
    return this.toString();
};

const app = express();

// Ensure local uploads directory exists
const uploadDir = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Global Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve uploaded media files statically (Phase 1 local storage)
app.use('/uploads', express.static(path.resolve(uploadDir)));

// Health Check Route
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Route Registration
const userRoutes = require('./routes/users');
const postRoutes = require('./routes/posts');
const engagementRoutes = require('./routes/engagement');

app.use('/api/v1/users', userRoutes);
app.use('/api/v1', postRoutes);           // handles /api/v1/posts, /api/v1/feed, /api/v1/search
app.use('/api/v1', engagementRoutes);     // handles /api/v1/posts/:post_id/like, comments

// 404 Route Handler
app.use((req, res, next) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Centralized Error Handling Middleware
app.use((err, req, res, next) => {
    console.error('[Error Middleware]:', err);

    // Handle Multer upload errors
    if (err.name === 'MulterError') {
        return res.status(400).json({ error: `File upload error: ${err.message}` });
    }

    // Handle Prisma known request errors (e.g., unique constraint violation)
    if (err.code === 'P2002') {
        return res.status(409).json({
            error: `Conflict: Unique constraint failed on field(s): ${err.meta?.target || 'unknown'}`,
        });
    }

    if (err.code === 'P2025') {
        return res.status(404).json({ error: 'Record not found' });
    }

    const statusCode = err.status || 500;
    res.status(statusCode).json({
        error: err.message || 'Internal Server Error',
    });
});

module.exports = app;
