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
    // 'available' | 'under_offer' | 'sold' — independent of the review-workflow status above.
  // A published listing can be sold/under offer and still stay visible with the right badge.
  await pool.query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS sale_status TEXT NOT NULL DEFAULT 'available';`);

  // Rotating homepage banners — replaces the old hardcoded "What We Actually Do"
  // card list with something manageable from the admin panel.
  await pool.query(`
      CREATE TABLE IF NOT EXISTS banners (
            id SERIAL PRIMARY KEY,
                  label TEXT NOT NULL,          -- small eyebrow tag, e.g. "Account Management"
                        head TEXT NOT NULL,           -- headline, e.g. "Ownership, not tasks."
                              sub TEXT,                     -- one-line subtitle
                                    badge TEXT,                   -- small pill text, e.g. "New" — optional, no pricing
                                          dest TEXT,                    -- link destination when clicked, e.g. "#account-management"
                                                display_order INTEGER NOT NULL DEFAULT 0,
                                                      is_active BOOLEAN NOT NULL DEFAULT true,
                                                            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                                                                  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
                                                                      );
                                                                        `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_banners_active_order ON banners(is_active, display_order);`);

  // Seed with the existing service cards, once only — never overwrites edits made later.
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
