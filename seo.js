'use strict';
// Tells search engines that use IndexNow (Bing, Yandex, Seznam, Naver and others) that pages changed,
// so they re-crawl straight away instead of waiting. Fire-and-forget: never blocks or breaks a request.
// Google does not support IndexNow; it re-reads the sitemap on its own (see /sitemap.xml).
const SITE = process.env.SITE_URL || 'https://the2sellers.io';
const KEY = process.env.INDEXNOW_KEY || 'bf71bc2fa0d15d5124517f40712e7877';

function abs(u) { return /^https?:\/\//i.test(u) ? u : SITE + (u.charAt(0) === '/' ? '' : '/') + u; }

async function pingIndexNow(urls) {
  try {
    const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean).map(abs);
    const uniq = Array.from(new Set(list)).slice(0, 500);
    if (!uniq.length) return { ok: false, count: 0 };
    const host = new URL(SITE).host;
    const r = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host: host, key: KEY, keyLocation: SITE + '/' + KEY + '.txt', urlList: uniq })
    });
    return { ok: r.status === 200 || r.status === 202, status: r.status, count: uniq.length };
  } catch (err) {
    console.error('IndexNow ping failed (non-fatal):', err.message);
    return { ok: false, count: 0 };
  }
}

module.exports = { pingIndexNow, SITE, KEY };
