'use strict';

/**
 * validate.js
 * Input validation middleware built on express-validator.
 *
 * Exports:
 *   validate(rules)   — runs a rules array and short-circuits with 422 on failure
 *   rules.*           — pre-built rule sets for every endpoint
 */

const { body, param, query, validationResult } = require('express-validator');

// ----------------------------------------------------------------
// Core runner — attach after rule arrays in route definitions.
// router.post('/loans', authenticate, rules.createLoan, validate, handler)
// ----------------------------------------------------------------
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();

  const formatted = errors.array().map((e) => ({
    field:   e.path || e.param,
    message: e.msg,
    value:   e.value !== undefined ? String(e.value).substring(0, 100) : undefined,
  }));

  return res.status(422).json({
    success: false,
    error:   'Validation failed.',
    code:    'VALIDATION_ERROR',
    details: formatted,
  });
};

// ----------------------------------------------------------------
// Reusable field validators
// ----------------------------------------------------------------
const isUUID     = (field, location = body) => location(field).isUUID(4).withMessage(`${field} must be a valid UUID`);
const isPositive = (field) => body(field).isFloat({ min: 0.01 }).withMessage(`${field} must be a positive number`);
const isPercent  = (field) => body(field).isFloat({ min: 0, max: 100 }).withMessage(`${field} must be between 0 and 100`);
const isDateStr  = (field) => body(field).isISO8601().toDate().withMessage(`${field} must be a valid date (YYYY-MM-DD)`);
const trimmed    = (field) => body(field).trim().notEmpty().withMessage(`${field} is required`);

const GOLD_PURITIES    = ['24K', '22K', '20K', '18K', '16K', '14K'];
const GOLD_ITEM_TYPES  = ['necklace', 'ring', 'bracelet', 'earring', 'bangle', 'chain', 'anklet', 'other'];
const PAYMENT_METHODS  = ['cash', 'upi', 'bank_transfer', 'cheque'];
const PAYMENT_TYPES    = ['interest', 'principal', 'full_settlement', 'partial_settlement'];
const USER_ROLES       = ['admin', 'manager', 'staff'];

// ----------------------------------------------------------------
// AUTH
// ----------------------------------------------------------------
const login = [
  body('username').trim().notEmpty().withMessage('Username is required'),
  body('password').notEmpty().withMessage('Password is required'),
];

const verifyTotp = [
  body('token')
    .trim()
    .notEmpty().withMessage('TOTP token is required')
    .isLength({ min: 6, max: 6 }).withMessage('TOTP token must be 6 digits')
    .isNumeric().withMessage('TOTP token must be numeric'),
];

const changePassword = [
  body('currentPassword').notEmpty().withMessage('Current password is required'),
  body('newPassword')
    .isLength({ min: 8 }).withMessage('New password must be at least 8 characters')
    .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
    .matches(/[a-z]/).withMessage('Password must contain at least one lowercase letter')
    .matches(/[0-9]/).withMessage('Password must contain at least one number')
    .matches(/[^A-Za-z0-9]/).withMessage('Password must contain at least one special character'),
  body('confirmPassword')
    .custom((value, { req }) => {
      if (value !== req.body.newPassword) throw new Error('Passwords do not match');
      return true;
    }),
];

// ----------------------------------------------------------------
// USERS
// ----------------------------------------------------------------
const createUser = [
  trimmed('username')
    .isLength({ min: 3, max: 50 }).withMessage('Username must be 3-50 characters')
    .matches(/^[a-zA-Z0-9_]+$/).withMessage('Username can only contain letters, numbers and underscores'),
  body('email').trim().isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('fullName').trim().notEmpty().isLength({ min: 2, max: 150 }).withMessage('Full name is required (2-150 chars)'),
  body('role').isIn(USER_ROLES).withMessage(`Role must be one of: ${USER_ROLES.join(', ')}`),
  body('password')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .matches(/[A-Z]/).withMessage('Password must contain an uppercase letter')
    .matches(/[0-9]/).withMessage('Password must contain a number'),
  body('phone').optional({ nullable: true }).trim().isMobilePhone().withMessage('Invalid phone number'),
];

const updateUser = [
  body('email').optional().trim().isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('fullName').optional().trim().isLength({ min: 2, max: 150 }).withMessage('Full name must be 2-150 chars'),
  body('role').optional().isIn(USER_ROLES).withMessage(`Role must be one of: ${USER_ROLES.join(', ')}`),
  body('phone').optional({ nullable: true }).trim().isMobilePhone().withMessage('Invalid phone number'),
];

// ----------------------------------------------------------------
// CUSTOMERS
// ----------------------------------------------------------------
const createCustomer = [
  body('fullName').trim().notEmpty().isLength({ min: 2, max: 150 }).withMessage('Full name is required (2-150 chars)'),
  body('phone')
    .trim().notEmpty().withMessage('Phone number is required')
    .matches(/^[6-9]\d{9}$/).withMessage('Enter a valid 10-digit Indian mobile number'),
  body('alternatePhone').optional({ nullable: true })
    .matches(/^[6-9]\d{9}$/).withMessage('Enter a valid 10-digit Indian mobile number'),
  body('email').optional({ nullable: true }).trim().isEmail().normalizeEmail().withMessage('Invalid email address'),
  body('addressLine1').trim().notEmpty().withMessage('Address is required'),
  body('city').trim().notEmpty().withMessage('City is required'),
  body('state').trim().notEmpty().withMessage('State is required'),
  body('pincode')
    .trim().notEmpty().withMessage('Pincode is required')
    .matches(/^\d{6}$/).withMessage('Enter a valid 6-digit pincode'),
  body('idType').trim().notEmpty().withMessage('ID type is required'),
  body('idNumber').trim().notEmpty().withMessage('ID number is required'),
  body('dateOfBirth').optional({ nullable: true }).isISO8601().toDate().withMessage('Invalid date of birth'),
];

const updateCustomer = [
  body('fullName').optional().trim().isLength({ min: 2, max: 150 }).withMessage('Full name must be 2-150 chars'),
  body('phone').optional().matches(/^[6-9]\d{9}$/).withMessage('Valid 10-digit mobile number required'),
  body('email').optional({ nullable: true }).trim().isEmail().normalizeEmail().withMessage('Invalid email address'),
  body('city').optional().trim().notEmpty(),
  body('state').optional().trim().notEmpty(),
  body('pincode').optional().matches(/^\d{6}$/).withMessage('Valid 6-digit pincode required'),
];

// ----------------------------------------------------------------
// GOLD ITEMS
// ----------------------------------------------------------------
const goldItemBody = [
  body('itemType').isIn(GOLD_ITEM_TYPES).withMessage(`Item type must be one of: ${GOLD_ITEM_TYPES.join(', ')}`),
  body('description').trim().notEmpty().isLength({ max: 500 }).withMessage('Description is required (max 500 chars)'),
  body('purity').isIn(GOLD_PURITIES).withMessage(`Purity must be one of: ${GOLD_PURITIES.join(', ')}`),
  body('grossWeightGrams')
    .isFloat({ min: 0.001 }).withMessage('Gross weight must be greater than 0'),
  body('stoneWeightGrams')
    .optional().isFloat({ min: 0 }).withMessage('Stone weight must be 0 or greater'),
  body('netWeightGrams')
    .isFloat({ min: 0.001 }).withMessage('Net weight must be greater than 0')
    .custom((value, { req }) => {
      if (parseFloat(value) > parseFloat(req.body.grossWeightGrams)) {
        throw new Error('Net weight cannot exceed gross weight');
      }
      return true;
    }),
  body('goldRateAtPledge').isFloat({ min: 1 }).withMessage('Gold rate must be a positive number'),
  body('appraisedValue').isFloat({ min: 1 }).withMessage('Appraised value must be a positive number'),
];

// ----------------------------------------------------------------
// LOANS
// ----------------------------------------------------------------
const createLoan = [
  isUUID('customerId'),
  isPositive('principalAmount'),
  body('interestRate')
    .isFloat({ min: 0.01, max: 50 }).withMessage('Interest rate must be between 0.01 and 50 percent per month'),
  body('loanDurationMonths')
    .isInt({ min: 1, max: 120 }).withMessage('Loan duration must be between 1 and 120 months'),
  isDateStr('startDate'),
  body('goldItems')
    .isArray({ min: 1 }).withMessage('At least one gold item is required'),
  body('goldItems.*.itemType').isIn(GOLD_ITEM_TYPES).withMessage('Invalid item type'),
  body('goldItems.*.purity').isIn(GOLD_PURITIES).withMessage('Invalid gold purity'),
  body('goldItems.*.grossWeightGrams').isFloat({ min: 0.001 }).withMessage('Gross weight must be > 0'),
  body('goldItems.*.netWeightGrams').isFloat({ min: 0.001 }).withMessage('Net weight must be > 0'),
  body('goldItems.*.description').trim().notEmpty().withMessage('Item description is required'),
  body('goldItems.*.goldRateAtPledge').isFloat({ min: 1 }).withMessage('Gold rate is required'),
  body('goldItems.*.appraisedValue').isFloat({ min: 1 }).withMessage('Appraised value is required'),
  body('notes').optional({ nullable: true }).trim().isLength({ max: 1000 }),
  body('processingFee').optional().isFloat({ min: 0 }).withMessage('Processing fee must be 0 or greater'),
];

const updateLoan = [
  body('notes').optional().trim().isLength({ max: 1000 }),
  body('status').optional().isIn(['active', 'closed', 'defaulted', 'auctioned']).withMessage('Invalid loan status'),
];

// ----------------------------------------------------------------
// PAYMENTS
// ----------------------------------------------------------------
const createPayment = [
  isUUID('loanId'),
  body('amount').isFloat({ min: 1 }).withMessage('Payment amount must be greater than 0'),
  body('paymentType').isIn(PAYMENT_TYPES).withMessage(`Payment type must be one of: ${PAYMENT_TYPES.join(', ')}`),
  body('paymentMethod').isIn(PAYMENT_METHODS).withMessage(`Payment method must be one of: ${PAYMENT_METHODS.join(', ')}`),
  isDateStr('paymentDate'),
  body('referenceNumber').optional({ nullable: true }).trim().isLength({ max: 100 }),
  body('notes').optional({ nullable: true }).trim().isLength({ max: 500 }),
];

// ----------------------------------------------------------------
// GOLD RATES
// ----------------------------------------------------------------
const createGoldRate = [
  body('ratePerGram')
    .isFloat({ min: 1000, max: 1000000 }).withMessage('Gold rate must be between ₹1,000 and ₹10,00,000 per gram'),
  isDateStr('effectiveDate'),
  body('source').optional().trim().isLength({ max: 100 }),
];

// ----------------------------------------------------------------
// SETTINGS
// ----------------------------------------------------------------
const updateSettings = [
  body('settings')
    .isArray({ min: 1 }).withMessage('Settings must be a non-empty array'),
  body('settings.*.key')
    .trim().notEmpty().withMessage('Setting key is required')
    .isLength({ max: 100 }),
  body('settings.*.value')
    .notEmpty().withMessage('Setting value is required')
    .isLength({ max: 1000 }),
];

// ----------------------------------------------------------------
// COMMON PARAMS
// ----------------------------------------------------------------
const uuidParam = (paramName = 'id') => [
  param(paramName).isUUID(4).withMessage(`${paramName} must be a valid UUID`),
];

const pagination = [
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer').toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100').toInt(),
  query('sortBy').optional().trim().isLength({ max: 50 }),
  query('sortOrder').optional().isIn(['asc', 'desc']).withMessage('sortOrder must be asc or desc'),
];

const dateRangeQuery = [
  query('fromDate').optional().isISO8601().toDate().withMessage('fromDate must be a valid date'),
  query('toDate').optional().isISO8601().toDate().withMessage('toDate must be a valid date'),
];

module.exports = {
  validate,
  rules: {
    login,
    verifyTotp,
    changePassword,
    createUser,
    updateUser,
    createCustomer,
    updateCustomer,
    goldItemBody,
    createLoan,
    updateLoan,
    createPayment,
    createGoldRate,
    updateSettings,
    uuidParam,
    pagination,
    dateRangeQuery,
  },
};
