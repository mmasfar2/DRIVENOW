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
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
};

function icon(name, size = 18) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
}

const SIDEBAR_LINKS = [
  { key: 'dashboard', label: 'Dashboard', href: 'dashboard.html' },
  { key: 'reservations', label: 'Reservations', href: 'reservations.html' },
  { key: 'waitlist', label: 'Waitlist', href: 'waitlist.html' },
  { key: 'leads', label: 'Leads', href: 'leads.html' },
  { key: 'automation', label: 'Automation', href: 'automation.html' },
  { key: 'fleet', label: 'Fleet Management', href: 'fleet-admin.html' },
  { key: 'maintenance', label: 'Maintenance', href: 'maintenance.html' },
  { key: 'business-expenses', label: 'Business Expenses', href: 'business-expenses.html' },
  { key: 'downtime', label: 'Downtime', href: 'downtime.html' },
  { key: 'claims', label: 'Claims', href: 'claims.html' },
  { key: 'metrics', label: 'Reports', href: 'metrics.html' },
  { key: 'clients', label: 'Clients', href: 'clients.html' },
  { key: 'insurance', label: 'Insurance', href: 'insurance.html' },
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
  const isGroupActive = (l) => l.key === activeKey || (l.children && l.children.some(c => c.key === activeKey));
  root.innerHTML = `
    <div class="sidebar">
      <div class="sidebar__logo">Drive<span>Now</span></div>
      <div class="sidebar__nav" id="sidebar-nav">
        ${links.map(l => `
          <div class="sidebar__nav-item" draggable="true" data-key="${l.key}">
            ${l.children ? `
              <a href="#" class="sidebar__nav-toggle${isGroupActive(l) ? ' active' : ''}" data-toggle-key="${l.key}">
                <span class="sidebar__drag-handle">⠿</span>${l.label}
                <span class="sidebar__caret">${isGroupActive(l) ? '▾' : '▸'}</span>
              </a>
              <div class="sidebar__subnav" data-submenu-for="${l.key}" style="${isGroupActive(l) ? '' : 'display:none;'}">
                ${l.children.map(c => `<a href="${c.href}" class="sidebar__sublink${c.key === activeKey ? ' active' : ''}">${c.label}</a>`).join('')}
              </div>
            ` : `
              <a href="${l.href}" class="${l.key === activeKey ? 'active' : ''}"${l.external ? ' target="_blank" rel="noopener"' : ''}>
                <span class="sidebar__drag-handle">⠿</span>${l.label}${l.external ? ' ↗' : ''}
              </a>
            `}
          </div>`).join('')}
      </div>
      <div class="sidebar__footer">
        <div class="sidebar__user" id="nav-user"></div>
        <a href="#" class="btn btn-sm btn-outline btn-block" style="border-color:rgba(255,255,255,0.3);color:#fff;" onclick="logout()">Log Out</a>
      </div>
    </div>
  `;
  initSidebarDragReorder();
  initSidebarToggles();
  ensureUndoButton();
}

function initSidebarToggles() {
  document.querySelectorAll('.sidebar__nav-toggle').forEach(toggle => {
    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      const submenu = document.querySelector(`.sidebar__subnav[data-submenu-for="${toggle.dataset.toggleKey}"]`);
      if (!submenu) return;
      const opening = submenu.style.display === 'none';
      submenu.style.display = opening ? '' : 'none';
      toggle.querySelector('.sidebar__caret').textContent = opening ? '▾' : '▸';
    });
  });
}

function ensureUndoButton() {
  let wrap = document.getElementById('global-undo-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'global-undo-wrap';
    wrap.style.position = 'fixed';
    wrap.style.top = '16px';
    wrap.style.right = '24px';
    wrap.style.zIndex = '9999';
    wrap.style.display = 'none';
    wrap.style.alignItems = 'center';
    wrap.style.gap = '4px';

    const btn = document.createElement('button');
    btn.id = 'global-undo-btn';
    btn.className = 'btn btn-sm btn-outline';
    btn.onclick = undoLastAction;
    wrap.appendChild(btn);

    const close = document.createElement('button');
    close.id = 'global-undo-close';
    close.type = 'button';
    close.textContent = '×';
    close.title = 'Dismiss';
    close.style.cssText = 'border:1.5px solid var(--gray-border);background:#fff;font-size:16px;line-height:1;cursor:pointer;color:#888;padding:0 8px;border-radius:4px;align-self:stretch;';
    close.onclick = (e) => {
      e.stopPropagation();
      // Remembers which specific undo-able action was dismissed (by label) so it
      // stays hidden across page navigations, but reappears if a *new* action
      // becomes undoable rather than being gone for the rest of the session.
      sessionStorage.setItem('dismissedUndoLabel', wrap.dataset.currentLabel || '');
      wrap.style.display = 'none';
    };
    wrap.appendChild(close);

    document.body.appendChild(wrap);
  }
  refreshUndoButton();
}

async function refreshUndoButton() {
  const wrap = document.getElementById('global-undo-wrap');
  const btn = document.getElementById('global-undo-btn');
  if (!wrap || !btn) return;
  try {
    const result = await api('/api/undo');
    if (result) {
      const label = `Undo: ${result.label}`;
      wrap.dataset.currentLabel = label;
      btn.textContent = label;
      const dismissed = sessionStorage.getItem('dismissedUndoLabel') === label;
      wrap.style.display = dismissed ? 'none' : 'flex';
    } else {
      wrap.style.display = 'none';
      wrap.dataset.currentLabel = '';
    }
  } catch {
    wrap.style.display = 'none';
  }
}

async function undoLastAction() {
  try {
    await api('/api/undo', { method: 'POST' });
    location.reload();
  } catch (e) {
    alert(e.message || 'Failed to undo');
  }
}

function initSidebarDragReorder() {
  const nav = document.getElementById('sidebar-nav');
  if (!nav) return;
  let dragEl = null;

  nav.querySelectorAll(':scope > .sidebar__nav-item').forEach(item => {
    item.addEventListener('dragstart', (e) => {
      dragEl = item;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      dragEl = null;
      saveSidebarOrder(Array.from(nav.querySelectorAll(':scope > .sidebar__nav-item')).map(el => el.dataset.key));
    });
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!dragEl || dragEl === item) return;
      const rect = item.getBoundingClientRect();
      const before = (e.clientY - rect.top) / rect.height < 0.5;
      nav.insertBefore(dragEl, before ? item : item.nextSibling);
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
  const num = Number(n || 0);
  const sign = num < 0 ? '-' : '';
  return sign + '$' + Math.abs(num).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

// Same as fmtMoney but to the cent, not rounded to the nearest whole
// dollar — for figures where the cents actually matter (reports, vehicle
// financials, itemized invoice amounts) rather than dashboard-style tiles.
function fmtExact(n) {
  const num = Number(n || 0);
  const sign = num < 0 ? '-' : '';
  return sign + '$' + Math.abs(num).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// customers.email is NOT NULL, so a walk-in booking with no email on file
// gets a deterministic placeholder (walkin-<phone>@no-email.drivenow, see
// upsertCustomer in db.js) instead of silently never becoming a client at
// all. Never show that placeholder string to a human — display this instead
// wherever a customer's email is shown.
function displayEmail(email) {
  if (!email || /^walkin-\d+@no-email\.drivenow$/i.test(email)) return 'No email on file';
  return email;
}

// DriveNow operates out of Charlotte, NC — every timestamp shown here is
// pinned to Eastern time explicitly, rather than whatever timezone the
// viewer's own device happens to be set to, so a booking made from a phone
// set to a different timezone still reads the same way office staff would
// read it.
const DISPLAY_TZ = 'America/New_York';

// "Today," in Charlotte — for prefilling date inputs (payment date, deposit
// date, damage-reported date, default report range) with the business's own
// calendar day rather than the viewer's UTC/local day, which can already be
// tomorrow (or still yesterday) depending on where and when they're logged in.
function todayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: DISPLAY_TZ });
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: DISPLAY_TZ });
}

// For calendar-date-only values (pickup/return dates, DOB, deposit collected
// date) — never a timestamp. `new Date('2026-06-15')` parses as UTC midnight,
// so formatting it with the viewer's local timezone (as fmtDate does) can
// display the day *before* what's actually stored whenever the browser is
// behind UTC. Anchoring to local midnight instead keeps the displayed date
// identical to the stored date in every timezone.
function fmtDateOnly(d) {
  if (!d) return '—';
  return new Date(d.length <= 10 ? d + 'T00:00:00' : d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// Renders a "View File" link, plus a small thumbnail preview when the upload is an image.
function filePreviewHtml(filePath, linkText) {
  if (!filePath) return 'Not provided';
  const url = `/uploads/${filePath}`;
  const isImage = /\.(jpe?g|png|gif|webp)$/i.test(filePath);
  return `
    <div style="display:flex;align-items:center;gap:10px;justify-content:flex-end;">
      ${isImage ? `<a href="${url}" target="_blank"><img src="${url}" alt="preview" style="width:40px;height:40px;object-fit:cover;border-radius:4px;border:1px solid var(--gray-border);"></a>` : ''}
      <a href="${url}" target="_blank">${linkText || 'View File'}</a>
    </div>
  `;
}

// Chrome (and other browsers) can restore a page from the back/forward
// cache when you navigate back to it — instantly, without re-running this
// page's load() — so an edit just saved on a detail page (e.g. changing an
// insurance record's status) wouldn't show up after clicking back to the
// list until a manual refresh. Forcing a real reload on a bfcache restore
// keeps every list page showing what's actually in the database.
window.addEventListener('pageshow', (event) => {
  if (event.persisted) location.reload();
});

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
