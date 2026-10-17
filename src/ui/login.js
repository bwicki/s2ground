// Login page (design/Login.dc.html) for GROUND USERS (name + password) + the one-time master
// setup form shown when the Worker's user table is still empty (so Balthasar never needs a
// terminal to create the first login). Observers never log in here – they use their code in s2stueve.

import { t, currentLang } from '../i18n.js';
import { esc, html, qs, onAct } from '../util/dom.js';
import { api, SIM } from '../api.js';

export function mountLogin(root, ctx) {
  const lang = currentLang();
  const el = html(`<div id="loginpage" style="display:flex;flex-direction:column;min-height:100vh">
    <header class="login">
      <div class="seg lang" aria-label="${esc(t('hdr.language'))}"><button type="button" data-act="lang" data-lang="de" class="${lang === 'de' ? 'on' : ''}">DE</button><button type="button" data-act="lang" data-lang="en" class="${lang === 'en' ? 'on' : ''}">EN</button></div>
      <img src="./img/logo.png" alt="Wicki Partners Ballonteam">
    </header>
    <main class="center">
      <form class="login" autocomplete="on">
        <div style="display:flex;flex-direction:column;gap:4px"><h1>S2 Ground</h1><span class="muted">${esc(t('login.tagline'))}</span></div>
        <div class="setup hidden">
          <div class="banner info" style="margin-bottom:12px"><div class="body"><h3>${esc(t('login.setupTitle'))}</h3><div class="sub">${esc(t('login.setupText'))}</div></div></div>
        </div>
        <label class="f">${esc(t('login.user'))}<input class="in" name="user" type="text" autocomplete="username" value="${SIM ? 'bwicki' : ''}" required></label>
        <label class="f setup-only hidden">${esc(t('login.fullName'))}<input class="in" name="fullName" type="text" autocomplete="name"></label>
        <label class="f">${esc(t('login.password'))}<input class="in" name="password" type="password" autocomplete="current-password" value="${SIM ? 'demo' : ''}" required></label>
        <div class="err hidden" role="alert"></div>
        <button class="btn primary" type="submit" style="min-height:56px;font-size:17px">${esc(t('login.submit'))}</button>
        <p class="muted" style="margin:0;font-size:13px;line-height:1.5">${esc(t('login.note'))}</p>
        ${SIM ? `<p class="muted" style="margin:0;font-size:13px">${esc(t('login.simHint'))}</p>` : ''}
      </form>
    </main>
    <footer class="foot"><span>s2ground.wicki.aero · Version 0.1</span><span>${esc(t('login.browsers'))}</span></footer>
  </div>`);
  onAct(el, { lang: (b) => ctx.onLang(b.dataset.lang) });
  const form = qs(el, 'form'), err = qs(el, '.err');
  let setupMode = false;
  api.setupNeeded().then((needed) => {
    if (!needed) return;
    setupMode = true;
    el.querySelectorAll('.setup, .setup-only').forEach((x) => x.classList.remove('hidden'));
    qs(el, 'button[type=submit]').textContent = t('login.setupSubmit');
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.classList.add('hidden');
    const user = form.user.value.trim(), password = form.password.value;
    const btn = qs(el, 'button[type=submit]'); btn.disabled = true;
    try {
      if (setupMode) await api.setup(user, password, form.fullName.value.trim());
      await ctx.onLogin(user, password);
    } catch (ex) {
      err.textContent = ex.status === 401 ? t('login.badCredentials') : ex.status === 429 ? t('login.rateLimited') : `${t('login.failed')} (${ex.message})`;
      err.classList.remove('hidden');
    } finally { btn.disabled = false; }
  });
  root.replaceChildren(el);
  return { destroy() { el.remove(); } };
}
