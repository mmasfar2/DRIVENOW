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
