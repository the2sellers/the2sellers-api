// 1-1 sessions: a paid funnel page, bookings, emails and an admin screen.
// Mounted from payments.js so it can share the Stripe helper and the webhook.
// Flow: customer pays through Stripe Checkout -> booking is "paid" -> owner confirms a time
// (status "scheduled") -> session done (status "completed"). Refunds are manual (admin button).

const crypto = require('crypto');
const multer = require('multer');
const { requireAuth, requireAdmin } = require('./auth');
const { sendNotification, sendMail } = require('./email');

const SITE = process.env.SITE_URL || 'https://the2sellers.io';
const PAGE_URL = process.env.ONE_TO_ONE_PAGE_URL || (SITE + '/1-1');
const ADMIN_URL = process.env.ADMIN_SESSIONS_URL || 'https://the2sellers-api.onrender.com/admin/sessions.html';
const STRIPE_SESSION_MINUTES = 31;

const DEFAULTS = {
  headline: '1-1 Session with Muhammad Bilal Aftab',
  intro: 'A private one-to-one video session with me. Bring your Amazon or marketplace business, your questions and your numbers. You leave with a clear plan.',
  video_url: '',
  price_cents: 10000,
  currency: 'usd',
  duration_min: 45,
  meeting_tool: 'Zoom',
  meeting_link: '',
  covers: 'A clear look at where your Amazon or marketplace business stands today\nThe biggest opportunities and risks in your account, listings and ads\nA practical plan for your next 90 days\nTime to ask me anything: account health, PPC, buying or selling a business',
  who_for: 'Sellers who want honest, experienced advice from someone who has built, grown and rescued thousands of marketplace businesses.',
  refund_text: 'If we cannot find a time that works for both of us, you get a full refund. Need to move your session? One free reschedule with at least 24 hours notice.',
  accepting: true,
  banner_on: true,
  banner_label: '1-1 SESSION',
  banner_head: 'Book a 1-1 Session with Muhammad Bilal Aftab',
  banner_sub: '',
  banner_cta: 'Book my session'
};
const DEFAULT_FAQ = [
  { q: 'What happens after I pay?', a: 'You get an email straight away. Within 24 hours I confirm your time by email and WhatsApp and send the video link.' },
  { q: 'Can I choose the time?', a: 'Yes. Suggest up to three times in your own time zone and I will try to use one of them. If you leave it blank, I will suggest a time.' },
  { q: 'What if we cannot find a time?', a: '{refund}' },
  { q: 'Is the session recorded?', a: 'Only if you ask me to. Everything you share stays between us.' }
];
const IMG_FIELDS = { banner_image: 'banner_image', hero_photo: 'hero_photo', covers_photo: 'covers_photo' };
function parseFaq(raw, refund) {
  let arr = null;
  try { arr = raw ? JSON.parse(raw) : null; } catch (e) { arr = null; }
  if (!Array.isArray(arr)) arr = DEFAULT_FAQ;
  return arr.map(function (x) { return { q: String((x && x.q) || '').trim(), a: String((x && x.a) || '').trim().replace('{refund}', refund || '') }; }).filter(function (x) { return x.q && x.a; });
}
const SETTINGS_TEXT = ['banner_label', 'banner_head', 'banner_sub', 'banner_cta', 'headline', 'intro', 'video_url', 'currency', 'meeting_tool', 'meeting_link', 'covers', 'who_for', 'refund_text'];
const SETTINGS_INT = ['price_cents', 'duration_min'];
const SETTINGS_BOOL = ['accepting', 'banner_on'];
const SYMBOLS = { usd: 'US$', aud: 'A$', gbp: '£', eur: '€', aed: 'AED ', cad: 'C$', nzd: 'NZ$', sgd: 'S$', pkr: 'PKR ', inr: '₹' };

function esc(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}
function money(cents, cur) {
  const c = String(cur || 'usd').toLowerCase();
  const n = cents / 100;
  return (SYMBOLS[c] !== undefined ? SYMBOLS[c] : c.toUpperCase() + ' ') + (n % 1 === 0 ? n.toLocaleString('en-US') : n.toFixed(2));
}

// ---------- time zones (no extra libraries) ----------
function validTz(tz) {
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; } catch (e) { return false; }
}
function tzOffsetMs(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = {};
  f.formatToParts(date).forEach(function (x) { p[x.type] = x.value; });
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - date.getTime();
}
// "2026-10-20T14:00" typed in time zone tz -> the real moment (Date)
function zonedToUtc(local, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(local || ''));
  if (!m || !validTz(tz)) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let t = guess - tzOffsetMs(new Date(guess), tz);
  t = guess - tzOffsetMs(new Date(t), tz);
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : d;
}
function fmtIn(date, tz) {
  const d = new Date(date);
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(d).replace(/\s?([ap])m/i, function (x, a) { return ' ' + a.toLowerCase() + 'm'; });
  return day + ', ' + time + ' (' + tz.replace(/_/g, ' ') + ')';
}
// A time the customer typed (no zone attached) shown exactly as typed.
function fmtLocal(str, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(str || ''));
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit', hour12: true }).format(d).replace(/\s?([ap])m/i, function (x, a) { return ' ' + a.toLowerCase() + 'm'; });
  return day + ', ' + time + (tz ? ' (' + tz.replace(/_/g, ' ') + ')' : '');
}
function gcalUrl(title, start, mins, details, location) {
  const f = function (d) { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); };
  const end = new Date(start.getTime() + mins * 60000);
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent(title) + '&dates=' + f(start) + '/' + f(end) +
    '&details=' + encodeURIComponent(details || '') + (location ? '&location=' + encodeURIComponent(location) : '');
}
function waDigits(phone) { return String(phone || '').replace(/[^\d]/g, ''); }

function wrapHtml(title, inner) {
  return '<div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;color:#0F0F12;line-height:1.55"><h2 style="font-family:Georgia,serif;font-weight:normal;margin:0 0 14px">' + esc(title) + '</h2>' + inner +
    '<p style="color:#5B5D63;margin-top:26px">Muhammad Bilal Aftab<br>The2Sellers.io</p></div>';
}
function box(inner) { return '<div style="background:#FAFAF7;border:1px solid #e7e3d8;border-radius:8px;padding:14px 18px;margin:14px 0">' + inner + '</div>'; }

module.exports = function mountSessions(app, pool, h, deps) {
  const ah = h.ah;
  const stripe = deps.stripe;
  let ready = null;

  function ensure() {
    if (ready) return ready;
    ready = (async function () {
      await pool.query(
        'CREATE TABLE IF NOT EXISTS one_to_one_settings (id INTEGER PRIMARY KEY, headline TEXT, intro TEXT, video_url TEXT, price_cents INTEGER, currency TEXT, duration_min INTEGER, meeting_tool TEXT, meeting_link TEXT, covers TEXT, who_for TEXT, refund_text TEXT, accepting BOOLEAN NOT NULL DEFAULT true, banner_on BOOLEAN NOT NULL DEFAULT true, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())');
      await pool.query(
        'CREATE TABLE IF NOT EXISTS one_to_one_bookings (' +
        'id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT, timezone TEXT, pref1 TEXT, pref2 TEXT, pref3 TEXT, topic TEXT, ' +
        "amount_cents INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'usd', status TEXT NOT NULL DEFAULT 'pending', public_token TEXT NOT NULL UNIQUE, " +
        'stripe_session_id TEXT, stripe_payment_intent TEXT, scheduled_at TIMESTAMPTZ, scheduled_tz TEXT, meeting_link TEXT, admin_note TEXT, ' +
        'created_at TIMESTAMPTZ NOT NULL DEFAULT now(), paid_at TIMESTAMPTZ, refunded_at TIMESTAMPTZ, completed_at TIMESTAMPTZ)');
      const cols = ['banner_label', 'banner_head', 'banner_sub', 'banner_cta', 'banner_image', 'hero_photo', 'covers_photo', 'faq'];
      for (const c of cols) await pool.query('ALTER TABLE one_to_one_settings ADD COLUMN IF NOT EXISTS ' + c + ' TEXT');
      await pool.query('ALTER TABLE reviews ADD COLUMN IF NOT EXISTS show_on_main BOOLEAN NOT NULL DEFAULT true').catch(function () {});
      await pool.query('ALTER TABLE reviews ADD COLUMN IF NOT EXISTS show_on_o2o BOOLEAN NOT NULL DEFAULT true').catch(function () {});
      const d = DEFAULTS;
      await pool.query(
        'INSERT INTO one_to_one_settings (id, headline, intro, video_url, price_cents, currency, duration_min, meeting_tool, meeting_link, covers, who_for, refund_text, accepting, banner_on) ' +
        'VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (id) DO NOTHING',
        [d.headline, d.intro, d.video_url, d.price_cents, d.currency, d.duration_min, d.meeting_tool, d.meeting_link, d.covers, d.who_for, d.refund_text, d.accepting, d.banner_on]);
    })().catch(function (e) { ready = null; throw e; });
    return ready;
  }
  async function getSettings() {
    await ensure();
    const r = await pool.query('SELECT * FROM one_to_one_settings WHERE id = 1');
    const row = Object.assign({}, r.rows[0] || {});
    ['banner_label', 'banner_head', 'banner_cta'].forEach(function (k) { if (!row[k]) delete row[k]; });
    return Object.assign({}, DEFAULTS, row);
  }

  // ---------- emails ----------
  async function emailPaid(b, s) {
    const prefs = [b.pref1, b.pref2, b.pref3].filter(Boolean).map(function (p) { return fmtLocal(p, b.timezone); });
    const amount = money(b.amount_cents, b.currency);
    const prefText = prefs.length ? '\nTimes you suggested:\n' + prefs.map(function (p, i) { return (i + 1) + '. ' + p; }).join('\n') + '\n' : '';
    const text = 'Hello ' + b.name + ',\n\nThank you. Your payment of ' + amount + ' for a ' + s.duration_min + '-minute 1-1 session with Muhammad Bilal Aftab has been received.\n' +
      prefText + '\nWhat happens next: I will confirm a time with you by email and WhatsApp within 24 hours. ' + (prefs.length ? 'I will try to use one of the times you suggested.' : 'I will suggest a time that suits you.') +
      '\n\nBooking reference: #' + b.id + '\n\n' + (s.refund_text || '') + '\n\nMuhammad Bilal Aftab\nThe2Sellers.io\n';
    const html = wrapHtml('Payment received. You are booked in.',
      '<p>Hello ' + esc(b.name) + ',</p><p>Thank you. Your payment of <strong>' + esc(amount) + '</strong> for a ' + esc(s.duration_min) + '-minute 1-1 session with Muhammad Bilal Aftab has been received.</p>' +
      (prefs.length ? box('<strong>Times you suggested</strong><br>' + prefs.map(function (p, i) { return (i + 1) + '. ' + esc(p); }).join('<br>')) : '') +
      '<p><strong>What happens next:</strong> I will confirm a time with you by email and WhatsApp within 24 hours. ' + (prefs.length ? 'I will try to use one of the times you suggested.' : 'I will suggest a time that suits you.') + '</p>' +
      '<p style="color:#5B5D63">Booking reference #' + esc(b.id) + '</p>' + (s.refund_text ? '<p style="font-size:14px;color:#5B5D63">' + esc(s.refund_text) + '</p>' : ''));
    const r = await sendMail({ to: b.email, subject: 'Payment received: your 1-1 session with Muhammad Bilal Aftab', html: html, text: text });
    return !!(r && r.ok);
  }
  async function notifyPaid(b, s) {
    const prefs = [b.pref1, b.pref2, b.pref3].filter(Boolean).map(function (p, i) { return (i + 1) + '. ' + fmtLocal(p, b.timezone); });
    const lines = ['NEW 1-1 SESSION BOOKING (paid ' + money(b.amount_cents, b.currency) + ')', '', 'Name: ' + b.name, 'Email: ' + b.email, 'WhatsApp: ' + (b.phone || '-'), 'Their time zone: ' + (b.timezone || '-'),
      'Suggested times:', prefs.length ? prefs.join('\n') : '(none given: you choose)', 'About: ' + (b.topic || '-'), '',
      'Confirm a time here: ' + ADMIN_URL, 'Reference #' + b.id];
    return sendNotification('New 1-1 booking: ' + b.name + ' (' + money(b.amount_cents, b.currency) + ')', lines.join('\n') + '\n');
  }
  function confirmContent(b, s, when, link, message, resched) {
    const tz = b.scheduled_tz || b.timezone || 'Europe/London';
    const mine = fmtIn(when, tz);
    const uk = tz === 'Europe/London' ? '' : fmtIn(when, 'Europe/London');
    const cal = gcalUrl('1-1 Session with Muhammad Bilal Aftab', when, s.duration_min, 'Video session on ' + (s.meeting_tool || 'video') + (link ? '. Join: ' + link : ''), link || '');
    const subject = (resched ? 'New time for your 1-1 session: ' : 'Confirmed: your 1-1 session on ') + new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'long' }).format(when);
    const text = 'Hello ' + b.name + ',\n\nYour 1-1 session with Muhammad Bilal Aftab is ' + (resched ? 'moved to' : 'confirmed for') + ':\n\n' + mine + (uk ? '\n(UK time: ' + uk + ')' : '') + '\nLength: ' + s.duration_min + ' minutes\n' +
      (link ? 'Join here (' + (s.meeting_tool || 'video') + '): ' + link + '\n' : (s.meeting_tool ? 'Meeting tool: ' + s.meeting_tool + ' (link to follow)\n' : '')) +
      (message ? '\n' + message + '\n' : '') + '\nAdd to your calendar: ' + cal + '\n\nTo move the session, reply to this email or message me on WhatsApp.\nReference #' + b.id + '\n\nMuhammad Bilal Aftab\nThe2Sellers.io\n';
    const html = wrapHtml(resched ? 'Your session has a new time' : 'Your session is confirmed',
      '<p>Hello ' + esc(b.name) + ',</p><p>Your 1-1 session with Muhammad Bilal Aftab is ' + (resched ? 'moved to' : 'confirmed for') + ':</p>' +
      box('<strong style="font-size:17px">' + esc(mine) + '</strong>' + (uk ? '<br><span style="color:#5B5D63">UK time: ' + esc(uk) + '</span>' : '') + '<br>Length: ' + esc(s.duration_min) + ' minutes' +
        (link ? '<br>Join on ' + esc(s.meeting_tool || 'video') + ': <a href="' + esc(link) + '">' + esc(link) + '</a>' : (s.meeting_tool ? '<br>Meeting tool: ' + esc(s.meeting_tool) + ' (link to follow)' : ''))) +
      (message ? '<p>' + esc(message).replace(/\n/g, '<br>') + '</p>' : '') +
      '<p><a href="' + esc(cal) + '" style="background:#E8B939;color:#0F0F12;text-decoration:none;font-weight:bold;padding:11px 20px;border-radius:4px;display:inline-block">Add to Google Calendar</a></p>' +
      '<p style="font-size:14px;color:#5B5D63">To move the session, reply to this email or message me on WhatsApp. Reference #' + esc(b.id) + '</p>');
    return { subject: subject, text: text, html: html, mine: mine, uk: uk, cal: cal };
  }
  function waProposeText(b, s) {
    const prefs = [b.pref1, b.pref2, b.pref3].filter(Boolean).map(function (p, i) { return (i + 1) + '. ' + fmtLocal(p, b.timezone); });
    return 'Hi ' + String(b.name).split(' ')[0] + ', this is Bilal. Thank you for booking a 1-1 session. ' +
      (prefs.length ? 'You suggested:\n' + prefs.join('\n') + '\nI can do: [write the time here]. Does that work?' : 'What day and time suit you? Please tell me your time zone as well.');
  }
  function waConfirmText(b, s, c) {
    return 'Hi ' + String(b.name).split(' ')[0] + ', your 1-1 session is confirmed for ' + c.mine + '.' + (b.meeting_link ? '\nJoin here: ' + b.meeting_link : '') + '\nI have also emailed you the details. See you then. Bilal';
  }

  // ---------- turn a paid Stripe session into a paid booking (safe to run more than once) ----------
  async function fulfil(bookingId, session) {
    if (!session || (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required')) return { state: 'unpaid' };
    const pi = typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent && session.payment_intent.id) || null;
    const client = await pool.connect();
    let b, changed = false;
    try {
      await client.query('BEGIN');
      const r = await client.query('SELECT * FROM one_to_one_bookings WHERE id = $1 FOR UPDATE', [bookingId]);
      b = r.rows[0];
      if (!b) { await client.query('ROLLBACK'); return { state: 'missing' }; }
      if (b.status === 'pending' || b.status === 'expired') {
        const u = await client.query("UPDATE one_to_one_bookings SET status = 'paid', paid_at = NOW(), stripe_payment_intent = $1, amount_cents = $2 WHERE id = $3 RETURNING *",
          [pi, session.amount_total !== undefined && session.amount_total !== null ? session.amount_total : b.amount_cents, b.id]);
        b = u.rows[0]; changed = true;
      }
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (e2) { /* ignore */ }
      throw e;
    } finally { client.release(); }
    if (changed) {
      const s = await getSettings();
      emailPaid(b, s).catch(function () {});
      notifyPaid(b, s).catch(function () {});
    }
    return { state: changed ? 'paid' : (b.status === 'refunded' ? 'refunded' : 'already') };
  }

  // ---------- public: page content ----------
  app.get('/api/public/one-to-one', ah(async function (req, res) {
    const s = await getSettings();
    const host = (await pool.query('SELECT name, headline, bio, photo_data FROM host_profile WHERE id = 1').catch(function () { return { rows: [] }; })).rows[0] || {};
    const reviews = (await pool.query('SELECT kind, author, detail, body, rating, source, source_url, video_url FROM reviews WHERE is_active = true AND show_on_o2o = true ORDER BY display_order ASC, id ASC').catch(function () { return { rows: [] }; })).rows;
    res.json({
      accepting: !!s.accepting && !!process.env.STRIPE_SECRET_KEY,
      payments: !!process.env.STRIPE_SECRET_KEY,
      headline: s.headline, intro: s.intro, video_url: s.video_url || '',
      price_cents: s.price_cents, currency: s.currency, price_text: money(s.price_cents, s.currency),
      duration_min: s.duration_min, meeting_tool: s.meeting_tool,
      covers: String(s.covers || '').split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean),
      who_for: s.who_for, refund_text: s.refund_text,
      host: { name: host.name || 'Muhammad Bilal Aftab', headline: host.headline || null, bio: host.bio || null, photo_data: s.hero_photo || host.photo_data || null, covers_photo: s.covers_photo || null },
      faq: parseFaq(s.faq, s.refund_text),
      reviews: reviews
    });
  }));

  // ---------- public: start a payment ----------
  app.post('/api/public/one-to-one/checkout', ah(async function (req, res) {
    await ensure();
    const b = req.body || {};
    if (b.website) return res.json({ ok: true });
    if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: 'Online payment is not switched on yet. Please try again soon.' });
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    if (h.limited(ip)) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
    const s = await getSettings();
    if (!s.accepting) return res.status(409).json({ error: 'Bookings are paused at the moment. Please check back soon.' });
    const name = String(b.name || '').trim().slice(0, 120);
    const email = String(b.email || '').trim().toLowerCase().slice(0, 200);
    const phone = h.cleanPhone(b.phone);
    const tz = String(b.timezone || '').trim();
    const topic = String(b.topic || '').trim().slice(0, 1000);
    if (!name) return res.status(400).json({ error: 'Please enter your name.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (!phone.ok) return res.status(400).json({ error: 'Please enter your WhatsApp number with the country code, for example +44 7xxx xxxxxx.' });
    if (!validTz(tz)) return res.status(400).json({ error: 'Please choose your time zone.' });
    const prefs = [];
    for (let i = 1; i <= 3; i++) {
      const v = String(b['pref' + i] || '').trim();
      if (!v) { prefs.push(null); continue; }
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) || !zonedToUtc(v, tz)) return res.status(400).json({ error: 'One of your suggested times is not valid. Please check it.' });
      if (zonedToUtc(v, tz).getTime() < Date.now()) return res.status(400).json({ error: 'A suggested time is in the past. Please choose a future time.' });
      prefs.push(v);
    }
    if (!(s.price_cents >= 50)) return res.status(400).json({ error: 'The price is not set correctly yet.' });
    const token = crypto.randomBytes(18).toString('base64url');
    const ins = await pool.query(
      'INSERT INTO one_to_one_bookings (name, email, phone, timezone, pref1, pref2, pref3, topic, amount_cents, currency, status, public_token) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,\'pending\',$11) RETURNING id',
      [name, email, phone.value, tz, prefs[0], prefs[1], prefs[2], topic, s.price_cents, s.currency, token]);
    const id = ins.rows[0].id;
    try {
      const msg = ['1-1 session with Muhammad Bilal Aftab · ' + s.duration_min + ' minutes on ' + (s.meeting_tool || 'video'),
        'After you pay, I will confirm your time by email and WhatsApp within 24 hours.', s.refund_text].filter(Boolean).join('\n\n').slice(0, 1190);
      const session = await stripe('POST', '/v1/checkout/sessions', {
        mode: 'payment',
        client_reference_id: 'o2o-' + id,
        customer_email: email,
        line_items: [{ quantity: 1, price_data: { currency: s.currency, unit_amount: s.price_cents, product_data: { name: '1-1 Session with Muhammad Bilal Aftab', description: (s.duration_min + '-minute private video session · booked for ' + name).slice(0, 480) } } }],
        custom_text: { submit: { message: msg } },
        success_url: PAGE_URL + '?t=' + token + '&paid=1',
        cancel_url: PAGE_URL + '?cancelled=1#book',
        expires_at: Math.floor(Date.now() / 1000) + STRIPE_SESSION_MINUTES * 60,
        metadata: { kind: 'one_to_one', booking_id: String(id) },
        payment_intent_data: { description: '1-1 session #' + id + ' (' + name + ')', metadata: { kind: 'one_to_one', booking_id: String(id) } }
      }, 'checkout-o2o-' + id);
      await pool.query('UPDATE one_to_one_bookings SET stripe_session_id = $1 WHERE id = $2', [session.id, id]);
      res.json({ url: session.url });
    } catch (e) {
      console.error('1-1 checkout failed:', e.message);
      await pool.query("UPDATE one_to_one_bookings SET status = 'expired' WHERE id = $1", [id]).catch(function () {});
      res.status(502).json({ error: 'Sorry, we could not start the payment. Please try again in a moment.' });
    }
  }));

  // ---------- public: the thank-you state asks "has my payment gone through?" ----------
  app.post('/api/public/one-to-one/:token/confirm', ah(async function (req, res) {
    await ensure();
    if (!/^[A-Za-z0-9_-]{20,40}$/.test(req.params.token)) return res.status(404).json({ error: 'Not found' });
    let r = await pool.query('SELECT * FROM one_to_one_bookings WHERE public_token = $1', [req.params.token]);
    let b = r.rows[0];
    if (!b) return res.status(404).json({ error: 'Not found' });
    if (b.status === 'pending' && b.stripe_session_id) {
      try {
        const session = await stripe('GET', '/v1/checkout/sessions/' + encodeURIComponent(b.stripe_session_id));
        await fulfil(b.id, session);
        r = await pool.query('SELECT * FROM one_to_one_bookings WHERE id = $1', [b.id]); b = r.rows[0];
      } catch (e) { /* still pending */ }
    }
    const out = { status: b.status, name: b.name, email: b.email };
    if (b.status === 'scheduled' && b.scheduled_at) out.when = fmtIn(b.scheduled_at, b.scheduled_tz || b.timezone || 'Europe/London');
    res.json(out);
  }));

  // ---------- admin ----------
  function settingsOut(s) {
    const o = Object.assign({}, s);
    o.faq = parseFaq(s.faq, s.refund_text);
    o.faq_raw_default = !s.faq;
    return o;
  }
  app.get('/api/admin/one-to-one/settings', requireAuth, requireAdmin, ah(async function (req, res) {
    res.json(settingsOut(await getSettings()));
  }));
  const imgUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024, files: 3 },
    fileFilter: function (req, file, cb) { cb(null, ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].indexOf(file.mimetype) >= 0); }
  }).fields([{ name: 'banner_image', maxCount: 1 }, { name: 'hero_photo', maxCount: 1 }, { name: 'covers_photo', maxCount: 1 }]);
  app.patch('/api/admin/one-to-one/settings', requireAuth, requireAdmin, imgUpload, ah(async function (req, res) {
    await ensure();
    const b = req.body || {};
    const files = req.files || {};
    const sets = [], vals = [];
    SETTINGS_TEXT.forEach(function (k) { if (b[k] !== undefined) { vals.push(String(b[k]).slice(0, 4000)); sets.push(k + ' = $' + vals.length); } });
    SETTINGS_INT.forEach(function (k) {
      if (b[k] !== undefined) {
        const n = parseInt(b[k], 10);
        if (!(n >= 0 && n < 100000000)) return;
        vals.push(n); sets.push(k + ' = $' + vals.length);
      }
    });
    SETTINGS_BOOL.forEach(function (k) { if (b[k] !== undefined) { vals.push(b[k] === true || b[k] === 'true'); sets.push(k + ' = $' + vals.length); } });
    if (b.currency !== undefined && !/^[a-zA-Z]{3}$/.test(String(b.currency))) return res.status(400).json({ error: 'Currency must be a 3-letter code such as usd.' });
    if (b.price_cents !== undefined && !(parseInt(b.price_cents, 10) >= 50)) return res.status(400).json({ error: 'The price must be at least 0.50.' });
    if (b.currency !== undefined) { const i = sets.findIndex(function (x) { return x.indexOf('currency =') === 0; }); if (i >= 0) vals[sets.findIndex(function (x) { return x.indexOf('currency =') === 0; })] = String(b.currency).toLowerCase(); }
    // questions: JSON list of {q, a}; empty rows are dropped
    if (b.faq !== undefined) {
      let arr;
      try { arr = typeof b.faq === 'string' ? JSON.parse(b.faq) : b.faq; } catch (e) { return res.status(400).json({ error: 'The questions list could not be read.' }); }
      if (!Array.isArray(arr)) return res.status(400).json({ error: 'The questions list could not be read.' });
      const clean = arr.slice(0, 30).map(function (x) { return { q: String((x && x.q) || '').trim().slice(0, 300), a: String((x && x.a) || '').trim().slice(0, 2000) }; }).filter(function (x) { return x.q && x.a; });
      vals.push(JSON.stringify(clean)); sets.push('faq = $' + vals.length);
    }
    // pictures: upload replaces, remove_<name> clears (the page then falls back to the host photo or no picture)
    Object.keys(IMG_FIELDS).forEach(function (k) {
      const f = files[k] && files[k][0];
      if (f) { vals.push('data:' + f.mimetype + ';base64,' + f.buffer.toString('base64')); sets.push(k + ' = $' + vals.length); }
      else if (b['remove_' + k] === 'true' || b['remove_' + k] === true) { sets.push(k + ' = NULL'); }
    });
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
    await pool.query('UPDATE one_to_one_settings SET ' + sets.join(', ') + ', updated_at = NOW() WHERE id = 1', vals);
    res.json(settingsOut(await getSettings()));
  }));

  function rowOut(b, s) {
    const tz = b.scheduled_tz || b.timezone || 'Europe/London';
    const o = {
      id: b.id, name: b.name, email: b.email, phone: b.phone, timezone: b.timezone, topic: b.topic, status: b.status,
      amount_text: money(b.amount_cents, b.currency), created_at: b.created_at, paid_at: b.paid_at,
      prefs: [b.pref1, b.pref2, b.pref3].filter(Boolean).map(function (p) { return { raw: p, text: fmtLocal(p, b.timezone) }; }),
      scheduled_at: b.scheduled_at, scheduled_text: b.scheduled_at ? fmtIn(b.scheduled_at, tz) : null, meeting_link: b.meeting_link || '', admin_note: b.admin_note || ''
    };
    const num = waDigits(b.phone);
    let text = waProposeText(b, s);
    if (b.status === 'scheduled' && b.scheduled_at) { text = waConfirmText(b, s, { mine: fmtIn(b.scheduled_at, tz) }); }
    o.whatsapp_link = num ? 'https://wa.me/' + num + '?text=' + encodeURIComponent(text) : null;
    return o;
  }
  app.get('/api/admin/one-to-one/bookings', requireAuth, requireAdmin, ah(async function (req, res) {
    await ensure();
    const s = await getSettings();
    const r = await pool.query("SELECT * FROM one_to_one_bookings WHERE status <> 'expired' ORDER BY (status = 'paid') DESC, (status = 'scheduled') DESC, created_at DESC LIMIT 300");
    const counts = { paid: 0, scheduled: 0, completed: 0, refunded: 0, pending: 0 };
    r.rows.forEach(function (b) { if (counts[b.status] !== undefined) counts[b.status]++; });
    res.json({ counts: counts, bookings: r.rows.map(function (b) { return rowOut(b, s); }) });
  }));

  // Confirm (or change) the time. Emails the customer and gives a WhatsApp link.
  app.post('/api/admin/one-to-one/bookings/:id/confirm', requireAuth, requireAdmin, ah(async function (req, res) {
    await ensure();
    const s = await getSettings();
    const b0 = (await pool.query('SELECT * FROM one_to_one_bookings WHERE id = $1', [req.params.id])).rows[0];
    if (!b0) return res.status(404).json({ error: 'Booking not found' });
    if (b0.status !== 'paid' && b0.status !== 'scheduled') return res.status(409).json({ error: 'Only a paid booking can be scheduled (this one is "' + b0.status + '").' });
    const body = req.body || {};
    const tz = String(body.tz || b0.timezone || 'Europe/London');
    const when = zonedToUtc(String(body.when_local || ''), tz);
    if (!when) return res.status(400).json({ error: 'Please choose a valid date and time.' });
    if (when.getTime() < Date.now() - 3600000) return res.status(400).json({ error: 'That time is in the past.' });
    const link = String(body.meeting_link !== undefined ? body.meeting_link : (b0.meeting_link || s.meeting_link || '')).trim().slice(0, 500);
    const message = String(body.message || '').trim().slice(0, 1500);
    const resched = b0.status === 'scheduled';
    const u = await pool.query("UPDATE one_to_one_bookings SET status = 'scheduled', scheduled_at = $1, scheduled_tz = $2, meeting_link = $3 WHERE id = $4 RETURNING *", [when, tz, link, b0.id]);
    const b = u.rows[0];
    const c = confirmContent(b, s, when, link, message, resched);
    let emailed = false;
    try { const r = await sendMail({ to: b.email, subject: c.subject, html: c.html, text: c.text }); emailed = !!(r && r.ok); } catch (e) { emailed = false; }
    sendNotification((resched ? 'Rescheduled: ' : 'Confirmed: ') + 'your 1-1 with ' + b.name, 'Time: ' + c.mine + (c.uk ? '\nUK: ' + c.uk : '') + '\nCustomer: ' + b.name + ' <' + b.email + '> ' + (b.phone || '') + '\nCustomer email sent: ' + (emailed ? 'yes' : 'NO, please message them') + (link ? '\nLink: ' + link : '\nNo meeting link set') + '\nCalendar: ' + c.cal + '\n').catch(function () {});
    res.json({ ok: true, emailed: emailed, booking: rowOut(b, s) });
  }));

  app.post('/api/admin/one-to-one/bookings/:id/complete', requireAuth, requireAdmin, ah(async function (req, res) {
    await ensure();
    const r = await pool.query("UPDATE one_to_one_bookings SET status = 'completed', completed_at = NOW() WHERE id = $1 AND status IN ('paid','scheduled') RETURNING id", [req.params.id]);
    if (!r.rowCount) return res.status(409).json({ error: 'Only a paid or scheduled booking can be marked as done.' });
    res.json({ ok: true });
  }));

  app.patch('/api/admin/one-to-one/bookings/:id/note', requireAuth, requireAdmin, ah(async function (req, res) {
    await ensure();
    await pool.query('UPDATE one_to_one_bookings SET admin_note = $1 WHERE id = $2', [String((req.body || {}).note || '').slice(0, 2000), req.params.id]);
    res.json({ ok: true });
  }));

  app.post('/api/admin/one-to-one/bookings/:id/refund', requireAuth, requireAdmin, ah(async function (req, res) {
    await ensure();
    if (!(req.body && (req.body.confirm === true || req.body.confirm === 'true'))) return res.status(400).json({ error: 'Please confirm the refund.' });
    const b = (await pool.query('SELECT * FROM one_to_one_bookings WHERE id = $1', [req.params.id])).rows[0];
    if (!b) return res.status(404).json({ error: 'Booking not found' });
    if (b.status !== 'paid' && b.status !== 'scheduled') return res.status(409).json({ error: 'Only a paid or scheduled booking can be refunded (this one is "' + b.status + '").' });
    if (!b.stripe_payment_intent) return res.status(409).json({ error: 'This booking has no Stripe payment on record, so it cannot be refunded here.' });
    try {
      await stripe('POST', '/v1/refunds', { payment_intent: b.stripe_payment_intent, metadata: { kind: 'one_to_one', booking_id: String(b.id), by: (req.user && req.user.email) || 'admin' } }, 'refund-o2o-' + b.id);
    } catch (e) { return res.status(502).json({ error: 'Stripe could not refund this payment: ' + e.message }); }
    await pool.query("UPDATE one_to_one_bookings SET status = 'refunded', refunded_at = NOW() WHERE id = $1", [b.id]);
    let emailed = false;
    try {
      const amount = money(b.amount_cents, b.currency);
      const line = 'We have refunded your payment of ' + amount + ' for your 1-1 session. Banks usually show the money within 5 to 10 business days.';
      const r = await sendMail({
        to: b.email, subject: 'Your refund: 1-1 session with Muhammad Bilal Aftab',
        text: 'Hello ' + b.name + ',\n\n' + line + '\nReference #' + b.id + '\n\nIf this is not what you expected, just reply to this email.\n\nMuhammad Bilal Aftab\nThe2Sellers.io\n',
        html: wrapHtml('Your refund is on its way', '<p>Hello ' + esc(b.name) + ',</p><p>' + esc(line) + '</p><p style="color:#5B5D63">Reference #' + esc(b.id) + '</p><p>If this is not what you expected, just reply to this email.</p>')
      });
      emailed = !!(r && r.ok);
    } catch (e) { emailed = false; }
    res.json({ ok: true, status: 'refunded', emailed: emailed });
  }));

  // Remove an unpaid or abandoned attempt (paid bookings are never deleted, refund them instead).
  app.delete('/api/admin/one-to-one/bookings/:id', requireAuth, requireAdmin, ah(async function (req, res) {
    await ensure();
    const r = await pool.query("DELETE FROM one_to_one_bookings WHERE id = $1 AND status IN ('pending','expired','refunded','completed') RETURNING id", [req.params.id]);
    if (!r.rowCount) return res.status(409).json({ error: 'A paid or scheduled booking cannot be deleted. Refund it or mark it done first.' });
    res.json({ ok: true });
  }));

  // ---------- hooks used by the shared Stripe webhook and daily check ----------
  return {
    async webhook(type, obj) {
      await ensure();
      const id = parseInt((obj.metadata && obj.metadata.booking_id) || '', 10);
      if (!id) return;
      const own = (await pool.query('SELECT stripe_session_id FROM one_to_one_bookings WHERE id = $1', [id])).rows[0];
      if (!own) return;
      if (!own.stripe_session_id) { const e = new Error('Booking not ready yet'); e.retry = true; throw e; }   // Stripe will retry
      if (own.stripe_session_id !== obj.id) return;   // not a session we created for this booking
      if (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded') await fulfil(id, obj);
      else if (type === 'checkout.session.expired' || type === 'checkout.session.async_payment_failed') await pool.query("UPDATE one_to_one_bookings SET status = 'expired' WHERE id = $1 AND status = 'pending'", [id]);
    },
    async healSession(s) {
      await ensure();
      const id = parseInt((s.metadata && s.metadata.booking_id) || '', 10);
      if (!id) return null;
      const b = (await pool.query('SELECT id, status, stripe_session_id FROM one_to_one_bookings WHERE id = $1', [id])).rows[0];
      if (!b || b.stripe_session_id !== s.id) return null;
      if (s.payment_status === 'paid' && (b.status === 'pending' || b.status === 'expired')) { const f = await fulfil(id, s); return { order_id: 'o2o-' + id, result: f.state }; }
      if (s.status === 'expired' && b.status === 'pending') await pool.query("UPDATE one_to_one_bookings SET status = 'expired' WHERE id = $1", [id]);
      return null;
    }
  };
};

// Slide for the homepage banner slider (shown while the 1-1 page is open for bookings).
module.exports.slide = async function (pool) {
  const r = await pool.query('SELECT * FROM one_to_one_settings WHERE id = 1').catch(function () { return { rows: [] }; });
  const row = r.rows[0];
  if (!row || !row.banner_on || !row.accepting) return [];
  const s = Object.assign({}, DEFAULTS, row);
  ['banner_label', 'banner_head', 'banner_cta'].forEach(function (k) { if (!row[k]) s[k] = DEFAULTS[k]; });
  const sub = String(s.banner_sub || '').trim() || (s.duration_min + ' minutes · private video session · ' + money(s.price_cents, s.currency));
  return [{
    id: 'one-to-one',
    label: s.banner_label,
    head: s.banner_head,
    sub: sub,
    badge: '',
    dest: PAGE_URL,
    cta: s.banner_cta,
    layout: row.banner_image ? 'background' : 'text',
    image_data: row.banner_image || null,
    img_size: 'medium', img_focus: 'upper', img_style: 'fade'
  }];
};
