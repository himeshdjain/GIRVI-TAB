'use strict';

/**
 * db.js
 * PostgreSQL connection pool using node-postgres (pg).
 * All database interactions should use the `query` helper or
 * acquire a client via `getClient()` for transactions.
 */

const { Pool } = require('pg');
const logger   = require('./logger');

// ----------------------------------------------------------------
// Pool configuration
// ----------------------------------------------------------------
const poolConfig = {
  host:               process.env.DB_HOST     || 'localhost',
  port:               parseInt(process.env.DB_PORT || '5432', 10),
  database:           process.env.DB_NAME     || 'digital_girvi',
  user:               process.env.DB_USER     || 'postgres',
  password:           process.env.DB_PASSWORD || '',
  max:                parseInt(process.env.DB_POOL_MAX               || '10',   10),
  idleTimeoutMillis:  parseInt(process.env.DB_POOL_IDLE_TIMEOUT_MS   || '30000', 10),
  connectionTimeoutMillis: parseInt(process.env.DB_POOL_CONNECTION_TIMEOUT_MS || '2000', 10),
  ssl: process.env.DB_SSL === 'true'
    ? { rejectUnauthorized: false }
    : false,
};

const pool = new Pool(poolConfig);

// ----------------------------------------------------------------
// Pool-level event handlers
// ----------------------------------------------------------------
pool.on('connect', (client) => {
  logger.debug('DB pool: new client connected');
  // Enforce UTC for every session
  client.query("SET timezone = 'UTC'").catch((err) =>
    logger.error('DB pool: failed to set timezone', { error: err.message })
  );
});

pool.on('error', (err) => {
  logger.error('DB pool: unexpected error on idle client', { error: err.message });
  // Do NOT call process.exit here — let the app handle graceful shutdown
});

// ----------------------------------------------------------------
// Simple query helper
// Automatically checks out and releases a client.
// Usage:  const { rows } = await db.query(sql, [params]);
// ----------------------------------------------------------------
const query = async (text, params) => {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    logger.debug('DB query executed', {
      query:    text.substring(0, 120),
      duration: `${duration}ms`,
      rows:     result.rowCount,
    });
    return result;
  } catch (err) {
    logger.error('DB query error', {
      query: text.substring(0, 120),
      error: err.message,
      code:  err.code,
    });
    throw err;
  }
};

// ----------------------------------------------------------------
// Transaction helper
// Checks out a dedicated client. Caller MUST call client.release().
// Usage:
//   const client = await db.getClient();
//   try {
//     await client.query('BEGIN');
//     ...
//     await client.query('COMMIT');
//   } catch (e) {
//     await client.query('ROLLBACK');
//     throw e;
//   } finally {
//     client.release();
//   }
// ----------------------------------------------------------------
const getClient = () => pool.connect();

// ----------------------------------------------------------------
// Convenience: run a function inside a transaction automatically.
// Usage:
//   const result = await db.withTransaction(async (client) => {
//     const { rows } = await client.query(...);
//     return rows;
//   });
// ----------------------------------------------------------------
const withTransaction = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// ----------------------------------------------------------------
// Health-check: verifies the pool can reach the database.
// Used by the /health endpoint and startup checks.
// ----------------------------------------------------------------
const healthCheck = async () => {
  const { rows } = await query('SELECT NOW() AS now, current_database() AS db');
  return {
    status:   'ok',
    database: rows[0].db,
    time:     rows[0].now,
  };
};

// ----------------------------------------------------------------
// Graceful shutdown — call this in SIGINT / SIGTERM handlers.
// ----------------------------------------------------------------
const close = async () => {
  logger.info('DB pool: closing all connections...');
  await pool.end();
  logger.info('DB pool: all connections closed');
};

module.exports = {
  query,
  getClient,
  withTransaction,
  healthCheck,
  close,
  // Expose pool directly for edge cases (e.g. streaming large result sets)
  pool,
};
