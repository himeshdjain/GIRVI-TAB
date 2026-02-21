'use strict';

/**
 * jwt.js
 * JWT utilities for Digital Girvi.
 *
 * Access tokens  — short-lived (default 15m), sent in Authorization header.
 * Refresh tokens — long-lived (default 7d), sent in HttpOnly cookie,
 *                  stored as SHA-256 hash in the refresh_tokens table.
 *
 * Payload shape:
 *   { sub: userId, username, role, iat, exp }
 */

const jwt        = require('jsonwebtoken');
const { hashToken, generateSecureToken } = require('./utils/encryption');
const db         = require('./db');
const logger     = require('./utils/logger');

// ----------------------------------------------------------------
// Secrets & expiry from environment
// ----------------------------------------------------------------
const ACCESS_SECRET   = () => {
  const s = process.env.JWT_ACCESS_SECRET;
  if (!s) throw new Error('JWT_ACCESS_SECRET is not set');
  return s;
};
const REFRESH_SECRET  = () => {
  const s = process.env.JWT_REFRESH_SECRET;
  if (!s) throw new Error('JWT_REFRESH_SECRET is not set');
  return s;
};
const ACCESS_EXPIRY   = process.env.JWT_ACCESS_EXPIRY  || '15m';
const REFRESH_EXPIRY  = process.env.JWT_REFRESH_EXPIRY || '7d';

// ----------------------------------------------------------------
// signAccessToken(payload) → signed JWT string
// payload should include: { sub, username, role }
// ----------------------------------------------------------------
const signAccessToken = (payload) =>
  jwt.sign(payload, ACCESS_SECRET(), {
    expiresIn:  ACCESS_EXPIRY,
    algorithm:  'HS256',
    issuer:     'digital-girvi',
    audience:   'digital-girvi-client',
  });

// ----------------------------------------------------------------
// verifyAccessToken(token) → decoded payload | throws
// ----------------------------------------------------------------
const verifyAccessToken = (token) =>
  jwt.verify(token, ACCESS_SECRET(), {
    algorithms: ['HS256'],
    issuer:     'digital-girvi',
    audience:   'digital-girvi-client',
  });

// ----------------------------------------------------------------
// signRefreshToken() → raw random token string (NOT a JWT)
// We use a random opaque token to avoid leaking expiry info and
// to allow server-side revocation without JWT overhead.
// ----------------------------------------------------------------
const signRefreshToken = () => generateSecureToken(40);

// ----------------------------------------------------------------
// storeRefreshToken({ userId, rawToken, ipAddress, userAgent })
// Hashes and stores the refresh token in the DB.
// ----------------------------------------------------------------
const storeRefreshToken = async ({ userId, rawToken, ipAddress, userAgent }) => {
  const tokenHash  = hashToken(rawToken);
  const expiresAt  = new Date(Date.now() + parseExpiry(REFRESH_EXPIRY));

  await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, tokenHash, expiresAt, ipAddress || null, userAgent || null]
  );
};

// ----------------------------------------------------------------
// validateRefreshToken(rawToken) → { userId, tokenRow } | null
// Verifies the token exists in DB, is not revoked, and not expired.
// ----------------------------------------------------------------
const validateRefreshToken = async (rawToken) => {
  if (!rawToken) return null;
  const tokenHash = hashToken(rawToken);
  const { rows } = await db.query(
    `SELECT rt.*, u.is_active, u.role, u.username
     FROM refresh_tokens rt
     JOIN users u ON u.id = rt.user_id
     WHERE rt.token_hash = $1
       AND rt.revoked = FALSE
       AND rt.expires_at > NOW()`,
    [tokenHash]
  );
  if (!rows.length) return null;
  const row = rows[0];
  if (!row.is_active) return null;
  return { userId: row.user_id, tokenRow: row };
};

// ----------------------------------------------------------------
// revokeRefreshToken(rawToken)
// Marks a single refresh token as revoked.
// ----------------------------------------------------------------
const revokeRefreshToken = async (rawToken) => {
  if (!rawToken) return;
  const tokenHash = hashToken(rawToken);
  await db.query(
    `UPDATE refresh_tokens SET revoked = TRUE WHERE token_hash = $1`,
    [tokenHash]
  );
};

// ----------------------------------------------------------------
// revokeAllUserTokens(userId)
// Revoke all refresh tokens for a user (e.g. password change, account lock).
// ----------------------------------------------------------------
const revokeAllUserTokens = async (userId) => {
  await db.query(
    `UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1 AND revoked = FALSE`,
    [userId]
  );
};

// ----------------------------------------------------------------
// pruneExpiredTokens()
// Housekeeping — delete old revoked/expired tokens.
// Call from a scheduled job (e.g. daily).
// ----------------------------------------------------------------
const pruneExpiredTokens = async () => {
  const { rowCount } = await db.query(
    `DELETE FROM refresh_tokens WHERE expires_at < NOW() OR revoked = TRUE`
  );
  logger.info(`JWT: pruned ${rowCount} expired/revoked refresh tokens`);
  return rowCount;
};

// ----------------------------------------------------------------
// setRefreshCookie(res, rawToken)
// Writes the refresh token into a secure HttpOnly cookie.
// ----------------------------------------------------------------
const COOKIE_NAME = 'girvi_rt';

const setRefreshCookie = (res, rawToken) => {
  const maxAgeMs = parseExpiry(REFRESH_EXPIRY);
  res.cookie(COOKIE_NAME, rawToken, {
    httpOnly:  true,
    secure:    process.env.COOKIE_SECURE === 'true',
    sameSite:  process.env.COOKIE_SAME_SITE || 'lax',
    maxAge:    maxAgeMs,
    path:      '/api/auth',  // Only sent to auth endpoints
  });
};

// ----------------------------------------------------------------
// clearRefreshCookie(res)
// ----------------------------------------------------------------
const clearRefreshCookie = (res) => {
  res.clearCookie(COOKIE_NAME, { path: '/api/auth' });
};

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

/**
 * parseExpiry('15m' | '7d' | '1h') → milliseconds
 */
const parseExpiry = (expiry) => {
  const unit  = expiry.slice(-1);
  const value = parseInt(expiry.slice(0, -1), 10);
  const map   = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  if (!map[unit]) throw new Error(`Unsupported expiry unit: ${unit}`);
  return value * map[unit];
};

/**
 * extractBearerToken(req) → raw token string | null
 */
const extractBearerToken = (req) => {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  return auth.slice(7).trim() || null;
};

module.exports = {
  signAccessToken,
  verifyAccessToken,
  signRefreshToken,
  storeRefreshToken,
  validateRefreshToken,
  revokeRefreshToken,
  revokeAllUserTokens,
  pruneExpiredTokens,
  setRefreshCookie,
  clearRefreshCookie,
  extractBearerToken,
  COOKIE_NAME,
  ACCESS_EXPIRY,
  REFRESH_EXPIRY,
};
