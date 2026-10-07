// Booking engine: free-event registration, order lookup and QR images.
// Paid checkout (Stripe) is added in a later step and reuses the same tables.

const crypto = require('crypto');
const { sendMail, sendNotification } = require('./email');
const { qrPng } = require('./qr');

const TICKET_PAGE_URL = process.env.TICKET_PAGE_URL || 'https://the2sellers-api.onrender.com/admin/ticket.html';
const API_PUBLIC_URL = process.env.API_PUBLIC_URL || 'https://the2sellers-api.onrender.com';
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L, easy to read aloud
const MAX_PER_ORDER = 10;
const MAX_PER_EMAIL = 10;
const CODE_RE = /^T2S[A-Z0-9]{10}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,40}$/;

function newCode() {
  const b = crypto.randomBytes(10);
  let s = '';
  for (let i = 0; i < 10; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return 'T2S' + s;
}

function esc(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// Simple in-memory limiter: at most 8 booking attempts per IP per 15 minutes.
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(function (t) { return now - t < 15 * 60 * 1000; });
  if (arr.length >= 8) { hits.set(ip, arr); return true; }
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return false;
}

let schemaReady = null;
function ensureSchema(pool) {
  if (!schemaReady) {
    schemaReady = (async function () {
      await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS email_status TEXT');
      await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS public_token TEXT');
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_public_token ON orders(public_token)');
    })().catch(function (e) { schemaReady = null; throw e; });
  }
  return schemaReady;
}

function whenText(ev) {
  if (!ev.starts_at) return 'Date to be announced';
  try {
    const d = new Date(ev.starts_at);
    const day = new Intl.DateTimeFormat('en-AU', { timeZone: ev.timezone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
    const t1 = new Intl.DateTimeFormat('en-AU', { timeZone: ev.timezone, hour: 'numeric', minute: '2-digit' }).format(d);
    let out = day + ', ' + t1;
    if (ev.ends_at) out += ' to ' + new Intl.DateTimeFormat('en-AU', { timeZone: ev.timezone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(ev.ends_at));
    return out;
  } catch (e) { return ''; }
}

function placeText(ev) {
  return ev.is_online ? 'Live online' : [ev.venue, ev.address].filter(Boolean).join(', ');
}

function buildEmail(ev, name, token, codes) {
  const link = TICKET_PAGE_URL + '?t=' + encodeURIComponent(token);
  const rows = codes.map(function (c) {
    return '<tr><td style="padding:12px 0;border-top:1px solid #e7e3d8"><div style="font-family:monospace;font-size:16px;letter-spacing:1px;margin-bottom:8px">' + esc(c.code) + (c.has_dinner ? ' &nbsp;·&nbsp; includes dinner' : '') + '</div><img src="' + API_PUBLIC_URL + '/api/public/tickets/' + c.code + '/qr.png" width="160" height="160" alt="QR code for ' + esc(c.code) + '"></td></tr>';
  }).join('');
  const html = '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#0F0F12">' +
    '<h2 style="font-family:Georgia,serif;font-weight:normal">You are booked in, ' + esc(name) + '.</h2>' +
    '<p><strong>' + esc(ev.title) + '</strong><br>' + esc(whenText(ev)) + '<br>' + esc(placeText(ev)) + '</p>' +
    '<p>Show the QR code below at the door. You can also open your tickets any time:</p>' +
    '<p><a href="' + esc(link) + '" style="background:#E8B939;color:#0F0F12;padding:12px 20px;border-radius:4px;text-decoration:none;font-weight:bold">Open my tickets</a></p>' +
    '<table style="width:100%;border-collapse:collapse">' + rows + '</table>' +
    '<p style="color:#5B5D63;font-size:13px;margin-top:24px">Questions? Reply to this email or write to contact@the2sellers.io.</p></div>';
  const text = 'You are booked in, ' + name + '.\n\n' + ev.title + '\n' + whenText(ev) + '\n' + placeText(ev) + '\n\nYour tickets: ' + link + '\n\n' +
    codes.map(function (c) { return 'Ticket ' + c.code + (c.has_dinner ? ' (includes dinner)' : ''); }).join('\n') + '\n';
  return { html: html, text: text };
}

module.exports = function mountBookings(app, pool) {
  const ah = function (fn) { return function (req, res, next) { Promise.resolve(fn(req, res, next)).catch(next); }; };

  // Reserve seats for a FREE booking. Paid bookings go through checkout instead.
  app.post('/api/public/events/:slug/register', ah(async function (req, res) {
    await ensureSchema(pool);
    const b = req.body || {};
    if (b.website) return res.json({ ok: true }); // honeypot: bots fill hidden fields
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    if (limited(ip)) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });

    const name = String(b.name || '').trim().slice(0, 120);
    const email = String(b.email || '').trim().toLowerCase().slice(0, 200);
    const qty = parseInt(b.qty, 10);
    const dq = parseInt(b.dinner_qty || 0, 10) || 0;
    if (!name) return res.status(400).json({ error: 'Please enter your name.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (!(qty >= 1 && qty <= MAX_PER_ORDER)) return res.status(400).json({ error: 'Please choose between 1 and ' + MAX_PER_ORDER + ' seats.' });
    if (dq < 0 || dq > qty) return res.status(400).json({ error: 'Dinner seats cannot be more than your seats.' });

    const client = await pool.connect();
    let ev, orderId, token, codes = [];
    try {
      await client.query('BEGIN');
      // Lock the event row so two people can never take the last seat at the same moment.
      const evr = await client.query("SELECT * FROM events WHERE slug = $1 AND status = 'published' FOR UPDATE", [req.params.slug]);
      ev = evr.rows[0];
      if (!ev) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'This event is not available.' }); }
      if (dq > 0 && (ev.dinner_price_cents === null || ev.dinner_price_cents === undefined)) {
        await client.query('ROLLBACK'); return res.status(400).json({ error: 'Dinner is not offered for this event.' });
      }
      const total = ev.ticket_price_cents * qty + (dq > 0 ? (ev.dinner_price_cents || 0) * dq : 0);
      if (total > 0) { await client.query('ROLLBACK'); return res.status(402).json({ error: 'This booking needs a payment. Online payment opens soon.' }); }

      const sold = (await client.query(
        "SELECT COUNT(*)::int AS n, (COUNT(*) FILTER (WHERE t.has_dinner))::int AS d FROM tickets t JOIN orders o ON o.id = t.order_id WHERE t.event_id = $1 AND o.status = 'paid'", [ev.id])).rows[0];
      const left = Math.max(0, ev.capacity - sold.n);
      if (qty > left) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: left > 0 ? 'Only ' + left + ' seat' + (left === 1 ? '' : 's') + ' left.' : 'Sorry, this event is sold out.', seats_left: left });
      }
      if (dq > 0 && sold.d + dq > ev.dinner_capacity) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Not enough dinner seats left.' });
      }
      const mine = (await client.query(
        "SELECT COUNT(*)::int AS n FROM tickets t JOIN orders o ON o.id = t.order_id WHERE t.event_id = $1 AND o.status = 'paid' AND lower(o.buyer_email) = $2", [ev.id, email])).rows[0].n;
      if (mine + qty > MAX_PER_EMAIL) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'This email address has already reserved the maximum number of seats.' });
      }

      token = crypto.randomBytes(18).toString('base64url');
      const o = await client.query(
        "INSERT INTO orders (event_id, buyer_name, buyer_email, qty, dinner_qty, amount_cents, currency, status, paid_at, public_token) VALUES ($1, $2, $3, $4, $5, 0, $6, 'paid', NOW(), $7) RETURNING id",
        [ev.id, name, email, qty, dq, ev.currency, token]);
      orderId = o.rows[0].id;
      for (let i = 0; i < qty; i++) {
        const code = newCode();
        const hasDinner = i < dq;
        await client.query('INSERT INTO tickets (order_id, event_id, code, holder_name, has_dinner) VALUES ($1, $2, $3, $4, $5)', [orderId, ev.id, code, name, hasDinner]);
        codes.push({ code: code, has_dinner: hasDinner });
      }
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (e2) { /* ignore */ }
      throw e;
    } finally {
      client.release();
    }

    res.status(201).json({ ok: true, token: token, tickets: codes.length });

    // After responding: email the customer (a copy of the ticket page) and notify the owner.
    (async function () {
      let status = 'skipped';
      try {
        const m = buildEmail(ev, name, token, codes);
        const r = await sendMail({ to: email, subject: 'Your ticket: ' + ev.title, html: m.html, text: m.text });
        status = r.ok ? 'sent' : (r.skipped ? 'skipped' : 'failed:' + (r.status || r.error || 'unknown'));
      } catch (e) { status = 'failed'; }
      try { await pool.query('UPDATE orders SET email_status = $1 WHERE id = $2', [status, orderId]); } catch (e) { /* ignore */ }
      try {
        await sendNotification('New booking: ' + ev.city + ' (' + codes.length + ' seat' + (codes.length === 1 ? '' : 's') + ')',
          name + ' <' + email + '> booked ' + codes.length + ' seat(s) for ' + ev.title + ' (' + ev.city + ').\nTicket email: ' + status + '\n');
      } catch (e) { /* ignore */ }
    })();
  }));

  // The customer's ticket page reads this. The long random token is the only key.
  app.get('/api/public/orders/:token', ah(async function (req, res) {
    await ensureSchema(pool);
    if (!TOKEN_RE.test(req.params.token)) return res.status(404).json({ error: 'Not found' });
    const { rows } = await pool.query(
      'SELECT o.id, o.buyer_name, o.buyer_email, o.status, e.title, e.city, e.venue, e.address, e.starts_at, e.ends_at, e.timezone, e.is_online, e.status AS event_status ' +
      'FROM orders o JOIN events e ON e.id = o.event_id WHERE o.public_token = $1', [req.params.token]);
    const o = rows[0];
    if (!o) return res.status(404).json({ error: 'Not found' });
    const t = await pool.query('SELECT code, has_dinner, checked_in_at FROM tickets WHERE order_id = $1 ORDER BY id ASC', [o.id]);
    const em = String(o.buyer_email || '');
    const masked = em.length > 3 ? em.charAt(0) + '***' + em.slice(em.indexOf('@')) : '';
    res.json({
      status: o.status, buyer_name: o.buyer_name, email: masked,
      event: { title: o.title, city: o.city, venue: o.venue, address: o.address, starts_at: o.starts_at, ends_at: o.ends_at, timezone: o.timezone, is_online: o.is_online, status: o.event_status },
      tickets: t.rows.map(function (r) { return { code: r.code, has_dinner: r.has_dinner, checked_in: !!r.checked_in_at }; })
    });
  }));

  // QR image for a ticket code (the code itself is what the door scanner reads).
  app.get('/api/public/tickets/:code/qr.png', function (req, res) {
    if (!CODE_RE.test(req.params.code)) return res.status(404).end();
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    res.send(qrPng(req.params.code, 8, 4));
  });
};
