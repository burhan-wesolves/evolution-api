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
