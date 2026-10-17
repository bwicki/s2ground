// Admin section "Beobachter · Zugangscodes" (master only): table of observer codes with
// revoke/reactivate, expandable login history, the create form and the "code shown once"
// dialog with copy + "send by WhatsApp" (wa.me link). Kept out of admin.js so that file
// stays readable; mounted by mountAdmin().

import { t } from '../i18n.js';
import { esc, html, qs, onAct, toast, copyText, confirmDialog } from '../util/dom.js';
import { api } from '../api.js';
import { fmtDateTimeUTC } from '../util/format.js';

const FOLLOW_URL = 'https://s2stueve.wicki.aero';
const waDigits = (m) => String(m || '').replace(/\D/g, '');
/** wa.me link for handing a code to its observer (short DE text; without a number WhatsApp asks for the contact). */
export function codeWaUrl(code, label, mobile) {
  const text = `Dein Zugangscode für die Sondenaufstiege (${label}): ${code}\nFolgen: ${FOLLOW_URL} → Follow sonde ascent → Code eingeben, Klarnamen wählen.`;
  return `https://wa.me/${waDigits(mobile)}?text=${encodeURIComponent(text)}`;
}

export function mountObserversAdmin(container) {
  const el = html(`<section class="card observers"><h2>${esc(t('obs.title'))}</h2>
    <p class="muted small" style="margin:0">${esc(t('obs.intro'))}</p>
    <div class="scroll-x list"></div>
    <form class="form4 addobs">
      <label class="f">${esc(t('obs.label'))}<input class="in" name="label" type="text" placeholder="${esc(t('obs.labelPh'))}" required minlength="2" maxlength="60"></label>
      <label class="f">${esc(t('obs.mobile'))}<input class="in mono" name="mobile" type="tel" placeholder="+41 79 123 45 67" pattern="^(\\+|00)?[0-9 \\(\\)\\-]{8,20}$"></label>
      <label class="chk" style="align-self:center"><input type="checkbox" name="whatsapp" checked> ${esc(t('obs.whatsappNotify'))}</label>
      <button class="btn primary" type="submit">${esc(t('obs.create'))}</button>
    </form></section>`);
  container.appendChild(el);
  let observers = [];
  const open = new Set();              // ids whose login history is expanded

  const fmt = (ms) => (ms ? fmtDateTimeUTC(ms).slice(0, 16) : '–');
  const render = () => {
    qs(el, '.list').innerHTML = `<table><thead><tr><th>${esc(t('obs.label'))}</th><th>${esc(t('obs.displayName'))}</th><th>Code</th><th>${esc(t('obs.mobile'))}</th><th>WhatsApp</th><th>${esc(t('obs.created'))}</th><th>${esc(t('admin.lastLogin'))}</th><th>${esc(t('obs.count'))}</th><th></th></tr></thead><tbody>
      ${observers.map((o) => `<tr class="${o.revokedAt ? 'muted' : ''}" data-id="${o.id}">
        <td>${esc(o.label)}${o.revokedAt ? ` <span class="tag">${esc(t('obs.revoked'))}</span>` : ''}</td>
        <td>${esc(o.displayName || '–')}</td>
        <td class="mono nowrap">${esc(o.code)} <button class="btn xs" type="button" data-act="copy" data-code="${esc(o.code)}" title="${esc(t('common.copy'))}">⧉</button></td>
        <td class="mono">${esc(o.mobile || '–')}</td>
        <td><button type="button" class="sw ${o.whatsapp ? '' : 'off'}" data-act="wa" data-id="${o.id}" role="switch" aria-checked="${!!o.whatsapp}" aria-label="WhatsApp" ${o.mobile ? '' : 'disabled'}></button></td>
        <td class="mono">${fmt(o.createdAt)}</td><td class="mono">${fmt(o.lastLoginAt)}</td><td class="mono">${o.loginCount}</td>
        <td class="nowrap">${o.revokedAt ? `<button class="btn xs" type="button" data-act="reactivate" data-id="${o.id}">${esc(t('obs.reactivate'))}</button>` : `<button class="btn xs" type="button" data-act="revoke" data-id="${o.id}">${esc(t('obs.revoke'))}</button>`}
          <button class="btn xs" type="button" data-act="history" data-id="${o.id}">${esc(open.has(o.id) ? t('obs.hideHistory') : t('obs.history'))}</button></td></tr>
        ${open.has(o.id) ? `<tr class="hist"><td colspan="9"><div class="hist-box" data-hist="${o.id}">${esc(t('obs.loading'))}</div></td></tr>` : ''}`).join('') || `<tr><td colspan="9" class="muted">${esc(t('obs.none'))}</td></tr>`}
    </tbody></table>`;
    for (const id of open) loadHistory(id);
  };
  const loadHistory = async (id) => {
    const box = qs(el, `[data-hist="${id}"]`); if (!box) return;
    try {
      const rows = await api.observers.logins(id);
      box.innerHTML = rows.length ? `<table class="sub"><thead><tr><th>${esc(t('admin.l.time'))}</th><th>${esc(t('obs.displayName'))}</th><th>IP</th><th>${esc(t('obs.device'))}</th><th>${esc(t('hdr.ascent'))}</th></tr></thead><tbody>${rows.map((r) => `<tr><td class="mono">${fmtDateTimeUTC(r.at)}</td><td>${esc(r.displayName || '')}</td><td class="mono">${esc(r.ip || '')}</td><td class="small">${esc(r.userAgent || '')}</td><td class="mono small">${esc(r.ascentId || '–')}</td></tr>`).join('')}</tbody></table>` : `<span class="muted small">${esc(t('obs.noLogins'))}</span>`;
    } catch (e) { box.textContent = e.message; }
  };
  const load = async () => { try { observers = await api.observers.list(); } catch (e) { toast(e.message, true); } render(); };

  /** The code is shown once in a dialog right after creation (it stays visible in the table too). */
  const showCodeDialog = (o) => {
    const bg = html(`<div class="modal-bg"><section class="modal sm" role="dialog" aria-modal="true">
      <div class="head"><h1>${esc(t('obs.createdTitle', { label: o.label }))}</h1></div>
      <p style="margin:0">${esc(t('obs.createdText'))}</p>
      <div class="code-big mono">${esc(o.code)}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" type="button" data-act="copy" data-code="${esc(o.code)}">${esc(t('common.copy'))}</button>
        <a class="btn primary" href="${esc(codeWaUrl(o.code, o.label, o.mobile))}" target="_blank" rel="noopener">${esc(t('obs.sendWa'))}</a></div>
      <div class="foot"><button class="btn" data-act="close" type="button">${esc(t('common.close'))}</button></div></section></div>`);
    onAct(bg, { copy: async (b) => toast((await copyText(b.dataset.code)) ? t('common.copied') : b.dataset.code), close: () => bg.remove() });
    document.body.appendChild(bg);
  };

  qs(el, '.addobs').addEventListener('submit', async (e) => {
    e.preventDefault(); const fd = new FormData(e.target);
    try {
      const o = await api.observers.create({ label: String(fd.get('label')).trim(), mobile: String(fd.get('mobile') || '').trim(), whatsapp: fd.get('whatsapp') === 'on' });
      e.target.reset(); showCodeDialog(o); load();
    } catch (ex) { toast(ex.message === 'E_MOBILE_FORMAT' ? t('obs.mobileFormat') : ex.message, true); }
  });
  onAct(el, {
    copy: async (b) => toast((await copyText(b.dataset.code)) ? t('common.copied') : b.dataset.code),
    wa: async (b) => { const o = observers.find((x) => x.id === Number(b.dataset.id)); if (!o) return; try { await api.observers.update(o.id, { whatsapp: !o.whatsapp }); load(); } catch (ex) { toast(ex.message, true); } },
    revoke: async (b) => { const o = observers.find((x) => x.id === Number(b.dataset.id)); if (!o) return; if (await confirmDialog({ title: t('obs.revokeTitle'), text: `<p>${esc(o.label)} · <span class="mono">${esc(o.code)}</span></p><p class="muted small">${esc(t('obs.revokeText'))}</p>`, okLabel: t('obs.revoke'), cancelLabel: t('common.cancel'), danger: true })) { try { await api.observers.revoke(o.id); load(); } catch (ex) { toast(ex.message, true); } } },
    reactivate: async (b) => { try { await api.observers.reactivate(Number(b.dataset.id)); load(); } catch (ex) { toast(ex.message, true); } },
    history: (b) => { const id = Number(b.dataset.id); if (open.has(id)) open.delete(id); else open.add(id); render(); },
  });
  load();
  return { destroy() { el.remove(); }, reload: load };
}
