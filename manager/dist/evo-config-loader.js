// Config-page loader overlay — when the manager opens an instance settings
// page (Webhook, WebSocket, RabbitMQ, NATS, SQS, Pusher, Kafka, Settings,
// Chatwoot, Proxy, …) the React form mounts with empty defaults and only
// fills in once the matching GET …/find/:instance returns. That ~300-1500ms
// gap makes the form look blank and users assume their settings are gone.
//
// This script tracks any in-flight GET to a `*/find/{instanceName}` URL and
// drops a skeleton overlay onto the visible settings card until the request
// resolves. Pure DOM, no React state.

(function () {
  'use strict';

  // Match any integration's "find" GET — the manager has a consistent
  // <namespace>/find/:instance shape for all instance-scoped config reads.
  const TRACKED_RE =
    /\/(webhook|websocket|rabbitmq|nats|sqs|pusher|kafka|settings|chatwoot|proxy|typebot|openai|dify|flowise|evolutionBot|evoai|n8n)\/find\//;

  let inflight = 0;
  let overlayEl = null;
  let attachedTo = null;

  function start() {
    inflight++;
    if (inflight === 1) attachOverlay();
  }
  function finish() {
    inflight = Math.max(0, inflight - 1);
    if (inflight === 0) detachOverlay();
  }

  // ── fetch wrapper ──────────────────────────────────────────────────
  const origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (origFetch) {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : input && input.url ? input.url : '';
      const method = (init && init.method) || (input && input.method) || 'GET';
      const tracked = method.toUpperCase() === 'GET' && TRACKED_RE.test(url);
      if (tracked) start();
      return origFetch(input, init).finally(() => {
        if (tracked) finish();
      });
    };
  }

  // ── XHR wrapper (covers axios) ─────────────────────────────────────
  const OrigXHR = window.XMLHttpRequest;
  if (OrigXHR) {
    function PatchedXHR() {
      const xhr = new OrigXHR();
      const origOpen = xhr.open.bind(xhr);
      let tracked = false;
      xhr.open = function (method, url, ...rest) {
        tracked =
          String(method || '').toUpperCase() === 'GET' && TRACKED_RE.test(String(url || ''));
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

  // ── overlay placement ──────────────────────────────────────────────
  function findSettingsCard() {
    // The settings cards (Webhook, WebSocket, …) all render as a heading
    // inside <main>. Find the closest stable wrapper around the heading
    // that contains a form or fieldset-like grouping.
    const main = document.querySelector('main');
    if (!main) return null;
    const heading = main.querySelector('h3, h2, h1');
    if (!heading) return main;
    // Walk up to a meaningful card-shaped container.
    let node = heading;
    for (let i = 0; i < 6 && node.parentElement && node.parentElement !== main; i++) {
      node = node.parentElement;
    }
    return node || main;
  }

  function attachOverlay() {
    const target = findSettingsCard();
    if (!target) return;
    attachedTo = target;
    // Ensure the host is a positioning context.
    const computed = window.getComputedStyle(target);
    if (computed.position === 'static') target.style.position = 'relative';

    overlayEl = document.createElement('div');
    overlayEl.className = 'evo-cfg-loader';
    overlayEl.setAttribute('role', 'status');
    overlayEl.setAttribute('aria-live', 'polite');
    overlayEl.innerHTML = [
      '<div class="evo-cfg-loader-card">',
      '  <div class="evo-cfg-loader-spinner" aria-hidden="true"></div>',
      '  <div class="evo-cfg-loader-text">Loading saved settings…</div>',
      '  <div class="evo-cfg-loader-sub">Fetching from the API — your configuration is on its way.</div>',
      '</div>',
    ].join('');
    target.appendChild(overlayEl);
    // Force reflow so the fade-in transition runs.
    void overlayEl.offsetWidth;
    overlayEl.setAttribute('data-evo-visible', 'true');
  }

  function detachOverlay() {
    if (!overlayEl) return;
    overlayEl.setAttribute('data-evo-visible', 'false');
    const node = overlayEl;
    const host = attachedTo;
    overlayEl = null;
    attachedTo = null;
    setTimeout(() => {
      if (node && node.parentElement) node.parentElement.removeChild(node);
      // Reset inline position only if we set it.
      if (host && host.style && host.style.position === 'relative') {
        host.style.position = '';
      }
    }, 180);
  }

  // If React re-renders the card mid-flight (route change), the overlay
  // may detach. Re-attach as long as requests are still in flight.
  const observer = new MutationObserver(() => {
    if (inflight > 0 && (!overlayEl || !document.body.contains(overlayEl))) {
      overlayEl = null;
      attachOverlay();
    }
  });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () =>
      observer.observe(document.body, { childList: true, subtree: true }),
    );
  } else {
    observer.observe(document.body, { childList: true, subtree: true });
  }
})();
