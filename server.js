require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { pool, initSchema } = require('./db');
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

app.get('/api/public/listings', ah(async (req, res) => {
  const { niche, marketplace } = req.query;
  let sql = `
    SELECT id, public_title, public_summary, display_price, public_monthly_profit, niche, marketplaces,
           fulfillment_model, published_at
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
            niche, marketplaces, fulfillment_model, years_in_business,
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

  const allowedFields = ['public_title', 'public_summary', 'public_description', 'display_price', 'public_monthly_profit', 'status', 'internal_notes'];
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

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

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
