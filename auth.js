'use strict';

/**
 * auth.js
 * Express middleware for JWT-based route protection and role-based access control.
 */

const { verifyAccessToken, extractBearerToken } = require('./jwt');
const db     = require('./db');
const logger = require('./logger');

// ----------------------------------------------------------------
// authenticate — verifies Bearer token, attaches req.user
// ----------------------------------------------------------------
const authenticate = async (req, res, next) => {
  try {
    const token = extractBearerToken(req);
    if (!token) {
      return res.status(401).json({ success: false, error: 'Authentication required. Please provide a valid Bearer token.' });
    }

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch (err) {
      const message = err.name === 'TokenExpiredError'
        ? 'Your session has expired. Please log in again.'
        : 'Invalid or malformed token.';
      return res.status(401).json({ success: false, error: message, code: err.name });
    }

    const { rows } = await db.query(
      `SELECT id, username, email, full_name, role, is_active, totp_enabled, locked_until
       FROM users WHERE id = $1`,
      [payload.sub]
    );

    if (!rows.length) {
      return res.status(401).json({ success: false, error: 'User account not found.' });
    }

    const user = rows[0];

    if (!user.is_active) {
      return res.status(401).json({ success: false, error: 'Your account has been deactivated. Contact an administrator.' });
    }

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      return res.status(423).json({
        success: false,
        error:   'Account is temporarily locked due to too many failed login attempts.',
        lockedUntil: user.locked_until,
      });
    }

    req.user = {
      id:          user.id,
      username:    user.username,
      email:       user.email,
      fullName:    user.full_name,
      role:        user.role,
      totpEnabled: user.totp_enabled,
    };

    return next();
  } catch (err) {
    logger.error('auth.authenticate error', { error: err.message, stack: err.stack });
    return next(err);
  }
};

// ----------------------------------------------------------------
// authorize(...roles) — role-based access control (use after authenticate)
// ----------------------------------------------------------------
const authorize = (...roles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, error: 'Not authenticated.' });
  }
  if (!roles.includes(req.user.role)) {
    logger.warn('auth.authorize: access denied', {
      userId: req.user.id, userRole: req.user.role, required: roles, path: req.originalUrl,
    });
    return res.status(403).json({
      success: false,
      error:   `Access denied. Required role(s): ${roles.join(', ')}.`,
    });
  }
  return next();
};

// ----------------------------------------------------------------
// optionalAuth — attaches req.user if token present, never blocks
// ----------------------------------------------------------------
const optionalAuth = async (req, res, next) => {
  const token = extractBearerToken(req);
  if (!token) return next();
  try {
    const payload = verifyAccessToken(token);
    const { rows } = await db.query(
      `SELECT id, username, email, full_name, role, is_active FROM users WHERE id = $1`,
      [payload.sub]
    );
    if (rows.length && rows[0].is_active) {
      const u = rows[0];
      req.user = { id: u.id, username: u.username, email: u.email, fullName: u.full_name, role: u.role };
    }
  } catch { /* silent */ }
  return next();
};

// ----------------------------------------------------------------
// requireTwoFactor — blocks if 2FA is enabled but not yet verified in token
// ----------------------------------------------------------------
const requireTwoFactor = (req, res, next) => {
  if (!req.user) return res.status(401).json({ success: false, error: 'Not authenticated.' });
  const require2fa = process.env.REQUIRE_2FA === 'true';
  if (!require2fa && !req.user.totpEnabled) return next();
  const token = extractBearerToken(req);
  if (!token) return res.status(401).json({ success: false, error: 'Not authenticated.' });
  let payload;
  try { payload = verifyAccessToken(token); } catch { return next(); }
  if (req.user.totpEnabled && !payload.twoFactorVerified) {
    return res.status(403).json({ success: false, error: 'Two-factor authentication required.', code: '2FA_REQUIRED' });
  }
  return next();
};

// ----------------------------------------------------------------
// isSelf — user can only access their own resource (admin exempt)
// ----------------------------------------------------------------
const isSelf = (paramName = 'userId') => (req, res, next) => {
  if (!req.user) return res.status(401).json({ success: false, error: 'Not authenticated.' });
  if (req.user.role === 'admin') return next();
  if (req.user.id === req.params[paramName]) return next();
  return res.status(403).json({ success: false, error: 'You can only access your own resources.' });
};

// Role shorthands
const adminOnly   = authorize('admin');
const managerPlus = authorize('admin', 'manager');
const staffPlus   = authorize('admin', 'manager', 'staff');

module.exports = { authenticate, authorize, optionalAuth, requireTwoFactor, isSelf, adminOnly, managerPlus, staffPlus };
