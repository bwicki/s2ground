// Manual cutdown ("CUTDOWN JETZT") – ONE guarded handler for every page that offers the button
// (Aufstieg, Detailsicht, Schnellstart): confirm dialog, one command at a time, never after landing, always logged.

import { t } from '../i18n.js';
import { esc, confirmDialog, toast } from '../util/dom.js';
import { state } from '../state.js';
import { fmtInt } from '../util/format.js';

let cutBusy = false;                   // one confirm dialog / one relBal at a time (double click, repeated key)

/** `where` is only appended to the log entry (e.g. «Detailsicht», «Schnellstart»). */
export async function manualCutdown(ctx, { where = '' } = {}) {
  if (cutBusy) return;
  // After landing the hot wire must not be fired again (burns the wire for nothing, drains the battery).
  if (state.landed) { toast(t('asc.cutdownLanded'), true); return; }
  cutBusy = true;
  const suffix = where ? ` (${where})` : '';
  const agl = () => (state.last ? fmtInt(state.last.altAgl) : '?');
  try {
    // Before launch the command is a 150 ms test burn (spec §5.8) – say so explicitly in the confirm dialog.
    const text = state.launch ? t('asc.cutdownConfirm', { alt: state.last ? fmtInt(state.last.altAgl) : '–' }) : t('asc.cutdownConfirmGround');
    const ok = await confirmDialog({ title: t('asc.cutdownNow'), text: `<p>${esc(text)}</p>`, okLabel: t('asc.cutdownDo'), cancelLabel: t('common.cancel'), danger: true });
    if (!ok) return;
    if (!state.link) { toast(`${t('asc.cutdownError')}: E_PORT_CLOSED`, true); return; }
    try { const res = await state.link.cutdown(); ctx.log('cutdown.manual', `${agl()} m AGL · ${res}${suffix}`); toast(t('asc.cutdownSent')); if (!state.launch) toast(t('asc.cutdownGround')); }
    catch (e) { ctx.log('cutdown.manual', `${agl()} m AGL · FAILED ${e.message}${suffix}`); toast(`${t('asc.cutdownError')}: ${e.message}`, true); }
  } finally { cutBusy = false; }
}
