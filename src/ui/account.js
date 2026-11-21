// «Passwort ändern» – the user's own password, reached from the name pill in the header (every page).
// Current password, new password twice; ≥ 4 characters (worker/src/users.js MIN_PW).
import { t } from '../i18n.js';
import { esc, html, qs, onAct, toast } from '../util/dom.js';
import { api } from '../api.js';

export function openPasswordDialog(user) {
  return new Promise((resolve) => {
    const bg = html(`<div class="modal-bg"><section class="modal sm" role="dialog" aria-modal="true" aria-label="${esc(t('pw.title'))}">
      <div class="head"><h1>${esc(t('pw.title'))}</h1><button class="btn icon" type="button" data-act="cancel" aria-label="${esc(t('common.close'))}">×</button></div>
      <form class="pwform" style="display:flex;flex-direction:column;gap:14px">
        <div class="muted small">${esc(t('pw.who', { user }))}</div>
        <label class="f">${esc(t('pw.current'))}<input class="in" name="current" type="password" autocomplete="current-password" required></label>
        <label class="f">${esc(t('pw.next'))}<input class="in" name="next" type="password" autocomplete="new-password" required minlength="4"></label>
        <label class="f">${esc(t('pw.repeat'))}<input class="in" name="repeat" type="password" autocomplete="new-password" required minlength="4"></label>
        <div class="muted small">${esc(t('pw.hint'))}</div>
        <div class="foot"><button class="btn" type="button" data-act="cancel">${esc(t('common.cancel'))}</button><button class="btn primary" type="submit">${esc(t('pw.save'))}</button></div>
      </form>
    </section></div>`);
    const done = (v) => { bg.remove(); resolve(v); };
    const form = qs(bg, 'form.pwform');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const current = String(fd.get('current') || ''); const next = String(fd.get('next') || ''); const repeat = String(fd.get('repeat') || '');
      if (next.length < 4) { toast(t('pw.tooShort'), true); return; }
      if (next !== repeat) { toast(t('pw.mismatch'), true); return; }
      const btn = qs(form, 'button[type=submit]'); btn.disabled = true;
      try { await api.changePassword(current, next); toast(t('pw.done')); done(true); }
      catch (ex) { btn.disabled = false; toast(ex.message === 'E_PW_CURRENT' ? t('pw.wrongCurrent') : ex.message, true); qs(form, '[name=current]').focus(); }
    });
    onAct(bg, { cancel: () => done(false) });
    bg.addEventListener('click', (e) => { if (e.target === bg) done(false); });
    document.body.appendChild(bg);
    qs(form, '[name=current]').focus();
  });
}

/** Master sets a user's password (no current password needed): new password twice. */
export function openSetPasswordDialog(name) {
  return new Promise((resolve) => {
    const bg = html(`<div class="modal-bg"><section class="modal sm" role="dialog" aria-modal="true" aria-label="${esc(t('pw.setTitle', { user: name }))}">
      <div class="head"><h1>${esc(t('pw.setTitle', { user: name }))}</h1><button class="btn icon" type="button" data-act="cancel" aria-label="${esc(t('common.close'))}">×</button></div>
      <form class="pwform" style="display:flex;flex-direction:column;gap:14px">
        <label class="f">${esc(t('pw.next'))}<input class="in" name="next" type="text" autocomplete="off" required minlength="4" placeholder="${esc(t('admin.pwShown'))}"></label>
        <div class="muted small">${esc(t('pw.hint'))}</div>
        <div class="foot"><button class="btn" type="button" data-act="cancel">${esc(t('common.cancel'))}</button><button class="btn primary" type="submit">${esc(t('pw.save'))}</button></div>
      </form>
    </section></div>`);
    const done = (v) => { bg.remove(); resolve(v); };
    const form = qs(bg, 'form.pwform');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const next = String(new FormData(form).get('next') || '');
      if (next.length < 4) { toast(t('pw.tooShort'), true); return; }
      const btn = qs(form, 'button[type=submit]'); btn.disabled = true;
      try { await api.users.save({ name, password: next }); toast(t('pw.doneFor', { user: name })); done(true); }
      catch (ex) { btn.disabled = false; toast(ex.message, true); }
    });
    onAct(bg, { cancel: () => done(false) });
    bg.addEventListener('click', (e) => { if (e.target === bg) done(false); });
    document.body.appendChild(bg);
    qs(form, '[name=next]').focus();
  });
}
