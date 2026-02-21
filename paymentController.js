'use strict';

/**
 * paymentController.js
 * Records payments, allocates amounts across penalty/interest/principal,
 * auto-closes fully settled loans, and provides payment history.
 */

const db   = require('./db');
const calc = require('./loanCalculations');
const { log, ACTIONS, sanitise } = require('./auditLog');
const { AppError, asyncHandler }  = require('./errorHandler');

// ----------------------------------------------------------------
// Helper: sequential payment number
// ----------------------------------------------------------------
const generatePaymentNumber = async (client) => {
  const year = new Date().getFullYear();
  const { rows } = await (client || db).query(
    `SELECT COUNT(*) AS cnt FROM payments WHERE EXTRACT(YEAR FROM created_at) = $1`, [year]
  );
  return `PAY-${year}-${String(parseInt(rows[0].cnt, 10) + 1).padStart(5, '0')}`;
};

// ----------------------------------------------------------------
// POST /api/payments
// Core payment recording with automatic allocation and auto-close
// ----------------------------------------------------------------
const createPayment = asyncHandler(async (req, res) => {
  const {
    loanId, amount, paymentType, paymentMethod,
    paymentDate, referenceNumber, notes,
  } = req.body;

  const payAmt = parseFloat(amount);

  // 1. Fetch loan with lock for update
  const { rows: loanRows } = await db.query(
    `SELECT l.*, c.full_name AS customer_name
     FROM loans l JOIN customers c ON c.id = l.customer_id
     WHERE l.id = $1 AND l.status = 'active'
     FOR UPDATE`,
    [loanId]
  );
  if (!loanRows.length) {
    throw new AppError('Active loan not found. Payments cannot be recorded for closed or defaulted loans.', 404, 'LOAN_NOT_FOUND');
  }
  const loan = loanRows[0];

  // 2. Calculate live outstanding balance
  const outstanding = calc.calculateOutstandingBalance({
    principalAmount: parseFloat(loan.principal_amount),
    principalPaid:   parseFloat(loan.principal_paid),
    interestRate:    parseFloat(loan.interest_rate),
    penaltyRate:     1,
    startDate:       loan.start_date,
    dueDate:         loan.due_date,
    interestPaid:    parseFloat(loan.interest_paid),
    penaltyPaid:     parseFloat(loan.penalty_paid),
  });

  // 3. Validate payment does not exceed total outstanding
  if (payAmt > outstanding.totalOutstanding + 0.01) {
    throw new AppError(
      `Payment amount (₹${payAmt.toLocaleString('en-IN')}) exceeds total outstanding balance (₹${outstanding.totalOutstanding.toLocaleString('en-IN')}).`,
      400, 'EXCEEDS_OUTSTANDING'
    );
  }

  // 4. Allocate: penalty → interest → principal
  const allocation = calc.allocatePayment(payAmt, outstanding);

  // 5. Determine transaction type
  const isFullSettlement =
    paymentType === 'full_settlement' ||
    (payAmt >= outstanding.totalOutstanding - 0.01);

  const transactionType = isFullSettlement
    ? 'full_settlement'
    : paymentType === 'interest' ? 'interest_payment'
    : paymentType === 'principal' ? 'principal_payment'
    : 'partial_settlement';

  const payment = await db.withTransaction(async (client) => {
    const paymentNumber = await generatePaymentNumber(client);

    // Insert payment record
    const { rows: payRows } = await client.query(
      `INSERT INTO payments
         (payment_number, loan_id, customer_id, payment_type, transaction_type,
          amount, interest_component, principal_component, penalty_component,
          payment_date, payment_method, reference_number, received_by, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        paymentNumber, loanId, loan.customer_id,
        paymentType, transactionType, payAmt,
        allocation.interestComponent,
        allocation.principalComponent,
        allocation.penaltyComponent,
        paymentDate, paymentMethod,
        referenceNumber || null, req.user.id, notes || null,
      ]
    );
    const payment = payRows[0];

    // Update loan balances
    const newInterestPaid  = calc.round2(parseFloat(loan.interest_paid)  + allocation.interestComponent);
    const newPrincipalPaid = calc.round2(parseFloat(loan.principal_paid) + allocation.principalComponent);
    const newPenaltyPaid   = calc.round2(parseFloat(loan.penalty_paid)   + allocation.penaltyComponent);

    if (isFullSettlement) {
      // Full settlement: close the loan
      await client.query(
        `UPDATE loans SET
           interest_paid   = $1,
           principal_paid  = $2,
           penalty_paid    = $3,
           status          = 'closed',
           closed_date     = $4,
           closed_by       = $5
         WHERE id = $6`,
        [newInterestPaid, newPrincipalPaid, newPenaltyPaid,
         paymentDate, req.user.id, loanId]
      );
      // Mark gold items returned
      await client.query(
        `UPDATE gold_items SET is_returned = TRUE, returned_at = NOW(), returned_by = $1
         WHERE loan_id = $2`, [req.user.id, loanId]
      );
    } else {
      await client.query(
        `UPDATE loans SET
           interest_paid  = $1,
           principal_paid = $2,
           penalty_paid   = $3
         WHERE id = $4`,
        [newInterestPaid, newPrincipalPaid, newPenaltyPaid, loanId]
      );
    }

    // Mark interest ledger periods as paid where applicable
    if (allocation.interestComponent > 0) {
      await client.query(
        `UPDATE interest_ledger SET is_paid = TRUE, paid_via_payment_id = $1
         WHERE loan_id = $2 AND is_paid = FALSE
           AND period_end <= $3::date`,
        [payment.id, loanId, paymentDate]
      );
    }

    return payment;
  });

  await log({ userId: req.user.id, action: ACTIONS.PAYMENT_CREATED,
    entityType: 'payment', entityId: payment.id, ipAddress: req.ip,
    newValues: sanitise({
      loanId, amount: payAmt, paymentType, transactionType,
      interestComponent:  allocation.interestComponent,
      principalComponent: allocation.principalComponent,
      penaltyComponent:   allocation.penaltyComponent,
    }) });

  return res.status(201).json({
    success: true,
    data: {
      payment,
      allocation,
      loanClosed: isFullSettlement,
      message: isFullSettlement
        ? 'Full settlement recorded. Loan has been closed and gold items marked as returned.'
        : `Payment of ₹${payAmt.toLocaleString('en-IN')} recorded successfully.`,
    },
  });
});

// ----------------------------------------------------------------
// GET /api/payments?loanId=...
// List payments with optional filters
// ----------------------------------------------------------------
const listPayments = asyncHandler(async (req, res) => {
  const page      = Math.max(1, parseInt(req.query.page  || '1',  10));
  const limit     = Math.min(100, parseInt(req.query.limit || '20', 10));
  const offset    = (page - 1) * limit;
  const loanId    = req.query.loanId    || null;
  const fromDate  = req.query.fromDate  || null;
  const toDate    = req.query.toDate    || null;
  const method    = req.query.paymentMethod || null;

  const params = [];
  const conditions = [];

  if (loanId) {
    params.push(loanId);
    conditions.push(`p.loan_id = $${params.length}`);
  }
  if (fromDate) {
    params.push(fromDate);
    conditions.push(`p.payment_date >= $${params.length}`);
  }
  if (toDate) {
    params.push(toDate);
    conditions.push(`p.payment_date <= $${params.length}`);
  }
  if (method) {
    params.push(method);
    conditions.push(`p.payment_method = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows: countRows } = await db.query(
    `SELECT COUNT(*) AS total FROM payments p ${where}`, params
  );
  const total = parseInt(countRows[0].total, 10);

  const { rows } = await db.query(
    `SELECT p.*, l.loan_number, c.full_name AS customer_name,
            c.customer_code, u.full_name AS received_by_name
     FROM payments p
     JOIN loans l ON l.id = p.loan_id
     JOIN customers c ON c.id = p.customer_id
     LEFT JOIN users u ON u.id = p.received_by
     ${where}
     ORDER BY p.payment_date DESC, p.created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  return res.status(200).json({
    success: true,
    data: rows,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});

// ----------------------------------------------------------------
// GET /api/payments/:id
// ----------------------------------------------------------------
const getPayment = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const { rows } = await db.query(
    `SELECT p.*, l.loan_number, l.interest_rate,
            c.full_name AS customer_name, c.customer_code, c.phone AS customer_phone,
            u.full_name AS received_by_name
     FROM payments p
     JOIN loans l ON l.id = p.loan_id
     JOIN customers c ON c.id = p.customer_id
     LEFT JOIN users u ON u.id = p.received_by
     WHERE p.id = $1`,
    [id]
  );

  if (!rows.length) throw new AppError('Payment not found.', 404, 'NOT_FOUND');

  return res.status(200).json({ success: true, data: rows[0] });
});

// ----------------------------------------------------------------
// GET /api/payments/summary/daily?date=YYYY-MM-DD
// Day's collection summary
// ----------------------------------------------------------------
const getDailySummary = asyncHandler(async (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];

  const { rows } = await db.query(
    `SELECT
       payment_method,
       payment_type,
       COUNT(*)           AS transaction_count,
       SUM(amount)        AS total_amount,
       SUM(interest_component)   AS total_interest,
       SUM(principal_component)  AS total_principal,
       SUM(penalty_component)    AS total_penalty
     FROM payments
     WHERE payment_date = $1
     GROUP BY payment_method, payment_type
     ORDER BY payment_method, payment_type`,
    [date]
  );

  const { rows: totals } = await db.query(
    `SELECT
       COUNT(*)                      AS total_transactions,
       SUM(amount)                   AS total_collected,
       SUM(interest_component)       AS total_interest,
       SUM(principal_component)      AS total_principal,
       SUM(penalty_component)        AS total_penalty,
       COUNT(*) FILTER (WHERE transaction_type = 'full_settlement') AS settlements
     FROM payments WHERE payment_date = $1`,
    [date]
  );

  return res.status(200).json({
    success: true,
    data: { date, breakdown: rows, totals: totals[0] },
  });
});

// ----------------------------------------------------------------
// GET /api/loans/:loanId/calculate-payment
// Preview allocation before recording a payment
// ----------------------------------------------------------------
const previewPayment = asyncHandler(async (req, res) => {
  const { loanId } = req.params;
  const amount = parseFloat(req.query.amount || '0');

  const { rows } = await db.query(
    `SELECT * FROM loans WHERE id = $1 AND status = 'active'`, [loanId]
  );
  if (!rows.length) throw new AppError('Active loan not found.', 404, 'NOT_FOUND');
  const loan = rows[0];

  const outstanding = calc.calculateOutstandingBalance({
    principalAmount: parseFloat(loan.principal_amount),
    principalPaid:   parseFloat(loan.principal_paid),
    interestRate:    parseFloat(loan.interest_rate),
    penaltyRate:     1,
    startDate:       loan.start_date,
    dueDate:         loan.due_date,
    interestPaid:    parseFloat(loan.interest_paid),
    penaltyPaid:     parseFloat(loan.penalty_paid),
  });

  const allocation = amount > 0
    ? calc.allocatePayment(Math.min(amount, outstanding.totalOutstanding), outstanding)
    : null;

  return res.status(200).json({
    success: true,
    data: { outstanding, allocation, settlementAmount: outstanding.totalOutstanding },
  });
});

module.exports = {
  createPayment,
  listPayments,
  getPayment,
  getDailySummary,
  previewPayment,
};
