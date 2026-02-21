'use strict';

/**
 * setupDb.js
 * One-time database setup utility.
 * Run with: node setupDb.js
 * Reads schema.sql and executes it against the configured database.
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME     || 'digital_girvi',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const run = async () => {
  const client = await pool.connect();
  try {
    console.log('✅ Connected to database:', process.env.DB_NAME);

    const schemaPath = path.join(__dirname, 'schema.sql');
    if (!fs.existsSync(schemaPath)) {
      throw new Error(`schema.sql not found at ${schemaPath}`);
    }

    const sql = fs.readFileSync(schemaPath, 'utf8');
    console.log('📄 Executing schema.sql...');

    await client.query(sql);

    console.log('🎉 Database setup complete!');
    console.log('');
    console.log('Default admin credentials:');
    console.log('  Username : admin');
    console.log('  Password : Admin@123');
    console.log('  ⚠️  Change this password immediately after first login!');
  } catch (err) {
    console.error('❌ Setup failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

run();
