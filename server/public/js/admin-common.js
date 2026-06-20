const SIDEBAR_LINKS = [
  { key: 'dashboard', label: 'Dashboard', href: 'dashboard.html' },
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
