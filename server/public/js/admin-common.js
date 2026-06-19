const SIDEBAR_LINKS = [
  { key: 'leads', label: 'Leads', href: 'dashboard.html' },
  { key: 'automation', label: 'Automation', href: 'automation.html' },
  { key: 'fleet', label: 'Fleet Management', href: 'fleet-admin.html' },
  { key: 'maintenance', label: 'Maintenance', href: 'maintenance.html' },
  { key: 'mysite', label: 'My Site', href: 'https://mmasfar2.github.io/drivenow/', external: true },
];

function renderSidebar(activeKey) {
  const root = document.getElementById('sidebar-root');
  if (!root) return;
  root.innerHTML = `
    <div class="sidebar">
      <div class="sidebar__logo">Drive<span>Now</span></div>
      <div class="sidebar__nav">
        ${SIDEBAR_LINKS.map(l => `<a href="${l.href}" class="${l.key === activeKey ? 'active' : ''}"${l.external ? ' target="_blank" rel="noopener"' : ''}>${l.label}${l.external ? ' ↗' : ''}</a>`).join('')}
      </div>
      <div class="sidebar__footer">
        <div class="sidebar__user" id="nav-user"></div>
        <a href="#" class="btn btn-sm btn-outline btn-block" style="border-color:rgba(255,255,255,0.3);color:#fff;" onclick="logout()">Log Out</a>
      </div>
    </div>
  `;
}

async function requireLogin() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) { window.location.href = 'login.html'; return null; }
    const user = await res.json();
    const userLabel = document.getElementById('nav-user');
    if (userLabel) userLabel.textContent = `${user.name} (${user.role})`;
    return user;
  } catch {
    window.location.href = 'login.html';
    return null;
  }
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = 'login.html';
}

function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
