// Admin page (design/Admin.dc.html), master user only: ground users (flag Masteruser), observer
// access codes (ui/observers.js), app settings, chat quick replies, activity log with CSV export.

import { t } from '../i18n.js';
import { esc, html, qs, qsa, onAct, toast, confirmDialog } from '../util/dom.js';
import { api } from '../api.js';
import { state, bus } from '../state.js';
import { fmtDateTimeUTC, fmtInt, fmtNum } from '../util/format.js';
import { mountObserversAdmin } from './observers.js';

export function mountAdmin(root, ctx) {
  const el = html(`<main class="page" style="padding:26px 28px;gap:22px">
    <h1 style="font-size:26px;font-weight:600">${esc(t('admin.title'))}</h1>
    <div class="row-wrap" style="align-items:flex-start">
      <section class="card" style="flex:999 1 560px"><h2>${esc(t('admin.users'))}</h2><div class="scroll-x users"></div>
        <form class="form4 adduser">
          <label class="f">${esc(t('login.user'))}<input class="in" name="name" type="text" placeholder="z. B. crew2" required pattern="[a-z0-9_.-]{2,32}"></label>
          <label class="f">${esc(t('admin.fullName'))}<input class="in" name="fullName" type="text" placeholder="${esc(t('admin.fullNamePh'))}"></label>
          <label class="f">${esc(t('login.password'))}<input class="in" name="password" type="text" placeholder="${esc(t('admin.pwShown'))}" required minlength="6"></label>
          <label class="chk" style="align-self:center"><input type="checkbox" name="master"> ${esc(t('role.master'))}</label>
          <button class="btn primary" type="submit">${esc(t('admin.addUser'))}</button>
        </form>
        <p class="muted small" style="margin:0">${esc(t('admin.usersNote'))}</p></section>
      <section class="card" style="flex:1 1 320px"><h2>${esc(t('admin.settings'))}</h2><form class="settings" style="display:flex;flex-direction:column;gap:14px"></form></section>
    </div>
    <div class="obsslot" style="display:contents"></div>
    <section class="card"><h2>${esc(t('admin.quick'))}</h2>
      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px">
        <div class="qr-list" data-list="quickRepliesGround"><div class="k" style="font-weight:600">${esc(t('admin.quickGround'))}</div></div>
        <div class="qr-list" data-list="quickRepliesObserver"><div class="k" style="font-weight:600">${esc(t('admin.quickObserver'))}</div></div>
      </div>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><button class="btn primary" type="button" data-act="saveQuick">${esc(t('common.save'))}</button><span class="muted small">${esc(t('admin.quickNote'))}</span></div></section>
    <section class="card"><div class="card-head" style="padding:0"><h2>${esc(t('admin.log'))}</h2><div style="display:flex;gap:8px"><button class="btn" type="button" data-act="csv">${esc(t('admin.exportCsv'))}</button></div></div><div class="scroll-x logbox"></div></section>
  </main>`);
  root.replaceChildren(el);
  const s = state.session.settings;
  let users = [], log = [];

  const renderUsers = () => {
    const me = state.session.user;
    qs(el, '.users').innerHTML = `<table><thead><tr><th>${esc(t('login.user'))}</th><th>${esc(t('admin.fullName'))}</th><th>${esc(t('role.master'))}</th><th>${esc(t('admin.active'))}</th><th>${esc(t('admin.lastLogin'))}</th><th>${esc(t('admin.ascents'))}</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr><td class="mono">${esc(u.name)}</td><td>${esc(u.fullName || '')}</td>
        <td><button type="button" class="sw ${u.master ? '' : 'off'}" data-act="master" data-name="${esc(u.name)}" role="switch" aria-checked="${!!u.master}" aria-label="${esc(t('role.master'))}" ${u.name === me ? 'disabled' : ''}></button></td>
        <td><button type="button" class="sw ${u.active ? '' : 'off'}" data-act="toggle" data-name="${esc(u.name)}" role="switch" aria-checked="${!!u.active}" aria-label="${esc(t('admin.active'))}" ${u.name === me ? 'disabled' : ''}></button></td>
        <td class="mono">${u.lastLogin ? fmtDateTimeUTC(u.lastLogin).slice(0, 16) : '–'}</td><td class="mono">${u.ascents ?? '–'}</td><td><button class="btn xs" type="button" data-act="del" data-name="${esc(u.name)}" ${u.name === me ? 'disabled' : ''}>×</button></td></tr>`).join('')}
    </tbody></table>`;
  };
  const renderSettings = () => {
    const f = (label, name, value, extra = '') => `<label class="f">${esc(label)}<input class="in mono" name="${name}" value="${esc(value)}" ${extra}></label>`;
    // relayUrl (override of apiBase) is deliberately not editable here – it only exists for tests; the Worker address lives in src/config.js
    qs(el, '.settings').innerHTML = ''
      + f(t('admin.s.frequency'), 'frequencyMHz', fmtNum((s.frequencyHz || 433900000) / 1e6, 3) + ' MHz')
      + f(t('admin.s.rise'), 'riseRate', `${s.riseRate} m/s`) + f(t('admin.s.descent'), 'descentRate', `${s.descentRate} m/s`)
      + f(t('admin.s.rr4usb'), 'rr4Usb', s.rr4Usb || t('admin.s.notDetected'), 'readonly')
      + f(t('admin.s.sondeTypes'), 'sondeTypes', s.sondeTypes || '')
      + f(t('admin.s.cloudRh'), 'cloudRh', `${s.cloudRh} %`) + f(t('admin.s.folder'), 'defaultFolder', s.defaultFolder || '')
      + f(t('admin.s.autoLogout'), 'autoLogoutH', `${s.autoLogoutH} h`)
      + f(t('admin.s.windFallback'), 'windFallback', `${s.windFallbackDir}° / ${s.windFallbackSpd} m/s`)
      + f(t('admin.s.cutAlt'), 'cutAltAgl', `${fmtInt(s.cutAltAgl || 3000)} m`)
      + `<label class="f">${esc(t('admin.s.openaipKey'))}<input class="in mono secret" name="openaipKey" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" data-lpignore="true" data-1p-ignore value="" placeholder="${esc(s.openaipKey === 'set' ? t('admin.s.keySet') : t('admin.s.keyMissing'))}"><span class="muted small">${esc(t('admin.s.openaipHint'))}</span></label>`
      + `<div class="f"><span class="muted small">${esc(t('admin.s.testKeyHint'))}</span><span><button class="btn" type="button" data-act="testKey">${esc(t('admin.s.testKey'))}</button></span><span class="muted small keyfp"></span></div>`
      + f(t('admin.s.airspaceCats'), 'airspaceCats', s.airspaceCats || 'P,R,D,CTR,TMA', 'placeholder="P,R,D,CTR,TMA,CTA,TMZ,ATZ,GLD"')
      + `<label class="f">${esc(t('admin.s.waPhoneNumberId'))}<input class="in mono secret" name="waPhoneNumberId" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" data-lpignore="true" data-1p-ignore value="" placeholder="${esc(s.waPhoneNumberId === 'set' ? t('admin.s.keySet') : '')}"></label>`
      + `<label class="f">${esc(t('admin.s.waToken'))}<input class="in mono secret" name="waToken" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" data-lpignore="true" data-1p-ignore value="" placeholder="${esc(s.waToken === 'set' ? t('admin.s.keySet') : '')}"><span class="muted small">${esc(t('admin.s.waHint'))}</span></label>`
      + `<button class="btn" type="submit">${esc(t('common.save'))}</button>`;
  };
  const renderQuick = () => {
    for (const key of ['quickRepliesGround', 'quickRepliesObserver']) {
      const box = qs(el, `[data-list=${key}]`);
      box.querySelectorAll('.line, .add').forEach((x) => x.remove());
      for (const q of s[key] || []) box.insertAdjacentHTML('beforeend', `<div class="line"><input class="in" type="text" value="${esc(q)}" maxlength="40"><button class="btn icon" type="button" data-act="rm" aria-label="${esc(t('common.remove'))}">×</button></div>`);
      box.insertAdjacentHTML('beforeend', `<button class="btn add" type="button" data-act="addQ" data-key="${key}" style="align-self:flex-start">+ ${esc(t('admin.addReply'))}</button>`);
    }
  };
  const renderLog = () => {
    qs(el, '.logbox').innerHTML = `<table><thead><tr><th>${esc(t('admin.l.time'))}</th><th>${esc(t('login.user'))}</th><th>${esc(t('admin.l.action'))}</th><th>${esc(t('admin.l.detail'))}</th></tr></thead><tbody>
      ${log.map((r) => `<tr><td class="mono">${fmtDateTimeUTC(r.t)}</td><td class="mono">${esc(r.user)}</td><td>${esc(t(`log.${r.action}`) === `log.${r.action}` ? r.action : t(`log.${r.action}`))}</td><td>${esc(r.detail || '')}</td></tr>`).join('') || `<tr><td colspan="4" class="muted">${esc(t('admin.l.empty'))}</td></tr>`}</tbody></table>`;
  };
  const load = async () => {
    try { users = await api.users.list(); log = await api.log.list(200); } catch (e) { toast(e.message, true); }
    renderUsers(); renderLog();
  };
  const num = (v) => parseFloat(String(v).replace(/[^\d.,-]/g, '').replace(',', '.'));

  qs(el, '.adduser').addEventListener('submit', async (e) => {
    e.preventDefault(); const fd = new FormData(e.target);
    try { await api.users.save({ name: fd.get('name').trim().toLowerCase(), fullName: fd.get('fullName').trim(), password: fd.get('password'), master: fd.get('master') === 'on' ? 1 : 0, active: 1 }); e.target.reset(); toast(t('admin.userSaved')); load(); } catch (ex) { toast(ex.message, true); }
  });
  qs(el, '.settings').addEventListener('submit', async (e) => {
    e.preventDefault(); const fd = new FormData(e.target);
    const wf = String(fd.get('windFallback')).split('/');
    const patch = { frequencyHz: Math.round(num(fd.get('frequencyMHz')) * 1e6), riseRate: num(fd.get('riseRate')), descentRate: num(fd.get('descentRate')), sondeTypes: fd.get('sondeTypes'), cloudRh: num(fd.get('cloudRh')), defaultFolder: fd.get('defaultFolder'), autoLogoutH: num(fd.get('autoLogoutH')), windFallbackDir: num(wf[0]), windFallbackSpd: num(wf[1] || s.windFallbackSpd), cutAltAgl: Math.round(num(fd.get('cutAltAgl')) / 100) * 100, airspaceCats: String(fd.get('airspaceCats') || '').toUpperCase().replace(/\s/g, '') };
    for (const k of ['openaipKey', 'waPhoneNumberId', 'waToken']) { const v = String(fd.get(k) || '').trim(); if (v) patch[k] = v; }   // empty field = keep the stored secret
    try { Object.assign(s, await api.settings.put(patch)); toast(t('admin.saved')); renderSettings(); bus.emit('settings'); } catch (ex) { toast(ex.message, true); return; }
    if (patch.openaipKey) testKey();   // a freshly pasted key is checked at once so a wrong one shows up here, not in Phase 1
  });
  /** One request to openAIP with the stored key; the toast shows the result including what openAIP answered. */
  async function testKey() {
    try {
      const r = await api.airspacesTest();
      const report = (r.tried || []).map((a) => `${a.via}: ${a.status}${a.body ? ' – ' + a.body.slice(0, 60) : ''}`).join(' · ');
      // fingerprint of the stored key (length, first 4 + last 2) so it can be compared with openaip.net; the key itself never leaves the Worker
      const fp = r.keyLength ? t('admin.s.keyFp', { n: r.keyLength, hint: r.keyHint, src: r.source === 'secret' ? 'GitHub-Secret' : t('admin.s.keySrcSettings') }) + (r.keyFormatOk ? '' : ' ' + t('admin.s.keyFormatBad')) : '';
      qs(el, '.keyfp').textContent = fp;
      if (r.ok) toast(t('admin.s.testOk', { n: r.count, via: r.via }));
      else toast((r.message === 'E_NO_OPENAIP_KEY' ? t('admin.s.keyMissing') : t('admin.s.testFail') + ' ' + fp + ' ' + (report || r.message || r.status)), true);
    } catch (ex) { toast(t('admin.s.testFail') + ' ' + ex.message, true); }
  }
  onAct(el, {
    testKey,
    toggle: async (b) => { const u = users.find((x) => x.name === b.dataset.name); if (!u) return; try { await api.users.save({ name: u.name, active: u.active ? 0 : 1 }); load(); } catch (ex) { toast(ex.message, true); } },
    master: async (b) => { const u = users.find((x) => x.name === b.dataset.name); if (!u) return; try { await api.users.save({ name: u.name, master: u.master ? 0 : 1 }); load(); } catch (ex) { toast(ex.message, true); } },
    del: async (b) => { if (await confirmDialog({ title: t('admin.deleteUser'), text: `<p>${esc(b.dataset.name)}</p>`, okLabel: t('common.remove'), cancelLabel: t('common.cancel'), danger: true })) { try { await api.users.remove(b.dataset.name); load(); } catch (ex) { toast(ex.message, true); } } },
    rm: (b) => b.closest('.line').remove(),
    addQ: (b) => { const box = b.closest('.qr-list'); if (box.querySelectorAll('.line').length >= 6) return; b.insertAdjacentHTML('beforebegin', `<div class="line"><input class="in" type="text" value="" maxlength="40"><button class="btn icon" type="button" data-act="rm" aria-label="${esc(t('common.remove'))}">×</button></div>`); },
    saveQuick: async () => {
      const patch = {};
      for (const key of ['quickRepliesGround', 'quickRepliesObserver']) patch[key] = qsa(el, `[data-list=${key}] .line input`).map((i) => i.value.trim()).filter(Boolean).slice(0, 6);
      try { Object.assign(s, await api.settings.put(patch)); toast(t('admin.saved')); renderQuick(); bus.emit('settings'); } catch (ex) { toast(ex.message, true); }
    },
    csv: () => { const txt = 'time_utc,user,action,detail\n' + log.map((r) => [new Date(r.t).toISOString(), r.user, r.action, (r.detail || '').replace(/"/g, '""')].map((v) => `"${v}"`).join(',')).join('\n'); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([txt], { type: 'text/csv' })); a.download = 'activity_log.csv'; a.click(); },
  });
  const obs = mountObserversAdmin(qs(el, '.obsslot'));
  renderSettings(); renderQuick(); load();
  return { destroy() { obs.destroy(); el.remove(); } };
}
