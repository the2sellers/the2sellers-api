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
app.use(express.json());
app.use('/admin', express.static(require('path').join(__dirname, 'admin')));

const PORT = process.env.PORT || 4000;

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
  const { rows } = await pool.query('SELECT * FROM admin_users WHERE email = $1', [email]);
  const user = rows[0];
  if (!user || !checkPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
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
  res.json(rows[0]);
}));

app.delete('/api/admin/blog-posts/:id', requireAuth, requireAdmin, ah(async (req, res) => {
  await pool.query('DELETE FROM blog_posts WHERE id = $1', [req.params.id]);
  res.status(204).send();
}));

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Multer-specific errors (file too large, too many files) get a clear message
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'One of your files is too large. Each file must be under 10MB.' });
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
