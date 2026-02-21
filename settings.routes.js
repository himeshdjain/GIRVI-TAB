'use strict';

/**
 * routes/settings.routes.js
 * All routes admin-only except gold-rate reads (managerPlus).
 */

const router = require('express').Router();
const ctrl   = require('../settingsController');
const { authenticate, adminOnly, managerPlus } = require('../auth');
const { rules, validate } = require('../validate');

router.use(authenticate);

// ── System settings ──────────────────────────────────────────────
router.get ('/',         managerPlus,             ctrl.getSettings);
router.get ('/:key',     managerPlus,             ctrl.getSetting);
router.put ('/',         adminOnly,
            rules.updateSettings, validate,       ctrl.updateSettings);

// ── Gold rates ───────────────────────────────────────────────────
router.get ('/gold-rates/current', managerPlus,   ctrl.getCurrentGoldRate);
router.get ('/gold-rates',         managerPlus,   ctrl.getGoldRates);
router.post('/gold-rates',         managerPlus,
            rules.createGoldRate, validate,       ctrl.addGoldRate);

// ── User management (admin only) ─────────────────────────────────
router.get ('/users',                   adminOnly, ctrl.listUsers);
router.post('/users',                   adminOnly,
            rules.createUser, validate,           ctrl.createUser);
router.get ('/users/:id',               adminOnly,
            rules.uuidParam('id'), validate,      ctrl.getUser);
router.put ('/users/:id',               adminOnly,
            rules.uuidParam('id'), rules.updateUser, validate, ctrl.updateUser);
router.patch('/users/:id/deactivate',   adminOnly,
            rules.uuidParam('id'), validate,      ctrl.deactivateUser);
router.patch('/users/:id/reactivate',   adminOnly,
            rules.uuidParam('id'), validate,      ctrl.reactivateUser);
router.patch('/users/:id/unlock',       adminOnly,
            rules.uuidParam('id'), validate,      ctrl.unlockUser);
router.post ('/users/:id/reset-password', adminOnly,
            rules.uuidParam('id'), validate,      ctrl.adminResetPassword);

module.exports = router;
