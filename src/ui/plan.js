// Phase 1 – "Aufstieg planen" (design/Planen.dc.html). Basis-Informationen on the left,
// predicted trajectory map + Ballondaten on the right, airspace warning banner with the
// three ways out (lower cutdown / shift time / move start) or a conscious "ignore".

import { t } from '../i18n.js';
import { esc, html, qs, qsa, onAct, banner, toast, copyText } from '../util/dom.js';
import { state, bus, setPhaseStatus, settings } from '../state.js';
import { fmtInt, fmtNum, icaoShort, fmtTimeUTC, fmtTimeLocal, fmtDateCH, pad2, fmtBearing } from '../util/format.js';
import * as planning from '../planning.js';
import { api } from '../api.js';
import { createMap } from './map.js';
import { openStartort } from './startort.js';
import { kmlText } from '../files.js';

let airspaceCache = null;

/** Sim wind profile that matches SimGroundLink's wind model (keeps the Soll-Ist comparison honest). */
function simProfile(groundAlt) {
  const levels = [];
  for (let alt = 0; alt <= 12000; alt += 500) {
    const agl = Math.max(0, alt - groundAlt);
    levels.push({ altM: alt, dir: (230 + agl / 100) % 360, spd: 2 + agl / 250, tC: 12.3 - 0.0065 * agl, rh: 60, hPa: 0 });
  }
  return levels;
}

/** Launch time in ms from the plan's date/time/tz fields. */
export function launchMs(plan) {
  const [y, mo, d] = plan.date.split('-').map(Number), [h, mi] = plan.time.split(':').map(Number);
  return plan.tz === 'UTC' ? Date.UTC(y, mo - 1, d, h, mi) : new Date(y, mo - 1, d, h, mi).getTime();
}

function initPlanDefaults() {
  const p = state.plan;
  if (!p.date) {
    const now = new Date(Date.now() + 20 * 60e3);
    now.setMinutes(Math.ceil(now.getMinutes() / 10) * 10, 0, 0);
    p.date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
    p.time = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  }
  const s = settings();
  if (s.riseRate && !p.riseTouched) p.riseRate = s.riseRate;
  if (s.descentRate && !p.descTouched) p.descentRate = s.descentRate;
  if (s.cutAltAgl && !p.cutTouched) p.cutAltAgl = s.cutAltAgl;
}

/**
 * Load the openAIP airspaces covering the predicted trajectory. Cached per 0.2°-quantised bbox for
 * the session. On failure the plan still works, but p.airspaceError carries the reason so the
 * banner tells the user to check DABS/NOTAM manually.
 */
async function loadAirspacesFor(points, groundAlt) {
  const p = state.plan;
  const q = 0.2, b = planning.bboxOf(points);
  const key = [Math.floor(b[0] / q) * q, Math.floor(b[1] / q) * q, Math.ceil(b[2] / q) * q, Math.ceil(b[3] / q) * q].map((v) => v.toFixed(1)).join(',');
  const cats = String(settings().airspaceCats || 'P,R,D,CTR,TMA').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
  if (!airspaceCache || airspaceCache.key !== key) {
    try {
      const res = await api.airspaces(key.split(',').map(Number));
      airspaceCache = { key, items: res.items || [], via: res.via || 'worker', generated: res.generated || null };
      p.airspaceSource = { via: airspaceCache.via, generated: airspaceCache.generated };
      p.airspaceError = null;
    } catch (e) {
      p.airspaceError = e.message || 'E_AIRSPACE';
      return null;
    }
  }
  return planning.fromOpenAip(airspaceCache.items, groundAlt, cats);
}

/** Compute (or recompute) the plan: wind profile, trajectory, airspace conflicts, lift. */
export async function runPlan() {
  const p = state.plan;
  initPlanDefaults();
  const ms = launchMs(p);
  let levels = null;
  if (state.sim) { levels = simProfile(p.start.alt); p.windSource = 'sim'; }
  else {
    levels = await planning.fetchOpenMeteo(p.start.lat, p.start.lon, ms);
    p.windSource = levels ? 'open-meteo' : 'fallback';
    if (!levels) levels = planning.fallbackProfile(settings().windFallbackDir, settings().windFallbackSpd);
  }
  const lift = planning.liftForRiseRate(p.riseRate, p.balloonG, p.payloadG);
  const burst = planning.burstAltitude(p.balloonG, lift.gasL);
  const result = planning.predict({ start: p.start, launchMs: ms, riseRate: p.riseRate, descentRate: p.descentRate, cutAltAgl: p.cutdownMode === 'alt' ? p.cutAltAgl : null, burstAltAmsl: burst, levels });
  result.levels = levels; result.lift = lift; result.burstAlt = burst; result.launchMs = ms;
  // Airspaces: live from openAIP via the Worker (sample data in the demo); cached per quantised bbox.
  const airspaces = await loadAirspacesFor(result.points, p.start.alt);
  result.conflicts = p.showAirspace && airspaces ? planning.airspaceConflicts(result.points, airspaces) : [];
  result.suggestAgl = planning.suggestCutdownAgl(result.conflicts, p.start.alt);
  result.airspaces = airspaces || [];
  result.airspaceError = p.airspaceError;
  p.result = result;
  updatePlanStatus();
  bus.emit('plan', result);
  return result;
}

export function updatePlanStatus() {
  const p = state.plan, r = p.result;
  if (!r) { setPhaseStatus('plan', 'bad', t('plan.status.none')); return; }
  if (p.cutdownMode === 'none' && !p.noCutdownConfirmed) { setPhaseStatus('plan', 'bad', t('plan.status.confirmNeeded')); return; }
  if (r.conflicts.length && !p.ignoreAirspace) { setPhaseStatus('plan', 'warn', t('plan.status.airspace')); return; }
  if (r.conflicts.length && p.ignoreAirspace) { setPhaseStatus('plan', 'warn', t('plan.status.ignored')); return; }
  if (p.showAirspace && p.airspaceError) { setPhaseStatus('plan', 'warn', t('plan.status.noAirspace')); return; }
  setPhaseStatus('plan', 'ok', t('plan.status.ok'));
}

export function planExpert() {
  const p = state.plan;
  return {
    title: t('plan.expert.title'), cls: 'cols4',
    body: `<label class="f">${esc(t('plan.expert.rise'))}<input class="in mono" name="riseRate" type="number" step="0.1" min="0.5" max="8" value="${p.riseRate}"></label>
      <label class="f">${esc(t('plan.expert.descent'))}<input class="in mono" name="descentRate" type="number" step="0.5" min="2" max="15" value="${p.descentRate}"></label>
      <label class="f">${esc(t('plan.expert.model'))}<input class="in" name="model" type="text" value="${esc(p.model)}" readonly></label>
      <label class="f">${esc(t('plan.expert.payload'))}<input class="in mono" name="payloadG" type="number" step="1" min="5" max="500" value="${p.payloadG}"></label>
      <label class="f">${esc(t('plan.expert.airspace'))}<select class="in" name="showAirspace"><option value="1" ${p.showAirspace ? 'selected' : ''}>${esc(t('common.on'))} · openAIP (Beispiel)</option><option value="0" ${!p.showAirspace ? 'selected' : ''}>${esc(t('common.off'))}</option></select></label>
      <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap"><button class="btn" type="button" data-act="kml">KML</button><button class="btn" type="button" data-act="json">JSON</button><button class="btn" type="button" data-act="link">Link</button><button class="btn" type="button" data-act="print">${esc(t('common.print'))}</button></div>`,
    bind(panel) {
      panel.addEventListener('change', (e) => {
        const n = e.target.name; if (!n) return;
        if (n === 'showAirspace') p.showAirspace = e.target.value === '1';
        else if (n === 'model') p.model = e.target.value;
        else { p[n] = Number(e.target.value); if (n === 'riseRate') p.riseTouched = true; if (n === 'descentRate') p.descTouched = true; }
        runPlan();
      });
      onAct(panel, {
        kml: () => { const r = p.result; if (!r) return; download('plan.kml', kmlText(r.points.map((x) => ({ ...x, t: r.launchMs + x.t * 1000 })), { name: 'S2 Ground Plan', groundAlt: p.start.alt }), 'application/vnd.google-earth.kml+xml'); },
        json: () => download('plan.json', JSON.stringify({ plan: { ...p, result: undefined }, result: p.result }, null, 1), 'application/json'),
        link: async () => { const u = new URL(location.href); u.searchParams.set('plan', btoa(JSON.stringify({ start: p.start, date: p.date, time: p.time, tz: p.tz, cutAltAgl: p.cutAltAgl, cutdownMode: p.cutdownMode }))); toast((await copyText(u.toString())) ? t('common.copied') : u.toString()); },
        print: () => window.print(),
      });
    },
  };
}
function download(name, text, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
}

export function mountPlan(root, ctx) {
  initPlanDefaults();
  const p = state.plan;
  const el = html(`<main class="page">
    <div class="bannerbox"></div>
    <div class="row-wrap">
      <section class="card" style="flex:1 1 320px;max-width:400px">
        <h2>${esc(t('plan.basics'))}</h2>
        <div style="display:flex;flex-direction:column;gap:6px;font-size:14px;color:var(--muted);font-weight:500">${esc(t('plan.start'))}
          <div class="seg"><button type="button" data-act="startRr4" class="${p.start.source === 'rr4' ? 'on' : ''}">${esc(t('plan.startRr4'))}</button><button type="button" data-act="startMap" class="${p.start.source === 'map' ? 'on' : ''}">${esc(t('plan.startMap'))}</button></div>
          <input class="in" type="text" data-f="start" readonly aria-label="${esc(t('plan.start'))}">
          <span class="hint" style="font-size:12px;font-weight:400" data-f="startHint"></span>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;font-size:14px;color:var(--muted);font-weight:500">${esc(t('plan.launchTime'))}
          <div style="display:flex;gap:8px;align-items:stretch;flex-wrap:wrap">
            <input class="in mono" type="date" name="date" value="${p.date}" aria-label="${esc(t('plan.date'))}" style="flex:1 1 150px">
            <div class="stepper"><button type="button" data-act="tMinus" aria-label="−10 min">−</button><input class="in mono" name="time" type="text" value="${p.time}" aria-label="${esc(t('plan.timeLabel'))}"><button type="button" data-act="tPlus" aria-label="+10 min">+</button></div>
            <div class="seg" style="width:120px" aria-label="${esc(t('plan.tz'))}"><button type="button" data-act="tz" data-tz="LT" class="${p.tz === 'LT' ? 'on' : ''}">LT</button><button type="button" data-act="tz" data-tz="UTC" class="${p.tz === 'UTC' ? 'on' : ''}">UTC</button></div>
          </div>
          <span style="font-size:12px;font-weight:400" data-f="timeHint"></span>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;font-size:14px;color:var(--muted);font-weight:500">Cutdown
          <div class="seg"><button type="button" data-act="cutMode" data-m="alt" class="${p.cutdownMode === 'alt' ? 'on' : ''}">${esc(t('plan.cutAlt'))}</button><button type="button" data-act="cutMode" data-m="none" class="${p.cutdownMode === 'none' ? 'on' : ''}">${esc(t('plan.noCut'))}</button></div>
          <input class="in mono bigin" name="cutAltAgl" type="number" step="100" min="200" max="12000" value="${p.cutAltAgl}" aria-label="${esc(t('plan.cutAltLabel'))}" ${p.cutdownMode === 'none' ? 'disabled' : ''}>
          <div class="dashed nocut ${p.cutdownMode === 'none' ? '' : 'hidden'}">
            <span class="k">${esc(t('plan.noCutTitle'))}</span>
            <div style="font-size:14px;line-height:1.45;color:var(--text)" data-f="burstText"></div>
            <label class="chk" style="color:var(--text)"><input type="checkbox" name="noCutConfirm" ${p.noCutdownConfirmed ? 'checked' : ''}><span data-f="confirmText"></span></label>
            <span class="muted" style="font-size:12px">${esc(t('plan.noCutLocked'))}</span>
          </div>
        </div>
        <label class="f">${esc(t('plan.opMode'))}
          <div class="seg"><button type="button" data-act="opMode" data-m="ascent" class="${p.opMode === 'ascent' ? 'on' : ''}">${esc(t('plan.opAscent'))}</button><button type="button" data-act="opMode" data-m="drop" class="${p.opMode === 'drop' ? 'on' : ''}">${esc(t('plan.opDrop'))}</button></div>
        </label>
        <button class="btn primary big" type="button" data-act="recompute">${esc(t('plan.recompute'))}</button>
        <p class="muted" style="margin:0;font-size:13px" data-f="srcNote"></p>
      </section>
      <div class="col" style="flex:999 1 520px">
        <section class="card tight">
          <div class="card-head"><h2>${esc(t('plan.trajTitle'))}</h2><span class="muted small">${esc(t('plan.mapNote'))}</span></div>
          <div class="mapbox tall" style="border-radius:8px;overflow:hidden"></div>
          <div class="stats">
            <div class="stat"><div class="k">${esc(t('plan.landing'))}</div><div class="val" data-f="landing">–</div></div>
            <div class="stat"><div class="k">${esc(t('plan.maxAlt'))}</div><div class="val" data-f="maxAlt">–</div></div>
            <div class="stat"><div class="k">${esc(t('phase.ascent'))}</div><div class="val" data-f="ascentMin">–</div></div>
            <div class="stat"><div class="k">${esc(t('plan.total'))}</div><div class="val" data-f="totalMin">–</div></div>
            <div class="stat"><div class="k">${esc(t('plan.airspace'))}</div><div class="val" data-f="airspace">–</div><div class="muted small" data-f="airspaceSrc"></div></div>
          </div>
        </section>
        <section class="card">
          <h2>${esc(t('plan.balloon'))}</h2>
          <div class="stats3" style="align-items:start">
            <label class="f">${esc(t('plan.balloonType'))}<select class="in" name="balloonType"><option ${p.balloonG === 9 ? 'selected' : ''} value="9">Latex 9 g (Standard)</option><option ${p.balloonG === 30 ? 'selected' : ''} value="30">Latex 30 g</option><option ${p.balloonG === 100 ? 'selected' : ''} value="100">Latex 100 g</option></select></label>
            <label class="f">${esc(t('plan.gas'))}<select class="in" name="gas"><option>Ballongas (Linde)</option><option>Helium 4.6</option><option>Wasserstoff</option></select></label>
            <div class="infobox"><span class="k">${esc(t('plan.grossLift'))}</span><span class="val big" data-f="gross">–</span><span class="muted" style="font-size:12px" data-f="liftNote"></span></div>
          </div>
        </section>
      </div>
    </div>
  </main>`);
  root.replaceChildren(el);
  const mapEl = qs(el, '.mapbox');
  const map = createMap(mapEl, { center: [p.start.lat, p.start.lon], zoom: 11 });

  const f = (k) => qs(el, `[data-f=${k}]`);
  const refreshForm = () => {
    f('start').value = `${icaoShort(p.start.lat, p.start.lon)} · ${fmtInt(p.start.alt)} m AMSL · ${p.start.name || ''}`;
    f('startHint').textContent = p.start.source === 'rr4' ? t('plan.startHintRr4', { sats: state.linkState.receiver ? state.linkState.receiver.sats ?? '–' : '–' }) : t('plan.startHintMap');
    const ms = launchMs(p);
    f('timeHint').textContent = t('plan.timeHint', { utc: fmtTimeUTC(ms), lt: fmtTimeLocal(ms), date: fmtDateCH(ms) });
    qs(el, '[name=time]').value = p.time;
    qsa(el, '[data-act=tz]').forEach((b) => b.classList.toggle('on', b.dataset.tz === p.tz));
    qsa(el, '[data-act=cutMode]').forEach((b) => b.classList.toggle('on', b.dataset.m === p.cutdownMode));
    qs(el, '[name=cutAltAgl]').disabled = p.cutdownMode === 'none';
    qs(el, '.nocut').classList.toggle('hidden', p.cutdownMode !== 'none');
    qsa(el, '[data-act=opMode]').forEach((b) => b.classList.toggle('on', b.dataset.m === p.opMode));
    f('srcNote').textContent = t('plan.srcNote', { src: p.windSource === 'open-meteo' ? 'Open-Meteo «Best match»' : p.windSource === 'sim' ? t('plan.srcSim') : t('plan.srcFallback'), rise: fmtNum(p.riseRate, 1) });
  };
  const refreshResult = () => {
    const r = p.result; if (!r) return;
    f('srcNote').textContent = t('plan.srcNote', { src: p.windSource === 'open-meteo' ? 'Open-Meteo «Best match»' : p.windSource === 'sim' ? t('plan.srcSim') : t('plan.srcFallback'), rise: fmtNum(p.riseRate, 1) });
    f('landing').textContent = `${fmtNum(r.distanceM / 1000, 1)} km · ${fmtBearing(r.bearing)}`;
    f('maxAlt').textContent = `${fmtInt(r.maxAlt)} m AMSL`;
    f('ascentMin').textContent = `${Math.round(r.ascentS / 60)} min`;
    f('totalMin').textContent = `${Math.round(r.totalS / 60)} min`;
    const as = f('airspace'); as.textContent = r.conflicts.length ? t('plan.conflict') : t('plan.noConflict'); as.style.color = r.conflicts.length ? 'var(--red)' : 'var(--green)';
    // where the airspace data came from: nightly export (with its date) or the live API – the lay user sees the data's age
    const src = p.airspaceSource; const asrc = f('airspaceSrc');
    if (asrc) asrc.textContent = !p.showAirspace || p.airspaceError || !src ? '' : src.via === 'export' && src.generated ? t('plan.airspace.srcExport', { d: fmtDateCH(new Date(src.generated)) }) : t('plan.airspace.srcLive');
    f('gross').textContent = `≈ ${fmtInt(r.lift.grossLiftG)} g`;
    f('liftNote').textContent = t('plan.liftNote', { rise: fmtNum(p.riseRate, 1), gas: fmtInt(r.lift.gasL), payload: p.payloadG, net: fmtInt(r.lift.netLiftG) });
    f('burstText').innerHTML = t('plan.burstText', { alt: `<strong class="mono">≈ ${fmtInt(r.burstAlt)} m AMSL</strong>` });
    f('confirmText').textContent = t('plan.noCutConfirm', { alt: fmtInt(r.burstAlt) });
    if (map) {
      map.setPlan(r.points);
      map.setAirspaces(r.airspaces, p.showAirspace);
      map.setStart(p.start.lat, p.start.lon, `Start ${fmtTimeUTC(r.launchMs)}`);
      map.setCutdown(r.cutdown.lat, r.cutdown.lon, `${r.cutdown.kind === 'burst' ? t('plan.burst') : 'Cutdown'} ${fmtInt(r.cutdown.alt - p.start.alt)} m AGL · ${fmtTimeUTC(r.cutdown.ms)}`);
      map.setLanding(r.landing.lat, r.landing.lon, `${t('plan.landingAt')} ${fmtTimeUTC(r.landing.ms)}`);
      map.fitAll();
    }
    renderBanner();
  };
  const renderBanner = () => {
    const r = p.result, box = qs(el, '.bannerbox');
    if (!r) { box.innerHTML = banner({ level: 'info', title: t('plan.banner.computing') }); return; }
    if (p.cutdownMode === 'none' && !p.noCutdownConfirmed) { box.innerHTML = banner({ level: 'bad', title: t('plan.banner.confirmTitle'), sub: t('plan.banner.confirmSub') }); return; }
    if (r.conflicts.length) {
      const c = r.conflicts[0];
      const steps = [];
      if (r.suggestAgl && !p.ignoreAirspace) steps.push(t('plan.fix1', { alt: `<strong>${fmtInt(r.suggestAgl)} m ${t('unit.agl')}</strong>` }));
      steps.push(t('plan.fix2'), t('plan.fix3'), `<strong>${esc(t('plan.fix4a'))}</strong> ${esc(t('plan.fix4b'))}`);
      const side = p.ignoreAirspace ? `<span class="pill"><span class="dot y"></span>${esc(t('plan.ignored'))}</span>` : `${r.suggestAgl ? `<button class="btn" type="button" data-act="suggest">${esc(t('plan.applySuggestion'))}</button>` : ''}<button class="btn warnish" type="button" data-act="ignore">${esc(t('plan.ignoreWarning'))}</button>`;
      box.innerHTML = banner({ level: 'warn', title: t('plan.banner.conflict', { name: esc(c.airspace.name), alt: fmtInt(c.altEnter) }), intro: t('plan.whatYouCanDo'), steps, side });
      return;
    }
    if (p.showAirspace && p.airspaceError) {
      // The Worker appends what openAIP answered, e.g. "E_OPENAIP_KEY_REJECTED (openAIP 401: …)" – shown so the master can see why.
      const err = String(p.airspaceError || '');
      const detail = (err.match(/\((.*)\)\s*$/) || [])[1];
      const why = (err.startsWith('E_NO_OPENAIP_KEY') ? t('plan.airspace.noKey') : err.startsWith('E_OPENAIP_KEY_REJECTED') ? t('plan.airspace.badKey') : t('plan.airspace.unreachable')) + (detail ? ` [${detail}]` : '');
      box.innerHTML = banner({ level: 'warn', title: t('plan.banner.noAirspaceTitle'), intro: why, steps: [t('plan.airspace.step1'), t('plan.airspace.step2')], side: `<button class="btn" type="button" data-act="recompute">${esc(t('plan.airspace.retry'))}</button>` });
      return;
    }
    box.innerHTML = banner({ level: 'ok', title: t('plan.banner.ok'), sub: t('plan.banner.okSub', { dist: fmtNum(r.distanceM / 1000, 1), brg: fmtBearing(r.bearing), min: Math.round(r.totalS / 60) }) });
  };

  const shiftTime = (min) => {
    const [h, m] = p.time.split(':').map(Number);
    let tot = (h * 60 + m + min + 1440) % 1440;
    p.time = `${pad2(Math.floor(tot / 60))}:${pad2(tot % 60)}`;
    refreshForm(); runPlan();
  };
  onAct(el, {
    recompute: () => runPlan().then(() => toast(t('plan.recomputed'))),
    tMinus: () => shiftTime(-10), tPlus: () => shiftTime(10),
    tz: (b) => { p.tz = b.dataset.tz; refreshForm(); runPlan(); },
    cutMode: (b) => { p.cutdownMode = b.dataset.m; refreshForm(); runPlan(); },
    opMode: (b) => { p.opMode = b.dataset.m; refreshForm(); },
    startRr4: () => { const rx = state.linkState.receiver; if (rx && rx.lat) p.start = { lat: rx.lat, lon: rx.lon, alt: rx.alt ?? p.start.alt, name: p.start.name, source: 'rr4' }; else p.start.source = 'rr4'; refreshForm(); runPlan(); },
    startMap: async () => { const r = await openStartort(p.start, state.device); if (r) { p.start = r; p.start.name = r.name || p.start.name; refreshForm(); runPlan(); } },
    suggest: () => { if (p.result && p.result.suggestAgl) { p.cutAltAgl = p.result.suggestAgl; p.cutTouched = true; p.cutdownMode = 'alt'; qs(el, '[name=cutAltAgl]').value = p.cutAltAgl; refreshForm(); runPlan(); ctx.log('plan.suggestApplied', `Cutdown ${p.cutAltAgl} m AGL`); } },
    ignore: () => { p.ignoreAirspace = true; updatePlanStatus(); renderBanner(); ctx.log('plan.airspaceIgnored', p.result.conflicts.map((c) => c.airspace.id).join(', ')); },
  });
  el.addEventListener('change', (e) => {
    const n = e.target.name;
    if (n === 'date') { p.date = e.target.value; refreshForm(); runPlan(); }
    else if (n === 'time') { const m = /^(\d{1,2}):(\d{2})$/.exec(e.target.value.trim()); if (m) { p.time = `${pad2(+m[1] % 24)}:${pad2(Math.floor(+m[2] / 10) * 10 % 60)}`; } refreshForm(); runPlan(); }
    else if (n === 'cutAltAgl') { p.cutAltAgl = Math.max(100, Math.round(Number(e.target.value) / 100) * 100); p.cutTouched = true; e.target.value = p.cutAltAgl; p.ignoreAirspace = false; runPlan(); }
    else if (n === 'noCutConfirm') { p.noCutdownConfirmed = e.target.checked; updatePlanStatus(); renderBanner(); }
    else if (n === 'balloonType') { p.balloonG = Number(e.target.value); p.balloonType = e.target.selectedOptions[0].textContent; runPlan(); }
    else if (n === 'gas') { p.gas = e.target.value; }
  });
  const offPlan = bus.on('plan', refreshResult);
  refreshForm();
  if (p.result) refreshResult(); else { renderBanner(); runPlan(); }
  return { destroy() { offPlan(); if (map) map.destroy(); el.remove(); }, expert: () => planExpert() };
}
