const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Required for Neon
  },
  keepAlive: true
});

// This will log the specific error to your Vercel "Functions" log
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

module.exports = pool;
