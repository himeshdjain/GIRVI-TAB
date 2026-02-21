'use strict';

/**
 * dashboardController.js
 * Aggregated stats and summaries for the main dashboard.
 * All queries are read-only and optimised with single round-trips where possible.
 */

const db   = require('../db');
const calc = require('../utils/loanCalculations');
const { asyncHandler } = require('../errorHandler');

// ----------------------------------------------------------------
// GET /api/dashboard/summary
// Main KPI cards
// ----------------------------------------------------------------
const getSummary = asyncHandler(async (req, res) => {
  const today = new Date().toISOString().split('T')[0];

  const [loans, payments, customers, overdue, goldRate] = await Promise.all([
    // Loan stats
    db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'active')    AS active_loans,
        COUNT(*) FILTER (WHERE status = 'closed')    AS closed_loans,
        COUNT(*) FILTER (WHERE status = 'defaulted') AS defaulted_loans,
        COUNT(*) FILTER (WHERE status = 'auctioned') AS auctioned_loans,
        COUNT(*)                                      AS total_loans,
        COALESCE(SUM(principal_amount) FILTER (WHERE status = 'active'), 0)     AS active_principal,
        COALESCE(SUM(appraised_value)  FILTER (WHERE status = 'active'), 0)     AS active_gold_value,
        COALESCE(SUM(total_gold_weight) FILTER (WHERE status = 'active'), 0)    AS active_gold_weight,
        COALESCE(SUM(interest_paid), 0)   AS total_interest_collected,
        COALESCE(SUM(principal_paid), 0)  AS total_principal_collected
      FROM loans
    `),
    // Today's collections
    db.query(`
      SELECT
        COUNT(*)        AS transactions_today,
        COALESCE(SUM(amount), 0)                 AS collected_today,
        COALESCE(SUM(interest_component), 0)     AS interest_today,
        COALESCE(SUM(principal_component), 0)    AS principal_today,
        COALESCE(SUM(penalty_component), 0)      AS penalty_today
      FROM payments WHERE payment_date = $1
    `, [today]),
    // Customer stats
    db.query(`
      SELECT
        COUNT(*) FILTER (WHERE is_active = TRUE)  AS active_customers,
        COUNT(*)                                   AS total_customers
      FROM customers
    `),
    // Overdue count
    db.query(`
      SELECT COUNT(*) AS overdue_count,
             COALESCE(SUM(principal_amount - principal_paid), 0) AS overdue_principal
      FROM loans WHERE status = 'active' AND due_date < CURRENT_DATE
    `),
    // Latest gold rate
    db.query(`
      SELECT rate_per_gram, effective_date
      FROM gold_rates ORDER BY effective_date DESC LIMIT 1
    `),
  ]);

  // New loans & disbursements today
  const { rows: todayLoans } = await db.query(`
    SELECT COUNT(*) AS new_loans_today,
           COALESCE(SUM(principal_amount), 0) AS disbursed_today
    FROM loans WHERE DATE(created_at) = $1
  `, [today]);

  // Due in next 7 days
  const { rows: dueSoon } = await db.query(`
    SELECT COUNT(*) AS due_soon_count
    FROM loans
    WHERE status = 'active'
      AND due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
  `);

  return res.status(200).json({
    success: true,
    data: {
      loans:       loans.rows[0],
      collections: { ...payments.rows[0], ...todayLoans[0] },
      customers:   customers.rows[0],
      overdue:     overdue.rows[0],
      dueSoon:     dueSoon[0],
      goldRate:    goldRate.rows[0] || null,
      generatedAt: new Date().toISOString(),
    },
  });
});

// ----------------------------------------------------------------
// GET /api/dashboard/charts/loans-by-month
// Monthly disbursement vs collection (last 12 months)
// ----------------------------------------------------------------
const getLoansByMonth = asyncHandler(async (req, res) => {
  const { rows: disbursements } = await db.query(`
    SELECT
      TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
      COUNT(*)           AS loan_count,
      SUM(principal_amount) AS total_disbursed
    FROM loans
    WHERE created_at >= NOW() - INTERVAL '12 months'
    GROUP BY DATE_TRUNC('month', created_at)
    ORDER BY DATE_TRUNC('month', created_at)
  `);

  const { rows: collections } = await db.query(`
    SELECT
      TO_CHAR(DATE_TRUNC('month', payment_date), 'YYYY-MM') AS month,
      COUNT(*)      AS payment_count,
      SUM(amount)   AS total_collected,
      SUM(interest_component)  AS interest_collected,
      SUM(principal_component) AS principal_collected
    FROM payments
    WHERE payment_date >= NOW() - INTERVAL '12 months'
    GROUP BY DATE_TRUNC('month', payment_date)
    ORDER BY DATE_TRUNC('month', payment_date)
  `);

  return res.status(200).json({
    success: true,
    data: { disbursements, collections },
  });
});

// ----------------------------------------------------------------
// GET /api/dashboard/charts/portfolio-status
// Loan portfolio breakdown by status (for pie/doughnut chart)
// ----------------------------------------------------------------
const getPortfolioStatus = asyncHandler(async (req, res) => {
  const { rows } = await db.query(`
    SELECT
      status,
      COUNT(*)              AS count,
      SUM(principal_amount) AS total_principal,
      SUM(appraised_value)  AS total_gold_value
    FROM loans
    GROUP BY status
    ORDER BY count DESC
  `);

  return res.status(200).json({ success: true, data: rows });
});

// ----------------------------------------------------------------
// GET /api/dashboard/charts/collections-daily
// Daily collections for the current month
// ----------------------------------------------------------------
const getDailyCollections = asyncHandler(async (req, res) => {
  const year  = parseInt(req.query.year  || new Date().getFullYear(), 10);
  const month = parseInt(req.query.month || new Date().getMonth() + 1, 10);

  const { rows } = await db.query(`
    SELECT
      payment_date::text   AS date,
      COUNT(*)             AS transactions,
      SUM(amount)          AS total,
      SUM(interest_component)   AS interest,
      SUM(principal_component)  AS principal,
      SUM(penalty_component)    AS penalty
    FROM payments
    WHERE EXTRACT(YEAR  FROM payment_date) = $1
      AND EXTRACT(MONTH FROM payment_date) = $2
    GROUP BY payment_date
    ORDER BY payment_date
  `, [year, month]);

  return res.status(200).json({ success: true, data: rows });
});

// ----------------------------------------------------------------
// GET /api/dashboard/overdue-loans
// Paginated overdue list with outstanding amounts
// ----------------------------------------------------------------
const getOverdueList = asyncHandler(async (req, res) => {
  const page   = Math.max(1, parseInt(req.query.page  || '1',  10));
  const limit  = Math.min(100, parseInt(req.query.limit || '20', 10));
  const offset = (page - 1) * limit;

  const { rows: countRows } = await db.query(
    `SELECT COUNT(*) AS total FROM loans WHERE status = 'active' AND due_date < CURRENT_DATE`
  );
  const total = parseInt(countRows[0].total, 10);

  const { rows } = await db.query(`
    SELECT l.id, l.loan_number, l.principal_amount, l.interest_rate,
           l.start_date, l.due_date, l.principal_paid, l.interest_paid, l.penalty_paid,
           CURRENT_DATE - l.due_date AS days_overdue,
           c.id AS customer_id, c.full_name AS customer_name,
           c.phone AS customer_phone, c.customer_code
    FROM loans l
    JOIN customers c ON c.id = l.customer_id
    WHERE l.status = 'active' AND l.due_date < CURRENT_DATE
    ORDER BY days_overdue DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]);

  const enriched = rows.map((r) => {
    const balance = calc.calculateOutstandingBalance({
      principalAmount: parseFloat(r.principal_amount),
      principalPaid:   parseFloat(r.principal_paid),
      interestRate:    parseFloat(r.interest_rate),
      penaltyRate:     1,
      startDate:       r.start_date,
      dueDate:         r.due_date,
      interestPaid:    parseFloat(r.interest_paid),
      penaltyPaid:     parseFloat(r.penalty_paid),
    });
    return { ...r, outstanding: balance.totalOutstanding };
  });

  return res.status(200).json({
    success: true,
    data: enriched,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});

// ----------------------------------------------------------------
// GET /api/dashboard/due-soon
// Loans due within the next N days
// ----------------------------------------------------------------
const getDueSoonLoans = asyncHandler(async (req, res) => {
  const days = Math.min(30, parseInt(req.query.days || '7', 10));

  const { rows } = await db.query(`
    SELECT l.id, l.loan_number, l.principal_amount, l.interest_rate,
           l.due_date, l.total_gold_weight,
           CURRENT_DATE - l.due_date AS days_until_due,
           c.id AS customer_id, c.full_name AS customer_name,
           c.phone AS customer_phone, c.customer_code
    FROM loans l
    JOIN customers c ON c.id = l.customer_id
    WHERE l.status = 'active'
      AND l.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1 || ' days')::INTERVAL
    ORDER BY l.due_date ASC
  `, [days]);

  return res.status(200).json({ success: true, data: rows, count: rows.length });
});

// ----------------------------------------------------------------
// GET /api/dashboard/recent-activity
// Latest loans and payments (for activity feed)
// ----------------------------------------------------------------
const getRecentActivity = asyncHandler(async (req, res) => {
  const limit = Math.min(20, parseInt(req.query.limit || '10', 10));

  const [recentLoans, recentPayments] = await Promise.all([
    db.query(`
      SELECT l.id, l.loan_number, l.principal_amount, l.status, l.created_at,
             c.full_name AS customer_name, c.customer_code
      FROM loans l JOIN customers c ON c.id = l.customer_id
      ORDER BY l.created_at DESC LIMIT $1
    `, [limit]),
    db.query(`
      SELECT p.id, p.payment_number, p.amount, p.payment_type, p.payment_date, p.created_at,
             l.loan_number, c.full_name AS customer_name
      FROM payments p
      JOIN loans l ON l.id = p.loan_id
      JOIN customers c ON c.id = p.customer_id
      ORDER BY p.created_at DESC LIMIT $1
    `, [limit]),
  ]);

  return res.status(200).json({
    success: true,
    data: {
      recentLoans:    recentLoans.rows,
      recentPayments: recentPayments.rows,
    },
  });
});

// ----------------------------------------------------------------
// GET /api/dashboard/gold-rate-history
// ----------------------------------------------------------------
const getGoldRateHistory = asyncHandler(async (req, res) => {
  const days = Math.min(365, parseInt(req.query.days || '30', 10));

  const { rows } = await db.query(`
    SELECT rate_per_gram, effective_date, source
    FROM gold_rates
    WHERE effective_date >= CURRENT_DATE - ($1 || ' days')::INTERVAL
    ORDER BY effective_date DESC
  `, [days]);

  return res.status(200).json({ success: true, data: rows });
});

module.exports = {
  getSummary,
  getLoansByMonth,
  getPortfolioStatus,
  getDailyCollections,
  getOverdueList,
  getDueSoonLoans,
  getRecentActivity,
  getGoldRateHistory,
};
