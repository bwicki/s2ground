// Tiny DOM helpers. Views are written as HTML template strings (closest to the design boards),
// so every dynamic value MUST go through esc() – chat text and user names are untrusted.

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Parse an HTML string into a single element (or a fragment when several roots). */
export function html(str) {
  const tpl = document.createElement('template');
  tpl.innerHTML = str.trim();
  return tpl.content.childElementCount === 1 ? tpl.content.firstElementChild : tpl.content;
}

export const qs = (root, sel) => root.querySelector(sel);
export const qsa = (root, sel) => Array.from(root.querySelectorAll(sel));

/** Delegate click handlers by data-act attribute: on(root, {save: fn, cancel: fn}). */
export function onAct(root, handlers) {
  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || !root.contains(el)) return;
    const fn = handlers[el.dataset.act];
    if (fn) { e.preventDefault(); fn(el, e); }
  });
}

/** SVG icons used by banners and the menu. */
export const icons = {
  ok: '<svg class="ic" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16.5 9.5"/></svg>',
  warn: '<svg class="ic" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3L2 21h20L12 3z"/><path d="M12 10v5M12 18h.01"/></svg>',
  info: '<svg class="ic" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16h.01"/></svg>',
  pin: '<svg class="ic" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
  menu: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  close: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  clock: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  locate: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="8"/></svg>',
  lock: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  cutdown: '<svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true"><polygon points="19,10 15.6,11.5 17,15 13.5,14.3 12.5,18 10,15 7.5,18 6.5,14.3 3,15 4.4,11.5 1,10 4.4,8.5 3,5 6.5,5.7 7.5,2 10,5 12.5,2 13.5,5.7 17,5 15.6,8.5" fill="#f6b03d" stroke="#e07b00"/></svg>',
  landing: '<svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="6" fill="none" stroke="#c0392b" stroke-width="2"/><line x1="0" y1="10" x2="20" y2="10" stroke="#c0392b" stroke-width="2"/><line x1="10" y1="0" x2="10" y2="20" stroke="#c0392b" stroke-width="2"/><circle cx="10" cy="10" r="2" fill="#c0392b"/></svg>',
};

/** Banner markup: level ok|warn|bad|info, title, sub text, optional ordered steps and side slot. */
export function banner({ level, title, sub = '', intro = '', steps = [], side = '', extra = '' }) {
  const icon = level === 'ok' ? icons.ok : level === 'bad' ? icons.warn : level === 'warn' ? icons.warn : icons.info;
  const list = steps.length ? `<ol>${steps.map((s) => `<li>${s}</li>`).join('')}</ol>` : '';
  return `<div class="banner ${level}" role="status">${icon}<div class="body"><h3>${title}</h3>${sub ? `<div class="sub">${sub}</div>` : ''}${intro ? `<div class="sub">${intro}</div>` : ''}${list}</div>${side ? `<div class="side">${side}</div>` : ''}${extra}</div>`;
}

let toastTimer = null;
export function toast(text, isError = false) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = text; el.classList.toggle('err', isError);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.remove(), 3500);
}

/** Simple modal confirm; resolves true/false. Buttons are labels passed by the caller (i18n). */
export function confirmDialog({ title, text, okLabel, cancelLabel, danger = false }) {
  return new Promise((resolve) => {
    const bg = html(`<div class="modal-bg"><section class="modal sm" role="dialog" aria-modal="true">
      <div class="head"><h1>${esc(title)}</h1></div>
      <div>${text}</div>
      <div class="foot"><button class="btn" data-act="cancel" type="button">${esc(cancelLabel)}</button><button class="btn ${danger ? 'danger' : 'primary'}" data-act="ok" type="button">${esc(okLabel)}</button></div>
    </section></div>`);
    const done = (v) => { bg.remove(); resolve(v); };
    const t0 = Date.now();
    // danger: the second click of a double click (or a touch repeat) lands ~100 ms after the dialog opened – never let it confirm
    onAct(bg, { ok: () => { if (!danger || Date.now() - t0 > 400) done(true); }, cancel: () => done(false) });
    bg.addEventListener('click', (e) => { if (e.target === bg) done(false); });
    document.body.appendChild(bg);
    // Destructive dialogs (cut-down, delete) default to Cancel: the dialog opens on the keydown that
    // activated the trigger button, so a held/repeated Enter must not land on the destructive button.
    bg.querySelector(danger ? '[data-act="cancel"]' : '[data-act="ok"]').focus();
  });
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}
