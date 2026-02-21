'use strict';

/**
 * loanController.js
 * Full loan lifecycle: create, read, update, close, renew, default, auction.
 * All financial calculations delegated to loanCalculations.js.
 */

const db      = require('./db');
const calc    = require('./loanCalculations');
const { log, ACTIONS, sanitise } = require('./auditLog');
const { AppError, asyncHandler }  = require('./errorHandler');

// ----------------------------------------------------------------
// Helper: generate sequential loan number
// ----------------------------------------------------------------
const generateLoanNumber = async (client) => {
  const year = new Date().getFullYear();
  const { rows } = await (client || db).query(
    `SELECT COUNT(*) AS cnt FROM loans WHERE EXTRACT(YEAR FROM created_at) = $1`, [year]
  );
  const seq = parseInt(rows[0].cnt, 10) + 1;
  return `LN-${year}-${String(seq).padStart(5, '0')}`;
};

const generatePaymentNumber = async (client) => {
  const year = new Date().getFullYear();
  const { rows } = await (client || db).query(
    `SELECT COUNT(*) AS cnt FROM payments WHERE EXTRACT(YEAR FROM created_at) = $1`, [year]
  );
  const seq = parseInt(rows[0].cnt, 10) + 1;
  return `PAY-${year}-${String(seq).padStart(5, '0')}`;
};

// ----------------------------------------------------------------
// GET /api/loans
// ----------------------------------------------------------------
const listLoans = asyncHandler(async (req, res) => {
  const page      = Math.max(1, parseInt(req.query.page  || '1',  10));
  const limit     = Math.min(100, parseInt(req.query.limit || '20', 10));
  const offset    = (page - 1) * limit;
  const search    = (req.query.search || '').trim();
  const status    = req.query.status  || null;
  const fromDate  = req.query.fromDate || null;
  const toDate    = req.query.toDate   || null;
  const sortBy    = ['created_at', 'due_date', 'principal_amount', 'loan_number'].includes(req.query.sortBy)
    ? req.query.sortBy : 'created_at';
  const sortOrder = req.query.sortOrder === 'asc' ? 'ASC' : 'DESC';

  const params = [];
  const conditions = [];

  if (status) {
    params.push(status);
    conditions.push(`l.status = $${params.length}`);
  }
  if (fromDate) {
    params.push(fromDate);
    conditions.push(`l.created_at >= $${params.length}`);
  }
  if (toDate) {
    params.push(toDate);
    conditions.push(`l.created_at <= $${params.length}::date + interval '1 day'`);
  }
  if (search) {
    params.push(`%${search}%`);
    const i = params.length;
    conditions.push(
      `(l.loan_number ILIKE $${i} OR c.full_name ILIKE $${i} OR c.phone ILIKE $${i} OR c.customer_code ILIKE $${i})`
    );
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows: countRows } = await db.query(
    `SELECT COUNT(*) AS total FROM loans l
     JOIN customers c ON c.id = l.customer_id ${where}`, params
  );
  const total = parseInt(countRows[0].total, 10);

  const { rows } = await db.query(
    `SELECT l.id, l.loan_number, l.status, l.principal_amount, l.interest_rate,
            l.start_date, l.due_date, l.closed_date, l.total_gold_weight,
            l.appraised_value, l.interest_paid, l.interest_accrued,
            l.principal_paid, l.penalty_amount, l.renewal_count,
            c.id AS customer_id, c.full_name AS customer_name,
            c.phone AS customer_phone, c.customer_code,
            l.created_at
     FROM loans l
     JOIN customers c ON c.id = l.customer_id
     ${where}
     ORDER BY l.${sortBy} ${sortOrder}
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  // Attach overdue flag
  const enriched = rows.map((r) => ({
    ...r,
    isOverdue:   calc.isOverdue(r.due_date),
    daysOverdue: calc.getDaysOverdue(r.due_date),
    isDueSoon:   calc.isDueSoon(r.due_date),
  }));

  return res.status(200).json({
    success: true,
    data: enriched,
    pagination: {
      total, page, limit,
      totalPages: Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    },
  });
});

// ----------------------------------------------------------------
// GET /api/loans/:id
// ----------------------------------------------------------------
const getLoan = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const { rows } = await db.query(
    `SELECT l.*, c.full_name AS customer_name, c.phone AS customer_phone,
            c.customer_code, c.email AS customer_email,
            uc.full_name AS created_by_name, ucl.full_name AS closed_by_name
     FROM loans l
     JOIN customers c ON c.id = l.customer_id
     LEFT JOIN users uc  ON uc.id  = l.created_by
     LEFT JOIN users ucl ON ucl.id = l.closed_by
     WHERE l.id = $1`,
    [id]
  );
  if (!rows.length) throw new AppError('Loan not found.', 404, 'NOT_FOUND');

  const loan = rows[0];

  // Gold items
  const { rows: items } = await db.query(
    `SELECT * FROM gold_items WHERE loan_id = $1 ORDER BY created_at`, [id]
  );

  // Payment history
  const { rows: payments } = await db.query(
    `SELECT p.*, u.full_name AS received_by_name
     FROM payments p LEFT JOIN users u ON u.id = p.received_by
     WHERE p.loan_id = $1 ORDER BY p.payment_date DESC, p.created_at DESC`,
    [id]
  );

  // Live outstanding balance
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

  await log({ userId: req.user.id, action: ACTIONS.LOAN_VIEWED,
    entityType: 'loan', entityId: id, ipAddress: req.ip });

  return res.status(200).json({
    success: true,
    data: { ...loan, goldItems: items, payments, outstanding },
  });
});

// ----------------------------------------------------------------
// POST /api/loans
// ----------------------------------------------------------------
const createLoan = asyncHandler(async (req, res) => {
  const {
    customerId, principalAmount, interestRate, loanDurationMonths,
    startDate, goldItems, notes, processingFee = 0,
  } = req.body;

  // 1. Validate customer exists and is active
  const { rows: custRows } = await db.query(
    `SELECT id, full_name, is_active FROM customers WHERE id = $1`, [customerId]
  );
  if (!custRows.length) throw new AppError('Customer not found.', 404, 'CUSTOMER_NOT_FOUND');
  if (!custRows[0].is_active) throw new AppError('Customer account is inactive.', 400, 'CUSTOMER_INACTIVE');

  // 2. Get current/latest gold rate for LTV validation
  const { rows: rateRows } = await db.query(
    `SELECT rate_per_gram FROM gold_rates ORDER BY effective_date DESC LIMIT 1`
  );
  const currentGoldRate = rateRows.length ? parseFloat(rateRows[0].rate_per_gram) : null;

  // 3. Calculate total appraised value from items
  const totalGoldWeight = goldItems.reduce((sum, it) => sum + parseFloat(it.netWeightGrams), 0);
  const totalAppraised  = goldItems.reduce((sum, it) => sum + parseFloat(it.appraisedValue), 0);
  const ltvPercent      = calc.calculateLTV(parseFloat(principalAmount), totalAppraised);

  // 4. Fetch LTV limit from settings
  const { rows: ltv } = await db.query(
    `SELECT value FROM settings WHERE key = 'ltv_limit_percent'`
  );
  const ltvLimit = ltv.length ? parseFloat(ltv[0].value) : 75;

  if (ltvPercent > ltvLimit) {
    throw new AppError(
      `Loan amount exceeds LTV limit. Maximum allowed: ₹${calc.calculateMaxLoanAmount(totalAppraised, ltvLimit).toLocaleString('en-IN')} (${ltvLimit}% of ₹${totalAppraised.toLocaleString('en-IN')}).`,
      400, 'LTV_EXCEEDED'
    );
  }

  const dueDate = calc.calculateDueDate(startDate, loanDurationMonths);
  const goldRateAtPledge = goldItems[0]?.goldRateAtPledge || currentGoldRate || 0;

  const result = await db.withTransaction(async (client) => {
    const loanNumber = await generateLoanNumber(client);

    // Insert loan
    const { rows: loanRows } = await client.query(
      `INSERT INTO loans
         (loan_number, customer_id, principal_amount, interest_rate,
          loan_duration_months, start_date, due_date, status,
          total_gold_weight, gold_rate_at_pledge, appraised_value,
          ltv_percent, processing_fee, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        loanNumber, customerId, principalAmount, interestRate,
        loanDurationMonths, startDate, dueDate,
        calc.round2(totalGoldWeight), goldRateAtPledge,
        calc.round2(totalAppraised), calc.round2(ltvPercent),
        processingFee, notes || null, req.user.id,
      ]
    );
    const loan = loanRows[0];

    // Insert gold items
    for (const item of goldItems) {
      const netWeight = calc.calculateNetWeight(
        parseFloat(item.grossWeightGrams), parseFloat(item.stoneWeightGrams || 0)
      );
      await client.query(
        `INSERT INTO gold_items
           (loan_id, customer_id, item_type, description, purity,
            gross_weight_grams, net_weight_grams, stone_weight_grams,
            appraised_value, gold_rate_at_pledge, appraisal_notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          loan.id, customerId, item.itemType || 'other', item.description,
          item.purity, item.grossWeightGrams, netWeight,
          item.stoneWeightGrams || 0, item.appraisedValue,
          item.goldRateAtPledge, item.appraisalNotes || null, req.user.id,
        ]
      );
    }

    // Generate interest schedule
    const schedule = calc.generateInterestSchedule(
      parseFloat(principalAmount), parseFloat(interestRate), startDate, loanDurationMonths
    );
    for (const period of schedule) {
      await client.query(
        `INSERT INTO interest_ledger
           (loan_id, period_start, period_end, principal_balance, interest_rate, interest_amount)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [loan.id, period.periodStart, period.periodEnd,
         principalAmount, interestRate, period.interest]
      );
    }

    return loan;
  });

  await log({ userId: req.user.id, action: ACTIONS.LOAN_CREATED,
    entityType: 'loan', entityId: result.id, ipAddress: req.ip,
    newValues: sanitise({ loanNumber: result.loan_number, customerId, principalAmount, interestRate }) });

  return res.status(201).json({ success: true, data: result });
});

// ----------------------------------------------------------------
// PUT /api/loans/:id
// Only notes and status (within allowed transitions) are editable
// ----------------------------------------------------------------
const updateLoan = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { notes } = req.body;

  const { rows } = await db.query(
    `UPDATE loans SET notes = $1 WHERE id = $2 AND status = 'active'
     RETURNING id, loan_number, notes, status`,
    [notes || null, id]
  );

  if (!rows.length) {
    throw new AppError('Loan not found or cannot be edited (not in active status).', 404, 'NOT_FOUND');
  }

  await log({ userId: req.user.id, action: ACTIONS.LOAN_UPDATED,
    entityType: 'loan', entityId: id, ipAddress: req.ip,
    newValues: { notes } });

  return res.status(200).json({ success: true, data: rows[0] });
});

// ----------------------------------------------------------------
// POST /api/loans/:id/close
// Full settlement — closes the loan and marks items as returned
// ----------------------------------------------------------------
const closeLoan = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const { rows } = await db.query(
    `SELECT * FROM loans WHERE id = $1 AND status = 'active'`, [id]
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

  if (outstanding.totalOutstanding > 0) {
    throw new AppError(
      `Outstanding balance of ₹${outstanding.totalOutstanding.toLocaleString('en-IN')} must be cleared before closing. Use the payment endpoint to record a full settlement first.`,
      400, 'OUTSTANDING_BALANCE'
    );
  }

  await db.withTransaction(async (client) => {
    await client.query(
      `UPDATE loans SET status = 'closed', closed_date = CURRENT_DATE, closed_by = $1
       WHERE id = $2`, [req.user.id, id]
    );
    await client.query(
      `UPDATE gold_items SET is_returned = TRUE, returned_at = NOW(), returned_by = $1
       WHERE loan_id = $2`, [req.user.id, id]
    );
  });

  await log({ userId: req.user.id, action: ACTIONS.LOAN_CLOSED,
    entityType: 'loan', entityId: id, ipAddress: req.ip });

  return res.status(200).json({
    success: true,
    message: 'Loan closed successfully. Gold items marked as returned.',
  });
});

// ----------------------------------------------------------------
// POST /api/loans/:id/renew
// Renew a loan: close old, open new with same items
// ----------------------------------------------------------------
const renewLoan = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const {
    principalAmount, interestRate, loanDurationMonths, startDate, notes,
  } = req.body;

  const { rows } = await db.query(
    `SELECT * FROM loans WHERE id = $1 AND status = 'active'`, [id]
  );
  if (!rows.length) throw new AppError('Active loan not found.', 404, 'NOT_FOUND');
  const oldLoan = rows[0];

  const { rows: items } = await db.query(
    `SELECT * FROM gold_items WHERE loan_id = $1`, [id]
  );

  const dueDate = calc.calculateDueDate(startDate, loanDurationMonths);

  const newLoan = await db.withTransaction(async (client) => {
    // Mark old loan as closed (renewed)
    await client.query(
      `UPDATE loans SET status = 'closed', closed_date = CURRENT_DATE,
        closed_by = $1, notes = COALESCE(notes, '') || ' [Renewed]'
       WHERE id = $2`, [req.user.id, id]
    );

    const loanNumber = await generateLoanNumber(client);
    const renewalCount = (oldLoan.renewal_count || 0) + 1;

    const { rows: newRows } = await client.query(
      `INSERT INTO loans
         (loan_number, customer_id, principal_amount, interest_rate,
          loan_duration_months, start_date, due_date, status,
          total_gold_weight, gold_rate_at_pledge, appraised_value,
          ltv_percent, processing_fee, notes, parent_loan_id, renewal_count, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [
        loanNumber, oldLoan.customer_id, principalAmount, interestRate,
        loanDurationMonths, startDate, dueDate,
        oldLoan.total_gold_weight, oldLoan.gold_rate_at_pledge,
        oldLoan.appraised_value, oldLoan.ltv_percent,
        oldLoan.processing_fee, notes || null, id, renewalCount, req.user.id,
      ]
    );
    const newLoanRow = newRows[0];

    // Re-link gold items to new loan
    for (const item of items) {
      await client.query(
        `UPDATE gold_items SET loan_id = $1 WHERE id = $2`, [newLoanRow.id, item.id]
      );
    }

    return newLoanRow;
  });

  await log({ userId: req.user.id, action: ACTIONS.LOAN_RENEWED,
    entityType: 'loan', entityId: newLoan.id, ipAddress: req.ip,
    newValues: { parentLoanId: id, loanNumber: newLoan.loan_number } });

  return res.status(201).json({ success: true, data: newLoan });
});

// ----------------------------------------------------------------
// POST /api/loans/:id/default
// Mark loan as defaulted (admin/manager only)
// ----------------------------------------------------------------
const defaultLoan = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  const { rows } = await db.query(
    `UPDATE loans SET status = 'defaulted',
       notes = COALESCE(notes || ' | ', '') || $1
     WHERE id = $2 AND status = 'active'
     RETURNING id, loan_number, status`,
    [`Defaulted: ${reason || 'No reason provided'}`, id]
  );

  if (!rows.length) throw new AppError('Active loan not found.', 404, 'NOT_FOUND');

  await log({ userId: req.user.id, action: ACTIONS.LOAN_DEFAULTED,
    entityType: 'loan', entityId: id, ipAddress: req.ip,
    newValues: { reason } });

  return res.status(200).json({ success: true, data: rows[0] });
});

// ----------------------------------------------------------------
// GET /api/loans/overdue
// Returns all overdue active loans
// ----------------------------------------------------------------
const getOverdueLoans = asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT l.id, l.loan_number, l.principal_amount, l.interest_rate,
            l.start_date, l.due_date, l.principal_paid, l.interest_paid,
            l.penalty_paid, l.total_gold_weight,
            c.id AS customer_id, c.full_name AS customer_name,
            c.phone AS customer_phone, c.customer_code,
            CURRENT_DATE - l.due_date AS days_overdue
     FROM loans l
     JOIN customers c ON c.id = l.customer_id
     WHERE l.status = 'active' AND l.due_date < CURRENT_DATE
     ORDER BY days_overdue DESC`
  );

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
    return { ...r, outstanding: balance };
  });

  return res.status(200).json({ success: true, data: enriched, count: enriched.length });
});

// ----------------------------------------------------------------
// GET /api/loans/:id/statement
// Full account statement with outstanding calculation
// ----------------------------------------------------------------
const getLoanStatement = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const { rows } = await db.query(
    `SELECT l.*, c.full_name AS customer_name, c.phone AS customer_phone, c.customer_code
     FROM loans l JOIN customers c ON c.id = l.customer_id WHERE l.id = $1`, [id]
  );
  if (!rows.length) throw new AppError('Loan not found.', 404, 'NOT_FOUND');
  const loan = rows[0];

  const { rows: payments } = await db.query(
    `SELECT * FROM payments WHERE loan_id = $1 ORDER BY payment_date ASC`, [id]
  );

  const { rows: items } = await db.query(
    `SELECT * FROM gold_items WHERE loan_id = $1`, [id]
  );

  const settlement = calc.calculateSettlementAmount({
    principalAmount: parseFloat(loan.principal_amount),
    principalPaid:   parseFloat(loan.principal_paid),
    interestRate:    parseFloat(loan.interest_rate),
    penaltyRate:     1,
    startDate:       loan.start_date,
    dueDate:         loan.due_date,
    interestPaid:    parseFloat(loan.interest_paid),
    penaltyPaid:     parseFloat(loan.penalty_paid),
  });

  return res.status(200).json({
    success: true,
    data: { loan, goldItems: items, payments, settlement },
  });
});

module.exports = {
  listLoans, getLoan, createLoan, updateLoan,
  closeLoan, renewLoan, defaultLoan,
  getOverdueLoans, getLoanStatement,
};
