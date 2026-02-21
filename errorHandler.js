'use strict';

/**
 * errorHandler.js
 * Centralised Express error handling middleware.
 *
 * Catches all errors passed via next(err) and returns a clean JSON response.
 * Maps known error types to appropriate HTTP status codes.
 * Sanitises stack traces — only exposed in development.
 */

const logger = require('./logger');

// ----------------------------------------------------------------
// Known PostgreSQL error codes → HTTP status mappings
// ----------------------------------------------------------------
const PG_ERROR_MAP = {
  '23505': { status: 409, message: 'A record with these details already exists.' },   // unique_violation
  '23503': { status: 409, message: 'Referenced record does not exist.' },              // foreign_key_violation
  '23502': { status: 400, message: 'A required field is missing.' },                   // not_null_violation
  '22001': { status: 400, message: 'Input value is too long for the field.' },         // string_data_right_truncation
  '22P02': { status: 400, message: 'Invalid input format (e.g. bad UUID or number).' },// invalid_text_representation
  '42703': { status: 400, message: 'Unknown column referenced in query.' },            // undefined_column
  '08006': { status: 503, message: 'Database connection failure.' },                   // connection_failure
  '08001': { status: 503, message: 'Unable to connect to the database.' },
  '57014': { status: 504, message: 'Database query timed out.' },                      // query_canceled
};

// ----------------------------------------------------------------
// AppError — use this class to throw operational errors anywhere
// in the codebase. They will be handled gracefully.
//
// Usage:
//   throw new AppError('Loan not found', 404);
//   throw new AppError('Insufficient permission', 403, 'FORBIDDEN');
// ----------------------------------------------------------------
class AppError extends Error {
  constructor(message, statusCode = 500, code = null, details = null) {
    super(message);
    this.name       = 'AppError';
    this.statusCode = statusCode;
    this.code       = code;
    this.details    = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

// ----------------------------------------------------------------
// notFound — attach as a catch-all BEFORE errorHandler to handle
// requests to undefined routes.
// app.use(notFound);
// app.use(errorHandler);
// ----------------------------------------------------------------
const notFound = (req, res, next) => {
  const err = new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404, 'NOT_FOUND');
  next(err);
};

// ----------------------------------------------------------------
// errorHandler — the main error-handling middleware.
// Must be registered LAST in the Express middleware chain.
// ----------------------------------------------------------------
const errorHandler = (err, req, res, next) => { // eslint-disable-line no-unused-vars
  const isDev = process.env.NODE_ENV === 'development';

  // ---- Derive status & message -----------------------------------

  let status  = err.statusCode || err.status || 500;
  let message = err.message    || 'An unexpected error occurred.';
  let code    = err.code       || 'INTERNAL_ERROR';
  let details = err.details    || null;

  // express-validator ValidationError (from validate.js)
  if (err.type === 'validation') {
    status  = 422;
    message = 'Validation failed.';
    code    = 'VALIDATION_ERROR';
    details = err.errors;
  }

  // PostgreSQL errors
  if (err.code && PG_ERROR_MAP[err.code]) {
    const mapped = PG_ERROR_MAP[err.code];
    status  = mapped.status;
    message = mapped.message;
    code    = `PG_${err.code}`;
  }

  // JWT errors (shouldn't normally reach here — auth.js handles these)
  if (err.name === 'JsonWebTokenError')  { status = 401; message = 'Invalid token.';          code = 'JWT_INVALID'; }
  if (err.name === 'TokenExpiredError')  { status = 401; message = 'Token has expired.';       code = 'JWT_EXPIRED'; }
  if (err.name === 'NotBeforeError')     { status = 401; message = 'Token not yet valid.';     code = 'JWT_NOT_BEFORE'; }

  // Multer file upload errors
  if (err.code === 'LIMIT_FILE_SIZE')    { status = 413; message = 'Uploaded file is too large.'; code = 'FILE_TOO_LARGE'; }
  if (err.code === 'LIMIT_UNEXPECTED_FILE') { status = 400; message = 'Unexpected file field.';   code = 'UNEXPECTED_FILE'; }

  // SyntaxError from malformed JSON body
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    status  = 400;
    message = 'Invalid JSON in request body.';
    code    = 'INVALID_JSON';
  }

  // ---- Log -------------------------------------------------------

  if (status >= 500) {
    logger.error('Unhandled server error', {
      status,
      message,
      path:   req.originalUrl,
      method: req.method,
      userId: req.user?.id || null,
      error:  err.message,
      stack:  err.stack,
    });
  } else {
    logger.warn('Client error', {
      status,
      message,
      path:   req.originalUrl,
      method: req.method,
      userId: req.user?.id || null,
    });
  }

  // ---- Respond ---------------------------------------------------

  const body = {
    success: false,
    error:   message,
    code,
  };

  if (details)  body.details = details;
  if (isDev)    body.stack   = err.stack;

  return res.status(status).json(body);
};

// ----------------------------------------------------------------
// asyncHandler — wraps async route handlers so you don't need
// try/catch in every controller. Passes errors to next().
//
// Usage:
//   router.get('/loans', asyncHandler(async (req, res) => { ... }));
// ----------------------------------------------------------------
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { AppError, notFound, errorHandler, asyncHandler };
