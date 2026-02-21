/* ============================================================
   api-client.js
   Centralised fetch wrapper for Digital Girvi frontend.
   Handles: token storage, auto-refresh, auth headers,
            error normalisation, and typed API methods.
   ============================================================ */

const API_BASE = '/api';

/* ── Token Store ─────────────────────────────────────────── */
let _accessToken  = null;
let _refreshing   = null;   // Promise lock — prevents parallel refresh calls
let _currentUser  = null;

const Auth = {
  getToken:    ()    => _accessToken,
  setToken:    (tok) => { _accessToken = tok; },
  clearToken:  ()    => { _accessToken = null; _currentUser = null; },
  getUser:     ()    => _currentUser,
  setUser:     (u)   => { _currentUser = u; },
  isLoggedIn:  ()    => !!_accessToken,
};

/* ── Core Fetch Wrapper ──────────────────────────────────── */
async function request(method, path, { body, params, raw = false } = {}) {
  let url = `${API_BASE}${path}`;
  if (params) {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== '')
    ).toString();
    if (qs) url += `?${qs}`;
  }

  const headers = { 'Content-Type': 'application/json' };
  if (_accessToken) headers['Authorization'] = `Bearer ${_accessToken}`;

  const opts = { method, headers, credentials: 'include' };
  if (body !== undefined) opts.body = JSON.stringify(body);

  let res = await fetch(url, opts);

  // ── Auto-refresh on 401 ──────────────────────────────────
  if (res.status === 401 && path !== '/auth/login' && path !== '/auth/refresh') {
    if (!_refreshing) {
      _refreshing = _tryRefresh().finally(() => { _refreshing = null; });
    }
    const refreshed = await _refreshing;
    if (refreshed) {
      headers['Authorization'] = `Bearer ${_accessToken}`;
      res = await fetch(url, { ...opts, headers });
    } else {
      Auth.clearToken();
      window.dispatchEvent(new CustomEvent('auth:expired'));
      throw new ApiError('Session expired. Please log in again.', 401, 'SESSION_EXPIRED');
    }
  }

  if (raw) return res;

  const data = await res.json().catch(() => ({ success: false, error: 'Invalid server response' }));

  if (!res.ok) {
    throw new ApiError(
      data.error  || `Request failed (${res.status})`,
      res.status,
      data.code   || 'REQUEST_FAILED',
      data.details || null
    );
  }

  return data;
}

async function _tryRefresh() {
  try {
    const data = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST', credentials: 'include',
    }).then((r) => r.json());
    if (data.success && data.accessToken) {
      Auth.setToken(data.accessToken);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/* ── ApiError class ──────────────────────────────────────── */
class ApiError extends Error {
  constructor(message, status, code, details) {
    super(message);
    this.name    = 'ApiError';
    this.status  = status;
    this.code    = code;
    this.details = details;
  }
}

/* ── Convenience Methods ─────────────────────────────────── */
const get    = (path, params) => request('GET',    path, { params });
const post   = (path, body)   => request('POST',   path, { body });
const put    = (path, body)   => request('PUT',    path, { body });
const patch  = (path, body)   => request('PATCH',  path, { body });
const del    = (path)         => request('DELETE', path);

/* ── AUTH ────────────────────────────────────────────────── */
const auth = {
  async login(username, password) {
    const data = await post('/auth/login', { username, password });
    if (data.success && !data.twoFactor) {
      Auth.setToken(data.accessToken);
      Auth.setUser(data.user);
    }
    return data;
  },
  async verifyTwoFactor(token, preAuthToken) {
    const prevToken = _accessToken;
    _accessToken = preAuthToken;
    try {
      const data = await post('/auth/verify-2fa', { token });
      if (data.success) {
        Auth.setToken(data.accessToken);
        Auth.setUser(data.user);
      }
      return data;
    } catch (e) {
      _accessToken = prevToken;
      throw e;
    }
  },
  async logout() {
    try { await post('/auth/logout'); } catch { /* ignore */ }
    Auth.clearToken();
  },
  async refresh()         { return post('/auth/refresh'); },
  async me()              { return get('/auth/me'); },
  async changePassword(currentPassword, newPassword, confirmPassword) {
    return post('/auth/change-password', { currentPassword, newPassword, confirmPassword });
  },
  async setup2fa()        { return post('/auth/2fa/setup'); },
  async confirm2fa(token) { return post('/auth/2fa/confirm', { token }); },
  async disable2fa(password) { return post('/auth/2fa/disable', { password }); },
};

/* ── CUSTOMERS ───────────────────────────────────────────── */
const customers = {
  list: (params)    => get('/customers', params),
  search: (q)       => get('/customers/search', { q }),
  get: (id)         => get(`/customers/${id}`),
  create: (data)    => post('/customers', data),
  update: (id, data)=> put(`/customers/${id}`, data),
  deactivate: (id)  => patch(`/customers/${id}/deactivate`),
  reactivate: (id)  => patch(`/customers/${id}/reactivate`),
  loanHistory: (id) => get(`/customers/${id}/loan-history`),
};

/* ── LOANS ───────────────────────────────────────────────── */
const loans = {
  list: (params)       => get('/loans', params),
  get: (id)            => get(`/loans/${id}`),
  create: (data)       => post('/loans', data),
  update: (id, data)   => put(`/loans/${id}`, data),
  close: (id)          => post(`/loans/${id}/close`),
  renew: (id, data)    => post(`/loans/${id}/renew`, data),
  default: (id, data)  => post(`/loans/${id}/default`, data),
  overdue: ()          => get('/loans/overdue'),
  statement: (id)      => get(`/loans/${id}/statement`),
  previewPayment: (loanId, amount) =>
    get(`/loans/${loanId}/calculate-payment`, { amount }),
};

/* ── PAYMENTS ────────────────────────────────────────────── */
const payments = {
  list: (params)   => get('/payments', params),
  get: (id)        => get(`/payments/${id}`),
  create: (data)   => post('/payments', data),
  daily: (date)    => get('/payments/summary/daily', { date }),
};

/* ── DASHBOARD ───────────────────────────────────────────── */
const dashboard = {
  summary:          () => get('/dashboard/summary'),
  loansByMonth:     () => get('/dashboard/charts/loans-by-month'),
  portfolioStatus:  () => get('/dashboard/charts/portfolio-status'),
  dailyCollections: (year, month) => get('/dashboard/charts/collections-daily', { year, month }),
  overdueList:      (params) => get('/dashboard/overdue-loans', params),
  dueSoon:          (days)   => get('/dashboard/due-soon', { days }),
  recentActivity:   ()       => get('/dashboard/recent-activity'),
  goldRateHistory:  (days)   => get('/dashboard/gold-rate-history', { days }),
};

/* ── SETTINGS ────────────────────────────────────────────── */
const settings = {
  getAll:           ()         => get('/settings'),
  get:              (key)      => get(`/settings/${key}`),
  update:           (settings) => put('/settings', { settings }),
  goldRates:        ()         => get('/settings/gold-rates'),
  currentGoldRate:  ()         => get('/settings/gold-rates/current'),
  addGoldRate:      (data)     => post('/settings/gold-rates', data),
  users: {
    list:           ()         => get('/settings/users'),
    get:            (id)       => get(`/settings/users/${id}`),
    create:         (data)     => post('/settings/users', data),
    update:         (id, data) => put(`/settings/users/${id}`, data),
    deactivate:     (id)       => patch(`/settings/users/${id}/deactivate`),
    reactivate:     (id)       => patch(`/settings/users/${id}/reactivate`),
    unlock:         (id)       => patch(`/settings/users/${id}/unlock`),
    resetPassword:  (id, newPassword) => post(`/settings/users/${id}/reset-password`, { newPassword }),
  },
};

/* ── Export ──────────────────────────────────────────────── */
window.API = { auth, customers, loans, payments, dashboard, settings, Auth, ApiError };
