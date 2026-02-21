'use strict';

// Load environment variables
require('dotenv').config();

const express      = require('express');
const path         = require('path');
const cors         = require('cors');
const helmet       = require('helmet');
const compression  = require('compression');
const morgan       = require('morgan');
const cookieParser = require('cookie-parser');

// Internal project dependencies
const logger       = require('./logger');
const db           = require('./db');
const { errorHandler, notFound } = require('./errorHandler');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// 1. GLOBAL MIDDLEWARE
// ==========================================
// Helmet secures your app by setting various HTTP headers
app.use(helmet({
  contentSecurityPolicy: false, // Set to false to allow your local styles and scripts to load
}));

// Enable CORS for frontend-backend communication
app.use(cors({
  origin: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : '*',
  credentials: true
}));

app.use(compression()); // Compress all responses for speed
app.use(express.json()); // Support JSON-encoded bodies
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser()); // Parse cookies for your refresh tokens

// Log every request to the terminal and log files
app.use(morgan('combined', { 
  stream: { write: (message) => logger.info(message.trim()) } 
}));

// ==========================================
// 2. STATIC FILES & FRONTEND (The Fix)
// ==========================================
// This line tells the server: "If you see a request for a file, look in the main folder"
app.use(express.static(path.join(__dirname, './')));

// This line specifically fixes the "GET /" error by sending your login page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Health check endpoint for the database and server
app.get('/health', async (req, res) => {
  try {
    const dbStatus = await db.healthCheck();
    res.json({ status: 'ok', database: dbStatus, timestamp: new Date() });
  } catch (err) {
    res.status(503).json({ status: 'error', message: err.message });
  }
});

// ==========================================
// 3. API ROUTES
// ==========================================
// These link to your 'routes' folder where the logic lives
app.use('/api/auth',      require('./routes/auth.routes'));
app.use('/api/customers',   require('./routes/customer.routes'));
app.use('/api/loans',       require('./routes/loan.routes'));
app.use('/api/payments',    require('./routes/payment.routes'));
app.use('/api/dashboard',   require('./routes/dashboard.routes'));
app.use('/api/settings',    require('./routes/settings.routes'));

// ==========================================
// 4. ERROR HANDLING
// ==========================================
// If a request hits a route that doesn't exist, show the 404
app.use(notFound);

// Central error handler for database or code crashes
app.use(errorHandler);

// ==========================================
// 5. SERVER STARTUP
// ==========================================
app.listen(PORT, () => {
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info(`🏦  Digital Girvi server is LIVE`);
  logger.info(`🚀  URL: http://localhost:${PORT}`);
  logger.info(`⚙️   Mode: ${process.env.NODE_ENV}`);
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});

module.exports = app;