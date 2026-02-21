'use strict';

/**
 * routes/customer.routes.js
 */

const router = require('express').Router();
const ctrl   = require('../customerController');
const { authenticate, managerPlus, adminOnly } = require('../auth');
const { rules, validate } = require('../validate');

// All customer routes require authentication
router.use(authenticate);

// ── Search (before /:id to avoid route conflict) ─────────────────
router.get('/search',                                           ctrl.searchCustomers);

// ── Collection ───────────────────────────────────────────────────
router.get ('/',              rules.pagination, validate,      ctrl.listCustomers);
router.post('/',              rules.createCustomer, validate,  ctrl.createCustomer);

// ── Single resource ──────────────────────────────────────────────
router.get ('/:id',           rules.uuidParam(), validate,     ctrl.getCustomer);
router.put ('/:id',           rules.uuidParam(), validate,
                              rules.updateCustomer, validate,  ctrl.updateCustomer);

// ── Status changes (manager+) ────────────────────────────────────
router.patch('/:id/deactivate', managerPlus,
             rules.uuidParam(), validate,                      ctrl.deactivateCustomer);
router.patch('/:id/reactivate', managerPlus,
             rules.uuidParam(), validate,                      ctrl.reactivateCustomer);

// ── Loan history ─────────────────────────────────────────────────
router.get ('/:id/loan-history', rules.uuidParam(), validate, ctrl.getLoanHistory);

module.exports = router;
