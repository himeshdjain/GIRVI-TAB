'use strict';

/**
 * routes/auth.routes.js
 * Public + protected auth endpoints.
 */

const router  = require('express').Router();
const ctrl    = require('../controllers/authController');
const { authenticate } = require('../auth');
const { rules, validate } = require('../validate');
const rateLimit = require('express-rate-limit');

// Strict rate limiter for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX || '10', 10),
  message: { success: false, error: 'Too many attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders:  false,
});

// ── Public ──────────────────────────────────────────────────────
router.post('/login',         authLimiter, rules.login,      validate, ctrl.login);
router.post('/refresh',                                                 ctrl.refresh);

// ── Requires pre-auth token (2FA step) ──────────────────────────
router.post('/verify-2fa',    authLimiter, authenticate, rules.verifyTotp, validate, ctrl.verifyTwoFactor);

// ── Fully authenticated ─────────────────────────────────────────
router.get ('/me',            authenticate,                             ctrl.getMe);
router.post('/logout',        authenticate,                             ctrl.logout);
router.post('/logout-all',    authenticate,                             ctrl.logoutAll);
router.post('/change-password', authenticate, rules.changePassword, validate, ctrl.changePassword);

// ── 2FA management ──────────────────────────────────────────────
router.post('/2fa/setup',     authenticate,                             ctrl.setupTwoFactor);
router.post('/2fa/confirm',   authenticate, rules.verifyTotp, validate, ctrl.confirmTwoFactor);
router.post('/2fa/disable',   authenticate,                             ctrl.disableTwoFactor);

module.exports = router;
