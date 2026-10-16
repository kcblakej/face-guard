import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  protocol,
  screen,
  session,
  shell,
  Tray,
  type MenuItemConstructorOptions,
} from 'electron';
import { execFile, spawn } from 'node:child_process';
import { existsSync, promises as fs, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AlertRequest, MonitorState, PenaltyAction, PenaltyRequest, ShellCommand, StatusUpdate } from '../shared/bridge';

const APP_ID = 'com.blakejordan.faceguard';
const SCHEME = 'app';
const ORIGIN = `${SCHEME}://face-guard`;
const WEB_ROOT = path.join(__dirname, '..', 'web');
const ASSETS = path.join(__dirname, 'assets');
/** Installed from the Microsoft Store (MSIX). Windows then owns startup + uninstall. */
const IS_STORE = process.windowsStore === true;

// Keep detection running at full speed while the window is hidden in the tray.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let popup: BrowserWindow | null = null;
let popupTimer: ReturnType<typeof setTimeout> | null = null;
let quitting = false;
let pausedByLock = false;
let status: StatusUpdate = { state: 'starting', touchesToday: 0, alertsToday: 0, pausedUntil: null };
const liveToasts = new Set<Notification>(); // hold references so toasts aren't garbage-collected

/* ---------------- small persisted shell state ---------------- */

interface ShellState {
  firstRunDone?: boolean;
  trayHintShown?: boolean;
}
const statePath = () => path.join(app.getPath('userData'), 'shell-state.json');
function readState(): ShellState {
  try {
    return JSON.parse(readFileSync(statePath(), 'utf8')) as ShellState;
  } catch {
    return {};
  }
}
function writeState(patch: ShellState): void {
  try {
    writeFileSync(statePath(), JSON.stringify({ ...readState(), ...patch }));
  } catch {
    /* non-fatal */
  }
}

/* ---------------- app:// protocol serving the built web app ---------------- */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.task': 'application/octet-stream',
  '.tflite': 'application/octet-stream',
  '.map': 'application/json',
};

function registerAppProtocol(): void {
  protocol.handle(SCHEME, async (request) => {
    const { pathname } = new URL(request.url);
    const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    const file = path.normalize(path.join(WEB_ROOT, rel));
    if (!file.startsWith(WEB_ROOT + path.sep)) return new Response('Forbidden', { status: 403 });
    const headers = { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' };
    try {
      if (request.method === 'HEAD') {
        await fs.stat(file);
        return new Response(null, { status: 200, headers });
      }
      const data = await fs.readFile(file);
      return new Response(data as unknown as BodyInit, { status: 200, headers });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

/* ---------------- windows ---------------- */

function createWindow(startHidden: boolean): void {
  win = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 380,
    minHeight: 520,
    show: false,
    title: 'Face Guard',
    backgroundColor: '#0b1220',
    icon: path.join(ASSETS, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  // Only our own privacy page may open in a new window; everything else is blocked.
  win.webContents.setWindowOpenHandler(({ url }) =>
    url.startsWith(`${ORIGIN}/privacy.html`)
      ? {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 720,
            height: 760,
            autoHideMenuBar: true,
            backgroundColor: '#0b1220',
            webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
          },
        }
      : { action: 'deny' },
  );
  win.webContents.on('will-navigate', (e) => {
    if (!e.url.startsWith(ORIGIN)) e.preventDefault();
  });

  win.once('ready-to-show', () => {
    if (!startHidden) win?.show();
  });

  // Windows is signing out / shutting down: let the window close instead of hiding to the tray,
  // otherwise Face Guard would block the sign-out.
  win.on('query-session-end', () => {
    quitting = true;
  });
  win.on('session-end', () => {
    quitting = true;
  });

  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault(); // closing the window just sends it to the tray
    win?.hide();
    const st = readState();
    if (!st.trayHintShown) {
      writeState({ trayHintShown: true });
      toast('Face Guard is still watching', 'It keeps running in the system tray. Right-click the tray icon to pause or quit.', true);
    }
  });

  void win.loadURL(`${ORIGIN}/index.html`);
}

function showWindow(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function toggleWindow(): void {
  if (win?.isVisible() && win.isFocused()) win.hide();
  else showWindow();
}

/* ---------------- alerts ---------------- */

function toast(title: string, body: string, silent: boolean): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent, icon: path.join(ASSETS, 'icon.png') });
  liveToasts.add(n);
  const done = () => liveToasts.delete(n);
  n.on('click', () => {
    showWindow();
    done();
  });
  n.on('close', done);
  n.show();
  setTimeout(done, 60_000);
}

function showPopup(title: string, body: string): void {
  if (popupTimer) clearTimeout(popupTimer);
  if (popup && !popup.isDestroyed()) popup.destroy();

  const width = 380;
  const height = 112;
  const { workArea } = screen.getPrimaryDisplay();
  popup = new BrowserWindow({
    width,
    height,
    x: Math.round(workArea.x + workArea.width - width - 12),
    y: Math.round(workArea.y + workArea.height - height - 12),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    show: false,
    hasShadow: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  popup.setAlwaysOnTop(true, 'screen-saver');
  popup.setVisibleOnAllWorkspaces(true);
  const q = new URLSearchParams({ title, body });
  popup.webContents.once('did-finish-load', () => popup?.showInactive());
  void popup.loadURL(`${ORIGIN}/popup.html?${q.toString()}`);
  popupTimer = setTimeout(() => {
    if (popup && !popup.isDestroyed()) popup.destroy();
    popup = null;
  }, 4500);
}

ipcMain.on('fg:alert', (_e, req: AlertRequest) => {
  if (req.style === 'popup' || !Notification.isSupported()) showPopup(req.title, req.body);
  else toast(req.title, req.body, req.silent);
});

/* ---------------- penalty: sign out / lock after too many alerts ---------------- */

let penaltyWin: BrowserWindow | null = null;
let penaltyTimer: ReturnType<typeof setTimeout> | null = null;

function executePenalty(action: PenaltyAction): void {
  if (process.platform !== 'win32') {
    toast('Face Guard', `Automatic ${action === 'lock' ? 'lock' : 'sign-out'} is only supported on Windows.`, true);
    return;
  }
  // `shutdown /l` asks apps to close normally (no /f), so apps with unsaved work can still hold it up.
  const [cmd, args] =
    action === 'lock' ? ['rundll32.exe', ['user32.dll,LockWorkStation']] : ['shutdown.exe', ['/l']];
  if (action === 'signout') quitting = true; // don't let our close-to-tray handler block the sign-out
  execFile(cmd, args, { windowsHide: true }, (err) => {
    if (err) {
      quitting = false;
      console.error('[face-guard] penalty failed', err);
      toast('Face Guard', `Couldn't ${action === 'lock' ? 'lock' : 'sign out'}: ${err.message}`, true);
    }
  });
}

function runPenalty(req: PenaltyRequest): void {
  if (penaltyWin && !penaltyWin.isDestroyed()) return; // a countdown is already running

  const finish = () => executePenalty(req.action);
  const graceSec = Math.max(0, Math.round(req.graceSec));
  if (graceSec === 0) {
    finish();
    return;
  }

  const width = 480;
  const height = 270;
  const { workArea } = screen.getPrimaryDisplay();
  penaltyWin = new BrowserWindow({
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    closable: req.allowCancel,
    alwaysOnTop: true,
    skipTaskbar: false,
    show: false,
    hasShadow: false,
    title: 'Face Guard',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  penaltyWin.setAlwaysOnTop(true, 'screen-saver');
  penaltyWin.setVisibleOnAllWorkspaces(true);

  let fired = false;
  penaltyTimer = setTimeout(() => {
    fired = true;
    if (penaltyWin && !penaltyWin.isDestroyed()) penaltyWin.destroy();
    penaltyWin = null;
    finish();
  }, graceSec * 1000);

  penaltyWin.on('closed', () => {
    penaltyWin = null;
    if (fired) return;
    if (penaltyTimer) clearTimeout(penaltyTimer);
    penaltyTimer = null;
    // The page closes itself when you press Cancel. If cancelling isn't allowed, closing it just acts now.
    if (req.allowCancel) toast('Face Guard', 'Cancelled. Hands off your face!', true);
    else {
      fired = true;
      finish();
    }
  });

  const q = new URLSearchParams({
    action: req.action,
    seconds: String(graceSec),
    reason: req.reason,
    cancel: req.allowCancel ? '1' : '0',
  });
  penaltyWin.once('ready-to-show', () => {
    penaltyWin?.show();
    penaltyWin?.focus();
  });
  void penaltyWin.loadURL(`${ORIGIN}/countdown.html?${q.toString()}`);
}

ipcMain.on('fg:penalty', (_e, req: PenaltyRequest) => runPenalty(req));

/* ---------------- tray ---------------- */

const TRAY_ICON: Record<MonitorState, string> = {
  watching: 'watching',
  touching: 'touching',
  alert: 'alert',
  idle: 'paused',
  starting: 'paused',
  away: 'paused',
  paused: 'paused',
  error: 'paused',
};

const STATE_LABEL: Record<MonitorState, string> = {
  idle: 'Not watching',
  starting: 'Starting…',
  watching: 'Watching',
  touching: 'Touching…',
  alert: 'Hands off!',
  away: 'Away (no face in view)',
  paused: 'Paused',
  error: 'Camera problem',
};

function sendCommand(cmd: ShellCommand): void {
  win?.webContents.send('fg:command', cmd);
}

function loginArgs(): string[] {
  // In development Electron needs the app path; the installed app is launched directly.
  return app.isPackaged ? ['--hidden'] : [path.resolve(process.argv[1] ?? '.'), '--hidden'];
}

function getOpenAtLogin(): boolean {
  if (IS_STORE) return false; // managed by Windows (Settings → Apps → Startup)
  return app.getLoginItemSettings({ args: loginArgs() }).openAtLogin;
}

function setOpenAtLogin(enabled: boolean): boolean {
  if (IS_STORE) return false;
  // Named explicitly so the uninstaller knows which registry value to remove (see build/installer.nsh).
  app.setLoginItemSettings({ openAtLogin: enabled, args: loginArgs(), ...(app.isPackaged ? { name: APP_ID } : {}) });
  rebuildTrayMenu();
  return getOpenAtLogin();
}

function openStartupSettings(): void {
  void shell.openExternal('ms-settings:startupapps');
}

/** Runs the uninstaller (installer build) or opens Windows' app list (Store build). */
function uninstall(): 'started' | 'settings' | 'dev' {
  if (!app.isPackaged) return 'dev';
  const uninstaller = path.join(path.dirname(process.execPath), `Uninstall ${app.getName()}.exe`);
  if (IS_STORE || !existsSync(uninstaller)) {
    void shell.openExternal('ms-settings:appsfeatures');
    return 'settings';
  }
  spawn(uninstaller, [], { detached: true, stdio: 'ignore' }).unref();
  quitting = true;
  app.quit(); // the uninstaller needs Face Guard closed
  return 'started';
}

function statusLine(): string {
  let label = STATE_LABEL[status.state];
  if (status.state === 'paused' && status.pausedUntil) {
    label = `Paused until ${new Date(status.pausedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  return `${label} · ${status.alertsToday} alert${status.alertsToday === 1 ? '' : 's'} today`;
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  const running = !['paused', 'idle', 'error'].includes(status.state);
  const items: MenuItemConstructorOptions[] = [
    { label: statusLine(), enabled: false },
    { type: 'separator' },
    { label: 'Show Face Guard', click: showWindow },
    ...(running
      ? ([
          { label: 'Pause for 15 minutes', click: () => sendCommand({ type: 'pause', minutes: 15 }) },
          { label: 'Pause for 1 hour', click: () => sendCommand({ type: 'pause', minutes: 60 }) },
          { label: 'Pause until I resume', click: () => sendCommand({ type: 'pause', minutes: null }) },
        ] as MenuItemConstructorOptions[])
      : ([{ label: 'Resume watching', click: () => sendCommand({ type: 'resume' }) }] as MenuItemConstructorOptions[])),
    { type: 'separator' },
    {
      ...(IS_STORE
        ? { label: 'Startup settings…', click: openStartupSettings }
        : {
            label: 'Start with Windows',
            type: 'checkbox' as const,
            checked: getOpenAtLogin(),
            click: (item: { checked: boolean }) => setOpenAtLogin(item.checked),
          }),
    },
    { type: 'separator' },
    {
      label: 'Quit Face Guard',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

let lastTrayIcon = '';
function updateTray(): void {
  if (!tray) return;
  const icon = TRAY_ICON[status.state];
  if (icon !== lastTrayIcon) {
    lastTrayIcon = icon;
    tray.setImage(nativeImage.createFromPath(path.join(ASSETS, `tray-${icon}.png`)));
  }
  tray.setToolTip(`Face Guard — ${statusLine()}`);
}

function createTray(): void {
  tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, 'tray-paused.png')));
  tray.on('click', toggleWindow);
  tray.on('double-click', showWindow);
  updateTray();
  rebuildTrayMenu();
}

let lastMenuKey = '';
ipcMain.on('fg:status', (_e, next: StatusUpdate) => {
  status = next;
  updateTray();
  // Rebuilding the menu on every touch/watch flip is wasteful; only when something shown in it changes.
  const running = !['paused', 'idle', 'error'].includes(next.state);
  const key = `${running}|${next.state === 'paused' ? next.pausedUntil : ''}|${next.alertsToday}|${STATE_LABEL[next.state]}`;
  if (key !== lastMenuKey) {
    lastMenuKey = key;
    rebuildTrayMenu();
  }
});

ipcMain.handle('fg:get-open-at-login', () => getOpenAtLogin());
ipcMain.handle('fg:set-open-at-login', (_e, enabled: boolean) => setOpenAtLogin(Boolean(enabled)));
ipcMain.handle('fg:app-info', () => ({ version: app.getVersion(), store: IS_STORE, packaged: app.isPackaged }));
ipcMain.handle('fg:open-startup-settings', () => openStartupSettings());
ipcMain.handle('fg:uninstall', () => uninstall());

/* ---------------- lifecycle ---------------- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    // Store builds get their identity from the package; setting our own would break their toasts.
    if (!IS_STORE) app.setAppUserModelId(app.isPackaged ? APP_ID : process.execPath);
    Menu.setApplicationMenu(null);
    registerAppProtocol();

    // Only the camera (no microphone) and notifications, only for our own pages.
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
      const ours = wc.getURL().startsWith(ORIGIN);
      if (permission === 'media') {
        const types = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
        callback(ours && types.every((t) => t === 'video'));
        return;
      }
      callback(ours && permission === 'notifications');
    });
    session.defaultSession.setPermissionCheckHandler((wc, permission) => {
      const ours = (wc?.getURL() ?? '').startsWith(ORIGIN);
      return ours && (permission === 'media' || permission === 'notifications');
    });

    // First launch of the installed app: start with Windows by default (toggle in tray or settings).
    const st = readState();
    if (!st.firstRunDone) {
      writeState({ firstRunDone: true });
      if (app.isPackaged && !IS_STORE) setOpenAtLogin(true);
    }

    // Installer build: the login entry passes --hidden. Store build: Windows' startup task can't pass
    // arguments, so treat a launch in the first few minutes after boot as an automatic start.
    const startHidden = process.argv.includes('--hidden') || (IS_STORE && os.uptime() < 300);
    createWindow(startHidden);
    createTray();

    // Turn the camera off while the PC is locked; turn it back on when you return.
    powerMonitor.on('lock-screen', () => {
      if (!['paused', 'idle'].includes(status.state)) {
        pausedByLock = true;
        sendCommand({ type: 'pause', minutes: null });
      }
    });
    powerMonitor.on('unlock-screen', () => {
      if (pausedByLock) {
        pausedByLock = false;
        sendCommand({ type: 'resume' });
      }
    });
  });

  app.on('before-quit', () => {
    quitting = true;
  });

  // The tray keeps the app alive; never quit just because the window is hidden.
  app.on('window-all-closed', () => undefined);
}
