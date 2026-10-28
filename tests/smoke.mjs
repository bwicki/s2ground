// Playwright smoke test through the whole flow in simulation mode (no Worker needed):
// login → plan → prepare → checks → ascent → detail → retrieve → admin, then the Schnellstart (#quick) pass, with screenshots.
// Run: node tests/smoke.mjs   (env PLAYWRIGHT_MODULE=/path/to/playwright, PLAYWRIGHT_BROWSERS_PATH)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(new URL('..', import.meta.url).pathname);
const shots = path.resolve(new URL('./shots', import.meta.url).pathname);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

// tiny static server for the repo root (GitHub Pages serves the same layout)
const server = http.createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  try { const data = await readFile(path.join(root, p)); res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' }); res.end(data); }
  catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 980 } });
const errors = [];
const track = (pg) => {
  pg.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  pg.on('console', (m) => { if (m.type() === 'error' && !/net::ERR|Failed to load resource|ERR_TUNNEL|403/.test(m.text())) errors.push(`console: ${m.text()}`); });
};
track(page);
const shot = (name) => page.screenshot({ path: path.join(shots, name), fullPage: true });
const step = (s) => console.log(`» ${s}`);
let qp;                                                  // the Schnellstart page (second pass)

try {
  step('login page');
  await page.goto(`${base}/?sim=1&speed=20&fast=1#login`);
  await page.waitForSelector('form.login');
  await shot('01-login.png');
  await page.click('form.login button[type=submit]');
  await page.waitForSelector('.actionbar', { timeout: 10000 });

  step('plan: small «Sonde sofort hier starten» button in the action bar');
  const smallQuick = await page.getAttribute('.actionbar a.q-blue', 'href');
  if (smallQuick !== '#quick') throw new Error(`quick button in the plan action bar: ${smallQuick}`);

  step('plan: airspace warning + suggestion');
  await page.waitForSelector('.banner.warn', { timeout: 15000 });
  await shot('02-plan-warning.png');
  await page.click('[data-act=suggest]');
  await page.waitForSelector('.banner.ok', { timeout: 10000 });
  await shot('02b-plan-ok.png');
  step('plan: Startort dialog');
  await page.click('[data-act=startMap]');
  await page.waitForSelector('.modal');
  await shot('03-startort.png');
  await page.click('.modal [data-act=cancel]');
  step('plan: expert menu');
  await page.click('details.menu > summary');
  await shot('02c-plan-menu.png');
  await page.click('details.menu > summary');

  step('prepare');
  await page.click('.actionbar [data-act=next]');
  await page.waitForURL(/#prepare/);
  await page.waitForSelector('[data-act=balloon]');
  await page.waitForFunction(() => /Zurückgelesen/.test(document.querySelector('.written').textContent), null, { timeout: 20000 });
  await page.click('[data-act=balloon]');
  await page.waitForSelector('.banner.ok', { timeout: 10000 });
  step('prepare: WhatsApp notify card (stage 1) + connected observers with kick');
  await page.waitForSelector('[data-act=notify]');
  const wa = await page.getAttribute('[data-act=notify]', 'href');
  if (!wa.startsWith('https://wa.me/41790000001?text=Sondenaufstieg')) throw new Error(`wa.me url: ${wa}`);
  await page.waitForSelector('.obs [data-act=kick]', { timeout: 15000 });
  await shot('04-prepare.png');
  const before = await page.locator('.obs [data-act=kick]').count();
  await page.click('.obs [data-act=kick]');
  await page.waitForSelector('.modal');
  await page.waitForTimeout(500);                       // danger dialog ignores clicks in the first 400 ms
  await page.click('.modal [data-act=ok]');
  await page.waitForFunction((n) => document.querySelectorAll('.obs [data-act=kick]').length < n, before, { timeout: 5000 });
  await page.click('details.menu > summary');
  await shot('04b-prepare-menu.png');
  await page.click('details.menu > summary');

  step('checks');
  await page.click('.actionbar [data-act=next]');
  await page.waitForURL(/#checks/);
  await page.waitForSelector('.ck');
  await shot('05a-checks-open.png');
  await page.waitForSelector('.ck button[data-act=wire]:not([disabled])', { timeout: 20000 });
  await page.click('.ck button[data-act=wire]');
  await page.waitForFunction(() => !document.querySelector('[data-act=release]').disabled, null, { timeout: 60000 });
  await shot('05-checks-ready.png');
  step('"Trotzdem weiter?" strip is shown when a phase is not ok (go back to plan, break it)');

  step('release + ascent');
  await page.click('[data-act=release]');
  await page.waitForURL(/#ascent/);
  await page.waitForFunction(() => /seit/.test((document.querySelector('.bannerbox') || {}).textContent || ''), null, { timeout: 60000 });
  await page.waitForTimeout(6000);
  await shot('06-ascent.png');
  await page.click('details.menu > summary');
  await shot('06b-ascent-menu.png');
  await page.click('details.menu > summary');

  step('detail views');
  await page.goto(`${base}/?sim=1&speed=20&fast=1#detail/map`);
  await page.waitForSelector('.viewer-big');
  await page.waitForTimeout(1500);
  await shot('07-detail-map.png');
  await page.click('[data-act=tab][data-tab=vertical]');
  await page.waitForTimeout(800);
  await shot('07b-detail-vertical.png');
  await page.click('[data-act=tab][data-tab=stueve]');
  await page.waitForTimeout(800);
  await shot('07c-detail-stueve.png');
  await page.click('[data-act=close]');
  await page.waitForURL(/#ascent/);

  step('chat quick reply');
  await page.click('.chat [data-act=quick]');
  await page.waitForFunction(() => document.querySelectorAll('.chat .msg').length >= 2, null, { timeout: 10000 });

  step('wait for cutdown + landing');
  await page.waitForFunction(() => /Cutdown ausgelöst|gelandet/i.test(document.querySelector('.bannerbox').textContent), null, { timeout: 120000 });
  await shot('06c-ascent-descent.png');
  await page.waitForFunction(() => /gelandet/i.test(document.querySelector('.bannerbox').textContent), null, { timeout: 120000 });
  await shot('06d-ascent-landed.png');

  step('retrieve');
  await page.click('.actionbar [data-act=next]');
  await page.waitForURL(/#retrieve/);
  await page.waitForSelector('[data-f=pos]');
  await page.waitForTimeout(1500);
  await shot('08-retrieve.png');
  const pos = await page.textContent('[data-f=pos]');
  if (!/^\d{6}N\d{7}E$/.test(pos.trim())) throw new Error(`position not ICAO: ${pos}`);
  const nav = await page.getAttribute('[data-act=nav]', 'href');
  if (!nav.startsWith('https://www.google.com/maps/dir/?api=1&destination=')) throw new Error(`nav url: ${nav}`);

  step('admin: users (master switch) + observer codes');
  await page.goto(`${base}/?sim=1&speed=20&fast=1#admin`);
  await page.waitForSelector('.observers table');
  await page.fill('.addobs [name=label]', 'Testbeobachter');
  await page.fill('.addobs [name=mobile]', '+41 79 555 66 77');
  await page.click('.addobs button[type=submit]');
  await page.waitForSelector('.code-big');
  const code = (await page.textContent('.code-big')).trim();
  if (!/^[2-9A-HJ-NP-Z]{6}$/.test(code)) throw new Error(`observer code: ${code}`);
  await shot('09b-admin-observer-code.png');
  await page.click('.modal [data-act=close]');
  await page.click('.observers [data-act=history]');
  await page.waitForSelector('.hist-box table');
  await page.waitForTimeout(300);
  await shot('09-admin.png');

  step('EN + "Trotzdem weiter?" dialog');
  await page.goto(`${base}/?sim=1&speed=20&fast=1#plan`);
  await page.waitForSelector('.actionbar');
  await page.click('[data-act=lang][data-lang=en]');
  await page.waitForTimeout(500);
  await shot('10-plan-en.png');
  await page.click('[data-act=lang][data-lang=de]');
  await page.waitForTimeout(300);
  await page.click('[data-act=startMap]'); await page.click('.modal [data-act=cancel]');
  // break the plan: cutdown back to 1900 m → warning → Weiter shows the confirm strip
  await page.fill('[name=cutAltAgl]', '1900'); await page.press('[name=cutAltAgl]', 'Tab');
  await page.waitForSelector('.banner.warn', { timeout: 10000 });
  await page.click('.actionbar [data-act=next]');
  await page.waitForSelector('.confirm-strip');
  await shot('11-trotzdem-weiter.png');
  step('warning consciously ignored → Weiter goes on without a second confirmation');
  await page.click('.confirm-strip [data-act=stay]');
  await page.click('[data-act=ignore]');
  await page.waitForFunction(() => /ignoriert/.test(document.querySelector('.actionbar .status').textContent), null, { timeout: 5000 });
  await page.click('.actionbar [data-act=next]');
  await page.waitForURL(/#prepare/, { timeout: 5000 });
  if (await page.$('.confirm-strip')) throw new Error('no confirm strip expected after an ignored warning');

  // ---------------------------------------------------------------------------------------------------------------
  // Schnellstart: login via the amber button → step 1/2 → stepper → PROGRAMMIEREN & FREIGEBEN → BEREIT → live → cutdown → landed
  // ---------------------------------------------------------------------------------------------------------------
  step('quick start: the login page has NO shortcut – login first, then the blue button in step 1');
  qp = await browser.newPage({ viewport: { width: 1280, height: 980 } });
  track(qp);
  const qshot = (name) => qp.screenshot({ path: path.join(shots, name), fullPage: true });
  const qtext = (sel) => qp.textContent(sel, { timeout: 2000 }).catch(() => null);
  await qp.goto(`${base}/?sim=1&speed=5&fast=1#quick`);           // deep link without a session → login page
  await qp.waitForSelector('form.login');
  if (await qp.$('form.login [data-act=quick]')) throw new Error('the login page must not offer the quick start');
  await qshot('12-quick-0-login.png');
  await qp.click('form.login button[type=submit]');
  await qp.waitForURL(/#plan/);                                     // never straight to #quick
  await qp.waitForSelector('.actionbar a.q-blue');
  await qp.click('.actionbar a.q-blue');
  await qp.waitForURL(/#quick/);
  await qp.waitForSelector('.q-step');

  step('quick start: minimal header (pill, link to full planning, no phase bar), steps 1 and 2');
  if (await qp.$('header.top nav.phases')) throw new Error('quick page must not show the phase bar');
  if (!/ohne Planung/.test(await qp.textContent('header.top .pill.amber'))) throw new Error('quick pill missing');
  if ((await qp.getAttribute('header.top .qmid a[href="#plan"]', 'href')) !== '#plan') throw new Error('«vollständig planen» link missing');
  await qp.waitForFunction(() => /RR4/.test(document.querySelector('[data-f=s1]').textContent) && /verbunden/.test(document.querySelector('[data-f=s1]').textContent) && /Nr\./.test(document.querySelector('[data-f=s1]').textContent), null, { timeout: 20000 });
  await qp.waitForFunction(() => /\d{6}N\d{7}E/.test(document.querySelector('[data-f=start]').textContent), null, { timeout: 20000 });
  const startTxt = await qtext('[data-f=start]');
  if (!/m\s*AMSL/.test(startTxt) || !/hier/.test(startTxt)) throw new Error(`start line: ${startTxt}`);
  if (((await qtext('[data-f=cut]')) || '').trim() !== "3'000") throw new Error(`default cutdown altitude: ${await qtext('[data-f=cut]')}`);
  await qp.waitForSelector('[data-act=applySuggest]', { timeout: 20000 });        // 3'000 m AGL runs into the LS-R12 sample airspace
  await qshot('12-quick-1-start.png');

  step('quick start: open airspace conflict is asked again at the start button, going back keeps everything untouched');
  await qp.waitForFunction(() => !document.querySelector('[data-act=go]').disabled, null, { timeout: 20000 });
  await qp.click('[data-act=go]');
  await qp.waitForSelector('.modal');
  if (!/LS-R12/.test(await qp.textContent('.modal'))) throw new Error('conflict dialog should name the airspace');
  await qshot('12-quick-1b-conflict-dialog.png');
  await qp.click('.modal [data-act=cancel]');
  await qp.waitForSelector('.modal', { state: 'detached' });
  if (await qp.$('[data-f=status] .q-status')) throw new Error('nothing may start after «zurück»');

  step('quick start: cutdown stepper (+500 / −500) and automatic airspace check');
  await qp.click('[data-act=applySuggest]');
  await qp.waitForFunction(() => document.querySelector('[data-f=cut]').textContent.trim() === "1'500" && /kein Konflikt/.test(document.querySelector('[data-f=air]').textContent), null, { timeout: 20000 });
  await qp.click('[data-act=cutPlus]');
  if (((await qtext('[data-f=cut]')) || '').trim() !== "2'000") throw new Error('+500 should give 2\'000 m AGL');
  await qp.waitForSelector('[data-act=applySuggest]', { timeout: 20000 });         // 2'000 m AGL conflicts again → suggestion
  await qp.click('[data-act=cutMinus]');
  if (((await qtext('[data-f=cut]')) || '').trim() !== "1'500") throw new Error('−500 should give 1\'500 m AGL');
  await qp.waitForFunction(() => /kein Konflikt/.test(document.querySelector('[data-f=air]').textContent), null, { timeout: 20000 });
  await qshot('12-quick-2-ready-to-start.png');

  step('quick start: SONDE PROGRAMMIEREN & FREIGEBEN → WARTEN → BEREIT (release by itself)');
  await qp.click('[data-act=go]');
  await qp.waitForFunction(() => /WARTEN/.test((document.querySelector('[data-f=status]') || {}).textContent || ''), null, { timeout: 20000, polling: 100 });
  await qshot('12-quick-3-warten.png');
  await qp.waitForFunction(() => /BEREIT/.test((document.querySelector('[data-f=status]') || {}).textContent || ''), null, { timeout: 60000, polling: 50 });
  await qshot('12-quick-4-bereit.png');

  step('quick start: the launch switches the page to the live state (banner + three tiles)');
  await qp.waitForSelector('.q-tiles .q-tile', { timeout: 60000 });
  await qp.waitForFunction(() => document.querySelectorAll('.q-tiles .q-tile').length === 3 && /OK/.test(document.querySelector('[data-f=banner]').textContent) && parseInt(document.querySelector('.q-tile .v').textContent.replace(/[^0-9]/g, ''), 10) > 150, null, { timeout: 90000 });
  const tiles = await qp.locator('.q-tile').allTextContents();
  if (!/AGL/.test(tiles[0]) || !/AMSL/.test(tiles[0])) throw new Error(`tile 1: ${tiles[0]}`);
  if (!/m\/s/.test(tiles[1])) throw new Error(`tile 2: ${tiles[1]}`);
  if (!/Funk/.test(tiles[2]) || !/Cutdown/i.test(tiles[2])) throw new Error(`tile 3: ${tiles[2]}`);
  if (!/1'500 m über Grund/.test(await qtext('[data-f=banner]'))) throw new Error('banner should name the programmed cutdown altitude');
  await qshot('12-quick-5-live.png');

  step('quick start: «Vollständige Ansicht» shows the same ascent, and back');
  await qp.click('header.top a[href="#ascent"]');
  await qp.waitForURL(/#ascent/);
  await qp.waitForSelector('.bannerbox');
  await qp.waitForFunction(() => /seit/.test(document.querySelector('.bannerbox').textContent), null, { timeout: 30000 });
  await qp.evaluate(() => { location.hash = '#quick'; });
  await qp.waitForSelector('.q-tiles .q-tile');

  step('quick start: CUTDOWN JETZT on the quick page (confirm dialog), descent, landed → retrieval block');
  await qp.click('[data-act=cutdown]');
  await qp.waitForSelector('.modal');
  if (!/Cutdown/.test(await qp.textContent('.modal'))) throw new Error('cutdown confirm dialog');
  await qshot('12-quick-6-cutdown-confirm.png');
  await qp.waitForTimeout(500);                         // danger dialog ignores clicks in the first 400 ms
  await qp.click('.modal [data-act=ok]');
  await qp.waitForFunction(() => /Cutdown ausgelöst/.test(document.querySelector('[data-f=banner]').textContent), null, { timeout: 30000 });
  await qshot('12-quick-7-descent.png');
  await qp.waitForSelector('[data-f=banner] a[data-act=nav]', { timeout: 150000 });
  await qp.waitForTimeout(1200);
  const banner = await qtext('[data-f=banner]');
  if (!/gelandet/.test(banner) || !/\d{6}N\d{7}E/.test(banner)) throw new Error(`landed banner: ${banner}`);
  const qnav = await qp.getAttribute('[data-f=banner] a[data-act=nav]', 'href');
  if (!qnav.startsWith('https://www.google.com/maps/dir/?api=1&destination=')) throw new Error(`quick nav url: ${qnav}`);
  if (!(await qp.$('[data-f=banner] .q-qr'))) throw new Error('QR block missing');
  if (await qp.$('[data-act=cutdown]:not(.hidden)') && await qp.isVisible('[data-act=cutdown]')) throw new Error('CUTDOWN JETZT must be gone after landing');
  await qshot('12-quick-8-landed.png');

  step('quick start: archive → ready for the next sonde (step 1/2 again)');
  await qp.click('[data-act=archive]');
  await qp.waitForSelector('.modal');
  await qp.waitForTimeout(500);
  await qp.click('.modal [data-act=ok]');
  await qp.waitForSelector('.q-step', { timeout: 20000 });
  await qp.waitForFunction(() => !document.querySelector('.q-tiles') && /RR4/.test(document.querySelector('[data-f=s1]').textContent), null, { timeout: 20000 });
  await qshot('12-quick-9-after-archive.png');

  step('quick start: English');
  await qp.evaluate(() => localStorage.setItem('s2ground.lang', 'en'));
  await qp.reload();                                    // the simulation keeps no session over a reload → login page, now in English
  await qp.waitForSelector('form.login button[type=submit]');
  if (await qp.$('form.login [data-act=quick]')) throw new Error('the login page must not offer the quick start (EN)');
  await qshot('12-quick-10-login-en.png');
  await qp.click('form.login button[type=submit]');
  await qp.waitForSelector('.actionbar a.q-blue', { timeout: 20000 });
  if (!/Start the sonde right here/.test(await qp.textContent('.actionbar a.q-blue'))) throw new Error('EN quick button in the action bar');
  await qp.click('.actionbar a.q-blue');
  await qp.waitForSelector('.q-step', { timeout: 20000 });
  await qp.waitForFunction(() => /Start the sonde right here/.test(document.querySelector('h1, .q-page h1') ? document.querySelector('h1, .q-page h1').textContent : ''), null, { timeout: 10000 });
  if (!/PROGRAM SONDE & RELEASE/.test(await qp.textContent('[data-act=go]'))) throw new Error('EN start button');
  await qp.waitForFunction(() => /connected/.test(document.querySelector('[data-f=s1]').textContent) && /here/.test(document.querySelector('[data-f=start]').textContent) && /receiver/.test(document.querySelector('[data-f=start]').textContent) && !/no fix yet/.test(document.querySelector('[data-f=start]').textContent), null, { timeout: 20000 });
  await qshot('12-quick-11-en.png');
  await qp.evaluate(() => localStorage.setItem('s2ground.lang', 'de'));
  await qp.close();

  if (errors.length) { console.log('JS errors:\n' + errors.join('\n')); process.exitCode = 1; }
  else console.log('smoke OK – screenshots in', shots);
} catch (e) {
  console.error('SMOKE FAILED:', e.message);
  await shot('ZZ-failure.png').catch(() => {});
  if (qp) await qp.screenshot({ path: path.join(shots, 'ZZ-failure-quick.png'), fullPage: true }).catch(() => {});
  if (errors.length) console.log('JS errors:\n' + errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close(); server.close();
}
