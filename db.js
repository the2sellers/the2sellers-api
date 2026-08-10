const { Pool } = require('pg');

// On Render, set DATABASE_URL to your free Neon (or Render Postgres) connection string.
// Locally, it falls back to a local Postgres for testing.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:testpass123@localhost:5432/the2sellers_test',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'reviewer',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS listings (
      id SERIAL PRIMARY KEY,

      seller_name TEXT NOT NULL,
      seller_email TEXT NOT NULL,
      seller_phone TEXT,
      storefront_link TEXT,

      years_in_business TEXT,
      num_skus TEXT,
      marketplaces TEXT,
      niche TEXT,
      fulfillment_model TEXT,

      monthly_sales TEXT,
      last_12mo_sales TEXT,
      monthly_profit TEXT,
      last_12mo_profit TEXT,
      inventory_value TEXT,
      asking_price TEXT,

      brand_registered TEXT,
      trademark TEXT,
      patent TEXT,

      reason_for_selling TEXT,

      public_title TEXT,
      public_summary TEXT,
      public_description TEXT,
      display_price TEXT,

      status TEXT NOT NULL DEFAULT 'pending',
      reviewed_by INTEGER REFERENCES admin_users(id),
      internal_notes TEXT,

      submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      published_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS buyer_inquiries (
      id SERIAL PRIMARY KEY,
      buyer_name TEXT NOT NULL,
      buyer_email TEXT NOT NULL,
      buyer_phone TEXT,
      desired_marketplaces TEXT,
      preferred_niche TEXT,
      budget TEXT,
      min_monthly_profit TEXT,
      timeline TEXT,
      buying_experience TEXT,
      notes TEXT,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
    CREATE INDEX IF NOT EXISTS idx_listings_niche ON listings(niche);
  `);
}

module.exports = { pool, initSchema };
