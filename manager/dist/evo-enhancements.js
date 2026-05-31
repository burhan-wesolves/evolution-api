// Lock i18next to English BEFORE the bundle initializes. i18next-browser-
// language-detector consults localStorage.i18nextLng first, so seeding it
// here defeats the detector and avoids a flash of non-English content.
try {
  localStorage.setItem('i18nextLng', 'en');
} catch (_) {}

// Manager UI enhancements — a top progress bar that lights up whenever any
// /instance/* HTTP request is in-flight, plus a small spinner on the button
// that initiated the click. Bundled UI uses axios (XHR) for most calls; the
// QR/login flow uses fetch. We hook both to be safe.

(function () {
  const INSTANCE_PATH_RE = /\/instance\//;

  const bar = document.createElement('div');
  bar.id = '__evo_loader_bar';

  const mountBar = () => {
    if (document.body && !document.getElementById('__evo_loader_bar')) {
      document.body.appendChild(bar);
    }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountBar);
  } else {
    mountBar();
  }

  let inflight = 0;
  let lastButton = null;

  document.addEventListener(
    'click',
    (e) => {
      const target = e.target instanceof Element ? e.target.closest('button') : null;
      if (target) lastButton = target;
    },
    true,
  );

  const start = () => {
    inflight++;
    bar.classList.add('__active');
    if (lastButton && inflight === 1) {
      lastButton.setAttribute('data-evo-busy', 'true');
    }
  };

  const finish = () => {
    inflight = Math.max(0, inflight - 1);
    if (inflight === 0) {
      bar.classList.remove('__active');
      if (lastButton) {
        lastButton.removeAttribute('data-evo-busy');
        lastButton = null;
      }
    }
  };

  // fetch wrapper
  const origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (origFetch) {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : input && input.url ? input.url : '';
      const tracked = INSTANCE_PATH_RE.test(url);
      if (tracked) start();
      return origFetch(input, init).finally(() => {
        if (tracked) finish();
      });
    };
  }

  // XHR wrapper (covers axios)
  const OrigXHR = window.XMLHttpRequest;
  if (OrigXHR) {
    function PatchedXHR() {
      const xhr = new OrigXHR();
      const origOpen = xhr.open.bind(xhr);
      let tracked = false;
      xhr.open = function (method, url, ...rest) {
        tracked = INSTANCE_PATH_RE.test(String(url || ''));
        return origOpen(method, url, ...rest);
      };
      xhr.addEventListener('loadstart', () => {
        if (tracked) start();
      });
      const cleanup = () => {
        if (tracked) {
          finish();
          tracked = false;
        }
      };
      xhr.addEventListener('loadend', cleanup);
      xhr.addEventListener('error', cleanup);
      xhr.addEventListener('abort', cleanup);
      return xhr;
    }
    PatchedXHR.prototype = OrigXHR.prototype;
    window.XMLHttpRequest = PatchedXHR;
  }
})();

// Sidebar visibility toggles driven by backend flags in GET /.
//   integrationsEnabled=false → hide "Integrations" group + its 8 chatbot rows
//   chatUiEnabled=false       → hide "Chat" sidebar row
// The manager bundle is minified React; we identify menu items by their
// rendered text content (which is locale-stable for brand names; the Chat
// label is matched against translations) and walk up to the smallest stable
// wrapper to hide.
(function () {
  const INTEGRATIONS_LABELS = new Set([
    'Integrations',
    'Integrações',
    'Integraciones',
    'Intégrations',
  ]);

  // Brand names rendered as child menu items. These are not translated.
  const CHATBOT_LABELS = new Set([
    'EvoAI',
    'n8n',
    'Evolution Bot',
    'Chatwoot',
    'Typebot',
    'OpenAI',
    'Dify',
    'Flowise',
  ]);

  // Sidebar "Chat" entry — translated, but i18nextLng is locked to 'en' for
  // this build so the English label is what we see in practice. We include
  // the other locales defensively in case the lock fails.
  const CHAT_LABELS = new Set(['Chat', 'Bate-papo']);

  const MAX_WALK = 6;

  const findLeafByText = (root, labels) => {
    const out = [];
    const all = root.querySelectorAll('span, a, button, p, div, li');
    for (const el of all) {
      let direct = '';
      for (const node of el.childNodes) {
        if (node.nodeType === 3) direct += node.nodeValue;
      }
      direct = direct.trim();
      if (direct && labels.has(direct)) out.push(el);
    }
    return out;
  };

  const findRowWrapper = (leaf, label) => {
    let node = leaf;
    let best = leaf;
    for (let i = 0; i < MAX_WALK && node && node.parentElement; i++) {
      const parent = node.parentElement;
      if (parent === document.body || parent === document.documentElement) break;
      const text = (parent.textContent || '').trim();
      if (text === label) {
        best = parent;
        node = parent;
      } else {
        break;
      }
    }
    return best;
  };

  const hide = (el) => {
    if (!el || el.__evoHidden) return;
    el.__evoHidden = true;
    el.setAttribute('data-evo-hide-integration', '');
    el.style.display = 'none';
  };

  const sweep = (hideIntegrations, hideChat) => {
    if (hideIntegrations) {
      for (const leaf of findLeafByText(document, CHATBOT_LABELS)) {
        hide(findRowWrapper(leaf, leaf.textContent.trim()));
      }
      for (const leaf of findLeafByText(document, INTEGRATIONS_LABELS)) {
        hide(findRowWrapper(leaf, leaf.textContent.trim()));
      }
    }
    if (hideChat) {
      for (const leaf of findLeafByText(document, CHAT_LABELS)) {
        // Only hide rows that look like sidebar nav (anchor or button-like).
        // Skip headings on the chat page itself, which would also match "Chat".
        const wrapper = findRowWrapper(leaf, leaf.textContent.trim());
        if (wrapper === leaf) continue; // bare text node — not a sidebar row
        // Heuristic: a sidebar row's wrapper is interactive (has data-slot,
        // role, or is an <a>/<button>) and is inside a <nav> or sidebar.
        const isInteractive =
          wrapper.tagName === 'A' ||
          wrapper.tagName === 'BUTTON' ||
          wrapper.getAttribute('role') === 'menuitem' ||
          wrapper.getAttribute('data-slot') ||
          wrapper.closest('nav, [data-slot="sidebar"], aside');
        if (isInteractive) hide(wrapper);
      }
    }
  };

  const apply = (flags) => {
    if (flags.hideIntegrations) document.body.classList.add('evo-integrations-disabled');
    if (flags.hideChat) document.body.classList.add('evo-chat-ui-disabled');
    sweep(flags.hideIntegrations, flags.hideChat);
    const observer = new MutationObserver(() =>
      sweep(flags.hideIntegrations, flags.hideChat),
    );
    observer.observe(document.body, { childList: true, subtree: true });
  };

  const check = () => {
    fetch('/', { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        const flags = {
          hideIntegrations: data.integrationsEnabled === false,
          hideChat: data.chatUiEnabled === false,
        };
        if (!flags.hideIntegrations && !flags.hideChat) return;
        if (document.body) apply(flags);
        else document.addEventListener('DOMContentLoaded', () => apply(flags));
      })
      .catch(() => {});
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', check);
  } else {
    check();
  }
})();
