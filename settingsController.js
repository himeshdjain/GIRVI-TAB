'use strict';

/**
 * settingsController.js
 * Manages system settings, gold rates, and user management (admin).
 */

const bcrypt = require('bcrypt');
const db     = require('./db');
const { log, ACTIONS, sanitise } = require('./auditLog');
const { AppError, asyncHandler }  = require('./errorHandler');

// ================================================================
// SYSTEM SETTINGS
// ================================================================

// GET /api/settings
const getSettings = asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT key, value, description, updated_at FROM settings ORDER BY key`
  );

  // Group by category for easier consumption
  const grouped = {};
  for (const row of rows) {
    const category = row.key.split('_')[0];
    if (!grouped[category]) grouped[category] = {};
    grouped[category][row.key] = { value: row.value, description: row.description, updatedAt: row.updated_at };
  }

  return res.status(200).json({ success: true, data: { flat: rows, grouped } });
});

// GET /api/settings/:key
const getSetting = asyncHandler(async (req, res) => {
  const { key } = req.params;
  const { rows } = await db.query(
    `SELECT key, value, description, updated_at FROM settings WHERE key = $1`, [key]
  );
  if (!rows.length) throw new AppError(`Setting '${key}' not found.`, 404, 'NOT_FOUND');
  return res.status(200).json({ success: true, data: rows[0] });
});

// PUT /api/settings  (batch update)
const updateSettings = asyncHandler(async (req, res) => {
  const { settings } = req.body; // Array of { key, value }

  const IMMUTABLE_KEYS = new Set([
    'currency_symbol', // Changing mid-operation could corrupt records
  ]);

  const updated = [];
  const errors  = [];

  await db.withTransaction(async (client) => {
    for (const { key, value } of settings) {
      if (IMMUTABLE_KEYS.has(key)) {
        errors.push({ key, error: 'This setting cannot be changed after initial setup.' });
        continue;
      }
      const { rows } = await client.query(
        `UPDATE settings SET value = $1, updated_by = $2
         WHERE key = $3
         RETURNING key, value, updated_at`,
        [String(value), req.user.id, key]
      );
      if (rows.length) updated.push(rows[0]);
      else errors.push({ key, error: `Setting key '${key}' does not exist.` });
    }
  });

  await log({ userId: req.user.id, action: ACTIONS.SETTINGS_UPDATED,
    entityType: 'settings', ipAddress: req.ip,
    newValues: updated.map(({ key, value }) => ({ key, value })) });

  return res.status(200).json({
    success: true,
    data:    { updated, errors },
    message: `${updated.length} setting(s) updated.${errors.length ? ` ${errors.length} failed.` : ''}`,
  });
});

// ================================================================
// GOLD RATES
// ================================================================

// GET /api/settings/gold-rates
const getGoldRates = asyncHandler(async (req, res) => {
  const limit = Math.min(90, parseInt(req.query.limit || '30', 10));

  const { rows } = await db.query(
    `SELECT gr.id, gr.rate_per_gram, gr.effective_date, gr.source, gr.created_at,
            u.full_name AS entered_by_name
     FROM gold_rates gr
     LEFT JOIN users u ON u.id = gr.entered_by
     ORDER BY gr.effective_date DESC
     LIMIT $1`,
    [limit]
  );

  return res.status(200).json({ success: true, data: rows });
});

// GET /api/settings/gold-rates/current
const getCurrentGoldRate = asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT rate_per_gram, effective_date, source FROM gold_rates ORDER BY effective_date DESC LIMIT 1`
  );
  if (!rows.length) throw new AppError('No gold rate has been entered yet.', 404, 'NOT_FOUND');
  return res.status(200).json({ success: true, data: rows[0] });
});

// POST /api/settings/gold-rates
const addGoldRate = asyncHandler(async (req, res) => {
  const { ratePerGram, effectiveDate, source } = req.body;

  // Upsert: one rate per day
  const { rows } = await db.query(
    `INSERT INTO gold_rates (rate_per_gram, effective_date, source, entered_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (effective_date) DO UPDATE
       SET rate_per_gram = EXCLUDED.rate_per_gram,
           source = EXCLUDED.source,
           entered_by = EXCLUDED.entered_by
     RETURNING *`,
    [ratePerGram, effectiveDate, source || null, req.user.id]
  );

  await log({ userId: req.user.id, action: ACTIONS.GOLD_RATE_ADDED,
    entityType: 'gold_rate', entityId: rows[0].id, ipAddress: req.ip,
    newValues: { ratePerGram, effectiveDate } });

  return res.status(201).json({ success: true, data: rows[0] });
});

// ================================================================
// USER MANAGEMENT (admin only)
// ================================================================

// GET /api/settings/users
const listUsers = asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, username, email, full_name, role, phone,
            is_active, totp_enabled, last_login_at,
            failed_login_count, locked_until, created_at
     FROM users ORDER BY created_at DESC`
  );
  return res.status(200).json({ success: true, data: rows });
});

// GET /api/settings/users/:id
const getUser = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { rows } = await db.query(
    `SELECT id, username, email, full_name, role, phone,
            is_active, totp_enabled, last_login_at, created_at
     FROM users WHERE id = $1`,
    [id]
  );
  if (!rows.length) throw new AppError('User not found.', 404, 'NOT_FOUND');
  return res.status(200).json({ success: true, data: rows[0] });
});

// POST /api/settings/users
const createUser = asyncHandler(async (req, res) => {
  const { username, email, password, fullName, role, phone } = req.body;

  // Duplicate check
  const { rows: dup } = await db.query(
    `SELECT id FROM users WHERE username = $1 OR email = $2`, [username, email]
  );
  if (dup.length) throw new AppError('Username or email already in use.', 409, 'DUPLICATE_USER');

  const rounds   = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);
  const passHash = await bcrypt.hash(password, rounds);

  const { rows } = await db.query(
    `INSERT INTO users (username, email, password_hash, full_name, role, phone)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, username, email, full_name, role, phone, is_active, created_at`,
    [username.trim().toLowerCase(), email.trim().toLowerCase(),
     passHash, fullName, role, phone || null]
  );

  await log({ userId: req.user.id, action: ACTIONS.USER_CREATED,
    entityType: 'user', entityId: rows[0].id, ipAddress: req.ip,
    newValues: sanitise({ username, email, role }) });

  return res.status(201).json({ success: true, data: rows[0] });
});

// PUT /api/settings/users/:id
const updateUser = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { fullName, email, role, phone } = req.body;

  const { rows: existing } = await db.query(
    `SELECT * FROM users WHERE id = $1`, [id]
  );
  if (!existing.length) throw new AppError('User not found.', 404, 'NOT_FOUND');
  const old = existing[0];

  // Prevent demoting the last admin
  if (old.role === 'admin' && role && role !== 'admin') {
    const { rows: admins } = await db.query(
      `SELECT COUNT(*) AS cnt FROM users WHERE role = 'admin' AND is_active = TRUE`
    );
    if (parseInt(admins[0].cnt, 10) <= 1) {
      throw new AppError('Cannot change the role of the last active admin.', 400, 'LAST_ADMIN');
    }
  }

  const { rows } = await db.query(
    `UPDATE users SET
       full_name = COALESCE($1, full_name),
       email     = COALESCE($2, email),
       role      = COALESCE($3, role),
       phone     = COALESCE($4, phone)
     WHERE id = $5
     RETURNING id, username, email, full_name, role, phone, is_active, updated_at`,
    [fullName || null, email || null, role || null, phone || null, id]
  );

  await log({ userId: req.user.id, action: ACTIONS.USER_UPDATED,
    entityType: 'user', entityId: id, ipAddress: req.ip,
    oldValues: sanitise({ fullName: old.full_name, email: old.email, role: old.role }),
    newValues: sanitise({ fullName, email, role }) });

  return res.status(200).json({ success: true, data: rows[0] });
});

// PATCH /api/settings/users/:id/deactivate
const deactivateUser = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (id === req.user.id) {
    throw new AppError('You cannot deactivate your own account.', 400, 'SELF_DEACTIVATION');
  }

  const { rows: existing } = await db.query(
    `SELECT role FROM users WHERE id = $1`, [id]
  );
  if (!existing.length) throw new AppError('User not found.', 404, 'NOT_FOUND');

  if (existing[0].role === 'admin') {
    const { rows: admins } = await db.query(
      `SELECT COUNT(*) AS cnt FROM users WHERE role = 'admin' AND is_active = TRUE`
    );
    if (parseInt(admins[0].cnt, 10) <= 1) {
      throw new AppError('Cannot deactivate the last active admin.', 400, 'LAST_ADMIN');
    }
  }

  const { rows } = await db.query(
    `UPDATE users SET is_active = FALSE WHERE id = $1
     RETURNING id, username, is_active`, [id]
  );

  await log({ userId: req.user.id, action: ACTIONS.USER_DEACTIVATED,
    entityType: 'user', entityId: id, ipAddress: req.ip });

  return res.status(200).json({ success: true, data: rows[0] });
});

// PATCH /api/settings/users/:id/reactivate
const reactivateUser = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { rows } = await db.query(
    `UPDATE users SET is_active = TRUE, failed_login_count = 0, locked_until = NULL
     WHERE id = $1 RETURNING id, username, is_active`, [id]
  );
  if (!rows.length) throw new AppError('User not found.', 404, 'NOT_FOUND');

  await log({ userId: req.user.id, action: ACTIONS.USER_REACTIVATED,
    entityType: 'user', entityId: id, ipAddress: req.ip });

  return res.status(200).json({ success: true, data: rows[0] });
});

// PATCH /api/settings/users/:id/unlock
const unlockUser = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { rows } = await db.query(
    `UPDATE users SET failed_login_count = 0, locked_until = NULL
     WHERE id = $1 RETURNING id, username, locked_until`, [id]
  );
  if (!rows.length) throw new AppError('User not found.', 404, 'NOT_FOUND');

  await log({ userId: req.user.id, action: ACTIONS.ACCOUNT_UNLOCKED,
    entityType: 'user', entityId: id, ipAddress: req.ip });

  return res.status(200).json({ success: true, message: 'Account unlocked.', data: rows[0] });
});

// POST /api/settings/users/:id/reset-password (admin force-reset)
const adminResetPassword = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { newPassword } = req.body;

  if (!newPassword || newPassword.length < 8) {
    throw new AppError('New password must be at least 8 characters.', 400, 'WEAK_PASSWORD');
  }

  const rounds  = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);
  const hash    = await bcrypt.hash(newPassword, rounds);

  const { rows } = await db.query(
    `UPDATE users SET password_hash = $1, failed_login_count = 0, locked_until = NULL
     WHERE id = $2 RETURNING id, username`,
    [hash, id]
  );
  if (!rows.length) throw new AppError('User not found.', 404, 'NOT_FOUND');

  // Revoke all sessions for the user so they must re-login
  const jwtUtils = require('./jwt');
  await jwtUtils.revokeAllUserTokens(id);

  await log({ userId: req.user.id, action: ACTIONS.PASSWORD_CHANGED,
    entityType: 'user', entityId: id, ipAddress: req.ip,
    newValues: { resetBy: 'admin' } });

  return res.status(200).json({
    success: true,
    message: `Password reset for ${rows[0].username}. All active sessions have been terminated.`,
  });
});

module.exports = {
  getSettings, getSetting, updateSettings,
  getGoldRates, getCurrentGoldRate, addGoldRate,
  listUsers, getUser, createUser, updateUser,
  deactivateUser, reactivateUser, unlockUser, adminResetPassword,
};
