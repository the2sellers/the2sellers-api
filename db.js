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
  // 'available' | 'under_offer' | 'sold' â independent of the review-workflow status above.
  // A published listing can be sold/under offer and still stay visible with the right badge.
  await pool.query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS sale_status TEXT NOT NULL DEFAULT 'available';`);

  // Rotating homepage banners â replaces the old hardcoded "What We Actually Do"
  // card list with something manageable from the admin panel.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS banners (
      id SERIAL PRIMARY KEY,
      label TEXT NOT NULL,          -- small eybrow tag, e.g. "Account Management"
      head TEXT NOT NULL,           -- headline, e.g. "Ownership, not tasks."
      sub TEXT,                     -- one-line subtitle
      badge TEXT,                   -- small pill text, e.g. "New" â optional, no pricing
      dest TEXT,                    -- link destination when clicked, e.g. "#account-management"
      display_order INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_banners_active_order ON banners(is_active, display_order);`);

  // Safe migrations for the banner image/layout feature â adds columns if this
  // table already existed before these fields were introduced.
  // layout: 'text' (no image) | 'background' (full-bleed photo, text overlaid) | 'split' (photo one side, text the other)
  await pool.query(`ALTER TABLE banners ADD COLUMN IF NOT EXISTS layout TEXT NOT NULL DEFAULT 'text';`);
  // Uploaded image, stored as a base64 data URI so it works reliably without needing
  // separate file storage (Render's own disk doesn't persist across deploys).
  await pool.query(`ALTER TABLE banners ADD COLUMN IF NOT EXISTS image_data TEXT;`);
  await pool.query(`ALTER TABLE banners ADD COLUMN IF NOT EXISTS img_size TEXT NOT NULL DEFAULT 'medium';`);
  await pool.query(`ALTER TABLE banners ADD COLUMN IF NOT EXISTS img_focus TEXT NOT NULL DEFAULT 'upper';`);
  await pool.query(`ALTER TABLE banners ADD COLUMN IF NOT EXISTS img_style TEXT NOT NULL DEFAULT 'fade';`);

  // Seed with the existing service cards, once only â never overwrites edits made later.
  const { rows: bannerCountRows } = await pool.query('SELECT COUNT(*)::int AS c FROM banners');
  if (bannerCountRows[0].c === 0) {
    const seedBanners = [
      ['Launch', 'From zero to live in weeks.', 'New listings, built right the first time.', null, 'services.html'],
      ['Growth', 'Scale what', 'SEO and catalog expansion.', null, 'services.html'],
      ['Protection', 'Guard the account you built.', 'Policy, compliance, appeals handled.', null, 'account-management.html'],
      ['Rescue', 'Suspended? We', '1,800+ accounts reinstated.', null, 'account-management.html'],
      ['Account Management', 'Ownership, not tasks.', 'A VA executes. We run the business.', null, 'account-management.html'],
      ['PPC Audit', 'Every pound. Accounted for.', 'See where your ad spend really goes.', null, 'ppc-audit.html'],
      ['International Expansion', 'New marketplace? Opened doors before.', 'Launch into a market you', null, 'services.html'],
      ['Full Ads Management', 'We run it, not just audit it.', 'Ongoing PPC management, hands-on.', null, 'ppc-audit.html'],
    ];
    for (let i = 0; i < seedBanners.length; i++) {
      const [label, head, sub, badge, dest] = seedBanners[i];
      await pool.query(
        `INSERT INTO banners (label, head, sub, badge, dest, display_order) VALUES ($1,$2,$3,$4,$5,$6)`,
        [label, head, sub, badge, dest, i]
      );
    }
  }

  // Events: ticketed seminars and online sessions, with their orders and tickets.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      city TEXT NOT NULL,
      title TEXT NOT NULL,
      subline TEXT,
      venue TEXT,
      address TEXT,
      starts_at TIMESTAMPTZ,
      ends_at TIMESTAMPTZ,
      timezone TEXT NOT NULL DEFAULT 'Australia/Adelaide',
      currency TEXT NOT NULL DEFAULT 'aud',
      ticket_price_cents INTEGER NOT NULL DEFAULT 0,
      dinner_price_cents INTEGER,
      dinner_capacity INTEGER NOT NULL DEFAULT 0,
      capacity INTEGER NOT NULL DEFAULT 0,
      min_attendance INTEGER NOT NULL DEFAULT 0,
      refund_cutoff_days INTEGER NOT NULL DEFAULT 7,
      status TEXT NOT NULL DEFAULT 'draft',
      is_online BOOLEAN NOT NULL DEFAULT false,
      banner_type TEXT NOT NULL DEFAULT 'city',
      banner_image_data TEXT,
      banner_size TEXT NOT NULL DEFAULT 'medium',
      banner_focus TEXT NOT NULL DEFAULT 'upper',
      banner_overlay INTEGER NOT NULL DEFAULT 60,
      banner_text_pos TEXT NOT NULL DEFAULT 'left',
      banner_caption TEXT,
      intro_video_url TEXT,
      button_text TEXT NOT NULL DEFAULT 'Reserve my seat',
      includes_text TEXT,
      agenda JSONB NOT NULL DEFAULT '[]'::jsonb,
      faq JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id),
      buyer_name TEXT NOT NULL,
      buyer_email TEXT NOT NULL,
      qty INTEGER NOT NULL DEFAULT 1,
      dinner_qty INTEGER NOT NULL DEFAULT 0,
      amount_cents INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'aud',
      status TEXT NOT NULL DEFAULT 'pending',
      stripe_session_id TEXT UNIQUE,
      stripe_payment_intent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      paid_at TIMESTAMPTZ,
      refunded_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS tickets (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      event_id INTEGER NOT NULL REFERENCES events(id),
      code TEXT NOT NULL UNIQUE,
      holder_name TEXT,
      has_dinner BOOLEAN NOT NULL DEFAULT false,
      checked_in_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_orders_event ON orders(event_id, status);
    CREATE INDEX IF NOT EXISTS idx_tickets_event ON tickets(event_id);
  `);

  await pool.query('ALTER TABLE events ADD COLUMN IF NOT EXISTS featured_home BOOLEAN NOT NULL DEFAULT false');
  // Event extras: a per-event price note, plus the host profile, press items and reviews
  // that the public event pages show as social proof.
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS price_note TEXT;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS host_profile (
      id INTEGER PRIMARY KEY DEFAULT 1,
      name TEXT,
      headline TEXT,
      bio TEXT,
      photo_data TEXT,
      video_url TEXT,
      press_mode TEXT NOT NULL DEFAULT 'auto',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT host_profile_single_row CHECK (id = 1)
    );
    CREATE TABLE IF NOT EXISTS press_items (
      id SERIAL PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'article',
      name TEXT NOT NULL,
      url TEXT,
      logo_data TEXT,
      item_date DATE,
      is_active BOOLEAN NOT NULL DEFAULT true,
      display_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id SERIAL PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'text',
      author TEXT NOT NULL,
      detail TEXT,
      body TEXT,
      rating INTEGER,
      source TEXT,
      source_url TEXT,
      video_url TEXT,
      is_active BOOLEAN NOT NULL DEFAULT true,
      display_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(
    `INSERT INTO host_profile (id, name, bio) VALUES (1, $1, $2) ON CONFLICT (id) DO NOTHING`,
    ['Bilal Aftab', 'Fifteen years inside the marketplace. Ten thousand brands launched, grown, defended and rescued.']
  );
  // Seed the press strip once, from the appearances supplied by the owner.
  const { rows: pressCountRows } = await pool.query('SELECT COUNT(*)::int AS c FROM press_items');
  if (pressCountRows[0].c === 0) {
    const seedPress = [
      ['podcast', 'Munir Ahmad Podcast', 'https://www.youtube.com/watch?v=UAU7qsIvThg'],
      ['podcast', 'From Riches to Rags and Back to Riches', 'https://www.youtube.com/watch?v=Wrz8NF8KwiI'],
      ['profile', 'Connected Pakistan', 'https://people.connectedpakistan.pk/muhammad-bilal-aftab'],
      ['article', 'Startup Pakistan', 'https://startuppakistan.com.pk/muhammad-bilal-aftab-owns-multiple-7-figure-amazon-brands/'],
      ['article', 'TechBullion', 'https://techbullion.com/muhammad-bilal-aftab-ceo-of-the-xii-group-among-the-top-amazon-sellers-british-asian-entrepreneurs/']
    ];
    for (let i = 0; i < seedPress.length; i++) {
      await pool.query('INSERT INTO press_items (kind, name, url, display_order) VALUES ($1, $2, $3, $4)', [seedPress[i][0], seedPress[i][1], seedPress[i][2], i]);
    }
  }

  // Single-row table holding site-wide settings (currently just social links).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS site_settings (
      id INT PRIMARY KEY DEFAULT 1,
      facebook_url TEXT,
      youtube_url TEXT,
      linkedin_url TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT site_settings_single_row CHECK (id = 1)
    );
  `);
  await pool.query(`INSERT INTO site_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;`);
}

module.exports = { pool, initSchema };
