// Header (brand, phase bar, logo, user pill, DE/EN, logout, ☰ expert menu) and the action bar
// ("Weiter" always at the top). Pure rendering; app.js wires the callbacks.

import { VERSION } from '../version.js';
import { t, currentLang } from '../i18n.js';
import { esc, html, icons, onAct } from '../util/dom.js';
import { state, PHASES } from '../state.js';
import { fmtDateISO } from '../util/format.js';

const PHASE_KEYS = { plan: 'phase.plan', prepare: 'phase.prepare', checks: 'phase.checks', ascent: 'phase.ascent', retrieve: 'phase.retrieve' };

export function phaseLabel(p) { return t(PHASE_KEYS[p]); }

function phaseChips(current) {
  const maxVisited = Math.max(...PHASES.map((p, i) => (state.visited[p] ? i : -1)));
  return PHASES.map((p, i) => {
    const st = state.phaseStatus[p].level;
    const done = i < PHASES.indexOf(current) || (state.visited[p] && p !== current && i < maxVisited);
    const cls = ['ph', p === current ? 'active' : '', done ? 'done' : '', (done || p === current) && st === 'warn' ? 'warn' : '', (done || p === current) && st === 'bad' ? 'bad' : ''].join(' ');
    const n = done ? (st === 'warn' || st === 'bad' ? '!' : '✓') : i + 1;
    const enabled = i <= maxVisited;
    return `<button type="button" class="${cls}" data-act="goto" data-phase="${p}" ${enabled ? '' : 'disabled'}><span class="n">${n}</span><span class="lbl">${esc(phaseLabel(p))}</span></button>`;
  }).join('');
}

/**
 * o.mode: 'phases' | 'detail' | 'admin' | 'quick' | 'plain'; o.subtitle; o.expert {title, body} (menu content);
 * quick = Schnellstart: no phase bar, o.quick = the view's own pills/links (html string), only user pill + logout;
 * o.tabs [{id,label,on}] for the detail view; o.pill extra pill html; callbacks: onGoto, onLang, onLogout, onTab, onClose
 */
export function renderHeader(o) {
  const lang = currentLang();
  const user = state.session ? state.session.user : '';
  const title = o.mode === 'detail' ? t('detail.title') : 'S2 Ground';
  const ascentName = state.ascent ? state.ascent.name : `${t('hdr.ascent')} ${fmtDateISO(Date.now())} · ${state.plan.start.name || ''}`;
  const subtitle = o.subtitle || ascentName;
  let middle = '';
  if (o.mode === 'phases') middle = `<nav class="phases" aria-label="${esc(t('hdr.phases'))}">${phaseChips(state.phase)}</nav>`;
  else if (o.mode === 'detail') middle = `<nav class="phases" aria-label="${esc(t('hdr.views'))}">${o.tabs.map((tb) => `<button type="button" class="tab ${tb.on ? 'on' : ''}" data-act="tab" data-tab="${tb.id}">${esc(tb.label)}</button>`).join('')}</nav>`;
  else if (o.mode === 'quick') middle = `<div class="qmid">${o.quick || ''}</div>`;
  else if (o.subtitleOnly) middle = `<span class="muted">${esc(o.subtitleOnly)}</span>`;

  let tools = '';
  if (o.mode === 'detail') {
    tools = `${o.pill || ''}<button class="btn sm" type="button" data-act="close">${icons.close} ${esc(t('detail.close'))}</button>`;
  } else if (o.mode === 'quick') {
    tools = `<span class="pill">${esc(user)}</span><button class="btn sm" type="button" data-act="logout">${esc(t('hdr.logout'))}</button>`;
  } else {
    const menu = o.expert ? `<details class="menu"><summary aria-label="${esc(t('hdr.menu'))}" title="${esc(t('hdr.menu'))}">${icons.menu}</summary><div class="panel"><h3></h3><div class="body"></div><div class="foot">${state.session && state.session.master ? `<a href="#admin">${esc(t('hdr.adminLink'))}</a>` : ''}${o.mode === 'admin' ? '' : `<a href="#log" data-act="log">${esc(t('hdr.protocol'))}</a>`}</div></div></details>` : '';
    const adminBtn = o.mode === 'admin' ? `<a class="btn sm" href="#plan">${esc(t('admin.toAscents'))}</a>` : '';
    tools = `<span class="pill">${esc(user)}${o.mode === 'admin' ? ` · ${esc(t('role.master'))}` : ''}</span>
      <div class="seg lang" aria-label="${esc(t('hdr.language'))}"><button type="button" data-act="lang" data-lang="de" class="${lang === 'de' ? 'on' : ''}">DE</button><button type="button" data-act="lang" data-lang="en" class="${lang === 'en' ? 'on' : ''}">EN</button></div>
      ${adminBtn}<button class="btn sm" type="button" data-act="logout">${esc(t('hdr.logout'))}</button>${menu}`;
  }
  const el = html(`<header class="top">
    <div class="brand"><strong>${esc(title)}</strong><span>${esc(subtitle)}</span></div>
    ${middle}
    <div class="right"><img src="./img/logo.png" alt="Wicki Partners Ballonteam"><div class="tools">${tools}</div><span class="version" title="S2 Ground ${esc(VERSION)}">S2 Ground v${esc(VERSION)}</span></div>
  </header>`);
  onAct(el, {
    goto: (b) => o.onGoto && o.onGoto(b.dataset.phase),
    lang: (b) => o.onLang && o.onLang(b.dataset.lang),
    logout: () => o.onLogout && o.onLogout(),
    tab: (b) => o.onTab && o.onTab(b.dataset.tab),
    close: () => o.onClose && o.onClose(),
    log: () => o.onLog && o.onLog(),
  });
  // Expert content is built when the menu opens, so it always shows the current link/relay state
  const details = el.querySelector('details.menu');
  if (details && o.expert) {
    const fill = () => {
      const ex = typeof o.expert === 'function' ? o.expert() : o.expert;
      details.querySelector('h3').textContent = ex.title;
      const body = details.querySelector('.body');
      body.className = `body ${ex.cls || ''}`; body.innerHTML = ex.body;
      if (ex.bind) ex.bind(body, el);
    };
    fill();
    details.addEventListener('toggle', () => { if (details.open) fill(); });
  }
  return el;
}

/**
 * Action bar: back button (previous phase), status text, [Schnellstart link], "Weiter" (level colours the button).
 * o: {back:{label}|null, status, next:{label, level, disabled}, quick:boolean, onBack, onNext}
 */
export function renderActionBar(o) {
  const lvlCls = o.next && o.next.level === 'warn' ? 'warnish' : o.next && o.next.level === 'bad' ? 'badish' : 'primary';
  const el = html(`<div class="actionbar">
    ${o.back ? `<button class="btn" type="button" data-act="back">← ${esc(o.back.label)}</button>` : '<span></span>'}
    <span class="status">${o.status || ''}</span>
    ${o.quick ? `<a class="btn q-blue" href="#quick">${esc(t('quick.btn.short'))}</a>` : ''}
    ${o.next ? `<button class="btn ${lvlCls}" type="button" data-act="next" ${o.next.disabled ? 'disabled' : ''}>${esc(o.next.label)}</button>` : ''}
  </div>`);
  onAct(el, { back: () => o.onBack && o.onBack(), next: () => o.onNext && o.onNext() });
  return el;
}

/** "Trotzdem weiter?" strip shown under the action bar when the phase is not ok. */
export function renderConfirmStrip({ level, text, onStay, onGo }) {
  const el = html(`<div class="confirm-strip ${level === 'bad' ? 'bad' : ''}">
    <strong>${esc(t('confirm.title'))}</strong>
    <span class="txt">${text}</span>
    <button class="btn" type="button" data-act="stay">${esc(t('confirm.stay'))}</button>
    <button class="btn ${level === 'bad' ? 'badish' : 'warnish'}" type="button" data-act="go">${esc(t('confirm.go'))}</button>
  </div>`);
  onAct(el, { stay: onStay, go: onGo });
  return el;
}
