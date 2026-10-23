const { PrismaClient } = require('@prisma/client');

// Global singleton instance for connection reuse across the app
const prisma = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'warn', 'error'] : ['error'],
});

module.exports = prisma;
