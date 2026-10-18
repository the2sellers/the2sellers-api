// Workshop materials: files the owner uploads per event in the CMS (workbooks, templates,
// slides), downloadable only by people holding a confirmed booking for that event.
// Files are stored in Postgres (bytea) because Render's local disk is wiped on restart.
// Access key is the booking's long random public token, the same one the ticket page uses.

const multer = require('multer');
const { requireAuth } = require('./auth');
const { sendMail } = require('./email');

const MAX_FILE_MB = 25;
const API_PUBLIC_URL = process.env.API_PUBLIC_URL || 'https://the2sellers-api.onrender.com';
const MATERIALS_PAGE_URL = process.env.MATERIALS_PAGE_URL || (API_PUBLIC_URL + '/admin/materials.html');
const TOKEN_RE = /^[A-Za-z0-9_-]{20,40}$/;
const ALLOWED_EXT = ['pdf', 'docx', 'doc', 'xlsx', 'xls', 'csv', 'pptx', 'ppt', 'zip', 'png', 'jpg', 'jpeg', 'txt', 'mp4'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1 },
  fileFilter: function (req, file, cb) {
    const ext = String(file.originalname || '').split('.').pop().toLowerCase();
    if (ALLOWED_EXT.indexOf(ext) >= 0) cb(null, true);
    else cb(new Error('This file type is not allowed. Use PDF, Word, Excel, PowerPoint, ZIP, image, text or MP4.'));
  }
});

function esc(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}
function cleanText(v, max) { return String(v === undefined || v === null ? '' : v).trim().slice(0, max); }
function safeFilename(name) {
  const base = String(name || 'file').replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
  return base || 'file';
}
function extOf(name) { return String(name || '').split('.').pop().toLowerCase(); }

let ready = null;
function ensureSchema(pool) {
  if (!ready) {
    ready = pool.query(`
      CREATE TABLE IF NOT EXISTS event_files (
        id SERIAL PRIMARY KEY,
        event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        section TEXT NOT NULL DEFAULT 'Workshop materials',
        title TEXT NOT NULL,
        description TEXT,
        filename TEXT NOT NULL,
        mime TEXT NOT NULL DEFAULT 'application/octet-stream',
        size_bytes INTEGER NOT NULL DEFAULT 0,
        data BYTEA NOT NULL,
        display_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_event_files_event ON event_files(event_id, display_order);
      ALTER TABLE events ADD COLUMN IF NOT EXISTS materials_intro TEXT;
    `).catch(function (e) { ready = null; throw e; });
  }
  return ready;
}

const LIST_COLS = 'id, event_id, section, title, description, filename, mime, size_bytes, display_order, created_at, updated_at';
function publicFile(f) {
  return { id: f.id, section: f.section, title: f.title, description: f.description || '', filename: f.filename, ext: extOf(f.filename), size_bytes: f.size_bytes, updated_at: f.updated_at };
}

// The booking behind a token, if it is confirmed. Refunded or cancelled bookings lose access.
async function paidOrder(pool, token) {
  if (!TOKEN_RE.test(String(token || ''))) return null;
  const r = await pool.query(
    'SELECT o.id, o.status, o.buyer_name, o.event_id, e.title, e.city, e.slug, e.starts_at, e.timezone, e.materials_intro FROM orders o JOIN events e ON e.id = o.event_id WHERE o.public_token = $1', [token]);
  const o = r.rows[0];
  if (!o || o.status !== 'paid') return null;
  return o;
}

async function countFiles(pool, eventId) {
  await ensureSchema(pool);
  const r = await pool.query('SELECT COUNT(*)::int AS n FROM event_files WHERE event_id = $1', [eventId]);
  return r.rows[0].n;
}

function materialsLink(token) { return MATERIALS_PAGE_URL + '?t=' + encodeURIComponent(token); }

function linkEmail(ev, name, token, count) {
  const link = materialsLink(token);
  const html = '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#0F0F12">' +
    '<h2 style="font-family:Georgia,serif;font-weight:normal">Your workshop materials are ready, ' + esc(name) + '.</h2>' +
    '<p>Everything for <strong>' + esc(ev.title) + '</strong> is in your private download area: ' + count + ' file' + (count === 1 ? '' : 's') + ', including the module workbooks, templates and slides.</p>' +
    '<p style="margin:22px 0"><a href="' + esc(link) + '" style="background:#E8B939;color:#0F0F12;padding:12px 20px;border-radius:4px;text-decoration:none;font-weight:bold">Open my workshop materials</a></p>' +
    '<p style="color:#5B5D63;font-size:13px">This link is personal to your booking. Please don\'t share it. Questions? Reply to this email or write to contact@the2sellers.io.</p></div>';
  const text = 'Your workshop materials are ready, ' + name + '.\n\nEverything for ' + ev.title + ' is in your private download area (' + count + ' files):\n' + link + '\n\nThis link is personal to your booking. Please don\'t share it.\nQuestions? Reply to this email or write to contact@the2sellers.io.\n';
  return { html: html, text: text, link: link };
}

module.exports = function mountMaterials(app, pool) {
  const ah = function (fn) { return function (req, res, next) { Promise.resolve(fn(req, res, next)).catch(next); }; };
  const one = function (req, res, next) {
    upload.single('file')(req, res, function (err) {
      if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That file is over ' + MAX_FILE_MB + ' MB. Please compress it or split it.' : err.message });
      next();
    });
  };

  // ---------- public: what ticket holders get (titles only, shown on the event page) ----------
  app.get('/api/public/events/:slug/materials-preview', ah(async function (req, res) {
    await ensureSchema(pool);
    const e = await pool.query("SELECT id, materials_intro FROM events WHERE slug = $1 AND status IN ('published', 'closed')", [req.params.slug]);
    if (!e.rows[0]) return res.status(404).json({ error: 'Event not found' });
    const r = await pool.query('SELECT section, title, filename FROM event_files WHERE event_id = $1 ORDER BY display_order ASC, id ASC', [e.rows[0].id]);
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ intro: e.rows[0].materials_intro || '', files: r.rows.map(function (f) { return { section: f.section, title: f.title, ext: extOf(f.filename) }; }) });
  }));

  // ---------- public: a ticket holder's download list ----------
  app.get('/api/public/orders/:token/materials', ah(async function (req, res) {
    await ensureSchema(pool);
    const o = await paidOrder(pool, req.params.token);
    if (!o) return res.status(404).json({ error: 'We could not find a confirmed booking for this link.' });
    const r = await pool.query('SELECT ' + LIST_COLS + ' FROM event_files WHERE event_id = $1 ORDER BY display_order ASC, id ASC', [o.event_id]);
    res.set('Cache-Control', 'no-store');
    res.json({
      buyer_name: o.buyer_name,
      event: { title: o.title, city: o.city, slug: o.slug, starts_at: o.starts_at, timezone: o.timezone, intro: o.materials_intro || '' },
      files: r.rows.map(publicFile)
    });
  }));

  app.get('/api/public/orders/:token/materials/:fileId', ah(async function (req, res) {
    await ensureSchema(pool);
    const o = await paidOrder(pool, req.params.token);
    const fid = parseInt(req.params.fileId, 10);
    if (!o || !fid) return res.status(404).json({ error: 'Not found' });
    const r = await pool.query('SELECT filename, mime, data FROM event_files WHERE id = $1 AND event_id = $2', [fid, o.event_id]);
    const f = r.rows[0];
    if (!f) return res.status(404).json({ error: 'Not found' });
    const name = safeFilename(f.filename);
    res.set({
      'Content-Type': f.mime || 'application/octet-stream',
      'Content-Length': String(f.data.length),
      'Content-Disposition': 'attachment; filename="' + name.replace(/[^\x20-\x7E]/g, '_') + '"; filename*=UTF-8\'\'' + encodeURIComponent(name),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(f.data);
  }));

  // ---------- admin: manage an event's files ----------
  app.get('/api/admin/events/:id/materials', requireAuth, ah(async function (req, res) {
    await ensureSchema(pool);
    const e = await pool.query('SELECT id, title, city, slug, materials_intro FROM events WHERE id = $1', [req.params.id]);
    if (!e.rows[0]) return res.status(404).json({ error: 'Event not found' });
    const r = await pool.query('SELECT ' + LIST_COLS + ' FROM event_files WHERE event_id = $1 ORDER BY display_order ASC, id ASC', [e.rows[0].id]);
    const holders = (await pool.query("SELECT COUNT(*)::int AS n FROM orders WHERE event_id = $1 AND status = 'paid'", [e.rows[0].id])).rows[0].n;
    res.json({ event: e.rows[0], files: r.rows, paid_bookings: holders, max_mb: MAX_FILE_MB });
  }));

  app.patch('/api/admin/events/:id/materials-intro', requireAuth, ah(async function (req, res) {
    await ensureSchema(pool);
    const t = cleanText((req.body || {}).intro, 2000);
    const r = await pool.query('UPDATE events SET materials_intro = $1 WHERE id = $2 RETURNING id', [t || null, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Event not found' });
    res.json({ ok: true });
  }));

  app.post('/api/admin/events/:id/materials', requireAuth, one, ah(async function (req, res) {
    await ensureSchema(pool);
    if (!req.file) return res.status(400).json({ error: 'Please choose a file to upload.' });
    const e = await pool.query('SELECT id FROM events WHERE id = $1', [req.params.id]);
    if (!e.rows[0]) return res.status(404).json({ error: 'Event not found' });
    const b = req.body || {};
    const filename = safeFilename(req.file.originalname);
    const title = cleanText(b.title, 160) || filename.replace(/\.[^.]+$/, '');
    const section = cleanText(b.section, 80) || 'Workshop materials';
    const nextOrder = (await pool.query('SELECT COALESCE(MAX(display_order), 0) + 1 AS n FROM event_files WHERE event_id = $1', [e.rows[0].id])).rows[0].n;
    const order = b.display_order !== undefined && b.display_order !== '' ? (parseInt(b.display_order, 10) || 0) : nextOrder;
    const r = await pool.query(
      'INSERT INTO event_files (event_id, section, title, description, filename, mime, size_bytes, data, display_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ' + LIST_COLS,
      [e.rows[0].id, section, title, cleanText(b.description, 600) || null, filename, req.file.mimetype || 'application/octet-stream', req.file.size, req.file.buffer, order]);
    res.status(201).json(r.rows[0]);
  }));

  // Edit the title, section, description or order, and optionally replace the file itself.
  app.patch('/api/admin/materials/:fid', requireAuth, one, ah(async function (req, res) {
    await ensureSchema(pool);
    const b = req.body || {};
    const sets = [], vals = [];
    function set(col, v) { vals.push(v); sets.push(col + ' = $' + vals.length); }
    if (b.title !== undefined && cleanText(b.title, 160)) set('title', cleanText(b.title, 160));
    if (b.section !== undefined && cleanText(b.section, 80)) set('section', cleanText(b.section, 80));
    if (b.description !== undefined) set('description', cleanText(b.description, 600) || null);
    if (b.display_order !== undefined && b.display_order !== '') set('display_order', parseInt(b.display_order, 10) || 0);
    if (req.file) {
      set('filename', safeFilename(req.file.originalname)); set('mime', req.file.mimetype || 'application/octet-stream');
      set('size_bytes', req.file.size); set('data', req.file.buffer);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to change.' });
    vals.push(req.params.fid);
    const r = await pool.query('UPDATE event_files SET ' + sets.join(', ') + ', updated_at = NOW() WHERE id = $' + vals.length + ' RETURNING ' + LIST_COLS, vals);
    if (!r.rows[0]) return res.status(404).json({ error: 'File not found' });
    res.json(r.rows[0]);
  }));

  app.delete('/api/admin/materials/:fid', requireAuth, ah(async function (req, res) {
    await ensureSchema(pool);
    const r = await pool.query('DELETE FROM event_files WHERE id = $1 RETURNING id', [req.params.fid]);
    if (!r.rows[0]) return res.status(404).json({ error: 'File not found' });
    res.json({ ok: true });
  }));

  // Admin preview: download a file without a booking.
  app.get('/api/admin/materials/:fid/download', requireAuth, ah(async function (req, res) {
    await ensureSchema(pool);
    const r = await pool.query('SELECT filename, mime, data FROM event_files WHERE id = $1', [req.params.fid]);
    const f = r.rows[0];
    if (!f) return res.status(404).json({ error: 'File not found' });
    const name = safeFilename(f.filename);
    res.set({ 'Content-Type': f.mime, 'Content-Disposition': 'attachment; filename="' + name.replace(/[^\x20-\x7E]/g, '_') + '"', 'Cache-Control': 'no-store' });
    res.end(f.data);
  }));

  // Email the download link to everyone with a confirmed booking (for files added after people booked).
  app.post('/api/admin/events/:id/materials/notify', requireAuth, ah(async function (req, res) {
    await ensureSchema(pool);
    const e = await pool.query('SELECT id, title, city FROM events WHERE id = $1', [req.params.id]);
    const ev = e.rows[0];
    if (!ev) return res.status(404).json({ error: 'Event not found' });
    const count = await countFiles(pool, ev.id);
    if (!count) return res.status(400).json({ error: 'Upload at least one file first.' });
    const orders = (await pool.query("SELECT id, buyer_name, buyer_email, public_token FROM orders WHERE event_id = $1 AND status = 'paid' AND public_token IS NOT NULL ORDER BY id", [ev.id])).rows;
    let sent = 0, failed = 0;
    for (const o of orders) {
      const m = linkEmail(ev, o.buyer_name, o.public_token, count);
      try {
        const r = await sendMail({ to: o.buyer_email, subject: 'Your workshop materials: ' + ev.title, html: m.html, text: m.text });
        if (r && (r.ok || r.skipped)) sent++; else failed++;
      } catch (err) { failed++; }
    }
    res.json({ ok: true, bookings: orders.length, sent: sent, failed: failed });
  }));
};

module.exports.countFiles = countFiles;
module.exports.materialsLink = materialsLink;
module.exports.ensureSchema = ensureSchema;
