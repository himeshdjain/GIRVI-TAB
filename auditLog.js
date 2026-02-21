'use strict';

/**
 * auditLog.js
 * Audit logging for Digital Girvi.
 *
 * Writes every significant action to the `audit_logs` table.
 * Provides:
 *   log(entry)              — direct async insert (use in controllers)
 *   auditMiddleware(action) — Express middleware wrapper for route-level logging
 *   ACTIONS                 — Centralised action name constants
 */

const db     = require('./db');
const logger = require('./utils/logger');

// ----------------------------------------------------------------
// Action constants — use these everywhere to avoid typos
// ----------------------------------------------------------------
const ACTIONS = {
  // Auth
  LOGIN_SUCCESS:         'LOGIN_SUCCESS',
  LOGIN_FAILED:          'LOGIN_FAILED',
  LOGOUT:                'LOGOUT',
  TOKEN_REFRESHED:       'TOKEN_REFRESHED',
  PASSWORD_CHANGED:      'PASSWORD_CHANGED',
  TOTP_ENABLED:          'TOTP_ENABLED',
  TOTP_DISABLED:         'TOTP_DISABLED',
  TOTP_VERIFIED:         'TOTP_VERIFIED',
  ACCOUNT_LOCKED:        'ACCOUNT_LOCKED',
  ACCOUNT_UNLOCKED:      'ACCOUNT_UNLOCKED',

  // Users
  USER_CREATED:          'USER_CREATED',
  USER_UPDATED:          'USER_UPDATED',
  USER_DEACTIVATED:      'USER_DEACTIVATED',
  USER_REACTIVATED:      'USER_REACTIVATED',

  // Customers
  CUSTOMER_CREATED:      'CUSTOMER_CREATED',
  CUSTOMER_UPDATED:      'CUSTOMER_UPDATED',
  CUSTOMER_VIEWED:       'CUSTOMER_VIEWED',
  CUSTOMER_DEACTIVATED:  'CUSTOMER_DEACTIVATED',

  // Loans
  LOAN_CREATED:          'LOAN_CREATED',
  LOAN_UPDATED:          'LOAN_UPDATED',
  LOAN_CLOSED:           'LOAN_CLOSED',
  LOAN_DEFAULTED:        'LOAN_DEFAULTED',
  LOAN_RENEWED:          'LOAN_RENEWED',
  LOAN_AUCTIONED:        'LOAN_AUCTIONED',
  LOAN_VIEWED:           'LOAN_VIEWED',

  // Payments
  PAYMENT_CREATED:       'PAYMENT_CREATED',
  PAYMENT_VOIDED:        'PAYMENT_VOIDED',

  // Gold items
  GOLD_ITEM_ADDED:       'GOLD_ITEM_ADDED',
  GOLD_ITEM_RETURNED:    'GOLD_ITEM_RETURNED',

  // Gold rates
  GOLD_RATE_ADDED:       'GOLD_RATE_ADDED',

  // Settings
  SETTINGS_UPDATED:      'SETTINGS_UPDATED',

  // Reports
  REPORT_GENERATED:      'REPORT_GENERATED',
  REPORT_EXPORTED:       'REPORT_EXPORTED',
};

// ----------------------------------------------------------------
// getClientIp — extracts real IP accounting for proxies
// ----------------------------------------------------------------
const getClientIp = (req) => {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.ip || req.connection?.remoteAddress || null;
};

// ----------------------------------------------------------------
// log(entry) — insert one audit record
//
// entry: {
//   userId?:     UUID string  (null for anonymous actions like failed logins)
//   action:      string       (use ACTIONS constants)
//   entityType?: string       e.g. 'loan', 'customer', 'user'
//   entityId?:   UUID string
//   oldValues?:  object       (snapshot before change)
//   newValues?:  object       (snapshot after change)
//   ipAddress?:  string
//   userAgent?:  string
//   req?:        Express req  (auto-fills ip + userAgent if provided)
// }
// ----------------------------------------------------------------
const log = async (entry) => {
  try {
    const {
      userId     = null,
      action,
      entityType = null,
      entityId   = null,
      oldValues  = null,
      newValues  = null,
      req        = null,
    } = entry;

    const ipAddress = entry.ipAddress ?? (req ? getClientIp(req) : null);
    const userAgent = entry.userAgent ?? (req ? (req.headers['user-agent'] || null) : null);

    await db.query(
      `INSERT INTO audit_logs
         (user_id, action, entity_type, entity_id, old_values, new_values, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        userId,
        action,
        entityType,
        entityId   || null,
        oldValues  ? JSON.stringify(oldValues)  : null,
        newValues  ? JSON.stringify(newValues)  : null,
        ipAddress,
        userAgent,
      ]
    );
  } catch (err) {
    // Audit failure must NEVER crash the main request flow
    logger.error('auditLog.log failed', { error: err.message, action: entry?.action });
  }
};

// ----------------------------------------------------------------
// logFromReq — convenience wrapper that pulls userId/ip/ua from req
// ----------------------------------------------------------------
const logFromReq = (req, overrides = {}) =>
  log({
    userId:    req.user?.id ?? null,
    ipAddress: getClientIp(req),
    userAgent: req.headers['user-agent'] || null,
    ...overrides,
  });

// ----------------------------------------------------------------
// auditMiddleware(action, options)
// Express middleware that fires an audit log entry after the
// response is sent. Use on routes where you want automatic logging
// without adding code to the controller.
//
// Usage:
//   router.post('/loans', authenticate, auditMiddleware(ACTIONS.LOAN_CREATED, {
//     entityType: 'loan',
//     getEntityId: (req, res) => res.locals.createdId,
//   }), loanController.create);
//
// options: {
//   entityType?:   string
//   getEntityId?:  (req, res) => UUID string
//   getNewValues?: (req, res) => object
// }
// ----------------------------------------------------------------
const auditMiddleware = (action, options = {}) => (req, res, next) => {
  // Hook into response finish event
  const originalJson = res.json.bind(res);

  res.json = function (body) {
    // Only log on successful responses (2xx)
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const entityId  = options.getEntityId  ? options.getEntityId(req, res)  : null;
      const newValues = options.getNewValues ? options.getNewValues(req, res) : null;

      log({
        userId:     req.user?.id ?? null,
        action,
        entityType: options.entityType ?? null,
        entityId,
        newValues,
        ipAddress:  getClientIp(req),
        userAgent:  req.headers['user-agent'] || null,
      });
    }
    return originalJson(body);
  };

  return next();
};

// ----------------------------------------------------------------
// sanitise — remove sensitive fields before storing in audit log
// ----------------------------------------------------------------
const SENSITIVE_KEYS = new Set([
  'password', 'passwordHash', 'password_hash',
  'totpSecret', 'totp_secret',
  'idNumber', 'id_number',
  'token', 'refreshToken', 'accessToken',
  'currentPassword', 'newPassword', 'confirmPassword',
]);

const sanitise = (obj) => {
  if (!obj || typeof obj !== 'object') return obj;
  const clean = Array.isArray(obj) ? [] : {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(key)) {
      clean[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      clean[key] = sanitise(value);
    } else {
      clean[key] = value;
    }
  }
  return clean;
};

// ----------------------------------------------------------------
// getRecentActivity(userId, limit) — for dashboard / user profile
// ----------------------------------------------------------------
const getRecentActivity = async (userId, limit = 20) => {
  const { rows } = await db.query(
    `SELECT id, action, entity_type, entity_id, ip_address, created_at
     FROM audit_logs
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return rows;
};

// ----------------------------------------------------------------
// getEntityHistory(entityType, entityId) — full history of one record
// ----------------------------------------------------------------
const getEntityHistory = async (entityType, entityId) => {
  const { rows } = await db.query(
    `SELECT al.id, al.action, al.old_values, al.new_values,
            al.ip_address, al.created_at,
            u.username, u.full_name
     FROM audit_logs al
     LEFT JOIN users u ON u.id = al.user_id
     WHERE al.entity_type = $1 AND al.entity_id = $2
     ORDER BY al.created_at DESC`,
    [entityType, entityId]
  );
  return rows;
};

module.exports = {
  log,
  logFromReq,
  auditMiddleware,
  sanitise,
  getRecentActivity,
  getEntityHistory,
  ACTIONS,
  getClientIp,
};
