'use strict';

/**
 * routes/payment.routes.js
 */

const router = require('express').Router();
const ctrl   = require('../controllers/paymentController');
const { authenticate } = require('../auth');
const { rules, validate } = require('../validate');

router.use(authenticate);

// ── Special routes first ─────────────────────────────────────────
router.get('/summary/daily',                                    ctrl.getDailySummary);

// ── Collection ───────────────────────────────────────────────────
router.get ('/',  rules.pagination, rules.dateRangeQuery,
            validate,                                           ctrl.listPayments);
router.post('/',  rules.createPayment, validate,               ctrl.createPayment);

// ── Single resource ──────────────────────────────────────────────
router.get ('/:id', rules.uuidParam(), validate,               ctrl.getPayment);

module.exports = router;
