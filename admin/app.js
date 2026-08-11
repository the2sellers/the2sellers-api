const API_BASE = '/api';

function getToken() { return localStorage.getItem('t2s_admin_token'); }
function getUser() {
  const raw = localStorage.getItem('t2s_admin_user');
  return raw ? JSON.parse(raw) : null;
}
function setSession(token, user) {
  localStorage.setItem('t2s_admin_token', token);
  localStorage.setItem('t2s_admin_user', JSON.stringify(user));
}
function clearSession() {
  localStorage.removeItem('t2s_admin_token');
  localStorage.removeItem('t2s_admin_user');
}

// Redirect to login if not authenticated. Call at the top of every protected page.
function requireAuthOrRedirect() {
  if (!getToken()) {
    window.location.href = '/admin/login.html';
    return false;
  }
  return true;
}

async function apiFetch(path, options = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;

  const res = await fetch(API_BASE + path, Object.assign({}, options, { headers }));

  if (res.status === 401) {
    clearSession();
    window.location.href = '/admin/login.html';
    throw new Error('Session expired');
  }

  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const body = isJson ? await res.json() : null;

  if (!res.ok) {
    throw new Error((body && body.error) || `Request failed (${res.status})`);
  }
  return body;
}

function renderTopbar(activePage) {
  const user = getUser();
  const el = document.getElementById('topbar');
  if (!el) return;
  el.innerHTML = `
    <div class="brand">The2Sellers<span>.io</span> — Admin</div>
    <nav>
      <a href="/admin/index.html" class="${activePage === 'listings' ? 'active' : ''}">Listings</a>
      <a href="/admin/inquiries.html" class="${activePage === 'inquiries' ? 'active' : ''}">Buyer Inquiries</a>
    </nav>
    <div class="user">
      <span>${user ? user.name + ' · ' + user.role : ''}</span>
      <button id="logoutBtn">Log out</button>
    </div>
  `;
  document.getElementById('logoutBtn').addEventListener('click', () => {
    clearSession();
    window.location.href = '/admin/login.html';
  });
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  return days + 'd ago';
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
