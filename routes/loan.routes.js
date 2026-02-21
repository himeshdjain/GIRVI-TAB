'use strict';

/**
 * routes/loan.routes.js
 */

const router = require('express').Router();
const ctrl   = require('../controllers/loanController');
const pCtrl  = require('../controllers/paymentController');
const { authenticate, managerPlus } = require('../auth');
const { rules, validate } = require('../validate');

router.use(authenticate);

// ── Special routes first (avoid conflict with /:id) ──────────────
router.get('/overdue',                                          ctrl.getOverdueLoans);

// ── Collection ───────────────────────────────────────────────────
router.get ('/',  rules.pagination, rules.dateRangeQuery,
            validate,                                           ctrl.listLoans);
router.post('/',  rules.createLoan, validate,                  ctrl.createLoan);

// ── Single resource ──────────────────────────────────────────────
router.get ('/:id', rules.uuidParam(), validate,               ctrl.getLoan);
router.put ('/:id', rules.uuidParam(), rules.updateLoan,
            validate,                                          ctrl.updateLoan);

// ── Loan lifecycle (manager+) ────────────────────────────────────
router.post('/:id/close',    managerPlus, rules.uuidParam(), validate, ctrl.closeLoan);
router.post('/:id/renew',    managerPlus, rules.uuidParam(), validate, ctrl.renewLoan);
router.post('/:id/default',  managerPlus, rules.uuidParam(), validate, ctrl.defaultLoan);

// ── Statement & payment preview ──────────────────────────────────
router.get ('/:id/statement',         rules.uuidParam(), validate, ctrl.getLoanStatement);
router.get ('/:loanId/calculate-payment',                      pCtrl.previewPayment);

module.exports = router;
