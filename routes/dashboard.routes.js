'use strict';

/**
 * routes/dashboard.routes.js
 */

const router = require('express').Router();
const ctrl   = require('../controllers/dashboardController');
const { authenticate } = require('../auth');

router.use(authenticate);

router.get('/summary',                 ctrl.getSummary);
router.get('/charts/loans-by-month',   ctrl.getLoansByMonth);
router.get('/charts/portfolio-status', ctrl.getPortfolioStatus);
router.get('/charts/collections-daily',ctrl.getDailyCollections);
router.get('/overdue-loans',           ctrl.getOverdueList);
router.get('/due-soon',                ctrl.getDueSoonLoans);
router.get('/recent-activity',         ctrl.getRecentActivity);
router.get('/gold-rate-history',       ctrl.getGoldRateHistory);

module.exports = router;
