// OpenCode Go Chat — floating window (content script)
// Renders a draggable, resizable, minimizable chat window inside a shadow
// root (fully isolated from host-page CSS). The chat UI lives in an iframe
// (popup.html, full extension context); its header acts as the drag handle
// and its window controls reach us via postMessage.

(() => {
  if (window.__ocGoFloat) return;
  window.__ocGoFloat = true;

  const MIN_W = 340;
  const MIN_H = 400;
  const MARGIN = 10;
  const CHIP_SIZE = 54;
  const ANIM = 240;
  const KEY_RECT = 'oc_float_rect';
  const KEY_CHIP = 'oc_float_chip';
  const KEY_THEME = 'opencode_go_theme';
  const KEY_CLICK_AWAY = 'opencode_go_click_away';

  // Whether clicking the host page minimizes the window. Settable in options;
  // defaults to on, and is read before the first click can land.
  let clickAwayMinimizes = true;

  let built = false;
  let mode = 'hidden'; // 'hidden' | 'open' | 'chip'
  let rect = null;     // {x, y, w, h}
  let chipPos = null;  // {x, y}
  let host, root, win, chip, guard, frame;

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  // ── Persistence ──────────────────────────────────────────────
  async function loadPrefs() {
    try {
      const s = await chrome.storage.local.get([KEY_RECT, KEY_CHIP]);
      if (s[KEY_RECT] && typeof s[KEY_RECT] === 'object') rect = s[KEY_RECT];
      if (s[KEY_CHIP] && typeof s[KEY_CHIP] === 'object') chipPos = s[KEY_CHIP];
    } catch (_) {}
  }

  function savePrefs() {
    try {
      chrome.storage.local.set({ [KEY_RECT]: rect, [KEY_CHIP]: chipPos });
    } catch (_) {}
  }

  // ── Geometry ─────────────────────────────────────────────────
  function defaultRect() {
    const w = clamp(Math.round(window.innerWidth * 0.32), 400, 460);
    const h = clamp(Math.round(window.innerHeight * 0.8), 540, 720);
    return {
      x: window.innerWidth - w - 24,
      y: Math.max(MARGIN, Math.round((window.innerHeight - h) / 2)),
      w,
      h,
    };
  }

  function clampToViewport(r) {
    r.w = clamp(r.w, MIN_W, window.innerWidth - MARGIN * 2);
    r.h = clamp(r.h, MIN_H, window.innerHeight - MARGIN * 2);
    r.x = clamp(r.x, MARGIN, window.innerWidth - MARGIN - r.w);
    r.y = clamp(r.y, MARGIN, window.innerHeight - MARGIN - r.h);
    return r;
  }

  function defaultChipPos() {
    return {
      x: window.innerWidth - CHIP_SIZE - 24,
      y: window.innerHeight - CHIP_SIZE - 120,
    };
  }

  function clampChip(p) {
    return {
      x: clamp(p.x, MARGIN, window.innerWidth - CHIP_SIZE - MARGIN),
      y: clamp(p.y, MARGIN, window.innerHeight - CHIP_SIZE - MARGIN),
    };
  }

  function applyRect() {
    win.style.left = rect.x + 'px';
    win.style.top = rect.y + 'px';
    win.style.width = rect.w + 'px';
    win.style.height = rect.h + 'px';
  }

  function applyChip() {
    chip.style.left = chipPos.x + 'px';
    chip.style.top = chipPos.y + 'px';
  }

  // ── Build ────────────────────────────────────────────────────
  function build() {
    if (built) return;
    built = true;

    host = document.createElement('div');
    host.id = 'oc-go-float-host';
    host.style.cssText =
      'all: initial !important; position: fixed !important; inset: 0 !important; ' +
      'z-index: 2147483647 !important; pointer-events: none !important; ' +
      'margin: 0 !important; padding: 0 !important; border: 0 !important; background: none !important;';
    root = host.attachShadow({ mode: 'open' });

    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = chrome.runtime.getURL('content/float.css');
    root.appendChild(css);

    win = document.createElement('div');
    win.className = 'oc-win oc-hidden';
    win.style.visibility = 'hidden'; // avoid unstyled flash before CSS loads
    win.innerHTML = `
      <div class="oc-body">
        <iframe class="oc-frame" src="${chrome.runtime.getURL('popup.html')}" title="OpenCode Go Chat"></iframe>
      </div>
      <div class="oc-guard"></div>
      ${['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
        .map((d) => `<div class="oc-rz oc-rz-${d}" data-dir="${d}"></div>`)
        .join('')}
      <div class="oc-grip" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M11 1L1 11M11 6L6 11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
      </div>`;

    chip = document.createElement('div');
    chip.className = 'oc-chip oc-hidden';
    chip.style.visibility = 'hidden';
    chip.title = 'OpenCode Go Chat';
    chip.setAttribute('role', 'button');
    chip.innerHTML = `<img src="${chrome.runtime.getURL('icons/icon128.png')}" alt="" draggable="false">`;

    css.addEventListener('load', () => {
      win.style.visibility = '';
      chip.style.visibility = '';
    });

    root.appendChild(win);
    root.appendChild(chip);
    document.documentElement.appendChild(host);

    frame = win.querySelector('.oc-frame');
    guard = win.querySelector('.oc-guard');

    wireResize();
    wireChip();
    initSettings();

    window.addEventListener('resize', () => {
      if (!rect || !chipPos) return;
      clampToViewport(rect);
      chipPos = clampChip(chipPos);
      applyRect();
      applyChip();
    });
  }

  // ── Mode switching ───────────────────────────────────────────
  async function setMode(next) {
    if (!built) {
      await loadPrefs();
      rect = clampToViewport(rect || defaultRect());
      chipPos = clampChip(chipPos || defaultChipPos());
      build();
      applyRect();
      applyChip();
    } else if (host && !host.isConnected) {
      // Host page (SPA nav, rerender) removed our node — re-attach.
      document.documentElement.appendChild(host);
    }

    const prev = mode;
    mode = next;

    if (next === 'open') {
      const fromChip = prev === 'chip';
      win.style.transformOrigin = fromChip
        ? `${chipPos.x + CHIP_SIZE / 2 - rect.x}px ${chipPos.y + CHIP_SIZE / 2 - rect.y}px`
        : '50% 60%';
      chip.classList.add('oc-hidden');
      win.classList.add(fromChip ? 'oc-from-chip' : 'oc-from-hidden');
      win.classList.remove('oc-hidden');
      void win.offsetWidth; // force reflow so the transition runs
      win.classList.remove('oc-from-chip', 'oc-from-hidden');
      try { frame.focus(); } catch (_) {}
      // The iframe stays loaded while minimized, so its own startup focus runs
      // only once. Tell it to put the cursor back in the composer every time
      // the window is shown, whether from the chip or the toolbar icon.
      try { frame.contentWindow.postMessage({ oc: 'focus' }, '*'); } catch (_) {}
    } else if (next === 'chip') {
      win.style.transformOrigin =
        `${chipPos.x + CHIP_SIZE / 2 - rect.x}px ${chipPos.y + CHIP_SIZE / 2 - rect.y}px`;
      win.classList.add('oc-to-chip');
      setTimeout(() => {
        if (mode !== 'chip') return;
        win.classList.add('oc-hidden');
        win.classList.remove('oc-to-chip');
        chip.classList.remove('oc-hidden');
        chip.classList.add('oc-pop');
        setTimeout(() => chip.classList.remove('oc-pop'), 400);
      }, ANIM);
    } else {
      // hidden
      if (prev === 'chip') {
        chip.classList.add('oc-hidden');
      } else {
        win.style.transformOrigin = '50% 50%';
        win.classList.add('oc-to-hidden');
        setTimeout(() => {
          if (mode !== 'hidden') return;
          win.classList.add('oc-hidden');
          win.classList.remove('oc-to-hidden');
        }, 180);
      }
    }
  }

  // ── Drag initiated from inside the iframe (chat header) ──────
  function beginExternalDrag(ix, iy) {
    if (mode !== 'open') return;
    const fr = frame.getBoundingClientRect();
    const px = fr.left + ix; // pointer position in top-document coords
    const py = fr.top + iy;
    const start = { ...rect };

    win.classList.add('oc-dragging');
    guard.classList.add('on'); // keeps pointer events off the iframe

    const move = (ev) => {
      rect.x = clamp(start.x + ev.clientX - px, MARGIN, window.innerWidth - MARGIN - rect.w);
      rect.y = clamp(start.y + ev.clientY - py, MARGIN, window.innerHeight - MARGIN - rect.h);
      applyRect();
    };
    const up = () => {
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', up, true);
      win.classList.remove('oc-dragging');
      guard.classList.remove('on');
      savePrefs();
    };
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', up, true);
  }

  // Messages from the chat iframe: window controls + drag + streaming state
  window.addEventListener('message', (e) => {
    let sourceWindow;
    try { sourceWindow = frame && frame.contentWindow; } catch (_) {}
    if (!built || !frame || !sourceWindow || e.source !== sourceWindow) return;
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.oc === 'min') setMode('chip');
    else if (d.oc === 'close') setMode('hidden');
    else if (d.oc === 'drag-start') beginExternalDrag(d.x || 0, d.y || 0);
    else if (d.oc === 'streaming') win.classList.toggle('oc-live', !!d.on);
    else if (d.oc === 'theme') applyChromeTheme(d.theme);
  });

  // The window frame lives in this shadow root, so it cannot inherit the
  // iframe document's theme tokens — it is themed by class instead.
  function applyChromeTheme(theme) {
    if (!win) return;
    win.classList.toggle('oc-light', theme === 'light');
    if (chip) chip.classList.toggle('oc-light', theme === 'light');
  }

  function resolveTheme(pref) {
    if (pref === 'light' || pref === 'dark') return pref;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  // Read settings as soon as the frame is built, rather than waiting for the
  // iframe to boot and post them — otherwise the chrome shows dark for as long
  // as the iframe takes to load.
  function initSettings() {
    try {
      chrome.storage.local.get([KEY_THEME, KEY_CLICK_AWAY], (res) => {
        applyChromeTheme(resolveTheme((res && res[KEY_THEME]) || 'system'));
        // Default on: absent means the user has never chosen, not "off".
        clickAwayMinimizes = !(res && res[KEY_CLICK_AWAY] === false);
      });
    } catch (_) {
      // Extension context invalidated (e.g. after a reload) — keep defaults.
    }
  }

  // Settings live in the options tab, so changes have to reach open windows
  // on every tab without a reload.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[KEY_CLICK_AWAY]) {
        clickAwayMinimizes = changes[KEY_CLICK_AWAY].newValue !== false;
      }
      if (changes[KEY_THEME]) {
        applyChromeTheme(resolveTheme(changes[KEY_THEME].newValue || 'system'));
      }
    });
  } catch (_) {}

  // ── Resizing (8 handles) ─────────────────────────────────────
  function wireResize() {
    win.querySelectorAll('.oc-rz').forEach((handle) => {
      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        try { handle.setPointerCapture(e.pointerId); } catch (_) {}

        const dir = handle.dataset.dir;
        const sx = e.clientX;
        const sy = e.clientY;
        const start = { ...rect };
        win.classList.add('oc-resizing');
        guard.classList.add('on');

        const move = (ev) => {
          const dx = ev.clientX - sx;
          const dy = ev.clientY - sy;
          if (dir.includes('e')) {
            rect.w = clamp(start.w + dx, MIN_W, window.innerWidth - MARGIN - start.x);
          }
          if (dir.includes('s')) {
            rect.h = clamp(start.h + dy, MIN_H, window.innerHeight - MARGIN - start.y);
          }
          if (dir.includes('w')) {
            const newX = clamp(start.x + dx, MARGIN, start.x + start.w - MIN_W);
            rect.w = start.w + (start.x - newX);
            rect.x = newX;
          }
          if (dir.includes('n')) {
            const newY = clamp(start.y + dy, MARGIN, start.y + start.h - MIN_H);
            rect.h = start.h + (start.y - newY);
            rect.y = newY;
          }
          applyRect();
        };
        const up = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          handle.removeEventListener('pointercancel', up);
          win.classList.remove('oc-resizing');
          guard.classList.remove('on');
          savePrefs();
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
      });
    });
  }

  // ── Chip (draggable, click to expand) ────────────────────────
  function wireChip() {
    chip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try { chip.setPointerCapture(e.pointerId); } catch (_) {}

      const sx = e.clientX;
      const sy = e.clientY;
      const start = { ...chipPos };
      let dragged = false;
      chip.classList.add('oc-held');

      const move = (ev) => {
        if (!dragged && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 6) dragged = true;
        if (dragged) {
          chipPos = clampChip({ x: start.x + ev.clientX - sx, y: start.y + ev.clientY - sy });
          applyChip();
        }
      };
      const up = () => {
        chip.removeEventListener('pointermove', move);
        chip.removeEventListener('pointerup', up);
        chip.removeEventListener('pointercancel', up);
        chip.classList.remove('oc-held');
        if (dragged) {
          savePrefs();
        } else {
          setMode('open');
        }
      };
      chip.addEventListener('pointermove', move);
      chip.addEventListener('pointerup', up);
      chip.addEventListener('pointercancel', up);
    });
  }

  // ── Click the page to minimize ───────────────────────────────
  // Bound on the top document in the capture phase so it still fires on pages
  // that stopPropagation() their own clicks.
  //
  // Clicks inside the chat UI never reach here at all: it is an iframe, a
  // separate browsing context whose events do not cross into this document.
  // Clicks on our own chrome (border, resize handles, grip, chip) DO reach
  // here, but the shadow boundary retargets e.target to the host element —
  // so this tests composedPath(), which still contains the real target.
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!clickAwayMinimizes) return;
      if (mode !== 'open' || !built || !host) return;
      if (e.button !== 0) return; // let right/middle click open menus in peace

      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      const insideOurs = path.length
        ? path.includes(host)
        : e.target === host || host.contains(e.target);
      if (insideOurs) return;

      setMode('chip');
    },
    true
  );

  // ── Toggle from the toolbar icon ─────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'oc-toggle') return;
    try {
      setMode(mode === 'open' ? 'hidden' : 'open');
    } catch (_) {}
  });
})();
