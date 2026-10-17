// Playwright smoke test through the whole flow in simulation mode (no Worker needed):
// login → plan → prepare → checks → ascent → detail → retrieve → admin, with screenshots.
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
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/net::ERR|Failed to load resource|ERR_TUNNEL|403/.test(m.text())) errors.push(`console: ${m.text()}`); });
const shot = (name) => page.screenshot({ path: path.join(shots, name), fullPage: true });
const step = (s) => console.log(`» ${s}`);

try {
  step('login page');
  await page.goto(`${base}/?sim=1&speed=20&fast=1#login`);
  await page.waitForSelector('form.login');
  await shot('01-login.png');
  await page.click('form.login button[type=submit]');
  await page.waitForSelector('.actionbar', { timeout: 10000 });

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
  if (!/^[2-9A-HJ-NP-Z]{8}$/.test(code)) throw new Error(`observer code: ${code}`);
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

  if (errors.length) { console.log('JS errors:\n' + errors.join('\n')); process.exitCode = 1; }
  else console.log('smoke OK – screenshots in', shots);
} catch (e) {
  console.error('SMOKE FAILED:', e.message);
  await shot('ZZ-failure.png').catch(() => {});
  if (errors.length) console.log('JS errors:\n' + errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close(); server.close();
}
