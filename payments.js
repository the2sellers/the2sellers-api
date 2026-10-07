// Stripe payments: checkout sessions, webhook, confirmation, refunds, status.
// Talks to Stripe's REST API directly (no SDK needed). Secrets come from environment
// variables only: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET.

const crypto = require('crypto');
const { requireAuth, requireAdmin } = require('./auth');
const { sendNotification } = require('./email');

const EVENT_PAGE_URL = process.env.EVENT_PAGE_URL || 'https://the2sellers-api.onrender.com/admin/event.html';
const HOLD_MINUTES = 32;        // seats are held this long while the buyer pays
const STRIPE_SESSION_MINUTES = 31; // Stripe needs at least 30
const SIG_TOLERANCE_S = 300;

function flatten(obj, prefix, out) {
  out = out || [];
  Object.keys(obj).forEach(function (k) {
    const v = obj[k];
    const key = prefix ? prefix + '[' + k + ']' : k;
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) {
      v.forEach(function (item, i) {
        if (item !== null && typeof item === 'object') flatten(item, key + '[' + i + ']', out);
        else out.push([key + '[' + i + ']', String(item)]);
      });
    } else if (typeof v === 'object') flatten(v, key, out);
    else out.push([key, String(v)]);
  });
  return out;
}

async function stripe(method, path, params, idem) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) { const e = new Error('Stripe is not configured'); e.code = 'NO_KEY'; throw e; }
  const headers = { 'Authorization': 'Bearer ' + key };
  let url = 'https://api.stripe.com' + path;
  let body;
  const pairs = params ? flatten(params).map(function (p) { return encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1]); }).join('&') : '';
  if (method === 'GET') { if (pairs) url += '?' + pairs; }
  else if (params) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = pairs; }
  if (idem) headers['Idempotency-Key'] = idem;
  const r = await fetch(url, { method: method, headers: headers, body: body });
  const j = await r.json().catch(function () { return {}; });
  if (!r.ok) {
    const e = new Error((j.error && j.error.message) || ('Stripe error ' + r.status));
    e.status = r.status; e.stripe = j.error || null;
    throw e;
  }
  return j;
}

// Checks Stripe's signature so only Stripe can confirm a payment.
function verifySignature(raw, header, secret) {
  if (!raw || !header || !secret) return false;
  const parts = {};
  String(header).split(',').forEach(function (p) {
    const i = p.indexOf('=');
    if (i > 0) { const k = p.slice(0, i).trim(); (parts[k] = parts[k] || []).push(p.slice(i + 1).trim()); }
  });
  const t = parseInt((parts.t || [])[0], 10);
  if (!t || Math.abs(Date.now() / 1000 - t) > SIG_TOLERANCE_S) return false;
  const expected = crypto.createHmac('sha256', secret).update(t + '.' + raw.toString('utf8')).digest('hex');
  return (parts.v1 || []).some(function (sig) {
    try {
      const a = Buffer.from(sig, 'hex'), b = Buffer.from(expected, 'hex');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch (e) { return false; }
  });
}

// Seats already sold, plus seats held by people who are in the middle of paying.
async function seatsTaken(client, eventId, excludeOrderId) {
  const r = await client.query(
    "SELECT (SELECT COUNT(*)::int FROM tickets t JOIN orders o ON o.id = t.order_id WHERE t.event_id = $1 AND o.status = 'paid') AS sold, " +
    "(SELECT COUNT(*)::int FROM tickets t JOIN orders o ON o.id = t.order_id WHERE t.event_id = $1 AND o.status = 'paid' AND t.has_dinner) AS dsold, " +
    "COALESCE((SELECT SUM(qty) FROM orders WHERE event_id = $1 AND status = 'pending' AND hold_expires_at > NOW() AND id <> $2), 0)::int AS held, " +
    "COALESCE((SELECT SUM(dinner_qty) FROM orders WHERE event_id = $1 AND status = 'pending' AND hold_expires_at > NOW() AND id <> $2), 0)::int AS dheld",
    [eventId, excludeOrderId || 0]);
  return r.rows[0];
}

module.exports = function mountPayments(app, pool, h) {
  const ah = h.ah;

  // Tells the event page whether online payment is switched on.
  app.get('/api/public/config', function (req, res) {
    res.json({ payments: !!process.env.STRIPE_SECRET_KEY });
  });

  // ---------- turn a paid Stripe session into tickets (safe to run more than once) ----------
  async function fulfil(orderId, session) {
    if (!session || (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required')) return { state: 'unpaid' };
    const pi = typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent && session.payment_intent.id) || null;
    const client = await pool.connect();
    let ev, o, codes = [], refundNeeded = false;
    try {
      await client.query('BEGIN');
      const orow = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
      o = orow.rows[0];
      if (!o) { await client.query('ROLLBACK'); return { state: 'missing' }; }
      if (o.status === 'paid' || o.status === 'refunded' || o.status === 'cancelled') { await client.query('COMMIT'); return { state: o.status === 'paid' ? 'already' : o.status }; }
      const evr = await client.query('SELECT * FROM events WHERE id = $1 FOR UPDATE', [o.event_id]);
      ev = evr.rows[0];
      const taken = await seatsTaken(client, o.event_id, o.id);
      const dinnerShort = o.dinner_qty > 0 && (taken.dsold + taken.dheld + o.dinner_qty > ev.dinner_capacity);
      if (taken.sold + taken.held + o.qty > ev.capacity || dinnerShort) {
        await client.query("UPDATE orders SET status = 'needs_refund', stripe_payment_intent = $1, hold_expires_at = NULL WHERE id = $2", [pi, o.id]);
        refundNeeded = true;
      } else {
        for (let i = 0; i < o.qty; i++) {
          const code = h.newCode();
          await client.query('INSERT INTO tickets (order_id, event_id, code, holder_name, has_dinner) VALUES ($1, $2, $3, $4, $5)', [o.id, o.event_id, code, o.buyer_name, i < o.dinner_qty]);
          codes.push({ code: code, has_dinner: i < o.dinner_qty });
        }
        await client.query("UPDATE orders SET status = 'paid', paid_at = NOW(), stripe_payment_intent = $1, amount_cents = $2, hold_expires_at = NULL WHERE id = $3",
          [pi, session.amount_total !== undefined && session.amount_total !== null ? session.amount_total : o.amount_cents, o.id]);
      }
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (e2) { /* ignore */ }
      throw e;
    } finally { client.release(); }

    if (refundNeeded) {
      // The event filled up while this buyer was paying. Give the money back automatically.
      try {
        await stripe('POST', '/v1/refunds', { payment_intent: pi, metadata: { order_id: String(o.id), reason: 'event_full' } }, 'refund-full-' + o.id);
        await pool.query("UPDATE orders SET status = 'refunded', refunded_at = NOW() WHERE id = $1", [o.id]);
        await sendNotification('Auto-refund: event was full (' + ev.city + ')', o.buyer_name + ' <' + o.buyer_email + '> paid but the event had filled up, so the payment was refunded automatically.\n');
        return { state: 'refunded' };
      } catch (e) {
        await sendNotification('ACTION NEEDED: refund failed (' + ev.city + ')', o.buyer_name + ' <' + o.buyer_email + '> paid for a full event and the automatic refund failed (' + e.message + '). Please refund order ' + o.id + ' in Stripe.\n');
        return { state: 'needs_refund' };
      }
    }
    const paidText = (session.amount_total ? (session.amount_total / 100).toFixed(2) + ' ' + String(o.currency).toUpperCase() : '');
    h.afterBooking(pool, ev, o.buyer_name, o.buyer_email, o.public_token, codes, o.id, paidText).catch(function () {});
    return { state: 'paid' };
  }

  // ---------- start a payment ----------
  app.post('/api/public/events/:slug/checkout', ah(async function (req, res) {
    await h.ensureSchema(pool);
    const b = req.body || {};
    if (b.website) return res.json({ ok: true });
    if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: 'Online payment is not switched on yet. Please try again soon.' });
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    if (h.limited(ip)) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });

    const name = String(b.name || '').trim().slice(0, 120);
    const email = String(b.email || '').trim().toLowerCase().slice(0, 200);
    const qty = parseInt(b.qty, 10);
    const dq = parseInt(b.dinner_qty || 0, 10) || 0;
    const phone = h.cleanPhone(b.phone);
    const waOk = (b.whatsapp_ok === true || b.whatsapp_ok === 'true');
    if (!name) return res.status(400).json({ error: 'Please enter your name.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (!phone.ok) return res.status(400).json({ error: 'Please enter your WhatsApp number with the country code, for example +61 4xx xxx xxx.' });
    if (!(qty >= 1 && qty <= h.MAX_PER_ORDER)) return res.status(400).json({ error: 'Please choose between 1 and ' + h.MAX_PER_ORDER + ' seats.' });
    if (dq < 0 || dq > qty) return res.status(400).json({ error: 'Dinner seats cannot be more than your seats.' });

    const client = await pool.connect();
    let ev, orderId, token, total;
    try {
      await client.query('BEGIN');
      const evr = await client.query("SELECT * FROM events WHERE slug = $1 AND status = 'published' FOR UPDATE", [req.params.slug]);
      ev = evr.rows[0];
      if (!ev) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'This event is not available.' }); }
      if (dq > 0 && (ev.dinner_price_cents === null || ev.dinner_price_cents === undefined)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Dinner is not offered for this event.' }); }
      const ticketCents = ev.ticket_price_cents * qty;
      const dinnerCents = dq > 0 ? (ev.dinner_price_cents || 0) * dq : 0;
      total = ticketCents + dinnerCents;
      if (total <= 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'This booking is free, so no payment is needed.' }); }
      if (total < 50) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'The total is below the minimum card payment.' }); }
      const taken = await seatsTaken(client, ev.id, 0);
      const left = Math.max(0, ev.capacity - taken.sold - taken.held);
      if (qty > left) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: left > 0 ? 'Only ' + left + ' seat' + (left === 1 ? '' : 's') + ' left.' : 'Sorry, this event is sold out.', seats_left: left });
      }
      if (dq > 0 && taken.dsold + taken.dheld + dq > ev.dinner_capacity) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Not enough dinner seats left.' }); }
      const mine = (await client.query("SELECT COUNT(*)::int AS n FROM tickets t JOIN orders o ON o.id = t.order_id WHERE t.event_id = $1 AND o.status = 'paid' AND lower(o.buyer_email) = $2", [ev.id, email])).rows[0].n;
      if (mine + qty > h.MAX_PER_EMAIL) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This email address has already reserved the maximum number of seats.' }); }
      token = crypto.randomBytes(18).toString('base64url');
      const o = await client.query(
        "INSERT INTO orders (event_id, buyer_name, buyer_email, buyer_phone, whatsapp_ok, qty, dinner_qty, amount_cents, currency, status, public_token, hold_expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, NOW() + ($11 || ' minutes')::interval) RETURNING id",
        [ev.id, name, email, phone.value, waOk, qty, dq, total, ev.currency, token, String(HOLD_MINUTES)]);
      orderId = o.rows[0].id;
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (e2) { /* ignore */ }
      throw e;
    } finally { client.release(); }

    const lines = [];
    const label = ev.title + ' (' + ev.city + ')';
    if (ev.ticket_price_cents > 0) lines.push({ quantity: qty, price_data: { currency: ev.currency, unit_amount: ev.ticket_price_cents, product_data: { name: ('Ticket: ' + label).slice(0, 200) } } });
    if (dq > 0 && (ev.dinner_price_cents || 0) > 0) lines.push({ quantity: dq, price_data: { currency: ev.currency, unit_amount: ev.dinner_price_cents, product_data: { name: ('Dinner: ' + label).slice(0, 200) } } });
    try {
      const session = await stripe('POST', '/v1/checkout/sessions', {
        mode: 'payment',
        client_reference_id: String(orderId),
        customer_email: email,
        line_items: lines,
        success_url: h.TICKET_PAGE_URL + '?t=' + token + '&paid=1',
        cancel_url: EVENT_PAGE_URL + '?e=' + encodeURIComponent(req.params.slug) + '&cancelled=1',
        expires_at: Math.floor(Date.now() / 1000) + STRIPE_SESSION_MINUTES * 60,
        metadata: { order_id: String(orderId), event_id: String(ev.id), slug: ev.slug },
        payment_intent_data: { description: label.slice(0, 200), metadata: { order_id: String(orderId) } }
      }, 'checkout-order-' + orderId);
      await pool.query('UPDATE orders SET stripe_session_id = $1 WHERE id = $2', [session.id, orderId]);
      res.json({ url: session.url });
    } catch (e) {
      console.error('Stripe checkout failed:', e.message);
      await pool.query("UPDATE orders SET status = 'expired', hold_expires_at = NULL WHERE id = $1", [orderId]).catch(function () {});
      res.status(502).json({ error: 'Sorry, we could not start the payment. Please try again in a moment.' });
    }
  }));

  // ---------- Stripe tells us a payment finished ----------
  app.post('/api/stripe/webhook', async function (req, res) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return res.status(503).json({ error: 'Webhook secret is not set' });
    if (!verifySignature(req.rawBody, req.headers['stripe-signature'], secret)) return res.status(400).json({ error: 'Bad signature' });
    try {
      await h.ensureSchema(pool);
      const ev = req.body || {};
      const obj = (ev.data && ev.data.object) || {};
      const orderId = parseInt(obj.client_reference_id || (obj.metadata && obj.metadata.order_id), 10);
      if (orderId && (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded')) {
        await fulfil(orderId, obj);
      } else if (orderId && (ev.type === 'checkout.session.expired' || ev.type === 'checkout.session.async_payment_failed')) {
        await pool.query("UPDATE orders SET status = 'expired', hold_expires_at = NULL WHERE id = $1 AND status = 'pending'", [orderId]);
      }
      res.json({ received: true });
    } catch (e) {
      console.error('Webhook processing failed:', e.message);
      res.status(500).json({ error: 'Processing failed' });   // Stripe will retry
    }
  });

  // ---------- the ticket page asks: has my payment gone through? (works even without the webhook) ----------
  app.post('/api/public/orders/:token/confirm', ah(async function (req, res) {
    await h.ensureSchema(pool);
    if (!/^[A-Za-z0-9_-]{20,40}$/.test(req.params.token)) return res.status(404).json({ error: 'Not found' });
    const r = await pool.query('SELECT id, status, stripe_session_id FROM orders WHERE public_token = $1', [req.params.token]);
    const o = r.rows[0];
    if (!o) return res.status(404).json({ error: 'Not found' });
    if (o.status !== 'pending' || !o.stripe_session_id) return res.json({ status: o.status });
    try {
      const session = await stripe('GET', '/v1/checkout/sessions/' + encodeURIComponent(o.stripe_session_id));
      const f = await fulfil(o.id, session);
      return res.json({ status: (f.state === 'paid' || f.state === 'already') ? 'paid' : (f.state === 'unpaid' ? 'pending' : f.state) });
    } catch (e) {
      return res.json({ status: 'pending' });
    }
  }));

  // ---------- admin: refund a paid booking, or cancel a free one ----------
  app.post('/api/admin/orders/:id/refund', requireAuth, requireAdmin, ah(async function (req, res) {
    await h.ensureSchema(pool);
    const r = await pool.query('SELECT o.*, e.city, e.title FROM orders o JOIN events e ON e.id = o.event_id WHERE o.id = $1', [req.params.id]);
    const o = r.rows[0];
    if (!o) return res.status(404).json({ error: 'Booking not found' });
    if (o.status !== 'paid') return res.status(409).json({ error: 'Only a confirmed booking can be refunded or cancelled (this one is "' + o.status + '").' });
    if (o.amount_cents > 0) {
      if (!o.stripe_payment_intent) return res.status(409).json({ error: 'This booking has no Stripe payment on record, so it cannot be refunded here.' });
      try {
        await stripe('POST', '/v1/refunds', { payment_intent: o.stripe_payment_intent, metadata: { order_id: String(o.id), by: (req.user && req.user.email) || 'admin' } }, 'refund-admin-' + o.id);
      } catch (e) {
        return res.status(502).json({ error: 'Stripe could not refund this payment: ' + e.message });
      }
      await pool.query("UPDATE orders SET status = 'refunded', refunded_at = NOW() WHERE id = $1", [o.id]);
      return res.json({ ok: true, refunded_cents: o.amount_cents, status: 'refunded' });
    }
    await pool.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [o.id]);
    res.json({ ok: true, refunded_cents: 0, status: 'cancelled' });
  }));

  // ---------- admin: is Stripe connected, and to which account? (never reveals the key) ----------
  app.get('/api/admin/payments-status', requireAuth, ah(async function (req, res) {
    const key = process.env.STRIPE_SECRET_KEY || '';
    const out = { key_set: !!key, mode: null, webhook_secret_set: !!process.env.STRIPE_WEBHOOK_SECRET, account: null, error: null };
    if (key) {
      out.mode = /_test_/.test(key) ? 'test' : (/_live_/.test(key) ? 'live' : 'unknown');
      try {
        const a = await stripe('GET', '/v1/account');
        out.account = {
          name: (a.business_profile && a.business_profile.name) || (a.settings && a.settings.dashboard && a.settings.dashboard.display_name) || null,
          country: a.country || null, charges_enabled: !!a.charges_enabled, default_currency: a.default_currency || null
        };
      } catch (e) { out.error = e.message; }
    }
    res.json(out);
  }));
};
