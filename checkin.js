// Door check-in: scan QR tickets, look guests up by hand, count arrivals.
// Everything here needs a logged-in admin or staff account.

const { requireAuth } = require('./auth');

module.exports = function mountCheckin(app, pool, h) {
  const ah = h.ah;
  let ready = null;
  function ensure() {
    if (!ready) {
      ready = pool.query('ALTER TABLE tickets ADD COLUMN IF NOT EXISTS checked_in_by TEXT').catch(function (e) { ready = null; throw e; });
    }
    return ready;
  }
  function staffName(req) { return (req.user && (req.user.name || req.user.email)) || 'staff'; }

  // A scanned value may be the bare code, or a link or text that contains it.
  function cleanCode(raw) {
    const m = String(raw || '').toUpperCase().match(/T2S[A-Z0-9]{10}/);
    return m ? m[0] : null;
  }

  async function partyOf(orderId) {
    const r = await pool.query('SELECT COUNT(*)::int AS total, COUNT(checked_in_at)::int AS arrived FROM tickets WHERE order_id = $1', [orderId]);
    return r.rows[0];
  }

  // Events to choose from, nearest to today first.
  app.get('/api/admin/checkin/events', requireAuth, ah(async function (req, res) {
    await ensure();
    const r = await pool.query(
      "SELECT e.id, e.city, e.title, e.starts_at, e.timezone, e.is_online, e.status, " +
      "(SELECT COUNT(*)::int FROM tickets t JOIN orders o ON o.id = t.order_id WHERE t.event_id = e.id AND o.status = 'paid') AS total, " +
      "(SELECT COUNT(*)::int FROM tickets t JOIN orders o ON o.id = t.order_id WHERE t.event_id = e.id AND o.status = 'paid' AND t.checked_in_at IS NOT NULL) AS arrived " +
      "FROM events e WHERE e.status IN ('published', 'closed') " +
      "ORDER BY (e.starts_at IS NULL), ABS(EXTRACT(EPOCH FROM (e.starts_at - NOW()))) ASC");
    res.json(r.rows);
  }));

  // Everyone booked into one event, with arrival status and totals.
  app.get('/api/admin/checkin/events/:id/attendees', requireAuth, ah(async function (req, res) {
    await ensure();
    const er = await pool.query('SELECT id, city, title, starts_at, timezone FROM events WHERE id = $1', [req.params.id]);
    if (!er.rows[0]) return res.status(404).json({ error: 'Event not found' });
    const r = await pool.query(
      "SELECT t.code, t.holder_name, t.has_dinner, t.checked_in_at, o.id AS order_id, o.buyer_email, o.buyer_phone, o.qty " +
      "FROM tickets t JOIN orders o ON o.id = t.order_id WHERE t.event_id = $1 AND o.status = 'paid' ORDER BY lower(t.holder_name), t.id", [req.params.id]);
    const tickets = r.rows;
    res.json({
      event: er.rows[0],
      counts: {
        total: tickets.length,
        arrived: tickets.filter(function (t) { return t.checked_in_at; }).length,
        dinner_total: tickets.filter(function (t) { return t.has_dinner; }).length,
        dinner_arrived: tickets.filter(function (t) { return t.has_dinner && t.checked_in_at; }).length
      },
      tickets: tickets
    });
  }));

  // Scan (or type) a ticket code and check the guest in.
  app.post('/api/admin/checkin/scan', requireAuth, ah(async function (req, res) {
    await ensure();
    const code = cleanCode((req.body || {}).code);
    if (!code) return res.json({ result: 'invalid', message: 'That does not look like a ticket code.' });
    const r = await pool.query(
      "SELECT t.id, t.code, t.holder_name, t.has_dinner, t.checked_in_at, t.event_id, t.order_id, o.status AS order_status, e.city, e.title " +
      "FROM tickets t JOIN orders o ON o.id = t.order_id JOIN events e ON e.id = t.event_id WHERE t.code = $1", [code]);
    const t = r.rows[0];
    if (!t) return res.json({ result: 'invalid', message: 'Ticket not found.', code: code });
    const base = { code: t.code, holder_name: t.holder_name, has_dinner: t.has_dinner, event_city: t.city };
    if (t.order_status !== 'paid') return res.json(Object.assign({ result: 'invalid', message: 'This ticket is no longer valid (' + t.order_status + ').' }, base));
    const wantEvent = parseInt((req.body || {}).event_id, 10);
    if (wantEvent && wantEvent !== t.event_id) return res.json(Object.assign({ result: 'wrong_event', message: 'This ticket is for ' + t.city + ', not this event.' }, base));
    if (t.checked_in_at) return res.json(Object.assign({ result: 'already', checked_in_at: t.checked_in_at, party: await partyOf(t.order_id), order_id: t.order_id }, base));
    // The WHERE ... IS NULL makes this safe if two phones scan the same ticket at the same moment.
    const u = await pool.query('UPDATE tickets SET checked_in_at = NOW(), checked_in_by = $2 WHERE id = $1 AND checked_in_at IS NULL RETURNING checked_in_at', [t.id, staffName(req)]);
    if (!u.rows[0]) {
      const again = await pool.query('SELECT checked_in_at FROM tickets WHERE id = $1', [t.id]);
      return res.json(Object.assign({ result: 'already', checked_in_at: again.rows[0].checked_in_at, party: await partyOf(t.order_id), order_id: t.order_id }, base));
    }
    res.json(Object.assign({ result: 'ok', checked_in_at: u.rows[0].checked_in_at, party: await partyOf(t.order_id), order_id: t.order_id }, base));
  }));

  // Check in everyone in one booking (a group arriving together).
  app.post('/api/admin/checkin/order', requireAuth, ah(async function (req, res) {
    await ensure();
    const orderId = parseInt((req.body || {}).order_id, 10);
    if (!orderId) return res.status(400).json({ error: 'Booking not specified.' });
    const o = await pool.query('SELECT status FROM orders WHERE id = $1', [orderId]);
    if (!o.rows[0]) return res.status(404).json({ error: 'Booking not found.' });
    if (o.rows[0].status !== 'paid') return res.status(409).json({ error: 'This booking is no longer valid (' + o.rows[0].status + ').' });
    const u = await pool.query('UPDATE tickets SET checked_in_at = NOW(), checked_in_by = $2 WHERE order_id = $1 AND checked_in_at IS NULL RETURNING id', [orderId, staffName(req)]);
    res.json({ ok: true, checked: u.rowCount, party: await partyOf(orderId) });
  }));

  // Undo a check-in made by mistake.
  app.post('/api/admin/checkin/undo', requireAuth, ah(async function (req, res) {
    await ensure();
    const code = cleanCode((req.body || {}).code);
    if (!code) return res.status(400).json({ error: 'Ticket code not recognised.' });
    const u = await pool.query('UPDATE tickets SET checked_in_at = NULL, checked_in_by = NULL WHERE code = $1 RETURNING id', [code]);
    if (!u.rows[0]) return res.status(404).json({ error: 'Ticket not found.' });
    res.json({ ok: true });
  }));
};
