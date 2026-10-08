require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { pool, initSchema } = require('./db');
const multer = require('multer');
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 8 } // 10MB per file, max 8 files
});
const { checkPassword, createToken, requireAuth, requireAdmin } = require('./auth');
const { sendNotification } = require('./email');

const app = express();
app.use(cors());
app.use(express.json({ verify: function (req, res, buf) { req.rawBody = buf; } }));
app.use('/admin', express.static(require('path').join(__dirname, 'admin')));
require('./bookings')(app, pool);

const PORT = process.env.PORT || 4000;

// Tells Bing (and other IndexNow-compatible engines) about a page the moment
// it goes live, instead of waiting for their normal crawl schedule. Never
// throws - if this fails for any reason, publishing itself should still succeed.
const INDEXNOW_KEY = 'bf71bc2fa0d15d5124517f40712e7877';
async function pingIndexNow(slug) {
    try {
          const url = `https://the2sellers.io/blog-post.html?slug=${encodeURIComponent(slug)}`;
          const pingUrl = `https://www.bing.com/indexnow?url=${encodeURIComponent(url)}&key=${INDEXNOW_KEY}`;
          await fetch(pingUrl);
    } catch (err) {
          console.error('IndexNow ping failed (non-fatal):', err.message);
    }
}

// Wrap async route handlers so thrown errors reach Express's error handler
// instead of crashing the process or hanging the request.
const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ============================================================
// PUBLIC — sell/buy form submissions
// ============================================================

app.post('/api/listings', ah(async (req, res) => {
    const b = req.body;
    if (!b.seller_name || !b.seller_email) {
          return res.status(400).json({ error: 'seller_name and seller_email are required' });
    }
    const { rows } = await pool.query(
          `INSERT INTO listings (
                seller_name, seller_email, seller_phone, storefront_link,
                      years_in_business, num_skus, marketplaces, niche, fulfillment_model,
                            monthly_sales, last_12mo_sales, monthly_profit, last_12mo_profit,
                                  inventory_value, asking_price,
                                        brand_registered, trademark, patent, reason_for_selling
                                            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
                                                RETURNING id`,
          [
                  b.seller_name, b.seller_email, b.seller_phone || null, b.storefront_link || null,
                  b.years_in_business || null, b.num_skus || null, b.marketplaces || null,
                  b.niche || null, b.fulfillment_model || null,
                  b.monthly_sales || null, b.last_12mo_sales || null, b.monthly_profit || null,
                  b.last_12mo_profit || null, b.inventory_value || null, b.asking_price || null,
                  b.brand_registered || null, b.trademark || null, b.patent || null,
                  b.reason_for_selling || null
                ]
        );
    res.status(201).json({ id: rows[0].id, status: 'pending' });

                               await sendNotification(
                                     `New FBA Business For Sale — ${b.seller_name}`,
                                     `A new seller submission just came in.\n\n` +
                                     `Name: ${b.seller_name}\n` +
                                     `Email: ${b.seller_email}\n` +
                                     `Phone: ${b.seller_phone || '—'}\n` +
                                     `Niche: ${b.niche || '—'}\n` +
                                     `Marketplaces: ${b.marketplaces || '—'}\n` +
                                     `Monthly profit: ${b.monthly_profit || '—'}\n` +
                                     `Asking price: ${b.asking_price || '—'}\n\n` +
                                     `Review it here: https://the2sellers-api.onrender.com/admin/index.html?status=pending`
                                   );
}));

app.post('/api/buyer-inquiries', ah(async (req, res) => {
    const b = req.body;
    if (!b.buyer_name || !b.buyer_email) {
          return res.status(400).json({ error: 'buyer_name and buyer_email are required' });
    }
    const { rows } = await pool.query(
          `INSERT INTO buyer_inquiries (
                buyer_name, buyer_email, buyer_phone, desired_marketplaces,
                      preferred_niche, budget, min_monthly_profit, timeline, buying_experience, notes
                          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                              RETURNING id`,
          [
                  b.buyer_name, b.buyer_email, b.buyer_phone || null, b.desired_marketplaces || null,
                  b.preferred_niche || null, b.budget || null, b.min_monthly_profit || null,
                  b.timeline || null, b.buying_experience || null, b.notes || null
                ]
        );
    res.status(201).json({ id: rows[0].id });

                                      await sendNotification(
                                            `New FBA Buyer Inquiry — ${b.buyer_name}`,
                                            `A new buyer inquiry just came in.\n\n` +
                                            `Name: ${b.buyer_name}\n` +
                                            `Email: ${b.buyer_email}\n` +
                                            `Phone: ${b.buyer_phone || '—'}\n` +
                                            `Desired marketplaces: ${b.desired_marketplaces || '—'}\n` +
                                            `Preferred niche: ${b.preferred_niche || '—'}\n` +
                                            `Budget: ${b.budget || '—'}\n` +
                                            `Minimum monthly profit: ${b.min_monthly_profit || '—'}\n` +
                                            `Timeline: ${b.timeline || '—'}\n\n` +
                                            `View it here: https://the2sellers-api.onrender.com/admin/inquiries.html`
                                          );
}));

// ============================================================
// PUBLIC — browse published listings
// ============================================================

app.get('/api/public/site-settings', ah(async (req, res) => {
    const { rows } = await pool.query('SELECT facebook_url, youtube_url, linkedin_url FROM site_settings WHERE id = 1');
    res.json(rows[0] || { facebook_url: null, youtube_url: null, linkedin_url: null });
}));

app.get('/api/admin/site-settings', requireAuth, ah(async (req, res) => {
    const { rows } = await pool.query('SELECT facebook_url, youtube_url, linkedin_url FROM site_settings WHERE id = 1');
    res.json(rows[0] || { facebook_url: null, youtube_url: null, linkedin_url: null });
}));

app.patch('/api/admin/site-settings', requireAuth, ah(async (req, res) => {
    const { facebook_url, youtube_url, linkedin_url } = req.body;
    const { rows } = await pool.query(
          `UPDATE site_settings SET facebook_url = $1, youtube_url = $2, linkedin_url = $3, updated_at = NOW()
               WHERE id = 1 RETURNING facebook_url, youtube_url, linkedin_url`,
          [facebook_url || null, youtube_url || null, linkedin_url || null]
        );
    res.json(rows[0]);
}));

// ============================================================
// HOMEPAGE BANNERS
// ============================================================

// Separate, smaller upload limit for banner images specifically — these load
// on every homepage visit, so a tighter cap than the 10MB inquiry-attachment
// limit keeps the page fast. Stored as a base64 data URI directly in the
// database row, since Render's own disk doesn't persist across deploys.
const uploadBannerImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPG, PNG, WEBP, or GIF images are allowed.'));
  }
});

// Events that the owner has ticked "Feature on the homepage banner" show up as hero slides,
// for as long as they are published, upcoming and not sold out.
const EVENT_CURRENCY_SYMBOLS = { aud: 'A$', gbp: '£', usd: 'US$', eur: '€', aed: 'AED ', cad: 'C$', nzd: 'NZ$', sgd: 'S$', pkr: 'PKR ', inr: '₹' };
async function featuredEventSlides() {
  const { rows } = await pool.query(
    "SELECT e.id, e.slug, e.city, e.title, e.venue, e.starts_at, e.timezone, e.is_online, e.currency, e.ticket_price_cents, e.capacity, e.banner_image_data, e.button_text, " +
    "(SELECT COUNT(*)::int FROM tickets t JOIN orders o ON o.id = t.order_id WHERE t.event_id = e.id AND o.status = 'paid') AS sold " +
    "FROM events e WHERE e.status = 'published' AND e.featured_home = true AND (e.starts_at IS NULL OR e.starts_at > NOW()) " +
    "ORDER BY e.starts_at ASC NULLS LAST, e.id ASC LIMIT 3");
  const site = process.env.SITE_URL || 'https://the2sellers.io';
  return rows.filter(function (r) { return r.capacity - r.sold > 0; }).map(function (r) {
    const left = r.capacity - r.sold;
    let when = '';
    try {
      if (r.starts_at) {
        const d = new Date(r.starts_at);
        when = new Intl.DateTimeFormat('en-AU', { timeZone: r.timezone || undefined, weekday: 'short', day: 'numeric', month: 'long' }).format(d) + ', ' +
          new Intl.DateTimeFormat('en-AU', { timeZone: r.timezone || undefined, hour: 'numeric', minute: '2-digit' }).format(d);
      }
    } catch (e) { when = ''; }
    const cur = String(r.currency || 'aud').toLowerCase();
    const price = r.ticket_price_cents ? (EVENT_CURRENCY_SYMBOLS[cur] !== undefined ? EVENT_CURRENCY_SYMBOLS[cur] : cur.toUpperCase() + ' ') + (r.ticket_price_cents / 100).toLocaleString('en-AU') : 'Free';
    const parts = [when, r.is_online ? 'Live online' : r.venue, price].filter(Boolean);
    return {
      id: 'event-' + r.id,
      label: r.is_online ? 'LIVE ONLINE' : 'LIVE IN ' + String(r.city || '').toUpperCase(),
      head: r.title,
      sub: parts.join(' · '),
      badge: left <= 20 ? 'Only ' + left + ' seat' + (left === 1 ? '' : 's') + ' left' : (r.ticket_price_cents ? '' : 'Free'),
      dest: site + '/events/' + r.slug,
      cta: r.button_text || 'Reserve my seat',
      layout: r.banner_image_data ? 'background' : 'text',
      image_data: r.banner_image_data || null,
      img_size: 'medium', img_focus: 'upper', img_style: 'fade'
    };
  });
}

app.get('/api/public/banners', ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, label, head, sub, badge, dest, layout, image_data, img_size, img_focus, img_style FROM banners
     WHERE is_active = true ORDER BY display_order ASC, id ASC`
  );
  let featured = [];
  try { featured = await featuredEventSlides(); } catch (e) { featured = []; }
  res.json(featured.concat(rows));
}));

app.get('/api/admin/banners', requireAuth, ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM banners ORDER BY display_order ASC, id ASC`
  );
  res.json(rows);
}));

app.get('/api/admin/banners/:id', requireAuth, ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM banners WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Banner not found' });
  res.json(rows[0]);
}));

app.post('/api/admin/banners', requireAuth, uploadBannerImage.single('image'), ah(async (req, res) => {
  const { label, head, sub, badge, dest, layout, img_size, img_focus, img_style, display_order, is_active } = req.body;
  if (!label || !head) return res.status(400).json({ error: 'label and head are required' });

  let image_data = null;
  if (req.file) {
    image_data = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
  }

  const is_active_val = (is_active === undefined) ? true : (is_active === true || is_active === 'true');
  const display_order_val = (display_order === undefined || display_order === '') ? 0 : parseInt(display_order, 10);

  const { rows } = await pool.query(
    `INSERT INTO banners (label, head, sub, badge, dest, layout, image_data, img_size, img_focus, img_style, display_order, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [label, head, sub || null, badge || null, dest || null, layout || 'text', image_data, ['small', 'medium', 'large'].includes(img_size) ? img_size : 'medium', ['top', 'upper', 'center', 'bottom'].includes(img_focus) ? img_focus : 'upper', ['fade', 'box'].includes(img_style) ? img_style : 'fade', display_order_val, is_active_val]
  );
  res.status(201).json(rows[0]);
}));

app.patch('/api/admin/banners/:id', requireAuth, uploadBannerImage.single('image'), ah(async (req, res) => {
  const fields = ['label', 'head', 'sub', 'badge', 'dest', 'layout', 'img_size', 'img_focus', 'img_style', 'display_order', 'is_active'];
  const setClauses = [];
  const params = [];
  fields.forEach((f) => {
    if (req.body[f] !== undefined) {
      let val = req.body[f];
      if (f === 'is_active') val = (val === true || val === 'true');
      if (f === 'display_order') val = parseInt(val, 10);
      params.push(val);
      setClauses.push(`${f} = $${params.length}`);
    }
  });

  // A new image was uploaded — replace the stored one.
  if (req.file) {
    const image_data = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    params.push(image_data);
    setClauses.push(`image_data = $${params.length}`);
  }
  // Explicit "remove the current image, don't replace it" request.
  if (req.body.remove_image === 'true' || req.body.remove_image === true) {
    setClauses.push(`image_data = NULL`);
  }

  if (setClauses.length === 0) return res.status(400).json({ error: 'No fields to update' });
  setClauses.push('updated_at = NOW()');
  params.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE banners SET ${setClauses.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!rows[0]) return res.status(404).json({ error: 'Banner not found' });
  res.json(rows[0]);
}));

app.delete('/api/admin/banners/:id', requireAuth, requireAdmin, ah(async (req, res) => {
  await pool.query('DELETE FROM banners WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

app.get('/api/public/listings', ah(async (req, res) => {
    const { niche, marketplace } = req.query;
    let sql = `
        SELECT id, public_title, public_summary, display_price, public_monthly_profit, niche, marketplaces,
                   fulfillment_model, sale_status, published_at
                       FROM listings WHERE status = 'published'
                         `;
    const params = [];
    if (niche) { params.push(niche); sql += ` AND niche = $${params.length}`; }
    if (marketplace) { params.push(`%${marketplace}%`); sql += ` AND marketplaces LIKE $${params.length}`; }
    sql += ' ORDER BY published_at DESC';
    const { rows } = await pool.query(sql, params);
    res.json(rows);
}));

app.get('/api/public/listings/:id', ah(async (req, res) => {
    const { rows } = await pool.query(
          `SELECT id, public_title, public_summary, public_description, display_price, public_monthly_profit,
                      niche, marketplaces, fulfillment_model, sale_status, years_in_business,
                                  num_skus, brand_registered, trademark, patent, published_at
                                       FROM listings WHERE id = $1 AND status = 'published'`,
          [req.params.id]
        );
    if (!rows[0]) return res.status(404).json({ error: 'Listing not found or not published' });
    res.json(rows[0]);
}));

// Fired when a visitor clicks "Interested? Get in touch" on a specific listing.
// Lightweight — no auth required (public visitors trigger this), logs the click,
// and emails the team immediately so they know which listing to expect a follow-up about.
app.post('/api/public/listings/:id/interest', ah(async (req, res) => {
    const { rows } = await pool.query(
          `SELECT id, public_title FROM listings WHERE id = $1 AND status = 'published'`,
          [req.params.id]
        );
    const listing = rows[0];
    if (!listing) return res.status(404).json({ error: 'Listing not found' });

                                                   await pool.query('INSERT INTO listing_interest (listing_id) VALUES ($1)', [listing.id]);
    res.status(201).json({ ok: true });

                                                   await sendNotification(
                                                         `Someone is interested in a listing — #${listing.id}`,
                                                         `A visitor just clicked "Interested" on:\n\n` +
                                                         `${listing.public_title || 'Listing #' + listing.id}\n` +
                                                         `https://the2sellers.io/fba-listing.html?id=${listing.id}\n\n` +
                                                         `They're being sent to the buyer inquiry form now — watch for their submission.`
                                                       );
}));

// ============================================================
// ADMIN — auth
// ============================================================

// ============================================================
// ONE-TIME SETUP — only works if zero admin accounts exist yet.
// Lets you create the first team login without needing shell access
// (Render's free tier doesn't include shell access). Permanently
// disables itself the moment one admin account exists.
// ============================================================

app.get('/api/setup/status', ah(async (req, res) => {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM admin_users');
    res.json({ setupAvailable: rows[0].count === 0 });
}));

app.post('/api/setup/create-first-admin', ah(async (req, res) => {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM admin_users');
    if (rows[0].count > 0) {
          return res.status(403).json({ error: 'Setup already completed — an admin account already exists.' });
    }
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
          return res.status(400).json({ error: 'name, email, and password are all required' });
    }
    if (password.length < 8) {
          return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const { hashPassword } = require('./auth');
    const result = await pool.query(
          'INSERT INTO admin_users (name, email, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id',
          [name, email, hashPassword(password), 'admin']
        );
    res.status(201).json({ id: result.rows[0].id, message: 'First admin account created.' });
}));

app.post('/api/admin/login', ah(async (req, res) => {
    const { email, password } = req.body;
    const { rows } = await pool.query('SELECT * FROM admin_users WHERE lower(email) = lower($1)', [String(email || '').trim()]);
    const user = rows[0];
    if (!user || !checkPassword(password, user.password_hash)) {
          return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (user.is_active === false) return res.status(403).json({ error: 'This account has been switched off. Please ask the administrator.' });
    res.json({ token: createToken(user), user: { id: user.id, name: user.name, email: user.email, role: user.role } });
}));

// ============================================================
// ADMIN — listings review workflow
// ============================================================

app.get('/api/admin/listings', requireAuth, ah(async (req, res) => {
    const { status } = req.query;
    let sql = 'SELECT * FROM listings';
    const params = [];
    if (status) { params.push(status); sql += ' WHERE status = $1'; }
    sql += ' ORDER BY submitted_at DESC';
    const { rows } = await pool.query(sql, params);
    res.json(rows);
}));

app.get('/api/admin/listings/:id', requireAuth, ah(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM listings WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Listing not found' });
    res.json(rows[0]);
}));

app.patch('/api/admin/listings/:id', requireAuth, ah(async (req, res) => {
    const { rows: existingRows } = await pool.query('SELECT * FROM listings WHERE id = $1', [req.params.id]);
    const listing = existingRows[0];
    if (!listing) return res.status(404).json({ error: 'Listing not found' });

                                                       const allowedFields = ['public_title', 'public_summary', 'public_description', 'display_price', 'public_monthly_profit', 'sale_status', 'status', 'internal_notes'];
    const setClauses = [];
    const params = [];

                                                       allowedFields.forEach((field) => {
                                                             if (req.body[field] !== undefined) {
                                                                     params.push(req.body[field]);
                                                                     setClauses.push(`${field} = $${params.length}`);
                                                             }
                                                       });
    if (setClauses.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

                                                       params.push(req.user.id);
    setClauses.push(`reviewed_by = $${params.length}`);
    setClauses.push(`updated_at = now()`);
    if (req.body.status === 'published' && listing.status !== 'published') {
          setClauses.push(`published_at = now()`);
    }

                                                       params.push(req.params.id);
    const { rows } = await pool.query(
          `UPDATE listings SET ${setClauses.join(', ')} WHERE id = $${params.length} RETURNING *`,
          params
        );
    res.json(rows[0]);
}));

app.delete('/api/admin/listings/:id', requireAuth, requireAdmin, ah(async (req, res) => {
    await pool.query('DELETE FROM listings WHERE id = $1', [req.params.id]);
    res.status(204).send();
}));

app.get('/api/admin/buyer-inquiries', requireAuth, ah(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM buyer_inquiries ORDER BY submitted_at DESC');
    res.json(rows);
}));

// ============================================================

// ============================================================
// SERVICE INQUIRIES — PPC Audit, Account Management, Listing
// Optimizer, and the general Contact Us form all funnel here.
// ============================================================

const SERVICE_LABELS = {
    ppc_audit: 'PPC Audit',
    account_management: 'Account Management',
    listing_optimizer: 'Listing Optimizer',
    general_contact: 'General Contact Form'
};

app.post('/api/service-inquiries', upload.array('files', 8), ah(async (req, res) => {
    const b = req.body;
    if (!b.service_type || !b.full_name || !b.email) {
          return res.status(400).json({ error: 'service_type, full_name, and email are required' });
    }
    const { rows } = await pool.query(
          `INSERT INTO service_inquiries (service_type, full_name, email, phone, whatsapp, details)
               VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [b.service_type, b.full_name, b.email, b.phone || null, b.whatsapp || null, b.details || null]
        );
    res.status(201).json({ id: rows[0].id });

                                                                  const label = SERVICE_LABELS[b.service_type] || b.service_type;
    const files = req.files || [];
    const attachments = files.map(function(f) {
          return { filename: f.originalname, content: f.buffer.toString('base64') };
    });
    const fileNote = files.length > 0
      ? `\n\nAttached files (${files.length}): ${files.map(function(f) { return f.originalname; }).join(', ')}`
          : '';

                                                                  await sendNotification(
                                                                        `New ${label} Inquiry — ${b.full_name}`,
                                                                        `A new inquiry came in via ${label}.\n\n` +
                                                                        `Name: ${b.full_name}\n` +
                                                                        `Email: ${b.email}\n` +
                                                                        `Phone: ${b.phone || '—'}\n` +
                                                                        `WhatsApp: ${b.whatsapp || '—'}\n\n` +
                                                                        `Details:\n${b.details || '—'}${fileNote}\n\n` +
                                                                        `View it here: https://the2sellers-api.onrender.com/admin/service-inquiries.html`,
                                                                        attachments
                                                                      );
}));

app.get('/api/admin/service-inquiries', requireAuth, ah(async (req, res) => {
    const { service_type } = req.query;
    let sql = 'SELECT * FROM service_inquiries';
    const params = [];
    if (service_type) { params.push(service_type); sql += ' WHERE service_type = $1'; }
    sql += ' ORDER BY submitted_at DESC';
    const { rows } = await pool.query(sql, params);
    res.json(rows);
}));

// ============================================================
// BLOG — same admin panel, new section. Public read-only
// endpoints only return published posts.
// ============================================================

function slugify(title) {
    return String(title).toLowerCase().trim()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 80);
}

app.get('/api/public/blog-posts', ah(async (req, res) => {
    const { rows } = await pool.query(
          `SELECT id, title, slug, excerpt, author, published_at
               FROM blog_posts WHERE status = 'published' ORDER BY published_at DESC`
        );
    res.json(rows);
}));

// Dynamic sitemap: static pages (fixed list below) + every published blog post,
// pulled live from the database so new posts never have to be added by hand.
app.get('/api/sitemap.xml', ah(async (req, res) => {
    const SITE = 'https://the2sellers.io';
    const staticPages = [
      { loc: `${SITE}/`, changefreq: 'weekly', priority: '1.0' },
      { loc: `${SITE}/portfolio.html`, changefreq: 'monthly', priority: '0.9' },
      { loc: `${SITE}/services.html`, changefreq: 'monthly', priority: '0.9' },
      { loc: `${SITE}/ppc-audit.html`, changefreq: 'monthly', priority: '0.9' },
      { loc: `${SITE}/account-management.html`, changefreq: 'monthly', priority: '0.9' },
      { loc: `${SITE}/buy-sell-fba.html`, changefreq: 'monthly', priority: '0.9' },
      { loc: `${SITE}/browse-fba.html`, changefreq: 'weekly', priority: '0.8' },
      { loc: `${SITE}/blog.html`, changefreq: 'weekly', priority: '0.7' },
      { loc: `${SITE}/privacy-policy.html`, changefreq: 'yearly', priority: '0.3' },
        ];

                                 const { rows: posts } = await pool.query(
                                       `SELECT slug, published_at, updated_at FROM blog_posts WHERE status = 'published' ORDER BY published_at DESC`
                                     );

                                 const fmtDate = (d) => new Date(d).toISOString().slice(0, 10);

                                 const staticXml = staticPages.map(p => `<url>
                                 <loc>${p.loc}</loc>
                                 <lastmod>${fmtDate(new Date())}</lastmod>
                                 <changefreq>${p.changefreq}</changefreq>
                                 <priority>${p.priority}</priority>
                                 </url>`).join('\n');

                                 const postsXml = posts.map(p => `<url>
                                 <loc>${SITE}/blog-post.html?slug=${encodeURIComponent(p.slug)}</loc>
                                 <lastmod>${fmtDate(p.updated_at || p.published_at)}</lastmod>
                                 <changefreq>monthly</changefreq>
                                 <priority>0.6</priority>
                                 </url>`).join('\n');

                                 res.set('Content-Type', 'application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    ${staticXml}
    ${postsXml}
    </urlset>`);
}));

app.get('/api/public/blog-posts/:slug', ah(async (req, res) => {
    const { rows } = await pool.query(
          `SELECT id, title, slug, excerpt, content, author, published_at
               FROM blog_posts WHERE slug = $1 AND status = 'published'`,
          [req.params.slug]
        );
    if (!rows[0]) return res.status(404).json({ error: 'Post not found or not published' });
    res.json(rows[0]);
}));

app.get('/api/admin/blog-posts', requireAuth, ah(async (req, res) => {
    const { status } = req.query;
    let sql = 'SELECT * FROM blog_posts';
    const params = [];
    if (status) { params.push(status); sql += ' WHERE status = $1'; }
    sql += ' ORDER BY updated_at DESC';
    const { rows } = await pool.query(sql, params);
    res.json(rows);
}));

app.get('/api/admin/blog-posts/:id', requireAuth, ah(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM blog_posts WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Post not found' });
    res.json(rows[0]);
}));

app.post('/api/admin/blog-posts', requireAuth, ah(async (req, res) => {
    const { title } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });

                                                    let slug = slugify(title);
    const { rows: existing } = await pool.query('SELECT id FROM blog_posts WHERE slug = $1', [slug]);
    if (existing.length > 0) slug = slug + '-' + Date.now().toString().slice(-5);

                                                    const { rows } = await pool.query(
                                                          `INSERT INTO blog_posts (title, slug, author) VALUES ($1, $2, $3) RETURNING id`,
                                                          [title, slug, req.user.name || 'The2Sellers.io Team']
                                                        );
    res.status(201).json({ id: rows[0].id, slug });
}));

app.patch('/api/admin/blog-posts/:id', requireAuth, ah(async (req, res) => {
    const { rows: existingRows } = await pool.query('SELECT * FROM blog_posts WHERE id = $1', [req.params.id]);
    const post = existingRows[0];
    if (!post) return res.status(404).json({ error: 'Post not found' });

                                                         const allowedFields = ['title', 'excerpt', 'content', 'author', 'status'];
    const setClauses = [];
    const params = [];
    allowedFields.forEach((field) => {
          if (req.body[field] !== undefined) {
                  params.push(req.body[field]);
                  setClauses.push(`${field} = $${params.length}`);
          }
    });
    if (setClauses.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

                                                         setClauses.push(`updated_at = now()`);
    if (req.body.status === 'published' && post.status !== 'published') {
          setClauses.push(`published_at = now()`);
    }

                                                         params.push(req.params.id);
    const { rows } = await pool.query(
          `UPDATE blog_posts SET ${setClauses.join(', ')} WHERE id = $${params.length} RETURNING *`,
          params
        );

                                                         // Notify Bing the moment a post is published or updated while already live -
                                                         // fire-and-forget, doesn't delay the response to the admin panel.
                                                         if (rows[0].status === 'published') {
                                                               pingIndexNow(rows[0].slug);
                                                         }

                                                         res.json(rows[0]);
}));

app.delete('/api/admin/blog-posts/:id', requireAuth, requireAdmin, ah(async (req, res) => {
    await pool.query('DELETE FROM blog_posts WHERE id = $1', [req.params.id]);
    res.status(204).send();
}));

// ============================================================
// EVENTS: ticketed seminars and online sessions
// ============================================================

const EVENT_TEXT_FIELDS = ['confirmation_note', 'city', 'title', 'subline', 'venue', 'address', 'timezone', 'currency', 'price_note', 'status', 'banner_type', 'banner_size', 'banner_focus', 'banner_text_pos', 'banner_caption', 'intro_video_url', 'button_text', 'includes_text', 'starts_at', 'ends_at'];
const EVENT_INT_FIELDS = ['ticket_price_cents', 'dinner_price_cents', 'dinner_capacity', 'capacity', 'min_attendance', 'refund_cutoff_days', 'banner_overlay'];
const EVENT_REQUIRED = ['city', 'title', 'timezone', 'currency', 'status', 'banner_type', 'banner_size', 'banner_focus', 'banner_text_pos', 'button_text', 'ticket_price_cents', 'dinner_capacity', 'capacity', 'min_attendance', 'refund_cutoff_days', 'banner_overlay'];
const EVENT_ENUMS = {
  currency: ['aud', 'gbp', 'usd', 'eur', 'aed', 'cad', 'nzd', 'sgd', 'pkr', 'inr'],
  status: ['draft', 'published', 'closed', 'cancelled'],
  banner_type: ['city', 'host'],
  banner_size: ['small', 'medium', 'large'],
  banner_focus: ['top', 'upper', 'center', 'bottom'],
  banner_text_pos: ['left', 'centre']
};

// Only whitelisted fields ever reach the database. Blank values become NULL
// unless the column cannot be empty, in which case the old value is kept.
function cleanEventBody(body) {
  const out = {};
  EVENT_TEXT_FIELDS.forEach((f) => {
    if (body[f] === undefined) return;
    const v = body[f] === '' ? null : String(body[f]).trim();
    if (v === null && EVENT_REQUIRED.includes(f)) return;
    if (v !== null && EVENT_ENUMS[f] && !EVENT_ENUMS[f].includes(v)) return;
    out[f] = v;
  });
  EVENT_INT_FIELDS.forEach((f) => {
    if (body[f] === undefined) return;
    if (body[f] === '' || body[f] === null) {
      if (!EVENT_REQUIRED.includes(f)) out[f] = null;
      return;
    }
    const n = parseInt(body[f], 10);
    if (Number.isNaN(n) || n < 0) return;
    out[f] = (f === 'banner_overlay') ? Math.min(n, 90) : n;
  });
  if (body.is_online !== undefined) out.is_online = (body.is_online === true || body.is_online === 'true');
  if (body.featured_home !== undefined) out.featured_home = (body.featured_home === true || body.featured_home === 'true');
  ['agenda', 'faq'].forEach((f) => {
    if (body[f] === undefined) return;
    try {
      const j = (typeof body[f] === 'string') ? JSON.parse(body[f]) : body[f];
      if (Array.isArray(j)) out[f] = JSON.stringify(j);
    } catch (e) { /* ignore malformed JSON */ }
  });
  return out;
}

const EVENT_SALES_SQL = `
  SELECT e.*,
    COALESCE((SELECT COUNT(*) FROM tickets t JOIN orders o ON o.id = t.order_id WHERE t.event_id = e.id AND o.status = 'paid'), 0)::int AS seats_sold,
    COALESCE((SELECT COUNT(*) FROM tickets t JOIN orders o ON o.id = t.order_id WHERE t.event_id = e.id AND o.status = 'paid' AND t.has_dinner), 0)::int AS dinner_sold,
    COALESCE((SELECT SUM(o.amount_cents) FROM orders o WHERE o.event_id = e.id AND o.status = 'paid'), 0)::int AS revenue_cents
  FROM events e`;

function publicEvent(r, withImage) {
  const o = {
    id: r.id, slug: r.slug, city: r.city, title: r.title, subline: r.subline,
    venue: r.venue, address: r.address, starts_at: r.starts_at, ends_at: r.ends_at,
    timezone: r.timezone, currency: r.currency, price_note: r.price_note, is_online: r.is_online, status: r.status,
    ticket_price_cents: r.ticket_price_cents, dinner_price_cents: r.dinner_price_cents,
    banner_type: r.banner_type, banner_size: r.banner_size, banner_focus: r.banner_focus,
    banner_overlay: r.banner_overlay, banner_text_pos: r.banner_text_pos,
    banner_caption: r.banner_caption, intro_video_url: r.intro_video_url,
    button_text: r.button_text, includes_text: r.includes_text,
    agenda: r.agenda, faq: r.faq,
    refund_cutoff_days: r.refund_cutoff_days, min_attendance: r.min_attendance,
    seats_left: Math.max(0, r.capacity - r.seats_sold),
    dinner_left: (r.dinner_price_cents !== null && r.dinner_price_cents !== undefined) ? Math.max(0, r.dinner_capacity - r.dinner_sold) : 0
  };
  if (withImage) o.banner_image_data = r.banner_image_data;
  return o;
}

app.get('/api/public/events', ah(async (req, res) => {
  const { rows } = await pool.query(EVENT_SALES_SQL + " WHERE e.status = 'published' ORDER BY e.starts_at ASC NULLS LAST");
  res.json(rows.map((r) => publicEvent(r, false)));
}));

app.get('/api/public/events/:slug', ah(async (req, res) => {
  const { rows } = await pool.query(EVENT_SALES_SQL + " WHERE e.slug = $1 AND e.status IN ('published', 'closed')", [req.params.slug]);
  if (!rows[0]) return res.status(404).json({ error: 'Event not found' });
  res.json(publicEvent(rows[0], true));
}));

app.get('/api/admin/events', requireAuth, ah(async (req, res) => {
  const { rows } = await pool.query(EVENT_SALES_SQL + ' ORDER BY e.starts_at DESC NULLS LAST, e.id DESC');
  res.json(rows.map((r) => {
    const o = Object.assign({}, r);
    o.has_image = !!r.banner_image_data;
    delete o.banner_image_data;
    return o;
  }));
}));

app.get('/api/admin/events/:id', requireAuth, ah(async (req, res) => {
  const { rows } = await pool.query(EVENT_SALES_SQL + ' WHERE e.id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Event not found' });
  res.json(rows[0]);
}));

app.post('/api/admin/events', requireAuth, uploadBannerImage.single('image'), ah(async (req, res) => {
  const d = cleanEventBody(req.body);
  if (!d.city || !d.title) return res.status(400).json({ error: 'city and title are required' });
  let slug = slugify(req.body.slug || (d.city + ' ' + d.title)).replace(/^-+|-+$/g, '') || 'event';
  const { rows: taken } = await pool.query('SELECT 1 FROM events WHERE slug = $1', [slug]);
  if (taken.length) slug = slug + '-' + Date.now().toString().slice(-5);
  d.slug = slug;
  if (req.file) d.banner_image_data = 'data:' + req.file.mimetype + ';base64,' + req.file.buffer.toString('base64');
  const cols = Object.keys(d);
  const vals = cols.map((c) => d[c]);
  const ph = cols.map((c, i) => ((c === 'agenda' || c === 'faq') ? '$' + (i + 1) + '::jsonb' : '$' + (i + 1)));
  const { rows } = await pool.query('INSERT INTO events (' + cols.join(', ') + ') VALUES (' + ph.join(', ') + ') RETURNING id, slug', vals);
  res.status(201).json(rows[0]);
}));

app.patch('/api/admin/events/:id', requireAuth, uploadBannerImage.single('image'), ah(async (req, res) => {
  const d = cleanEventBody(req.body);
  if (req.body.slug) {
    const s = slugify(req.body.slug).replace(/^-+|-+$/g, '');
    if (s) {
      const { rows: taken } = await pool.query('SELECT 1 FROM events WHERE slug = $1 AND id <> $2', [s, req.params.id]);
      if (!taken.length) d.slug = s;
    }
  }
  if (req.file) d.banner_image_data = 'data:' + req.file.mimetype + ';base64,' + req.file.buffer.toString('base64');
  if (req.body.remove_image === 'true' || req.body.remove_image === true) d.banner_image_data = null;
  const cols = Object.keys(d);
  if (cols.length === 0) return res.status(400).json({ error: 'No fields to update' });
  const sets = cols.map((c, i) => c + ' = ' + ((c === 'agenda' || c === 'faq') ? '$' + (i + 1) + '::jsonb' : '$' + (i + 1)));
  const vals = cols.map((c) => d[c]);
  vals.push(req.params.id);
  const { rows } = await pool.query('UPDATE events SET ' + sets.join(', ') + ', updated_at = NOW() WHERE id = $' + vals.length + ' RETURNING id, slug, status', vals);
  if (!rows[0]) return res.status(404).json({ error: 'Event not found' });
  res.json(rows[0]);
}));

app.delete('/api/admin/events/:id', requireAuth, requireAdmin, ah(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Event not specified' });
  const found = await pool.query('SELECT id FROM events WHERE id = $1', [id]);
  if (!found.rows[0]) return res.status(404).json({ error: 'Event not found' });
  // Never delete an event while someone holds a live booking or is in the middle of paying.
  const live = (await pool.query(
    "SELECT COUNT(*) FILTER (WHERE status IN ('paid', 'needs_refund'))::int AS booked, " +
    "COUNT(*) FILTER (WHERE status = 'pending' AND hold_expires_at > NOW())::int AS paying FROM orders WHERE event_id = $1", [id])).rows[0];
  if (live.booked > 0) return res.status(409).json({ error: 'This event still has ' + live.booked + ' confirmed booking' + (live.booked === 1 ? '' : 's') + '. Use "Cancel event and refund everyone" first, then you can delete it.' });
  if (live.paying > 0) return res.status(409).json({ error: 'Someone is paying for this event right now. Cancel the event, wait a few minutes, then delete it.' });
  // What is left is only refunded, cancelled, expired or abandoned bookings. Remove them with the event.
  const client = await pool.connect();
  let removed = 0;
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM tickets WHERE event_id = $1', [id]);
    removed = (await client.query('DELETE FROM orders WHERE event_id = $1', [id])).rowCount;
    await client.query('DELETE FROM events WHERE id = $1', [id]);
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (e2) { /* ignore */ }
    throw e;
  } finally { client.release(); }
  res.json({ ok: true, removed_bookings: removed });
}));

app.get('/api/admin/events/:id/attendees', requireAuth, ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT t.id, t.code, t.holder_name, t.has_dinner, t.checked_in_at,
            o.id AS order_id, o.buyer_name, o.buyer_email, o.amount_cents, o.status, o.created_at
     FROM tickets t JOIN orders o ON o.id = t.order_id
     WHERE t.event_id = $1 ORDER BY o.created_at DESC, t.id ASC`,
    [req.params.id]
  );
  res.json(rows);
}));

// ============================================================
// SOCIAL PROOF: host profile, press strip and reviews
// ============================================================

const PRESS_KINDS = ['podcast', 'article', 'profile', 'tv', 'newspaper', 'radio', 'other'];
const REVIEW_KINDS = ['text', 'video'];
const PRESS_MODES = ['auto', 'static', 'ticker'];

// Whitelisted fields only. Blank values become NULL unless the column cannot be empty.
function pickFields(body, spec) {
  const out = {};
  const req = spec.required || [];
  (spec.text || []).forEach((f) => {
    if (body[f] === undefined) return;
    const v = body[f] === '' ? null : String(body[f]).trim();
    if (v === null && req.includes(f)) return;
    if (v !== null && spec.enums && spec.enums[f] && !spec.enums[f].includes(v)) return;
    if (v !== null && f === 'item_date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
    out[f] = v;
  });
  (spec.int || []).forEach((f) => {
    if (body[f] === undefined) return;
    if (body[f] === '' || body[f] === null) { if (!req.includes(f)) out[f] = null; return; }
    const n = parseInt(body[f], 10);
    if (Number.isNaN(n)) return;
    out[f] = (f === 'rating') ? Math.min(5, Math.max(1, n)) : n;
  });
  (spec.bool || []).forEach((f) => {
    if (body[f] !== undefined) out[f] = (body[f] === true || body[f] === 'true');
  });
  return out;
}

function imageToData(file) {
  return 'data:' + file.mimetype + ';base64,' + file.buffer.toString('base64');
}

const PRESS_SPEC = { text: ['kind', 'name', 'url', 'item_date'], int: ['display_order'], bool: ['is_active'], required: ['kind', 'name', 'display_order'], enums: { kind: PRESS_KINDS } };
const REVIEW_SPEC = { text: ['kind', 'author', 'detail', 'body', 'source', 'source_url', 'video_url'], int: ['rating', 'display_order'], bool: ['is_active'], required: ['kind', 'author', 'display_order'], enums: { kind: REVIEW_KINDS } };

// Admin CRUD for a simple list table (press items, reviews).
function mountList(base, table, spec, imageCol, validate) {
  const path = '/api/admin/' + base;
  app.get(path, requireAuth, ah(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM ' + table + ' ORDER BY display_order ASC, id ASC');
    res.json(rows.map((r) => {
      const o = Object.assign({}, r);
      if (imageCol) { o.has_image = !!r[imageCol]; delete o[imageCol]; }
      return o;
    }));
  }));
  app.get(path + '/:id', requireAuth, ah(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM ' + table + ' WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  }));
  app.post(path, requireAuth, uploadBannerImage.single('image'), ah(async (req, res) => {
    const d = pickFields(req.body, spec);
    if (d.display_order === undefined) d.display_order = 0;
    const problem = validate(d, true);
    if (problem) return res.status(400).json({ error: problem });
    if (imageCol && req.file) d[imageCol] = imageToData(req.file);
    const cols = Object.keys(d);
    const ph = cols.map((c, i) => '$' + (i + 1));
    const { rows } = await pool.query('INSERT INTO ' + table + ' (' + cols.join(', ') + ') VALUES (' + ph.join(', ') + ') RETURNING id', cols.map((c) => d[c]));
    res.status(201).json(rows[0]);
  }));
  app.patch(path + '/:id', requireAuth, uploadBannerImage.single('image'), ah(async (req, res) => {
    const d = pickFields(req.body, spec);
    if (imageCol && req.file) d[imageCol] = imageToData(req.file);
    if (imageCol && (req.body.remove_image === 'true' || req.body.remove_image === true)) d[imageCol] = null;
    const cols = Object.keys(d);
    if (cols.length === 0) return res.status(400).json({ error: 'No fields to update' });
    const vals = cols.map((c) => d[c]);
    vals.push(req.params.id);
    const { rows } = await pool.query('UPDATE ' + table + ' SET ' + cols.map((c, i) => c + ' = $' + (i + 1)).join(', ') + ' WHERE id = $' + vals.length + ' RETURNING id', vals);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  }));
  app.delete(path + '/:id', requireAuth, requireAdmin, ah(async (req, res) => {
    await pool.query('DELETE FROM ' + table + ' WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  }));
}

mountList('press', 'press_items', PRESS_SPEC, 'logo_data', function (d) {
  if (!d.name) return 'A name is required';
  return null;
});
mountList('reviews', 'reviews', REVIEW_SPEC, null, function (d) {
  if (!d.author) return 'The reviewer name is required';
  if (d.kind === 'video' && !d.video_url) return 'A video link is required for a video review';
  if (d.kind !== 'video' && !d.body) return 'The review text is required';
  return null;
});

const HOST_SPEC = { text: ['name', 'headline', 'bio', 'video_url', 'press_mode'], enums: { press_mode: PRESS_MODES } };

app.get('/api/admin/host', requireAuth, ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM host_profile WHERE id = 1');
  res.json(rows[0] || {});
}));

app.patch('/api/admin/host', requireAuth, uploadBannerImage.single('image'), ah(async (req, res) => {
  const d = pickFields(req.body, HOST_SPEC);
  if (req.file) d.photo_data = imageToData(req.file);
  if (req.body.remove_image === 'true' || req.body.remove_image === true) d.photo_data = null;
  const cols = Object.keys(d);
  if (cols.length === 0) return res.status(400).json({ error: 'No fields to update' });
  const vals = cols.map((c) => d[c]);
  const { rows } = await pool.query('UPDATE host_profile SET ' + cols.map((c, i) => c + ' = $' + (i + 1)).join(', ') + ', updated_at = NOW() WHERE id = 1 RETURNING id', vals);
  res.json(rows[0] || { ok: true });
}));

// One call for the public event pages.
app.get('/api/public/proof', ah(async (req, res) => {
  const { rows: h } = await pool.query('SELECT name, headline, bio, photo_data, video_url, press_mode FROM host_profile WHERE id = 1');
  const { rows: press } = await pool.query('SELECT kind, name, url, logo_data, item_date FROM press_items WHERE is_active = true ORDER BY display_order ASC, id ASC');
  const { rows: reviews } = await pool.query('SELECT kind, author, detail, body, rating, source, source_url, video_url FROM reviews WHERE is_active = true ORDER BY display_order ASC, id ASC');
  const host = h[0] || {};
  res.json({
    host: { name: host.name || null, headline: host.headline || null, bio: host.bio || null, photo_data: host.photo_data || null, video_url: host.video_url || null },
    press: { mode: host.press_mode || 'auto', items: press },
    reviews: reviews
  });
}));

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Multer-specific errors (file too large, too many files) get a clear message
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
                  return res.status(400).json({ error: 'That file is too large.' });
          }
          if (err.code === 'LIMIT_FILE_COUNT') {
                  return res.status(400).json({ error: 'Too many files — please attach 8 or fewer.' });
          }
          return res.status(400).json({ error: 'File upload error: ' + err.message });
    }
    next(err);
});

// Generic error handler — logs the real error server-side, never leaks internals to the client
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

initSchema()
  .then(() => {
        app.listen(PORT, () => console.log(`the2sellers API listening on port ${PORT}`));
  })
  .catch((err) => {
        console.error('Failed to initialize database schema:', err);
        process.exit(1);
  });

module.exports = app;
