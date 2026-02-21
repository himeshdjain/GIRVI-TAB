'use strict';

/**
 * logger.js
 * Winston-based structured logger for Digital Girvi.
 * Outputs JSON in production, colorized text in development.
 */

const { createLogger, format, transports } = require('winston');
require('winston-daily-rotate-file');
const path = require('path');

const LOG_DIR  = process.env.LOG_DIR   || './logs';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const isDev    = process.env.NODE_ENV !== 'production';

const logger = createLogger({
  level: LOG_LEVEL,
  defaultMeta: { service: 'digital-girvi' },
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    format.errors({ stack: true }),
    format.json()
  ),
  transports: [
    // Console
    new transports.Console({
      format: isDev
        ? format.combine(format.colorize(), format.simple())
        : format.json(),
    }),
    // Rotating file — all logs
    new transports.DailyRotateFile({
      dirname:       LOG_DIR,
      filename:      'app-%DATE%.log',
      datePattern:   'YYYY-MM-DD',
      zippedArchive: true,
      maxSize:       '20m',
      maxFiles:      '30d',
    }),
    // Rotating file — errors only
    new transports.DailyRotateFile({
      dirname:       LOG_DIR,
      filename:      'error-%DATE%.log',
      datePattern:   'YYYY-MM-DD',
      level:         'error',
      zippedArchive: true,
      maxSize:       '20m',
      maxFiles:      '90d',
    }),
  ],
  exitOnError: false,
});

module.exports = logger;
