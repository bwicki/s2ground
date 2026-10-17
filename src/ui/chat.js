// Chat aside (design/Aufstieg.dc.html): messages via the relay, quick replies set by the
// master user in the admin page, free text. Reused by the ascent and retrieve phases.

import { t } from '../i18n.js';
import { esc, html, qs, onAct } from '../util/dom.js';
import { state, bus, settings } from '../state.js';
import { fmtTimeUTC } from '../util/format.js';

export function mountChat(container, ctx) {
  const el = html(`<aside class="card chat">
    <div class="head"><div><h2>${esc(t('chat.title'))}</h2><div class="muted small" data-f="who"></div></div><span class="pill sm"><span class="dot x" data-f="dot"></span><span data-f="online">0 online</span></span></div>
    <div class="msgs"></div>
    <div class="foot">
      <div class="k">${esc(t('chat.quick'))}</div>
      <div class="quick"></div>
      <div class="k">${esc(t('chat.free'))}</div>
      <form class="send"><input class="in" name="text" type="text" placeholder="${esc(t('chat.placeholder'))}" aria-label="${esc(t('chat.message'))}" autocomplete="off" maxlength="500"><button class="btn primary" type="submit">${esc(t('chat.send'))}</button></form>
    </div></aside>`);
  container.appendChild(el);
  const me = state.session ? state.session.user : '';
  const renderMsgs = () => {
    const box = qs(el, '.msgs');
    box.innerHTML = state.relay.chat.map((m) => {
      const mine = m.user === me;
      const sys = m.role === 'system';
      // observers appear under the Klarname they chose when joining (m.user); ground users under their login name
      return `<div class="msg ${mine ? 'me' : ''} ${sys ? 'sys' : ''}"><span class="who">${esc(mine ? t('chat.me') : (m.fullName || m.user))} · ${fmtTimeUTC(m.t)}</span><span class="t">${esc(m.text)}</span></div>`;
    }).join('') || `<div class="muted small">${esc(t('chat.empty'))}</div>`;
    box.scrollTop = box.scrollHeight;
  };
  const renderHead = () => {
    const n = state.relay.presence.length;
    qs(el, '[data-f=online]').textContent = `${n} online`;
    qs(el, '[data-f=dot]').className = `dot ${state.relay.connected ? 'g' : 'x'}`;
    qs(el, '[data-f=who]').textContent = n ? `${t('chat.via')} · ${state.relay.presence.map((u) => u.name).join(', ')}` : t('chat.via');
  };
  const renderQuick = () => {
    const list = settings().quickRepliesGround || [];
    qs(el, '.quick').innerHTML = list.map((q) => `<button class="btn chip" type="button" data-act="quick" data-text="${esc(q)}">${esc(q)}</button>`).join('');
  };
  const send = (text) => { if (text.trim()) ctx.sendChat(text.trim()); };
  onAct(el, { quick: (b) => send(b.dataset.text) });
  qs(el, 'form').addEventListener('submit', (e) => { e.preventDefault(); const inp = qs(el, '[name=text]'); send(inp.value); inp.value = ''; });
  const offs = [bus.on('chat', renderMsgs), bus.on('presence', renderHead), bus.on('relay', renderHead)];
  renderMsgs(); renderHead(); renderQuick();
  return { destroy() { offs.forEach((f) => f()); el.remove(); } };
}
