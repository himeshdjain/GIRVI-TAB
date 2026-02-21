'use strict';

/**
 * customerController.js
 * CRUD for customer profiles. Handles encrypted ID numbers,
 * masked display values, pagination, and search.
 */

const db         = require('../db');
const encryption = require('../utils/encryption');
const { log, ACTIONS, sanitise } = require('../auditLog');
const { AppError, asyncHandler }  = require('../errorHandler');

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------
const generateCustomerCode = async (client) => {
  const { rows } = await (client || db).query(
    `SELECT COUNT(*) AS cnt FROM customers`
  );
  const next = parseInt(rows[0].cnt, 10) + 1;
  return `CUST-${String(next).padStart(5, '0')}`;
};

const formatCustomer = (row) => {
  if (!row) return null;
  return {
    ...row,
    id_number: undefined,              // Never expose encrypted field
    idNumberMasked: row.id_number_masked,
  };
};

// ----------------------------------------------------------------
// GET /api/customers
// Supports: search (name/phone/code), pagination, sorting
// ----------------------------------------------------------------
const listCustomers = asyncHandler(async (req, res) => {
  const page      = Math.max(1, parseInt(req.query.page  || '1',  10));
  const limit     = Math.min(100, parseInt(req.query.limit || '20', 10));
  const offset    = (page - 1) * limit;
  const search    = (req.query.search || '').trim();
  const sortBy    = ['full_name', 'customer_code', 'created_at', 'city'].includes(req.query.sortBy)
    ? req.query.sortBy : 'created_at';
  const sortOrder = req.query.sortOrder === 'asc' ? 'ASC' : 'DESC';
  const activeOnly = req.query.activeOnly !== 'false';

  const params = [];
  const conditions = [];

  if (activeOnly) {
    params.push(true);
    conditions.push(`c.is_active = $${params.length}`);
  }

  if (search) {
    params.push(`%${search}%`);
    const i = params.length;
    conditions.push(
      `(c.full_name ILIKE $${i} OR c.phone ILIKE $${i} OR c.customer_code ILIKE $${i} OR c.email ILIKE $${i})`
    );
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await db.query(
    `SELECT COUNT(*) AS total FROM customers c ${where}`, params
  );
  const total = parseInt(countResult.rows[0].total, 10);

  const { rows } = await db.query(
    `SELECT c.id, c.customer_code, c.full_name, c.phone, c.alternate_phone,
            c.email, c.address_line1, c.address_line2, c.city, c.state, c.pincode,
            c.id_type, c.id_number_masked, c.date_of_birth, c.photo_url,
            c.is_active, c.notes, c.created_at, c.updated_at,
            COUNT(l.id) FILTER (WHERE l.status = 'active') AS active_loans,
            COUNT(l.id) AS total_loans,
            COALESCE(SUM(l.principal_amount) FILTER (WHERE l.status = 'active'), 0) AS total_active_principal
     FROM customers c
     LEFT JOIN loans l ON l.customer_id = c.id
     ${where}
     GROUP BY c.id
     ORDER BY c.${sortBy} ${sortOrder}
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  return res.status(200).json({
    success: true,
    data: rows,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    },
  });
});

// ----------------------------------------------------------------
// GET /api/customers/:id
// ----------------------------------------------------------------
const getCustomer = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const { rows } = await db.query(
    `SELECT c.id, c.customer_code, c.full_name, c.phone, c.alternate_phone,
            c.email, c.address_line1, c.address_line2, c.city, c.state, c.pincode,
            c.id_type, c.id_number_masked, c.date_of_birth, c.photo_url, c.id_proof_url,
            c.is_active, c.notes, c.created_at, c.updated_at,
            u.full_name AS created_by_name
     FROM customers c
     LEFT JOIN users u ON u.id = c.created_by
     WHERE c.id = $1`,
    [id]
  );

  if (!rows.length) throw new AppError('Customer not found.', 404, 'NOT_FOUND');

  // Fetch active loans summary
  const { rows: loans } = await db.query(
    `SELECT id, loan_number, principal_amount, interest_rate, status,
            start_date, due_date, total_gold_weight
     FROM loans WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 10`,
    [id]
  );

  await log({ userId: req.user.id, action: ACTIONS.CUSTOMER_VIEWED,
    entityType: 'customer', entityId: id, ipAddress: req.ip });

  return res.status(200).json({
    success: true,
    data: { ...formatCustomer(rows[0]), recentLoans: loans },
  });
});

// ----------------------------------------------------------------
// POST /api/customers
// ----------------------------------------------------------------
const createCustomer = asyncHandler(async (req, res) => {
  const {
    fullName, phone, alternatePhone, email,
    addressLine1, addressLine2, city, state, pincode,
    idType, idNumber, dateOfBirth, notes,
  } = req.body;

  // Check duplicate phone
  const { rows: existing } = await db.query(
    `SELECT id FROM customers WHERE phone = $1`, [phone]
  );
  if (existing.length) {
    throw new AppError('A customer with this phone number already exists.', 409, 'DUPLICATE_PHONE');
  }

  const encryptedId = encryption.encrypt(idNumber);
  const maskedId    = encryption.maskIdNumber(idNumber);

  const result = await db.withTransaction(async (client) => {
    const customerCode = await generateCustomerCode(client);

    const { rows } = await client.query(
      `INSERT INTO customers
         (customer_code, full_name, phone, alternate_phone, email,
          address_line1, address_line2, city, state, pincode,
          id_type, id_number, id_number_masked, date_of_birth, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING id, customer_code, full_name, phone, email, city, state,
                 id_type, id_number_masked, is_active, created_at`,
      [
        customerCode, fullName, phone, alternatePhone || null, email || null,
        addressLine1, addressLine2 || null, city, state, pincode,
        idType, encryptedId, maskedId, dateOfBirth || null, notes || null, req.user.id,
      ]
    );
    return rows[0];
  });

  await log({ userId: req.user.id, action: ACTIONS.CUSTOMER_CREATED,
    entityType: 'customer', entityId: result.id, ipAddress: req.ip,
    newValues: sanitise({ fullName, phone, city, idType }) });

  return res.status(201).json({ success: true, data: result });
});

// ----------------------------------------------------------------
// PUT /api/customers/:id
// ----------------------------------------------------------------
const updateCustomer = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const { rows: existing } = await db.query(
    `SELECT * FROM customers WHERE id = $1`, [id]
  );
  if (!existing.length) throw new AppError('Customer not found.', 404, 'NOT_FOUND');

  const old = existing[0];
  const {
    fullName     = old.full_name,
    phone        = old.phone,
    alternatePhone = old.alternate_phone,
    email        = old.email,
    addressLine1 = old.address_line1,
    addressLine2 = old.address_line2,
    city         = old.city,
    state        = old.state,
    pincode      = old.pincode,
    notes        = old.notes,
    dateOfBirth  = old.date_of_birth,
  } = req.body;

  // Duplicate phone check (excluding current customer)
  if (phone !== old.phone) {
    const { rows: dup } = await db.query(
      `SELECT id FROM customers WHERE phone = $1 AND id != $2`, [phone, id]
    );
    if (dup.length) throw new AppError('Phone number already in use by another customer.', 409, 'DUPLICATE_PHONE');
  }

  const { rows } = await db.query(
    `UPDATE customers SET
       full_name = $1, phone = $2, alternate_phone = $3, email = $4,
       address_line1 = $5, address_line2 = $6, city = $7, state = $8,
       pincode = $9, notes = $10, date_of_birth = $11
     WHERE id = $12
     RETURNING id, customer_code, full_name, phone, email, city, state,
               id_type, id_number_masked, is_active, updated_at`,
    [fullName, phone, alternatePhone || null, email || null,
     addressLine1, addressLine2 || null, city, state,
     pincode, notes || null, dateOfBirth || null, id]
  );

  await log({ userId: req.user.id, action: ACTIONS.CUSTOMER_UPDATED,
    entityType: 'customer', entityId: id, ipAddress: req.ip,
    oldValues: sanitise({ fullName: old.full_name, phone: old.phone, city: old.city }),
    newValues: sanitise({ fullName, phone, city }) });

  return res.status(200).json({ success: true, data: rows[0] });
});

// ----------------------------------------------------------------
// PATCH /api/customers/:id/deactivate
// ----------------------------------------------------------------
const deactivateCustomer = asyncHandler(async (req, res) => {
  const { id } = req.params;

  // Cannot deactivate if active loans exist
  const { rows: activeLoans } = await db.query(
    `SELECT id FROM loans WHERE customer_id = $1 AND status = 'active' LIMIT 1`, [id]
  );
  if (activeLoans.length) {
    throw new AppError('Cannot deactivate customer with active loans. Close all loans first.', 400, 'HAS_ACTIVE_LOANS');
  }

  const { rows } = await db.query(
    `UPDATE customers SET is_active = FALSE WHERE id = $1
     RETURNING id, customer_code, full_name, is_active`, [id]
  );
  if (!rows.length) throw new AppError('Customer not found.', 404, 'NOT_FOUND');

  await log({ userId: req.user.id, action: ACTIONS.CUSTOMER_DEACTIVATED,
    entityType: 'customer', entityId: id, ipAddress: req.ip });

  return res.status(200).json({ success: true, data: rows[0] });
});

// ----------------------------------------------------------------
// PATCH /api/customers/:id/reactivate
// ----------------------------------------------------------------
const reactivateCustomer = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { rows } = await db.query(
    `UPDATE customers SET is_active = TRUE WHERE id = $1
     RETURNING id, customer_code, full_name, is_active`, [id]
  );
  if (!rows.length) throw new AppError('Customer not found.', 404, 'NOT_FOUND');

  await log({ userId: req.user.id, action: ACTIONS.CUSTOMER_DEACTIVATED,
    entityType: 'customer', entityId: id, ipAddress: req.ip,
    newValues: { action: 'reactivated' } });

  return res.status(200).json({ success: true, data: rows[0] });
});

// ----------------------------------------------------------------
// GET /api/customers/:id/loan-history
// ----------------------------------------------------------------
const getLoanHistory = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const { rows: customer } = await db.query(
    `SELECT id, full_name, customer_code FROM customers WHERE id = $1`, [id]
  );
  if (!customer.length) throw new AppError('Customer not found.', 404);

  const { rows: loans } = await db.query(
    `SELECT l.id, l.loan_number, l.principal_amount, l.interest_rate,
            l.status, l.start_date, l.due_date, l.closed_date,
            l.total_gold_weight, l.appraised_value, l.interest_paid,
            l.principal_paid, l.renewal_count,
            COUNT(p.id) AS payment_count,
            COALESCE(SUM(p.amount), 0) AS total_paid
     FROM loans l
     LEFT JOIN payments p ON p.loan_id = l.id
     WHERE l.customer_id = $1
     GROUP BY l.id
     ORDER BY l.created_at DESC`,
    [id]
  );

  return res.status(200).json({
    success: true,
    data: { customer: customer[0], loans },
  });
});

// ----------------------------------------------------------------
// GET /api/customers/search?q=...
// Quick search for autocomplete (returns minimal fields)
// ----------------------------------------------------------------
const searchCustomers = asyncHandler(async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) {
    return res.status(200).json({ success: true, data: [] });
  }

  const { rows } = await db.query(
    `SELECT id, customer_code, full_name, phone, city,
            COUNT(l.id) FILTER (WHERE l.status = 'active') AS active_loans
     FROM customers c
     LEFT JOIN loans l ON l.customer_id = c.id
     WHERE c.is_active = TRUE
       AND (c.full_name ILIKE $1 OR c.phone ILIKE $1 OR c.customer_code ILIKE $1)
     GROUP BY c.id
     ORDER BY c.full_name
     LIMIT 15`,
    [`%${q}%`]
  );

  return res.status(200).json({ success: true, data: rows });
});

module.exports = {
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  deactivateCustomer,
  reactivateCustomer,
  getLoanHistory,
  searchCustomers,
};
