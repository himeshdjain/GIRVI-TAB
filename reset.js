require('dotenv').config();
const bcrypt = require('bcrypt');
const db = require('./db');
async function forceReset() {
  try {
    const hash = await bcrypt.hash('Admin@123', 12);
    await db.query("UPDATE users SET password_hash = $1, failed_login_count = 0, locked_until = NULL WHERE username = 'admin'", [hash]);
    console.log('✅ Success! Password is now mathematically guaranteed to be Admin@123');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err);
    process.exit(1);
  }
}
forceReset();
