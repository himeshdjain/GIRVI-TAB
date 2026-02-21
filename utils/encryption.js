'use strict';

/**
 * encryption.js
 * Provides:
 *  - AES-256-GCM symmetric encryption / decryption for sensitive fields
 *    (TOTP secrets, customer ID numbers, etc.)
 *  - TOTP (Time-based One-Time Password) helpers via otplib
 *  - QR-code generation for authenticator app setup
 */

const crypto  = require('crypto');
const { authenticator } = require('otplib');
const QRCode  = require('qrcode');

// ----------------------------------------------------------------
// Constants
// ----------------------------------------------------------------
const ALGORITHM    = 'aes-256-gcm';
const IV_LENGTH    = 12;   // 96-bit IV recommended for GCM
const TAG_LENGTH   = 16;   // 128-bit auth tag
const ENCODING     = 'hex';

// ----------------------------------------------------------------
// Derive the 32-byte key from the environment variable.
// The env var should be a 64-character hex string (32 bytes).
// ----------------------------------------------------------------
const getKey = () => {
  const hexKey = process.env.ENCRYPTION_KEY;
  if (!hexKey || hexKey.length !== 64) {
    throw new Error(
      'ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(hexKey, ENCODING);
};

// ----------------------------------------------------------------
// encrypt(plaintext) → "<iv_hex>:<tag_hex>:<ciphertext_hex>"
// ----------------------------------------------------------------
const encrypt = (plaintext) => {
  if (plaintext === null || plaintext === undefined) return null;
  const key        = getKey();
  const iv         = crypto.randomBytes(IV_LENGTH);
  const cipher     = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  const encrypted  = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString(ENCODING),
    tag.toString(ENCODING),
    encrypted.toString(ENCODING),
  ].join(':');
};

// ----------------------------------------------------------------
// decrypt("<iv_hex>:<tag_hex>:<ciphertext_hex>") → plaintext
// ----------------------------------------------------------------
const decrypt = (ciphertext) => {
  if (ciphertext === null || ciphertext === undefined) return null;
  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid ciphertext format. Expected iv:tag:data');
  }
  const [ivHex, tagHex, dataHex] = parts;
  const key      = getKey();
  const iv       = Buffer.from(ivHex,  ENCODING);
  const tag      = Buffer.from(tagHex, ENCODING);
  const data     = Buffer.from(dataHex, ENCODING);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
};

// ----------------------------------------------------------------
// maskIdNumber(idNumber) → "XXXX-XXXX-1234"
// Shows only last 4 characters, rest replaced with X groups.
// ----------------------------------------------------------------
const maskIdNumber = (idNumber) => {
  if (!idNumber) return '';
  const str  = String(idNumber).replace(/\s/g, '');
  const last4 = str.slice(-4);
  const masked = str.slice(0, -4).replace(/./g, 'X');
  // Group into 4-char chunks for readability
  const grouped = (masked + last4).match(/.{1,4}/g) || [];
  return grouped.join('-');
};

// ----------------------------------------------------------------
// TOTP — generate a new secret for a user
// ----------------------------------------------------------------
const generateTotpSecret = () => authenticator.generateSecret(20);

// ----------------------------------------------------------------
// TOTP — verify a 6-digit token against the (decrypted) secret
// A window of 1 means we accept the previous and next 30s window
// to account for minor clock drift.
// ----------------------------------------------------------------
authenticator.options = { window: 1 };

const verifyTotp = (token, secret) => {
  try {
    return authenticator.verify({ token: String(token), secret });
  } catch {
    return false;
  }
};

// ----------------------------------------------------------------
// TOTP — generate the current token (for testing / admin reset)
// ----------------------------------------------------------------
const generateTotpToken = (secret) => authenticator.generate(secret);

// ----------------------------------------------------------------
// TOTP — generate an otpauth:// URI for QR code generation
// ----------------------------------------------------------------
const getTotpUri = (username, secret, issuer = 'Digital Girvi') =>
  authenticator.keyuri(username, issuer, secret);

// ----------------------------------------------------------------
// TOTP — generate a base64 PNG QR code data URL
// Usage: const dataUrl = await generateTotpQrCode(username, secret);
// Embed directly in <img src="..."> for the setup page.
// ----------------------------------------------------------------
const generateTotpQrCode = async (username, secret, issuer = 'Digital Girvi') => {
  const uri = getTotpUri(username, secret, issuer);
  return QRCode.toDataURL(uri);
};

// ----------------------------------------------------------------
// Hash comparison helper (constant-time) for sensitive string comparison
// ----------------------------------------------------------------
const safeCompare = (a, b) => {
  try {
    return crypto.timingSafeEqual(Buffer.from(String(a)), Buffer.from(String(b)));
  } catch {
    return false;
  }
};

// ----------------------------------------------------------------
// Generate a cryptographically secure random token (for refresh tokens, etc.)
// ----------------------------------------------------------------
const generateSecureToken = (bytes = 40) =>
  crypto.randomBytes(bytes).toString(ENCODING);

// ----------------------------------------------------------------
// Hash a token for storage (SHA-256, non-reversible)
// Use this to store refresh tokens — never store raw tokens.
// ----------------------------------------------------------------
const hashToken = (token) =>
  crypto.createHash('sha256').update(String(token)).digest(ENCODING);

module.exports = {
  encrypt,
  decrypt,
  maskIdNumber,
  generateTotpSecret,
  verifyTotp,
  generateTotpToken,
  getTotpUri,
  generateTotpQrCode,
  safeCompare,
  generateSecureToken,
  hashToken,
};
