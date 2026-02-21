'use strict';

/**
 * authController.js
 * Handles: login, logout, token refresh, 2FA setup/verify,
 *          password change, current user profile.
 */

const bcrypt     = require('bcrypt');
const db         = require('../db');
const jwtUtils   = require('../jwt');
const encryption = require('../utils/encryption');
const { log, ACTIONS } = require('../auditLog');
const { AppError, asyncHandler } = require('../errorHandler');
const logger     = require('../utils/logger');

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MINUTES = 30;

// ----------------------------------------------------------------
// POST /api/auth/login
// ----------------------------------------------------------------
const login = asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  const ip        = req.ip;
  const userAgent = req.headers['user-agent'];

  // 1. Fetch user
  const { rows } = await db.query(
    `SELECT id, username, email, full_name, role, password_hash,
            is_active, totp_enabled, totp_secret,
            failed_login_count, locked_until
     FROM users WHERE username = $1 OR email = $1`,
    [username.trim().toLowerCase()]
  );

  const user = rows[0];

  // Generic message prevents username enumeration
  const invalidCredentials = () => {
    throw new AppError('Invalid username or password.', 401, 'INVALID_CREDENTIALS');
  };

  if (!user) {
    await log({ action: ACTIONS.LOGIN_FAILED, ipAddress: ip, userAgent,
      newValues: { username, reason: 'user_not_found' } });
    return invalidCredentials();
  }

  // 2. Check account lock
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    await log({ userId: user.id, action: ACTIONS.LOGIN_FAILED, entityType: 'user',
      entityId: user.id, ipAddress: ip, userAgent,
      newValues: { reason: 'account_locked', lockedUntil: user.locked_until } });
    throw new AppError(
      `Account locked due to too many failed attempts. Try again after ${new Date(user.locked_until).toLocaleTimeString()}.`,
      423, 'ACCOUNT_LOCKED'
    );
  }

  if (!user.is_active) {
    await log({ userId: user.id, action: ACTIONS.LOGIN_FAILED, entityType: 'user',
      entityId: user.id, ipAddress: ip, userAgent,
      newValues: { reason: 'account_inactive' } });
    throw new AppError('Your account has been deactivated. Contact an administrator.', 401, 'ACCOUNT_INACTIVE');
  }

  // 3. Verify password
  const passwordMatch = await bcrypt.compare(password, user.password_hash);
  if (!passwordMatch) {
    const failCount = user.failed_login_count + 1;
    const shouldLock = failCount >= MAX_FAILED_ATTEMPTS;
    const lockedUntil = shouldLock
      ? new Date(Date.now() + LOCK_DURATION_MINUTES * 60 * 1000)
      : null;

    await db.query(
      `UPDATE users SET failed_login_count = $1, locked_until = $2 WHERE id = $3`,
      [failCount, lockedUntil, user.id]
    );

    await log({ userId: user.id, action: ACTIONS.LOGIN_FAILED, entityType: 'user',
      entityId: user.id, ipAddress: ip, userAgent,
      newValues: { reason: 'wrong_password', failCount, locked: shouldLock } });

    if (shouldLock) {
      await log({ userId: user.id, action: ACTIONS.ACCOUNT_LOCKED, entityType: 'user', entityId: user.id });
      throw new AppError(`Too many failed attempts. Account locked for ${LOCK_DURATION_MINUTES} minutes.`, 423, 'ACCOUNT_LOCKED');
    }

    return invalidCredentials();
  }

  // 4. Reset failed attempts on success
  await db.query(
    `UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = NOW() WHERE id = $1`,
    [user.id]
  );

  // 5. If 2FA enabled — issue a short-lived pre-auth token, prompt for TOTP
  if (user.totp_enabled) {
    const preAuthToken = jwtUtils.signAccessToken({
      sub:          user.id,
      username:     user.username,
      role:         user.role,
      preAuth:      true,           // Signals 2FA not yet completed
      twoFactorVerified: false,
    });

    await log({ userId: user.id, action: ACTIONS.LOGIN_SUCCESS, entityType: 'user',
      entityId: user.id, ipAddress: ip, userAgent,
      newValues: { stage: '2fa_required' } });

    return res.status(200).json({
      success:     true,
      twoFactor:   true,
      message:     'Please enter your 2FA code to continue.',
      preAuthToken,
    });
  }

  // 6. Full login — issue access + refresh tokens
  const { accessToken, refreshToken } = await _issueTokens(user, ip, userAgent);

  await log({ userId: user.id, action: ACTIONS.LOGIN_SUCCESS, entityType: 'user',
    entityId: user.id, ipAddress: ip, userAgent,
    newValues: { stage: 'complete' } });

  jwtUtils.setRefreshCookie(res, refreshToken);

  return res.status(200).json({
    success:     true,
    twoFactor:   false,
    accessToken,
    expiresIn:   jwtUtils.ACCESS_EXPIRY,
    user:        _safeUser(user),
  });
});

// ----------------------------------------------------------------
// POST /api/auth/verify-2fa
// Validates TOTP token after pre-auth step.
// ----------------------------------------------------------------
const verifyTwoFactor = asyncHandler(async (req, res) => {
  const { token } = req.body;
  const ip        = req.ip;
  const userAgent = req.headers['user-agent'];

  // req.user is attached by authenticate middleware (pre-auth token)
  const userId = req.user.id;

  const { rows } = await db.query(
    `SELECT id, username, email, full_name, role, totp_secret, totp_enabled, is_active
     FROM users WHERE id = $1`,
    [userId]
  );
  const user = rows[0];

  if (!user || !user.totp_enabled || !user.totp_secret) {
    throw new AppError('2FA is not configured for this account.', 400, '2FA_NOT_CONFIGURED');
  }

  const decryptedSecret = encryption.decrypt(user.totp_secret);
  const isValid = encryption.verifyTotp(token, decryptedSecret);

  if (!isValid) {
    await log({ userId, action: ACTIONS.LOGIN_FAILED, entityType: 'user', entityId: userId,
      ipAddress: ip, userAgent, newValues: { reason: 'invalid_totp' } });
    throw new AppError('Invalid or expired 2FA code.', 401, 'INVALID_TOTP');
  }

  const { accessToken, refreshToken } = await _issueTokens(user, ip, userAgent, true);

  await log({ userId, action: ACTIONS.TOTP_VERIFIED, entityType: 'user', entityId: userId,
    ipAddress: ip, userAgent });

  jwtUtils.setRefreshCookie(res, refreshToken);

  return res.status(200).json({
    success:    true,
    accessToken,
    expiresIn:  jwtUtils.ACCESS_EXPIRY,
    user:       _safeUser(user),
  });
});

// ----------------------------------------------------------------
// POST /api/auth/refresh
// Issues a new access token using the HttpOnly refresh cookie.
// ----------------------------------------------------------------
const refresh = asyncHandler(async (req, res) => {
  const rawToken = req.cookies?.[jwtUtils.COOKIE_NAME];

  if (!rawToken) {
    throw new AppError('No refresh token provided.', 401, 'NO_REFRESH_TOKEN');
  }

  const result = await jwtUtils.validateRefreshToken(rawToken);
  if (!result) {
    jwtUtils.clearRefreshCookie(res);
    throw new AppError('Refresh token is invalid or expired. Please log in again.', 401, 'INVALID_REFRESH_TOKEN');
  }

  const { userId, tokenRow } = result;

  // Rotate refresh token (revoke old, issue new)
  await jwtUtils.revokeRefreshToken(rawToken);

  const { rows } = await db.query(
    `SELECT id, username, email, full_name, role, totp_enabled FROM users WHERE id = $1`,
    [userId]
  );
  const user = rows[0];

  const { accessToken, refreshToken: newRefreshToken } = await _issueTokens(
    user, req.ip, req.headers['user-agent'], tokenRow.totp_verified ?? false
  );

  await log({ userId, action: ACTIONS.TOKEN_REFRESHED, entityType: 'user', entityId: userId,
    ipAddress: req.ip, userAgent: req.headers['user-agent'] });

  jwtUtils.setRefreshCookie(res, newRefreshToken);

  return res.status(200).json({
    success:    true,
    accessToken,
    expiresIn:  jwtUtils.ACCESS_EXPIRY,
  });
});

// ----------------------------------------------------------------
// POST /api/auth/logout
// ----------------------------------------------------------------
const logout = asyncHandler(async (req, res) => {
  const rawToken = req.cookies?.[jwtUtils.COOKIE_NAME];
  if (rawToken) await jwtUtils.revokeRefreshToken(rawToken);

  jwtUtils.clearRefreshCookie(res);

  await log({ userId: req.user?.id, action: ACTIONS.LOGOUT, entityType: 'user',
    entityId: req.user?.id, ipAddress: req.ip, userAgent: req.headers['user-agent'] });

  return res.status(200).json({ success: true, message: 'Logged out successfully.' });
});

// ----------------------------------------------------------------
// POST /api/auth/logout-all
// Revokes all sessions for the current user.
// ----------------------------------------------------------------
const logoutAll = asyncHandler(async (req, res) => {
  await jwtUtils.revokeAllUserTokens(req.user.id);
  jwtUtils.clearRefreshCookie(res);

  await log({ userId: req.user.id, action: ACTIONS.LOGOUT, entityType: 'user',
    entityId: req.user.id, ipAddress: req.ip,
    newValues: { scope: 'all_sessions' } });

  return res.status(200).json({ success: true, message: 'All sessions terminated.' });
});

// ----------------------------------------------------------------
// GET /api/auth/me
// ----------------------------------------------------------------
const getMe = asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, username, email, full_name, role, phone,
            totp_enabled, last_login_at, created_at
     FROM users WHERE id = $1`,
    [req.user.id]
  );
  if (!rows.length) throw new AppError('User not found.', 404);

  return res.status(200).json({ success: true, data: rows[0] });
});

// ----------------------------------------------------------------
// POST /api/auth/change-password
// ----------------------------------------------------------------
const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  const { rows } = await db.query(
    `SELECT id, password_hash FROM users WHERE id = $1`, [req.user.id]
  );
  const user = rows[0];

  const match = await bcrypt.compare(currentPassword, user.password_hash);
  if (!match) throw new AppError('Current password is incorrect.', 400, 'WRONG_PASSWORD');

  const rounds = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);
  const newHash = await bcrypt.hash(newPassword, rounds);

  await db.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [newHash, req.user.id]);
  await jwtUtils.revokeAllUserTokens(req.user.id);
  jwtUtils.clearRefreshCookie(res);

  await log({ userId: req.user.id, action: ACTIONS.PASSWORD_CHANGED,
    entityType: 'user', entityId: req.user.id, ipAddress: req.ip });

  return res.status(200).json({
    success: true,
    message: 'Password changed successfully. Please log in again.',
  });
});

// ----------------------------------------------------------------
// POST /api/auth/2fa/setup
// Generates a TOTP secret and returns a QR code data URL.
// ----------------------------------------------------------------
const setupTwoFactor = asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, username, totp_enabled FROM users WHERE id = $1`, [req.user.id]
  );
  const user = rows[0];

  if (user.totp_enabled) {
    throw new AppError('2FA is already enabled for this account.', 400, '2FA_ALREADY_ENABLED');
  }

  const secret   = encryption.generateTotpSecret();
  const qrCode   = await encryption.generateTotpQrCode(user.username, secret);
  const encrypted = encryption.encrypt(secret);

  // Store as pending (not yet confirmed) — totp_enabled stays false
  await db.query(
    `UPDATE users SET totp_secret = $1 WHERE id = $2`, [encrypted, user.id]
  );

  return res.status(200).json({
    success: true,
    message: 'Scan the QR code with your authenticator app, then confirm with /2fa/confirm.',
    qrCode,
    // Also expose the raw secret for manual entry in authenticator apps
    manualEntryKey: secret,
  });
});

// ----------------------------------------------------------------
// POST /api/auth/2fa/confirm
// Confirms 2FA setup by verifying the first TOTP code.
// ----------------------------------------------------------------
const confirmTwoFactor = asyncHandler(async (req, res) => {
  const { token } = req.body;

  const { rows } = await db.query(
    `SELECT id, totp_secret, totp_enabled FROM users WHERE id = $1`, [req.user.id]
  );
  const user = rows[0];

  if (user.totp_enabled) {
    throw new AppError('2FA is already active on this account.', 400, '2FA_ALREADY_ENABLED');
  }
  if (!user.totp_secret) {
    throw new AppError('No pending 2FA setup found. Please call /2fa/setup first.', 400, '2FA_NOT_SETUP');
  }

  const secret = encryption.decrypt(user.totp_secret);
  if (!encryption.verifyTotp(token, secret)) {
    throw new AppError('Invalid 2FA code. Please try again.', 400, 'INVALID_TOTP');
  }

  await db.query(`UPDATE users SET totp_enabled = TRUE WHERE id = $1`, [user.id]);

  await log({ userId: req.user.id, action: ACTIONS.TOTP_ENABLED,
    entityType: 'user', entityId: req.user.id, ipAddress: req.ip });

  return res.status(200).json({
    success: true,
    message: '2FA has been successfully enabled on your account.',
  });
});

// ----------------------------------------------------------------
// POST /api/auth/2fa/disable
// Admin or the user themselves can disable 2FA (requires password).
// ----------------------------------------------------------------
const disableTwoFactor = asyncHandler(async (req, res) => {
  const { password } = req.body;

  const { rows } = await db.query(
    `SELECT id, password_hash, totp_enabled FROM users WHERE id = $1`, [req.user.id]
  );
  const user = rows[0];

  if (!user.totp_enabled) {
    throw new AppError('2FA is not enabled on this account.', 400, '2FA_NOT_ENABLED');
  }

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) throw new AppError('Incorrect password.', 400, 'WRONG_PASSWORD');

  await db.query(
    `UPDATE users SET totp_enabled = FALSE, totp_secret = NULL WHERE id = $1`, [user.id]
  );

  await log({ userId: req.user.id, action: ACTIONS.TOTP_DISABLED,
    entityType: 'user', entityId: req.user.id, ipAddress: req.ip });

  return res.status(200).json({ success: true, message: '2FA has been disabled.' });
});

// ----------------------------------------------------------------
// Private helpers
// ----------------------------------------------------------------
const _issueTokens = async (user, ip, userAgent, twoFactorVerified = false) => {
  const accessToken  = jwtUtils.signAccessToken({
    sub:      user.id,
    username: user.username,
    role:     user.role,
    twoFactorVerified,
  });
  const refreshToken = jwtUtils.signRefreshToken();
  await jwtUtils.storeRefreshToken({
    userId: user.id, rawToken: refreshToken, ipAddress: ip, userAgent,
  });
  return { accessToken, refreshToken };
};

const _safeUser = (user) => ({
  id:          user.id,
  username:    user.username,
  email:       user.email,
  fullName:    user.full_name,
  role:        user.role,
  totpEnabled: user.totp_enabled,
});

module.exports = {
  login,
  verifyTwoFactor,
  refresh,
  logout,
  logoutAll,
  getMe,
  changePassword,
  setupTwoFactor,
  confirmTwoFactor,
  disableTwoFactor,
};
