import type { MonitorState, ShellCommand } from '../shared/bridge';
import { Stats } from '../core/stats';
import { StrikeCounter } from '../core/strikes';
import { Monitor, type FrameReport } from './monitor';
import { drawOverlay } from './overlay';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from './settings';
import { chime, unlockAudio } from './sound';
import { listCameras } from './camera';
import {
  ScreenWakeLock,
  bridge,
  isElectron,
  isIOS,
  publishStatus,
  requestNotificationPermission,
  sendAlert,
} from './platform';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const el = {
  status: $('status'),
  statusText: $('status-text'),
  toggle: $<HTMLButtonElement>('toggle'),
  startBig: $<HTMLButtonElement>('start-big'),
  video: $<HTMLVideoElement>('video'),
  overlay: $<HTMLCanvasElement>('overlay'),
  videoWrap: $('video-wrap'),
  empty: $('stage-empty'),
  emptyThreshold: $('empty-threshold'),
  errorText: $('error-text'),
  previewOff: $('preview-off'),
  ring: $('ring'),
  ringBar: $('ring-bar'),
  ringText: $('ring-text'),
  banner: $('banner'),
  bannerSub: $('banner-sub'),
  debug: $('debug'),
  touches: $('stat-touches'),
  alerts: $('stat-alerts'),
  time: $('stat-time'),
  since: $('stat-since'),
  bars: $('bars'),
  cameraSelect: $<HTMLSelectElement>('camera-select'),
  openAtLogin: $<HTMLInputElement>('open-at-login'),
  ratioField: $('ratio-field'),
  webHint: $('web-hint'),
  strikes: $('strikes'),
  penaltyFields: $('penalty-fields'),
  drinkStatus: $('drink-status'),
};

let settings: Settings = loadSettings();
const stats = new Stats(safeLocalStorage());
const wakeLock = new ScreenWakeLock();
const strikes = new StrikeCounter(settings.penaltyStrikes, settings.penaltyWindowMin * 60_000);
const penaltyActive = () => isElectron && settings.penaltyEnabled;
let pausedUntil: number | null = null;
let pauseTimer: ReturnType<typeof setTimeout> | null = null;
let bannerTimer: ReturnType<typeof setTimeout> | null = null;
let lastReport: FrameReport | null = null;
let statusDetail = '';

function notify(body: string, bannerSub: string): void {
  showBanner(bannerSub);
  if (settings.sound) chime();
  void sendAlert({ title: 'Hands off your face!', body, style: settings.alertStyle, silent: true });
}

const monitor = new Monitor(el.video, settings, {
  onState: (state, detail) => {
    statusDetail = detail ?? '';
    renderState(state);
  },
  onFrame: (report) => {
    lastReport = report;
    renderFrame(report);
  },
  onEvent: (ev) => {
    const now = Date.now();
    if (ev.type === 'alert') {
      stats.recordAlert(now);
      renderStats();
      const secs = Math.round(ev.durationMs / 1000);
      let body = `You've been touching your face for ${secs} second${secs === 1 ? '' : 's'}.`;
      // Every alert is a strike: the first one for a touch, and each repeat while you keep touching
      // (so the "Repeat while touching" slider sets how often a continued touch adds a strike).
      if (penaltyActive()) {
        if (strikes.record(now)) triggerPenalty();
        else body += ` Strike ${strikes.count(now)} of ${settings.penaltyStrikes}.`;
        renderStrikes();
      }
      notify(body, `Touching for ${secs}s`);
    } else if (ev.type === 'end') {
      stats.recordTouchEnd(now, ev.durationMs, ev.alerted);
      hideBanner(800);
      renderStats();
    }
  },
});

function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/* ---------------- status ---------------- */

const STATE_TEXT: Record<MonitorState, string> = {
  idle: 'Not watching',
  starting: 'Starting…',
  watching: 'Watching',
  touching: 'Touching',
  alert: 'Hands off!',
  away: 'Away — no face',
  paused: 'Paused',
  error: 'Error',
};

function renderState(state: MonitorState): void {
  el.status.dataset.state = state;
  let text = STATE_TEXT[state];
  if ((state === 'starting' || state === 'error') && statusDetail) text = statusDetail;
  if (state === 'paused' && pausedUntil) {
    text = `Paused until ${new Date(pausedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  el.statusText.textContent = text;

  const running = !['idle', 'paused', 'error'].includes(state) || monitor.isRunning;
  el.toggle.textContent = running ? 'Pause' : state === 'paused' ? 'Resume' : 'Start';
  el.toggle.classList.toggle('primary', !running);

  const showEmpty = !monitor.isRunning;
  el.empty.hidden = !showEmpty;
  el.errorText.hidden = state !== 'error';
  el.errorText.textContent = state === 'error' ? statusDetail : '';
  el.startBig.textContent = state === 'paused' ? 'Resume watching' : 'Start watching';
  el.startBig.disabled = state === 'starting';
  el.previewOff.hidden = settings.showPreview || !monitor.isRunning;

  if (monitor.drinkStatus) {
    el.drinkStatus.textContent = monitor.drinkStatus;
    el.drinkStatus.classList.toggle('bad', !monitor.drinkStatus.includes('ready'));
  }

  if (state !== 'touching' && state !== 'alert') el.ring.hidden = true;
  if (!monitor.isRunning) {
    drawOverlay(el.overlay, null, 0);
    el.debug.textContent = '—';
  }
  publish();
}

function publish(): void {
  const today = stats.day(Date.now());
  publishStatus({
    state: monitor.state,
    touchesToday: today.touches,
    alertsToday: today.alerts,
    pausedUntil,
  });
}

/* ---------------- per-frame rendering ---------------- */

let lastDebugWrite = 0;

function renderFrame(r: FrameReport): void {
  const visible = !document.hidden;
  if (!visible) return; // don't burn CPU painting a hidden window

  if (settings.showPreview && settings.showLandmarks) drawOverlay(el.overlay, r, settings.marginPct);
  else drawOverlay(el.overlay, null, 0);

  const touching = r.state === 'touching' || r.state === 'alert';
  el.ring.hidden = !touching;
  if (touching) {
    const circumference = 125.66;
    el.ringBar.style.strokeDashoffset = String(circumference * (1 - r.progress));
    el.ring.classList.toggle('full', r.progress >= 1);
    el.ringText.textContent = `${(r.durationMs / 1000).toFixed(1)}s`;
  }

  const now = performance.now();
  if (now - lastDebugWrite > 250) {
    lastDebugWrite = now;
    const ratio = r.result.ratio !== null ? ` · hand/face ${r.result.ratio.toFixed(2)}` : '';
    const face = r.face ? (r.faceIsRemembered ? 'face (held)' : 'face') : 'no face';
    el.debug.textContent =
      `${r.fps.toFixed(1)} fps · ${r.detection.inferenceMs.toFixed(0)} ms · ${monitor.delegate} · ${monitor.frameSourceKind} · ` +
      `${face} · ${r.detection.hands.length} hand${r.detection.hands.length === 1 ? '' : 's'} · ${r.result.reason}${ratio}` +
      (r.drinkNote ? ` · ${r.drinkNote}` : '');
  }
}

function showBanner(sub: string): void {
  el.bannerSub.textContent = sub;
  el.banner.hidden = false;
  if (bannerTimer) clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => (el.banner.hidden = true), 6000);
}

function hideBanner(delay = 0): void {
  if (bannerTimer) clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => (el.banner.hidden = true), delay);
}

/* ---------------- stats ---------------- */

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function renderStats(): void {
  const now = Date.now();
  const today = stats.day(now);
  el.touches.textContent = String(today.touches);
  el.alerts.textContent = String(today.alerts);
  el.time.textContent = fmtDuration(today.touchMs);

  const hist = stats.history(now, 7);
  const max = Math.max(1, ...hist.map((d) => d.stats.touches));
  el.bars.replaceChildren(
    ...hist.map((d, i) => {
      const bar = document.createElement('div');
      bar.className = 'bar' + (i === hist.length - 1 ? ' today' : '');
      const [y, m, day] = d.key.split('-').map(Number);
      const label = new Date(y, m - 1, day).toLocaleDateString([], { weekday: 'narrow' });
      bar.title = `${d.key}: ${d.stats.touches} touches, ${d.stats.alerts} alerts`;
      const fill = document.createElement('div');
      fill.className = 'fill';
      fill.style.height = `${(d.stats.touches / max) * 100}%`;
      const lbl = document.createElement('span');
      lbl.textContent = label;
      bar.append(fill, lbl);
      return bar;
    }),
  );
  renderSince();
  publish();
}

function renderSince(): void {
  const last = stats.lastTouchAt;
  el.since.textContent = last ? fmtDuration(Date.now() - last) : '—';
  renderStrikes();
}

/* ---------------- strikes -> sign out ---------------- */

const ACTION_TEXT = { signout: 'signs you out', lock: 'locks your PC' } as const;

function renderStrikes(): void {
  if (!penaltyActive()) {
    el.strikes.hidden = true;
    return;
  }
  const now = Date.now();
  const n = strikes.count(now);
  const expiry = strikes.nextExpiry(now);
  el.strikes.hidden = false;
  el.strikes.classList.toggle('hot', n >= settings.penaltyStrikes - 1);
  const rule = `${settings.penaltyStrikes} in ${settings.penaltyWindowMin} min ${ACTION_TEXT[settings.penaltyAction]}`;
  el.strikes.innerHTML = '';
  const strong = document.createElement('strong');
  strong.textContent = `${n} / ${settings.penaltyStrikes}`;
  el.strikes.append('Strikes: ', strong, ` · ${rule}`);
  if (expiry) el.strikes.append(` · oldest clears in ${fmtDuration(expiry - now)}`);
}

function triggerPenalty(): void {
  if (!bridge) return;
  bridge.penalty({
    action: settings.penaltyAction,
    graceSec: settings.penaltyGraceSec,
    allowCancel: settings.penaltyAllowCancel,
    reason: `${settings.penaltyStrikes} face-touch strikes within ${settings.penaltyWindowMin} minute${
      settings.penaltyWindowMin === 1 ? '' : 's'
    }.`,
  });
}

/* ---------------- start / pause ---------------- */

async function start(): Promise<void> {
  clearPause();
  unlockAudio();
  void requestNotificationPermission();
  await wakeLock.acquire();
  await monitor.start();
  void populateCameras();
}

function pause(minutes: number | null): void {
  clearPause();
  if (minutes && minutes > 0) {
    pausedUntil = Date.now() + minutes * 60_000;
    pauseTimer = setTimeout(() => void start(), minutes * 60_000);
  }
  void wakeLock.release();
  hideBanner();
  monitor.stop('paused');
}

function clearPause(): void {
  if (pauseTimer) clearTimeout(pauseTimer);
  pauseTimer = null;
  pausedUntil = null;
}

function toggle(): void {
  if (monitor.isRunning || monitor.state === 'starting') pause(null);
  else void start();
}

el.toggle.addEventListener('click', toggle);
el.startBig.addEventListener('click', () => void start());
document.querySelectorAll<HTMLButtonElement>('[data-pause]').forEach((btn) =>
  btn.addEventListener('click', () => {
    const minutes = Number(btn.dataset.pause);
    pause(minutes > 0 ? minutes : null);
  }),
);

bridge?.onCommand((cmd: ShellCommand) => {
  if (cmd.type === 'pause') pause(cmd.minutes);
  else if (cmd.type === 'resume') void start();
  else toggle();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    if (monitor.isRunning) void wakeLock.acquire();
    if (lastReport) renderFrame(lastReport);
  }
});

/* ---------------- settings form ---------------- */

const FORMAT: Partial<Record<keyof Settings, (v: number) => string>> = {
  thresholdSec: (v) => `${v}s`,
  penaltyStrikes: (v) => `${v} strikes`,
  penaltyWindowMin: (v) => `${v} min`,
  penaltyGraceSec: (v) => (v === 0 ? 'none' : `${v}s`),
  repeatSec: (v) => (v === 0 ? 'off' : `every ${v}s`),
  marginPct: (v) => `${v}%`,
  maxHandFaceRatio: (v) => `${v.toFixed(2)}×`,
};

function bindSettings(): void {
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-key]').forEach((input) => {
    const key = input.dataset.key as keyof Settings;
    const read = () => {
      if (input instanceof HTMLInputElement && input.type === 'checkbox') return input.checked;
      if (input instanceof HTMLInputElement && input.type === 'range') return Number(input.value);
      return input.value;
    };
    input.addEventListener('input', () => {
      settings = { ...settings, [key]: read() } as Settings;
      saveSettings(settings);
      monitor.applySettings(settings);
      reflectSettings();
    });
  });
  reflectSettings();
}

function reflectSettings(): void {
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-key]').forEach((input) => {
    const key = input.dataset.key as keyof Settings;
    const value = settings[key];
    if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = Boolean(value);
    else if (document.activeElement !== input) input.value = String(value);
  });
  document.querySelectorAll<HTMLOutputElement>('output[data-for]').forEach((out) => {
    const key = out.dataset.for as keyof Settings;
    const fmt = FORMAT[key];
    out.textContent = fmt ? fmt(settings[key] as number) : String(settings[key]);
  });
  el.ratioField.classList.toggle('disabled', !settings.depthFilter);
  el.penaltyFields.classList.toggle('disabled', !settings.penaltyEnabled);
  strikes.limit = settings.penaltyStrikes;
  strikes.windowMs = settings.penaltyWindowMin * 60_000;
  renderStrikes();
  el.emptyThreshold.textContent = String(settings.thresholdSec);
  el.videoWrap.classList.toggle('hide-video', !settings.showPreview);
  el.previewOff.hidden = settings.showPreview || !monitor.isRunning;
}

async function populateCameras(): Promise<void> {
  try {
    const cams = await listCameras();
    const current = settings.cameraId;
    el.cameraSelect.replaceChildren(
      new Option('Default camera', ''),
      ...cams.map((c, i) => new Option(c.label || `Camera ${i + 1}`, c.deviceId)),
    );
    el.cameraSelect.value = cams.some((c) => c.deviceId === current) ? current : '';
  } catch {
    /* enumerateDevices unavailable */
  }
}

$('reset-settings').addEventListener('click', () => {
  settings = { ...DEFAULT_SETTINGS, cameraId: settings.cameraId };
  saveSettings(settings);
  monitor.applySettings(settings);
  reflectSettings();
});

$('clear-stats').addEventListener('click', () => {
  stats.clear();
  renderStats();
});

/* ---------------- platform specifics ---------------- */

function setupPlatform(): void {
  document.querySelectorAll<HTMLElement>('[data-electron-only]').forEach((n) => (n.hidden = !isElectron));
  document.querySelectorAll<HTMLElement>('[data-web-only]').forEach((n) => (n.hidden = isElectron));

  if (bridge) {
    let isStore = false;
    void bridge.getAppInfo().then((info) => {
      isStore = info.store;
      $('about-version').textContent = `Face Guard ${info.version}${info.store ? ' (Microsoft Store)' : ''}`;
      if (info.store) {
        // Store installs: Windows owns the startup entry.
        $('login-row').hidden = true;
        $('store-startup-row').hidden = false;
      }
    });
    $('open-startup-settings').addEventListener('click', () => void bridge!.openStartupSettings());
    $('uninstall').addEventListener('click', () => {
      const msg = isStore
        ? "Windows' installed-apps list will open. Find Face Guard there and choose Uninstall."
        : 'Uninstall Face Guard? Face Guard will close and the uninstaller will open.';
      if (!confirm(msg)) return;
      void bridge!.uninstall().then((r) => {
        if (r === 'dev') alert('This is a development build. Nothing is installed, so there is nothing to uninstall.');
      });
    });
    void bridge.getOpenAtLogin().then((on) => (el.openAtLogin.checked = on));
    el.openAtLogin.addEventListener('change', () => {
      void bridge!.setOpenAtLogin(el.openAtLogin.checked).then((on) => (el.openAtLogin.checked = on));
    });
  } else {
    el.webHint.textContent = isIOS
      ? 'On iPhone, add Face Guard to your Home Screen (Share → Add to Home Screen). iOS only allows the camera while the app is open on screen.'
      : 'Keep this tab open. For background monitoring, use the Face Guard desktop app.';
  }

  // Offline cache for the installed PWA. Skipped on localhost so dev builds are never stale.
  const isLocalDev = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (!isElectron && !isLocalDev && 'serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('[face-guard] SW registration failed', err));
  }
}

/* ---------------- boot ---------------- */

setupPlatform();
bindSettings();
renderStats();
renderState('idle');
setInterval(renderSince, 1000);
// Refresh "today" at midnight rollover (cheap enough to just re-render every minute).
setInterval(renderStats, 60_000);

// The desktop app starts watching immediately (it may have been launched at login).
if (isElectron) void start();
