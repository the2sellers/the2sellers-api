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
      public_monthly_profit TEXT,

      status TEXT NOT NULL DEFAULT 'pending',
      reviewed_by INTEGER REFERENCES admin_users(id),
      internal_notes TEXT,

      submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      published_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS listing_interest (
      id SERIAL PRIMARY KEY,
      listing_id INTEGER REFERENCES listings(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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

    CREATE TABLE IF NOT EXISTS service_inquiries (
      id SERIAL PRIMARY KEY,
      service_type TEXT NOT NULL, -- 'ppc_audit' | 'account_management' | 'listing_optimizer' | 'general_contact'
      full_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      whatsapp TEXT,
      details TEXT,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_service_inquiries_type ON service_inquiries(service_type);

    CREATE TABLE IF NOT EXISTS blog_posts (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      excerpt TEXT,
      content TEXT,
      author TEXT,
      status TEXT NOT NULL DEFAULT 'draft', -- 'draft' | 'published'
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      published_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_blog_posts_status ON blog_posts(status);
    CREATE INDEX IF NOT EXISTS idx_blog_posts_slug ON blog_posts(slug);
  `);

  // Safe migration: adds the column if this table already existed before this field was introduced.
  await pool.query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS public_monthly_profit TEXT;`);
}

module.exports = { pool, initSchema };
