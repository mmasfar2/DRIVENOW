const ICONS = {
  car: '<path d="M3 13l1.5-4.5A2 2 0 0 1 6.4 7h11.2a2 2 0 0 1 1.9 1.5L21 13"/><path d="M3 13h18v4a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H6v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><circle cx="7.5" cy="17.5" r="1.3"/><circle cx="16.5" cy="17.5" r="1.3"/>',
  trending: '<polyline points="3 17 9 11 13 15 21 6"/><polyline points="15 6 21 6 21 12"/>',
  dollar: '<line x1="12" y1="2" x2="12" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 16 14"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94z"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
};

function icon(name, size = 18) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
}

const SIDEBAR_LINKS = [
  { key: 'dashboard', label: 'Dashboard', href: 'dashboard.html' },
  { key: 'reservations', label: 'Reservations', href: 'reservations.html' },
  { key: 'leads', label: 'Leads', href: 'leads.html' },
  { key: 'automation', label: 'Automation', href: 'automation.html' },
  { key: 'fleet', label: 'Fleet Management', href: 'fleet-admin.html' },
  { key: 'maintenance', label: 'Maintenance', href: 'maintenance.html' },
  { key: 'mysite', label: 'My Site', href: 'https://mmasfar2.github.io/drivenow/', external: true },
];

const SIDEBAR_ORDER_KEY = 'dn-sidebar-order';

function getOrderedSidebarLinks() {
  let order = [];
  try { order = JSON.parse(localStorage.getItem(SIDEBAR_ORDER_KEY)) || []; } catch { order = []; }
  const byKey = Object.fromEntries(SIDEBAR_LINKS.map(l => [l.key, l]));
  const ordered = order.map(k => byKey[k]).filter(Boolean);
  SIDEBAR_LINKS.forEach(l => { if (!ordered.includes(l)) ordered.push(l); });
  return ordered;
}

function saveSidebarOrder(keys) {
  localStorage.setItem(SIDEBAR_ORDER_KEY, JSON.stringify(keys));
}

function renderSidebar(activeKey) {
  const root = document.getElementById('sidebar-root');
  if (!root) return;
  const links = getOrderedSidebarLinks();
  root.innerHTML = `
    <div class="sidebar">
      <div class="sidebar__logo">Drive<span>Now</span></div>
      <div class="sidebar__nav" id="sidebar-nav">
        ${links.map(l => `
          <a href="${l.href}" draggable="true" data-key="${l.key}" class="${l.key === activeKey ? 'active' : ''}"${l.external ? ' target="_blank" rel="noopener"' : ''}>
            <span class="sidebar__drag-handle">⠿</span>${l.label}${l.external ? ' ↗' : ''}
          </a>`).join('')}
      </div>
      <div class="sidebar__footer">
        <div class="sidebar__user" id="nav-user"></div>
        <a href="#" class="btn btn-sm btn-outline btn-block" style="border-color:rgba(255,255,255,0.3);color:#fff;" onclick="logout()">Log Out</a>
      </div>
    </div>
  `;
  initSidebarDragReorder();
}

function initSidebarDragReorder() {
  const nav = document.getElementById('sidebar-nav');
  if (!nav) return;
  let dragEl = null;

  nav.querySelectorAll('a').forEach(a => {
    a.addEventListener('dragstart', (e) => {
      dragEl = a;
      a.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    a.addEventListener('dragend', () => {
      a.classList.remove('dragging');
      dragEl = null;
      saveSidebarOrder(Array.from(nav.querySelectorAll('a')).map(el => el.dataset.key));
    });
    a.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!dragEl || dragEl === a) return;
      const rect = a.getBoundingClientRect();
      const before = (e.clientY - rect.top) / rect.height < 0.5;
      nav.insertBefore(dragEl, before ? a : a.nextSibling);
    });
  });
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
