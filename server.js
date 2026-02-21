'use strict';

/**
 * server.js
 * Digital Girvi — main Express application entry point.
 *
 * Responsibilities:
 *   - Load environment variables
 *   - Configure all middleware (security, logging, parsing, rate-limiting)
 *   - Mount all API routes
 *   - Serve static frontend
 *   - Start HTTP server with graceful shutdown
 */

// ── 1. Environment ───────────────────────────────────────────────
require('dotenv').config();

// ── 2. Core dependencies ─────────────────────────────────────────
const express      = require('express');
const path         = require('path');
const fs           = require('fs');
const http         = require('http');
const cors         = require('cors');
const helmet       = require('helmet');
const compression  = require('compression');
const cookieParser = require('cookie-parser');
const morgan       = require('morgan');
const rateLimit    = require('express-rate-limit');

// ── 3. Internal modules ──────────────────────────────────────────
const logger       = require('./logger');
const db           = require('./db');
const { notFound, errorHandler } = require('./errorHandler');
const { pruneExpiredTokens }     = require('./jwt');

// ── 4. Route modules ─────────────────────────────────────────────
const authRoutes      = require('./routes/auth.routes');
const customerRoutes  = require('./routes/customer.routes');
const loanRoutes      = require('./routes/loan.routes');
const paymentRoutes   = require('./routes/payment.routes');
const dashboardRoutes = require('./routes/dashboard.routes');
const settingsRoutes  = require('./routes/settings.routes');

// ── 5. Validate critical env vars before starting ────────────────
const REQUIRED_ENV = [
  'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET',
  'ENCRYPTION_KEY',
  'DB_NAME', 'DB_USER', 'DB_PASSWORD',
];
const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missingEnv.length) {
  logger.error(`Missing required environment variables: ${missingEnv.join(', ')}`);
  logger.error('Copy .env.example to .env and fill in all values.');
  process.exit(1);
}

// ── 6. Create Express app ────────────────────────────────────────
const app  = express();
const PORT = parseInt(process.env.PORT || '5000', 10);

// ── 7. Trust proxy (for correct IP behind Nginx / load balancer) ─
app.set('trust proxy', 1);

// ── 8. Security headers (Helmet) ─────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'"],   // adjust for your frontend build
      styleSrc:    ["'self'", "'unsafe-inline'"],
      imgSrc:      ["'self'", 'data:', 'blob:'],
      connectSrc:  ["'self'"],
      fontSrc:     ["'self'"],
      objectSrc:   ["'none'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,   // Required for some PDF/image previews
}));

// ── 9. CORS ──────────────────────────────────────────────────────
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5000')
  .split(',').map((o) => o.trim());

app.use(cors({
  origin: (origin, cb) => {
    // Allow server-to-server (no origin) and whitelisted origins
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin '${origin}' is not allowed`));
  },
  credentials:      true,
  methods:          ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders:   ['Content-Type', 'Authorization'],
  exposedHeaders:   ['X-Total-Count'],
}));

// ── 10. Global rate limiter ──────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
  max:      parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
  message:  { success: false, error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders:   false,
  skip: (req) => req.path === '/health',   // Never rate-limit health checks
});
app.use('/api/', globalLimiter);

// ── 11. Body parsing ─────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(cookieParser(process.env.COOKIE_SECRET));

// ── 12. Compression ──────────────────────────────────────────────
app.use(compression());

// ── 13. HTTP request logging ─────────────────────────────────────
const morganFormat = process.env.NODE_ENV === 'production' ? 'combined' : 'dev';
app.use(morgan(morganFormat, {
  stream: { write: (msg) => logger.http(msg.trim()) },
  skip:   (req) => req.path === '/health',
}));

// ── 14. File upload directory ────────────────────────────────────
const uploadDir = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
  logger.info(`Upload directory created: ${uploadDir}`);
}

// ── 15. Static file serving ──────────────────────────────────────
// Serve uploaded files (photos, documents)
app.use('/uploads', express.static(path.resolve(uploadDir), {
  maxAge: '1d',
  etag:   true,
}));

// Serve frontend static assets
const publicDir = path.join(__dirname, 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir, { maxAge: '1h', etag: true }));
}

// ── 16. Health check ─────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    const dbHealth = await db.healthCheck();
    return res.status(200).json({
      status:    'ok',
      app:       'Digital Girvi',
      version:   process.env.npm_package_version || '1.0.0',
      env:       process.env.NODE_ENV || 'development',
      database:  dbHealth,
      uptime:    Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(503).json({
      status:  'degraded',
      error:   'Database unreachable',
      uptime:  Math.floor(process.uptime()),
    });
  }
});

// ── 17. API Routes ───────────────────────────────────────────────
app.use('/api/auth',      authRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/loans',     loanRoutes);
app.use('/api/payments',  paymentRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/settings',  settingsRoutes);

// ── 18. SPA fallback ─────────────────────────────────────────────
// For any non-API route, serve index.html so the frontend router works
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) {
    return next();
  }
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  return next();
});

// ── 19. Error handling (must be last) ────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ── 20. Start server ─────────────────────────────────────────────
const server = http.createServer(app);

const start = async () => {
  // Verify DB connectivity before accepting traffic
  try {
    logger.info('Checking database connectivity...');
    await db.healthCheck();
    logger.info('Database connection verified ✅');
  } catch (err) {
    logger.error('Cannot connect to database. Aborting startup.', { error: err.message });
    process.exit(1);
  }

  server.listen(PORT, () => {
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info(`🏦  Digital Girvi server started`);
    logger.info(`🌍  Environment : ${process.env.NODE_ENV || 'development'}`);
    logger.info(`🚀  Listening on: http://localhost:${PORT}`);
    logger.info(`🩺  Health check: http://localhost:${PORT}/health`);
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  });

  // ── 21. Scheduled jobs ────────────────────────────────────────
  // Prune expired refresh tokens daily at 03:00
  scheduleDaily('03:00', async () => {
    try {
      const pruned = await pruneExpiredTokens();
      logger.info(`Scheduled job: pruned ${pruned} expired refresh tokens`);
    } catch (err) {
      logger.error('Scheduled job failed: pruneExpiredTokens', { error: err.message });
    }
  });
};

// ── 22. Graceful shutdown ─────────────────────────────────────────
const shutdown = async (signal) => {
  logger.info(`${signal} received — shutting down gracefully...`);

  server.close(async () => {
    logger.info('HTTP server closed');
    try {
      await db.close();
      logger.info('Database pool closed');
    } catch (err) {
      logger.error('Error closing DB pool', { error: err.message });
    }
    logger.info('Shutdown complete. Goodbye.');
    process.exit(0);
  });

  // Force exit if graceful shutdown hangs
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10_000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── 23. Unhandled rejections / exceptions ────────────────────────
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise Rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack:  reason instanceof Error ? reason.stack   : undefined,
  });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception — process will exit', {
    error: err.message, stack: err.stack,
  });
  shutdown('uncaughtException');
});

// ── Helper: simple daily scheduler ───────────────────────────────
function scheduleDaily(timeStr, fn) {
  const [hh, mm] = timeStr.split(':').map(Number);
  const msUntilNext = () => {
    const now  = new Date();
    const next = new Date();
    next.setHours(hh, mm, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next - now;
  };
  const schedule = () => setTimeout(async () => { await fn(); schedule(); }, msUntilNext());
  schedule();
}

// ── Boot ─────────────────────────────────────────────────────────
start();

module.exports = app;   // For testing with supertest
