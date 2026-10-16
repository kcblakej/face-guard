// Headless end-to-end smoke test of the web UI with MediaPipe mocked out.
//
//   npm run test:smoke      (needs: npm i -D playwright && npx playwright install chromium)
//
// Uses Chromium's fake camera, scripts what the "models" see, and checks that a
// 2-second touch produces an alert + notification and gets counted.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = path.join(root, 'dist/web');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const server = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(web, p.endsWith('/') ? p + 'index.html' : p);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const port = server.address().port;

const fail = (msg) => {
  console.error('✗', msg);
  process.exitCode = 1;
};
const ok = (msg) => console.log('✓', msg);

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const context = await browser.newContext({ permissions: ['camera', 'notifications'], viewport: { width: 1200, height: 820 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

await page.addInitScript(() => {
  window.__notifications = [];
  const record = (title, opts) => window.__notifications.push({ title, body: opts?.body });
  ServiceWorkerRegistration.prototype.showNotification = async function (title, opts) {
    record(title, opts);
  };
  const Real = window.Notification;
  class Spy {
    static permission = 'granted';
    static requestPermission = async () => 'granted';
    constructor(title, opts) {
      record(title, opts);
    }
  }
  window.Notification = Real ? Spy : Spy;
});

await page.goto(`http://localhost:${port}/`);
await page.click('#start-big');
await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'watching', null, { timeout: 10000 });
ok('starts watching with the fake camera');

await page.waitForFunction(() => (window.__detectCalls ?? 0) > 5, null, { timeout: 5000 });
const debug = await page.textContent('#debug');
debug.includes('face') ? ok(`detection loop running: "${debug}"`) : fail(`debug line: ${debug}`);

// Hand in front of the camera (too close): must NOT alert.
await page.evaluate(() => (window.__scene = 'wave'));
await page.waitForTimeout(2600);
let state = await page.getAttribute('#status', 'data-state');
state === 'watching' ? ok('hand held close to the camera is ignored (depth filter)') : fail(`wave produced state ${state}`);

// Touch for 1s: touching, no alert yet.
await page.evaluate(() => (window.__scene = 'touch'));
await page.waitForTimeout(1000);
state = await page.getAttribute('#status', 'data-state');
state === 'touching' ? ok('1s touch -> "touching" (countdown ring shown)') : fail(`after 1s touch state=${state}`);
let n = await page.evaluate(() => window.__notifications.length);
n === 0 ? ok('no alert before the threshold') : fail(`alerted early (${n})`);

// Keep touching past 2s: alert.
await page.waitForTimeout(1500);
state = await page.getAttribute('#status', 'data-state');
state === 'alert' ? ok('2s+ touch -> alert state') : fail(`after 2.5s touch state=${state}`);
const bannerVisible = await page.isVisible('#banner');
bannerVisible ? ok('in-app banner shown') : fail('banner not shown');
const notes = await page.evaluate(() => window.__notifications);
notes.length === 1 && notes[0].title === 'Hands off your face!'
  ? ok(`notification sent: "${notes[0].title}" / "${notes[0].body}"`)
  : fail(`notifications: ${JSON.stringify(notes)}`);
await page.screenshot({ path: path.join(root, 'dist/smoke-alert.png') });

// Let go: episode ends and is counted.
await page.evaluate(() => (window.__scene = 'clear'));
await page.waitForTimeout(900);
state = await page.getAttribute('#status', 'data-state');
const touches = await page.textContent('#stat-touches');
const alerts = await page.textContent('#stat-alerts');
state === 'watching' && touches === '1' && alerts === '1'
  ? ok('touch ended and counted (1 touch, 1 alert)')
  : fail(`after release state=${state} touches=${touches} alerts=${alerts}`);

// Walk away: status "away", no alerts.
await page.evaluate(() => (window.__scene = 'away'));
await page.waitForTimeout(3600);
state = await page.getAttribute('#status', 'data-state');
state === 'away' ? ok('no face for 3s -> away') : fail(`away state=${state}`);

// Pause releases the camera.
await page.evaluate(() => (window.__scene = 'clear'));
await page.click('[data-pause="15"]');
state = await page.getAttribute('#status', 'data-state');
const pill = await page.textContent('#status-text');
const tracks = await page.evaluate(() => document.querySelector('#video').srcObject);
state === 'paused' && tracks === null ? ok(`pause stops the camera ("${pill}")`) : fail(`pause state=${state}`);

// Resume.
await page.click('#toggle');
await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'watching', null, { timeout: 5000 });
ok('resume works');
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(root, 'dist/smoke-watching.png') });

// Drinking: hand at the mouth holding a cup -> not a touch; the cup detector only runs while a hand is at the face.
const drinkCallsIdle = await page.evaluate(async () => {
  const before = window.__drinkCalls ?? 0;
  await new Promise((r) => setTimeout(r, 1000)); // scene is 'clear'
  return (window.__drinkCalls ?? 0) - before;
});
drinkCallsIdle === 0 ? ok('cup detector stays idle when no hand is at the face') : fail(`cup detector ran ${drinkCallsIdle}x while idle`);
const notesBefore = await page.evaluate(() => window.__notifications.length);
await page.evaluate(() => (window.__scene = 'drink'));
await page.waitForTimeout(3200);
state = await page.getAttribute('#status', 'data-state');
let dbg = await page.textContent('#debug');
let notesNow = await page.evaluate(() => window.__notifications.length);
state === 'watching' && notesNow === notesBefore && dbg.includes('drinking') && dbg.includes('holding: Right')
  ? ok(`3 s sip from a mug -> no alert ("…${dbg.split('·').slice(-4).join('·').trim()}")`)
  : fail(`drinking: state=${state} notifications=${notesNow - notesBefore} debug="${dbg}"`);
await page.screenshot({ path: path.join(root, 'dist/smoke-drinking.png') });
const drinkStatus = await page.textContent('#drink-status');
drinkStatus.includes('ready') ? ok(`settings shows: "${drinkStatus}"`) : fail(`drink status: "${drinkStatus}"`);

// Mug tipped up and hidden from the detector: still excused because this hand was seen holding it.
await page.evaluate(() => (window.__scene = 'drink-hidden'));
await page.waitForTimeout(3000);
state = await page.getAttribute('#status', 'data-state');
notesNow = await page.evaluate(() => window.__notifications.length);
state === 'watching' && notesNow === notesBefore
  ? ok('mug hidden against the mouth for 3 s -> still no alert')
  : fail(`drink-hidden: state=${state} notifications=${notesNow - notesBefore}`);

// Put the mug down, wait, then touch your face with the mug on the desk -> alerts.
await page.evaluate(() => (window.__scene = 'clear'));
await page.waitForTimeout(4200);
await page.evaluate(() => (window.__scene = 'drink-far'));
await page.waitForTimeout(2600);
state = await page.getAttribute('#status', 'data-state');
notesNow = await page.evaluate(() => window.__notifications.length);
state === 'alert' && notesNow === notesBefore + 1
  ? ok('mug on the desk while touching your face -> still alerts')
  : fail(`drink-far: state=${state} notifications=${notesNow - notesBefore}`);
await page.evaluate(() => (window.__scene = 'clear'));
await page.waitForTimeout(700);

// Mobile layout.
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(root, 'dist/smoke-mobile.png'), fullPage: true });

// ---- Desktop-only: 3 separate alerts within 5 minutes -> sign-out request to the shell ----
const desk = await context.newPage();
desk.on('pageerror', (e) => errors.push(e.message));
await desk.addInitScript(() => {
  window.__shell = { alerts: [], penalties: [], uninstalls: 0 };
  window.faceGuard = {
    isElectron: true,
    getAppInfo: async () => ({ version: '1.0.0', store: false, packaged: true }),
    openStartupSettings: async () => {},
    uninstall: async () => (window.__shell.uninstalls++, 'started'),
    alert: (req) => window.__shell.alerts.push(req),
    setStatus: () => {},
    penalty: (req) => window.__shell.penalties.push(req),
    getOpenAtLogin: async () => false,
    setOpenAtLogin: async (v) => v,
    onCommand: () => () => {},
  };
  // Fast settings: alert after 0.5 s, repeat every 2 s while touching.
  // Includes settings from the old version (fps, "both") to check they migrate cleanly.
  localStorage.setItem('faceguard.settings.v1', JSON.stringify({ thresholdSec: 0.5, repeatSec: 2, fps: 3, alertStyle: 'both', penaltyEnabled: true }));
});
await desk.goto(`http://localhost:${port}/`);
await desk.waitForFunction(() => document.querySelector('#status').dataset.state === 'watching', null, { timeout: 10000 });
ok('desktop mode auto-starts watching');
const fpsNow = await desk.evaluate(async () => { await new Promise((r) => setTimeout(r, 1500)); return document.querySelector('#debug').textContent; });
/^(9|10|11)\.\d fps/.test(fpsNow) ? ok(`old fps setting ignored, runs at 10/s ("${fpsNow.slice(0, 8)}")`) : fail(`fps: ${fpsNow}`);

const touchFor = async (ms) => {
  await desk.evaluate(() => (window.__scene = 'touch'));
  await desk.waitForTimeout(ms);
  await desk.evaluate(() => (window.__scene = 'clear'));
  await desk.waitForTimeout(700);
};

// A 1.5 s touch: one alert (the next repeat would be at 2.5 s) = one strike.
await touchFor(1500);
let shell = await desk.evaluate(() => window.__shell);
let strikeText = await desk.textContent('#strikes');
shell.alerts.length === 1 && strikeText.includes('1 / 3') && shell.penalties.length === 0
  ? ok(`single alert = 1 strike ("${strikeText.trim()}")`)
  : fail(`first touch: alerts=${shell.alerts.length} strikes="${strikeText}" penalties=${shell.penalties.length}`);
shell.alerts[0].body.includes('Strike 1 of 3') && shell.alerts[0].style === 'popup'
  ? ok(`alert text warns: "${shell.alerts[0].body}"`)
  : fail(`alert body: ${shell.alerts[0].body}`);

await touchFor(900);
shell = await desk.evaluate(() => window.__shell);
shell.penalties.length === 0 ? ok('2 strikes: no sign-out yet') : fail('penalty after 2 strikes');
await desk.screenshot({ path: path.join(root, 'dist/smoke-strikes.png') });

await touchFor(900);
shell = await desk.evaluate(() => window.__shell);
const pen = shell.penalties[0];
shell.penalties.length === 1 && pen.action === 'signout' && pen.graceSec === 15 && pen.allowCancel
  ? ok(`3rd strike -> sign-out requested: ${JSON.stringify(pen)}`)
  : fail(`penalties: ${JSON.stringify(shell.penalties)}`);
strikeText = await desk.textContent('#strikes');
strikeText.includes('0 / 3') ? ok('strikes reset after triggering') : fail(`strikes after trigger: ${strikeText}`);

// One continuous touch: alert at 0.5 s (strike 1), repeats at 2.5 s (strike 2) and 4.5 s (strike 3 -> sign-out).
let before = await desk.evaluate(() => window.__shell.alerts.length);
await desk.evaluate(() => (window.__scene = 'touch'));
await desk.waitForTimeout(3300);
shell = await desk.evaluate(() => window.__shell);
strikeText = await desk.textContent('#strikes');
let fresh = shell.alerts.slice(before);
fresh.length === 2 && fresh[1].body.includes('Strike 2 of 3') && strikeText.includes('2 / 3') && shell.penalties.length === 1
  ? ok(`repeat alert while still touching = strike 2 ("${fresh[1].body}")`)
  : fail(`continuous touch: alerts=${JSON.stringify(fresh)} strikes="${strikeText}"`);
await desk.waitForTimeout(2000);
await desk.evaluate(() => (window.__scene = 'clear'));
await desk.waitForTimeout(700);
shell = await desk.evaluate(() => window.__shell);
shell.penalties.length === 2 && shell.alerts.slice(before).length === 3
  ? ok('3rd alert of the same touch -> sign-out requested (one alert per strike, no extras)')
  : fail(`continuous touch: alerts=${shell.alerts.slice(before).length} penalties=${shell.penalties.length}`);

// Repeat interval comes from the "Repeat while touching" slider; "off" = one strike per touch.
await desk.click('#settings summary');
await desk.evaluate(() => {
  const r = document.querySelector('[data-key="repeatSec"]');
  r.value = '0';
  r.dispatchEvent(new Event('input', { bubbles: true }));
});
before = await desk.evaluate(() => window.__shell.alerts.length);
await touchFor(5000);
shell = await desk.evaluate(() => window.__shell);
strikeText = await desk.textContent('#strikes');
shell.alerts.slice(before).length === 1 && strikeText.includes('1 / 3')
  ? ok('repeat set to off: a 5 s touch is 1 alert and 1 strike')
  : fail(`repeat off: alerts=${shell.alerts.slice(before).length} strikes="${strikeText}"`);
await desk.click('#settings summary'); // close again; the next block reopens it

// Removed controls stay removed.
await desk.click('#settings summary');
const gone = await desk.evaluate(() => ({
  testPenalty: !!document.querySelector('#test-penalty'),
  testAlert: !!document.querySelector('#test-alert'),
  fps: !!document.querySelector('[data-key="fps"]'),
  both: !!document.querySelector('[data-key="alertStyle"] option[value="both"]'),
  styles: [...document.querySelectorAll('[data-key="alertStyle"] option')].map((o) => o.value).join(','),
}));
!gone.testPenalty && !gone.testAlert && !gone.fps && !gone.both && gone.styles === 'toast,popup'
  ? ok('test buttons, checks-per-second slider and "Both" alert style are gone')
  : fail(`removed controls: ${JSON.stringify(gone)}`);
await desk.locator('.group').screenshot({ path: path.join(root, 'dist/smoke-penalty-settings.png') });

// Disabled -> no strikes counted.
await desk.uncheck('[data-key="penaltyEnabled"]');
await touchFor(900);
await touchFor(900);
await touchFor(900);
shell = await desk.evaluate(() => window.__shell);
shell.penalties.length === 2 && (await desk.isHidden('#strikes'))
  ? ok('turning the feature off stops strikes')
  : fail(`disabled: penalties=${shell.penalties.length}`);
await desk.close();

// About line + uninstall (installer build).
const aboutDesk = await context.newPage();
await aboutDesk.addInitScript(() => {
  window.__uninstalls = 0;
  window.faceGuard = {
    isElectron: true,
    alert() {},
    setStatus() {},
    penalty() {},
    getOpenAtLogin: async () => true,
    setOpenAtLogin: async (v) => v,
    onCommand: () => () => {},
    getAppInfo: async () => ({ version: '1.2.3', store: false, packaged: true }),
    openStartupSettings: async () => {},
    uninstall: async () => (window.__uninstalls++, 'started'),
  };
});
await aboutDesk.goto(`http://localhost:${port}/`);
await aboutDesk.waitForFunction(() => document.querySelector('#status').dataset.state === 'watching', null, { timeout: 10000 });
await aboutDesk.click('#settings summary');
const about = (await aboutDesk.textContent('.about')).replace(/\s+/g, ' ').trim();
const loginVisible = await aboutDesk.isVisible('#login-row');
const penaltyDefault = await aboutDesk.isChecked('[data-key="penaltyEnabled"]');
about.includes('Face Guard 1.2.3') && about.includes('Uninstall') && loginVisible && !penaltyDefault
  ? ok(`settings footer: "${about}"; start-with-Windows toggle shown; sign-out off by default`)
  : fail(`about="${about}" loginVisible=${loginVisible} penaltyDefault=${penaltyDefault}`);
aboutDesk.once('dialog', (d) => d.accept());
await aboutDesk.click('#uninstall');
await aboutDesk.waitForTimeout(300);
(await aboutDesk.evaluate(() => window.__uninstalls)) === 1
  ? ok('Uninstall… asks for confirmation, then launches the uninstaller')
  : fail('uninstall not requested');
await aboutDesk.locator('.settings').screenshot({ path: path.join(root, 'dist/smoke-settings-footer.png') });
await aboutDesk.close();

// Store build: Windows manages startup, so the toggle is replaced by a link to Windows settings.
const storeDesk = await context.newPage();
await storeDesk.addInitScript(() => {
  window.__openedStartup = 0;
  window.faceGuard = {
    isElectron: true,
    alert() {},
    setStatus() {},
    penalty() {},
    getOpenAtLogin: async () => false,
    setOpenAtLogin: async () => false,
    onCommand: () => () => {},
    getAppInfo: async () => ({ version: '1.2.3', store: true, packaged: true }),
    openStartupSettings: async () => void window.__openedStartup++,
    uninstall: async () => 'settings',
  };
});
await storeDesk.goto(`http://localhost:${port}/`);
await storeDesk.click('#settings summary');
await storeDesk.waitForFunction(() => document.querySelector('#about-version').textContent.includes('Store'));
await storeDesk.click('#open-startup-settings');
!(await storeDesk.isVisible('#login-row')) && (await storeDesk.evaluate(() => window.__openedStartup)) === 1
  ? ok('Store build: startup handled via Windows settings link')
  : fail('store startup row');
await storeDesk.close();

// Web build: no uninstall link; privacy page is reachable.
const web2 = await context.newPage();
await web2.goto(`http://localhost:${port}/`);
await web2.click('#settings summary');
const webUninstall = await web2.isVisible('#uninstall');
const privacyRes = await web2.request.get(`http://localhost:${port}/privacy.html`);
const privacyText = await privacyRes.text();
!webUninstall && privacyRes.ok() && privacyText.includes('ever saved, uploaded')
  ? ok('web build hides Uninstall; privacy.html is served')
  : fail(`web: uninstallVisible=${webUninstall} privacy=${privacyRes.status()}`);
const pp = await context.newPage();
await pp.goto(`http://localhost:${port}/privacy.html`);
await pp.screenshot({ path: path.join(root, 'dist/smoke-privacy.png'), fullPage: true });
await pp.close();
await web2.close();

// Drink model can't load: the app still works and Settings says why.
const noDrink = await context.newPage();
await noDrink.addInitScript(() => (window.__failDrinkModel = true));
await noDrink.goto(`http://localhost:${port}/`);
await noDrink.click('#start-big');
await noDrink.waitForFunction(() => document.querySelector('#status').dataset.state === 'watching', null, { timeout: 10000 });
const failText = await noDrink.textContent('#drink-status');
const failBad = await noDrink.evaluate(() => document.querySelector('#drink-status').classList.contains('bad'));
failText.includes('failed to load') && failText.includes('fetch-models') && failBad
  ? ok(`missing drink model is reported: "${failText}"`)
  : fail(`drink model failure: "${failText}"`);
await noDrink.close();

// Countdown window renders.
const cd = await context.newPage();
await cd.setViewportSize({ width: 480, height: 270 });
await cd.goto(`http://localhost:${port}/countdown.html?action=signout&seconds=15&cancel=1&reason=${encodeURIComponent('3 face-touch alerts within 5 minutes.')}`);
const cdText = await cd.textContent('main');
cdText.includes('Signing you out') && (await cd.isVisible('#cancel'))
  ? ok('countdown window renders with Cancel')
  : fail(`countdown: ${cdText}`);
await cd.screenshot({ path: path.join(root, 'dist/smoke-countdown.png') });
await cd.close();

// 404s are the HEAD probes for model files, which the mock build doesn't include.
const realErrors = errors.filter((e) => !/favicon|sw\.js|ServiceWorker|404/i.test(e));
realErrors.length === 0 ? ok('no page errors') : fail(`page errors:\n  ${realErrors.join('\n  ')}`);

await browser.close();
server.close();
