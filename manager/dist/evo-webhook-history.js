// Webhook History — adds a sidebar entry on instance pages that opens a
// drawer listing every webhook delivery attempt the API has recorded for
// the active instance. The list backs onto GET /webhook/history/:instance,
// which is fed by an in-memory ring buffer in WebhookController.emit.
//
// Pure vanilla DOM, same pattern as evo-event-tester.js: the bundle's
// outgoing apikey is sniffed off fetch/XHR, the sidebar entry is
// re-injected via MutationObserver, and nothing touches React state.

(function () {
  'use strict';

  const INSTANCE_RE = /\/manager\/instance\/([^/?#]+)/;
  const LS_APIKEY = 'evo_apikey_cache';
  const LS_FILTERS = (instance) => `evo:webhook-history:${instance || '_global'}`;

  let cachedApiKey = null;
  try {
    cachedApiKey = localStorage.getItem(LS_APIKEY) || null;
  } catch (_) {}

  // ── apikey sniff (mirrors the event-tester so this script works in isolation)
  (function installApiKeySniff() {
    const remember = (v) => {
      if (!v || typeof v !== 'string' || v === cachedApiKey) return;
      cachedApiKey = v;
      try {
        localStorage.setItem(LS_APIKEY, v);
      } catch (_) {}
    };
    const origFetch = window.fetch ? window.fetch.bind(window) : null;
    if (origFetch) {
      window.fetch = function (input, init) {
        try {
          const h =
            (init && init.headers) ||
            (input && input.headers) ||
            null;
          if (h) {
            if (typeof Headers !== 'undefined' && h instanceof Headers) {
              const v = h.get('apikey') || h.get('Apikey') || h.get('APIKEY');
              if (v) remember(v);
            } else if (Array.isArray(h)) {
              for (const [k, v] of h) if (k && k.toLowerCase() === 'apikey') remember(v);
            } else if (typeof h === 'object') {
              for (const k of Object.keys(h)) {
                if (k && k.toLowerCase() === 'apikey') remember(h[k]);
              }
            }
          }
        } catch (_) {}
        return origFetch(input, init);
      };
    }
    const OrigXHR = window.XMLHttpRequest;
    if (OrigXHR && OrigXHR.prototype && OrigXHR.prototype.setRequestHeader) {
      const origSet = OrigXHR.prototype.setRequestHeader;
      OrigXHR.prototype.setRequestHeader = function (name, value) {
        try {
          if (name && String(name).toLowerCase() === 'apikey') remember(String(value));
        } catch (_) {}
        return origSet.call(this, name, value);
      };
    }
  })();

  function getInstanceFromPath() {
    const m = location.pathname.match(INSTANCE_RE);
    return m ? decodeURIComponent(m[1]) : null;
  }

  // The manager URL identifies an instance by its database id (cuid/uuid),
  // but the API auth guard and webhook routes are keyed by instance name —
  // hitting `/webhook/history/{id}` returns 404 ("instance does not exist").
  // Cache the id → name mapping from /instance/fetchInstances so the drawer
  // can always reach the correct route regardless of the URL slug.
  const UUID_OR_CUID_RE = /^[a-z0-9-]{20,}$/i;
  const idToNameCache = new Map();
  let resolvePromise = null;

  async function resolveInstanceName(slug) {
    if (!slug) return null;
    // Looks like a name already (not a long id) — use as-is.
    if (!UUID_OR_CUID_RE.test(slug)) return slug;
    if (idToNameCache.has(slug)) return idToNameCache.get(slug);
    if (!cachedApiKey) return slug;
    if (!resolvePromise) {
      resolvePromise = fetch('/instance/fetchInstances', {
        headers: { apikey: cachedApiKey, Accept: 'application/json' },
      })
        .then((r) => (r.ok ? r.json() : []))
        .then((list) => {
          if (Array.isArray(list)) {
            for (const inst of list) {
              if (inst && inst.id && inst.name) idToNameCache.set(inst.id, inst.name);
            }
          }
        })
        .catch(() => {})
        .finally(() => {
          resolvePromise = null;
        });
    }
    await resolvePromise;
    return idToNameCache.get(slug) || slug;
  }

  // ── tiny DOM helper ──────────────────────────────────────────────────
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'text') node.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') {
          node.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (k.startsWith('data-') || k.startsWith('aria-')) {
          node.setAttribute(k, v);
        } else {
          try {
            node[k] = v;
          } catch (_) {
            node.setAttribute(k, v);
          }
        }
      }
    }
    for (const c of children) {
      if (c == null || c === false) continue;
      if (Array.isArray(c)) {
        for (const cc of c) if (cc != null && cc !== false) node.append(cc.nodeType ? cc : String(cc));
      } else {
        node.append(c.nodeType ? c : String(c));
      }
    }
    return node;
  }

  // ── icons ────────────────────────────────────────────────────────────
  const ICON_HISTORY =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>';
  const ICON_REFRESH =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>';
  const ICON_TRASH =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';

  // ── state ────────────────────────────────────────────────────────────
  const state = {
    instance: null,
    drawerOpen: false,
    items: [],
    matched: 0,
    total: 0,
    stats: { total: 0, byStatus: {}, avgLatencyMs: 0, capacity: 0 },
    loading: false,
    error: null,
    autoRefresh: true,
    autoTimer: null,
    selectedId: null,
    filters: loadFilters(getInstanceFromPath()),
  };

  function loadFilters(instance) {
    try {
      const raw = localStorage.getItem(LS_FILTERS(instance));
      const parsed = raw ? JSON.parse(raw) : null;
      return {
        event: parsed?.event ?? '',
        status: parsed?.status ?? '',
        scope: parsed?.scope ?? '',
        search: parsed?.search ?? '',
        sortBy: parsed?.sortBy ?? 'startedAt',
        sortOrder: parsed?.sortOrder ?? 'desc',
        limit: parsed?.limit ?? 100,
      };
    } catch (_) {
      return defaultFilters();
    }
  }
  function defaultFilters() {
    return { event: '', status: '', scope: '', search: '', sortBy: 'startedAt', sortOrder: 'desc', limit: 100 };
  }
  function persistFilters() {
    try {
      localStorage.setItem(LS_FILTERS(state.instance), JSON.stringify(state.filters));
    } catch (_) {}
  }

  // ── data fetching ────────────────────────────────────────────────────
  async function fetchHistory() {
    const slug = state.instance || getInstanceFromPath();
    if (!slug || !cachedApiKey) {
      state.error = !cachedApiKey
        ? 'No API key in cache yet — load any manager page once, then re-open.'
        : 'No instance selected.';
      state.items = [];
      render();
      return;
    }
    state.loading = true;
    state.error = null;
    render();
    const instance = await resolveInstanceName(slug);
    state.instance = instance;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(state.filters)) {
      if (v === '' || v == null) continue;
      params.set(k, String(v));
    }
    try {
      const res = await fetch(
        `/webhook/history/${encodeURIComponent(instance)}?${params.toString()}`,
        { headers: { apikey: cachedApiKey, Accept: 'application/json' } },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      state.items = Array.isArray(body.items) ? body.items : [];
      state.matched = body.matched ?? state.items.length;
      state.total = body.total ?? 0;
      state.stats = body.stats || state.stats;
    } catch (err) {
      state.error = err?.message || 'Failed to load webhook history';
      state.items = [];
    } finally {
      state.loading = false;
      render();
    }
  }

  async function clearHistory() {
    const slug = state.instance || getInstanceFromPath();
    if (!slug || !cachedApiKey) return;
    const instance = await resolveInstanceName(slug);
    if (!confirm(`Clear all stored webhook history for "${instance}"? This cannot be undone.`)) return;
    try {
      await fetch(`/webhook/history/${encodeURIComponent(instance)}`, {
        method: 'DELETE',
        headers: { apikey: cachedApiKey },
      });
      state.selectedId = null;
      await fetchHistory();
    } catch (err) {
      state.error = err?.message || 'Failed to clear history';
      render();
    }
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    if (!state.autoRefresh || !state.drawerOpen) return;
    state.autoTimer = setInterval(() => {
      if (state.drawerOpen) fetchHistory();
    }, 5000);
  }
  function stopAutoRefresh() {
    if (state.autoTimer) clearInterval(state.autoTimer);
    state.autoTimer = null;
  }

  // ── drawer ───────────────────────────────────────────────────────────
  let drawerEl = null;
  let backdropEl = null;

  function ensureDrawer() {
    if (drawerEl && document.body.contains(drawerEl)) return;
    backdropEl = el('div', { class: 'evo-wh-backdrop', onClick: closeDrawer });
    drawerEl = el('aside', { class: 'evo-wh-drawer', 'data-evo-open': 'false', role: 'dialog', 'aria-label': 'Webhook History' });
    document.body.append(backdropEl, drawerEl);
  }

  function openDrawer() {
    state.instance = getInstanceFromPath();
    state.filters = loadFilters(state.instance);
    ensureDrawer();
    drawerEl.setAttribute('data-evo-open', 'true');
    backdropEl.setAttribute('data-evo-open', 'true');
    state.drawerOpen = true;
    render();
    fetchHistory();
    startAutoRefresh();
  }

  function closeDrawer() {
    if (drawerEl) drawerEl.setAttribute('data-evo-open', 'false');
    if (backdropEl) backdropEl.setAttribute('data-evo-open', 'false');
    state.drawerOpen = false;
    stopAutoRefresh();
  }

  // ── event catalog (same set the backend uses) ───────────────────────
  const ALL_EVENTS = [
    'APPLICATION_STARTUP', 'QRCODE_UPDATED', 'MESSAGES_SET', 'MESSAGES_UPSERT',
    'MESSAGES_EDITED', 'MESSAGES_UPDATE', 'MESSAGES_DELETE', 'SEND_MESSAGE',
    'SEND_MESSAGE_UPDATE', 'CONTACTS_SET', 'CONTACTS_UPSERT', 'CONTACTS_UPDATE',
    'PRESENCE_UPDATE', 'CHATS_SET', 'CHATS_UPSERT', 'CHATS_UPDATE', 'CHATS_DELETE',
    'GROUPS_UPSERT', 'GROUP_UPDATE', 'GROUP_PARTICIPANTS_UPDATE', 'CONNECTION_UPDATE',
    'LABELS_EDIT', 'LABELS_ASSOCIATION', 'CALL', 'TYPEBOT_START', 'TYPEBOT_CHANGE_STATUS',
    'MESSAGING_HISTORY_SET', 'REMOVE_INSTANCE', 'LOGOUT_INSTANCE', 'INSTANCE_CREATE',
    'INSTANCE_DELETE', 'STATUS_INSTANCE',
  ];

  // ── rendering ────────────────────────────────────────────────────────
  function render() {
    if (!drawerEl) return;
    drawerEl.replaceChildren(buildHeader(), buildBody());
  }

  function buildHeader() {
    return el(
      'header',
      { class: 'evo-wh-header' },
      el('div', { class: 'evo-wh-title' },
        el('span', { class: 'evo-wh-icon', html: ICON_HISTORY }),
        el('span', null, 'Webhook History'),
        el('span', { class: 'evo-wh-instance' }, state.instance ? `· ${state.instance}` : ''),
      ),
      el(
        'div',
        { class: 'evo-wh-actions' },
        el('label', { class: 'evo-wh-auto' },
          el('input', {
            type: 'checkbox',
            checked: state.autoRefresh,
            onChange: (e) => {
              state.autoRefresh = !!e.target.checked;
              if (state.autoRefresh) startAutoRefresh();
              else stopAutoRefresh();
            },
          }),
          'Auto-refresh',
        ),
        el('button', { type: 'button', class: 'evo-wh-iconbtn', title: 'Refresh now', onClick: fetchHistory, html: ICON_REFRESH }),
        el('button', { type: 'button', class: 'evo-wh-iconbtn evo-wh-danger', title: 'Clear history', onClick: clearHistory, html: ICON_TRASH }),
        el('button', { type: 'button', class: 'evo-wh-close', onClick: closeDrawer, 'aria-label': 'Close' }, '×'),
      ),
    );
  }

  function buildBody() {
    return el('div', { class: 'evo-wh-body' }, buildToolbar(), buildStatsBar(), buildSplitView());
  }

  function buildToolbar() {
    const f = state.filters;
    return el('div', { class: 'evo-wh-toolbar' },
      el('input', {
        type: 'search',
        class: 'evo-wh-search',
        placeholder: 'Search URL, event, error, payload…',
        value: f.search,
        onInput: debounce((e) => { f.search = e.target.value; persistFilters(); fetchHistory(); }, 300),
      }),
      el('select', { class: 'evo-wh-select', onChange: (e) => { f.event = e.target.value; persistFilters(); fetchHistory(); } },
        el('option', { value: '' }, 'All events'),
        ...ALL_EVENTS.map((ev) => el('option', { value: ev, selected: f.event === ev }, ev)),
      ),
      el('select', { class: 'evo-wh-select', onChange: (e) => { f.status = e.target.value; persistFilters(); fetchHistory(); } },
        el('option', { value: '' }, 'Any status'),
        el('option', { value: 'success', selected: f.status === 'success' }, '✓ Success'),
        el('option', { value: 'failure', selected: f.status === 'failure' }, '✗ Failure'),
      ),
      el('select', { class: 'evo-wh-select', onChange: (e) => { f.scope = e.target.value; persistFilters(); fetchHistory(); } },
        el('option', { value: '' }, 'All scopes'),
        el('option', { value: 'instance', selected: f.scope === 'instance' }, 'Instance'),
        el('option', { value: 'global', selected: f.scope === 'global' }, 'Global'),
      ),
      el('select', { class: 'evo-wh-select', title: 'Sort by', onChange: (e) => { f.sortBy = e.target.value; persistFilters(); fetchHistory(); } },
        el('option', { value: 'startedAt', selected: f.sortBy === 'startedAt' }, 'Sort: time'),
        el('option', { value: 'event', selected: f.sortBy === 'event' }, 'Sort: event'),
        el('option', { value: 'httpStatus', selected: f.sortBy === 'httpStatus' }, 'Sort: HTTP status'),
        el('option', { value: 'latencyMs', selected: f.sortBy === 'latencyMs' }, 'Sort: latency'),
        el('option', { value: 'attempts', selected: f.sortBy === 'attempts' }, 'Sort: attempts'),
      ),
      el('button', {
        type: 'button',
        class: 'evo-wh-iconbtn evo-wh-order',
        title: f.sortOrder === 'asc' ? 'Ascending' : 'Descending',
        onClick: () => { f.sortOrder = f.sortOrder === 'asc' ? 'desc' : 'asc'; persistFilters(); fetchHistory(); },
      }, f.sortOrder === 'asc' ? '↑' : '↓'),
      el('button', { type: 'button', class: 'evo-wh-link', onClick: () => { state.filters = defaultFilters(); persistFilters(); fetchHistory(); } }, 'Reset'),
    );
  }

  function buildStatsBar() {
    const s = state.stats || {};
    const by = s.byStatus || {};
    const status = state.loading ? 'Loading…' : state.error ? `Error: ${state.error}` : `${state.matched} of ${state.total} shown`;
    return el('div', { class: 'evo-wh-stats' },
      el('span', { class: 'evo-wh-stat' }, status),
      el('span', { class: 'evo-wh-stat evo-wh-stat-ok' }, `✓ ${by.success ?? 0}`),
      el('span', { class: 'evo-wh-stat evo-wh-stat-err' }, `✗ ${by.failure ?? 0}`),
      el('span', { class: 'evo-wh-stat' }, `avg ${s.avgLatencyMs ?? 0} ms`),
      el('span', { class: 'evo-wh-stat evo-wh-stat-dim' }, `buffer ${s.total ?? 0}/${s.capacity ?? 0}`),
    );
  }

  function buildSplitView() {
    return el('div', { class: 'evo-wh-split' }, buildList(), buildDetail());
  }

  function buildList() {
    if (state.error) {
      return el('div', { class: 'evo-wh-list evo-wh-empty' }, state.error);
    }
    if (!state.items.length) {
      return el('div', { class: 'evo-wh-list evo-wh-empty' }, state.loading ? 'Loading…' : 'No webhook deliveries match this filter yet.');
    }
    return el('div', { class: 'evo-wh-list' },
      ...state.items.map((item) => buildRow(item)),
    );
  }

  function buildRow(item) {
    const isSel = state.selectedId === item.id;
    return el('button', {
      type: 'button',
      class: `evo-wh-row evo-wh-row-${item.status}${isSel ? ' is-selected' : ''}`,
      onClick: () => { state.selectedId = item.id; render(); },
    },
      el('span', { class: `evo-wh-badge evo-wh-badge-${item.status}` }, item.status === 'success' ? '✓' : '✗'),
      el('div', { class: 'evo-wh-row-main' },
        el('div', { class: 'evo-wh-row-top' },
          el('span', { class: 'evo-wh-row-event' }, item.event),
          el('span', { class: 'evo-wh-row-scope' }, item.scope),
          item.httpStatus != null ? el('span', { class: 'evo-wh-row-http' }, `HTTP ${item.httpStatus}`) : null,
        ),
        el('div', { class: 'evo-wh-row-bot' },
          el('span', { class: 'evo-wh-row-url' }, item.url || ''),
        ),
      ),
      el('div', { class: 'evo-wh-row-meta' },
        el('span', null, formatTime(item.startedAt)),
        el('span', { class: 'evo-wh-row-lat' }, `${item.latencyMs ?? 0} ms`),
        item.attempts > 1 ? el('span', { class: 'evo-wh-row-attempts' }, `${item.attempts}×`) : null,
      ),
    );
  }

  function buildDetail() {
    const item = state.items.find((i) => i.id === state.selectedId);
    if (!item) {
      return el('div', { class: 'evo-wh-detail evo-wh-empty' }, 'Select a delivery to inspect its payload.');
    }
    return el('div', { class: 'evo-wh-detail' },
      el('div', { class: 'evo-wh-detail-head' },
        el('div', { class: 'evo-wh-detail-title' },
          el('span', { class: `evo-wh-badge evo-wh-badge-${item.status}` }, item.status === 'success' ? '✓' : '✗'),
          el('span', null, item.event),
          el('span', { class: 'evo-wh-detail-meta' }, `${item.method} · ${item.scope} · ${formatTime(item.startedAt)}`),
        ),
        el('div', { class: 'evo-wh-detail-meta' },
          item.httpStatus != null ? el('span', null, `HTTP ${item.httpStatus}`) : null,
          el('span', null, `${item.latencyMs ?? 0} ms`),
          el('span', null, `${item.attempts || 1} attempt(s)`),
        ),
      ),
      el('div', { class: 'evo-wh-detail-row' },
        el('span', { class: 'evo-wh-kv-key' }, 'URL'),
        el('code', { class: 'evo-wh-kv-val' }, item.url),
      ),
      item.errorMessage
        ? el('div', { class: 'evo-wh-detail-row evo-wh-detail-error' },
            el('span', { class: 'evo-wh-kv-key' }, 'Error'),
            el('code', { class: 'evo-wh-kv-val' }, `${item.errorCode ? `[${item.errorCode}] ` : ''}${item.errorMessage}`),
          )
        : null,
      buildSection('Request headers', formatJson(item.requestHeaders)),
      buildSection('Request body', formatJson(item.requestBody)),
      buildSection('Response body', typeof item.responseBody === 'string' ? item.responseBody : formatJson(item.responseBody)),
    );
  }

  function buildSection(label, text) {
    if (text == null || text === '') return null;
    return el('div', { class: 'evo-wh-section' },
      el('div', { class: 'evo-wh-section-head' },
        el('span', null, label),
        el('button', {
          type: 'button',
          class: 'evo-wh-copy',
          onClick: (e) => copyText(text, e.currentTarget),
        }, 'Copy'),
      ),
      el('pre', { class: 'evo-wh-code' }, text),
    );
  }

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      btn.setAttribute('data-copied', 'true');
      setTimeout(() => btn.removeAttribute('data-copied'), 1100);
    } catch (_) {}
  }

  function formatJson(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch (_) {
      return String(value);
    }
  }

  function formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString(undefined, { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  function debounce(fn, wait) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  // ── sidebar injection ────────────────────────────────────────────────
  function injectSidebarButton() {
    const existing = document.querySelector('button.evo-wh-sidebar-btn');
    if (existing && document.body.contains(existing)) return;
    if (!getInstanceFromPath()) return;

    const ANCHOR_LABELS = ['Event Tester', 'Events', 'Configurations', 'Dashboard'];
    let anchorBtn = null;
    const candidates = document.querySelectorAll('nav button, [data-slot="sidebar"] button, aside button');
    for (const c of candidates) {
      let txt = '';
      for (const n of c.childNodes) {
        if (n.nodeType === 1 && n.tagName === 'IMG') continue;
        if (n.nodeType === 3) txt += n.nodeValue;
        else if (n.nodeType === 1) txt += n.textContent;
      }
      txt = (txt || '').trim();
      if (ANCHOR_LABELS.includes(txt)) {
        anchorBtn = c;
        break;
      }
    }
    if (!anchorBtn) return;

    const btn = el(
      'button',
      {
        class: 'evo-wh-sidebar-btn',
        type: 'button',
        title: 'View webhook delivery history',
        onClick: openDrawer,
      },
      el('span', { class: 'evo-wh-side-icon', html: ICON_HISTORY }),
      el('span', { class: 'evo-wh-side-label' }, 'Webhook History'),
      el('span', { class: 'evo-wh-side-badge' }, 'DEBUG'),
    );

    const wrapper = findRowWrapper(anchorBtn);
    wrapper.insertAdjacentElement('afterend', btn);
  }

  function findRowWrapper(el) {
    let node = el;
    const targetText = (el.textContent || '').trim();
    for (let i = 0; i < 6 && node.parentElement; i++) {
      const p = node.parentElement;
      if (p === document.body) break;
      const pText = (p.textContent || '').trim();
      if (pText === targetText) node = p;
      else break;
    }
    return node;
  }

  function boot() {
    injectSidebarButton();
    const observer = new MutationObserver(() => injectSidebarButton());
    observer.observe(document.body, { childList: true, subtree: true });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && drawerEl && drawerEl.getAttribute('data-evo-open') === 'true') {
        closeDrawer();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
