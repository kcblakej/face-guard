# Face Guard

A small desktop app that watches your webcam and warns you when you touch your face.
If a touch lasts longer than **2 seconds**, you get a notification. Everything runs on your device. No video, frames or landmarks are ever uploaded.

- **Windows desktop app** (Electron): lives in the system tray, keeps watching while minimized, starts with Windows, and shows native notifications or an always-on-top popup.
- **Installable web app (PWA)**: the same code runs in any modern browser, and on iPhone you can add it to the Home Screen.

## How it works

```
camera ──► frame source ──► MediaPipe (WASM + WebGL) ──► touch rules ──► tracker ──► alert
            │                  ├─ Face Landmarker (478 pts)   │               │
            │                  └─ Hand Landmarker (21 pts ×2) │               └─ 2 s threshold,
            │                                                  │                  400 ms flicker grace,
            └─ MediaStreamTrackProcessor (keeps running        │                  optional repeat
               when the window is hidden) or <video> fallback  │
                                                               ├─ face-oval polygon (+ margin)
                                                               ├─ fingertips / palm inside it?
                                                               ├─ depth filter: palm size vs face size
                                                               └─ face memory while a hand occludes it
```

A few details that make it reliable:

| Problem | Approach |
|---|---|
| 2D camera can't tell "hand on face" from "hand in front of face" | Compares apparent palm size to face size. A hand much closer to the lens looks too big and is ignored. |
| Drinking from a cup or bottle looks like a hand at your mouth | While a hand is near your face, a third model (EfficientDet-Lite0) checks for a cup, bottle or glass 5 times a second. It searches a crop around your face and hands, which gives it about twice the resolution. It usually spots the drink on the way up, before the drink gets hidden against your mouth. The hand holding it (tracked by left/right) is then excused for 4 s after the drink was last seen in it. Your other hand is still checked. |
| The face detector loses your face when your hand covers it | `FaceMemory` keeps the last face outline for up to 10 s while a hand sits over it. |
| Detection flickers for a frame or two | The tracker tolerates short dropouts (400 ms) before it ends a touch. |
| Browsers throttle hidden pages | Frames are read straight off the camera track, a Web Worker drives the clock, and Electron runs with background throttling disabled. |
| Camera unplugged or PC asleep | Retries automatically. The camera also turns off while Windows is locked and comes back on when you unlock. |

The detection logic (`src/core/`) is pure TypeScript with no DOM or MediaPipe dependency, so it's unit-tested directly.

## Run it on Windows

Requires [Node.js](https://nodejs.org) 20+.

```powershell
cd face-guard
npm install          # also downloads the three models (~18 MB) into ./models
npm start            # builds and launches the desktop app
```

### Build the installer

```powershell
npm run dist         # -> release\FaceGuard-Setup-1.0.0.exe   (setup wizard + uninstaller)
npm run dist:store   # -> release\FaceGuard-1.0.0-Store.appx  (Microsoft Store package)
```

The setup wizard installs for the current user by default, with no admin rights needed. Face Guard then starts in the tray and registers itself to start with Windows; you can turn that off from the tray menu or in Settings.

**Uninstalling:** use *Settings → Apps → Installed apps → Face Guard → Uninstall*, or the **Uninstall…** link at the bottom of Face Guard's settings. It removes the startup entry and asks whether to delete your settings and history.

**Sharing and the Microsoft Store:** see **[docs/DISTRIBUTING.md](docs/DISTRIBUTING.md)**. The Store is free and trusted by Windows out of the box. For a signed direct-download installer, the build signs automatically once signing credentials are configured. An unsigned installer still works, but Windows SmartScreen will warn (**More info → Run anyway**).

### Sign-out after repeated alerts

This is **off by default**; turn it on in Settings. Once it's on, if you rack up **3 strikes within 5 minutes**, Face Guard signs you out of Windows. You can change this under **Settings → Consequences**:

- **Action:** sign out, or just lock the PC.
- **Strikes and time window:** 2–10 strikes within 1–30 minutes.
- **Warning first:** a centered, always-on-top countdown (15 s by default) so you can save your work. Set it to 0 to act immediately.
- **Allow cancelling:** when this is on, the countdown has a Cancel button and Esc also cancels. Turn it off to make the countdown unskippable.

**Every alert is a strike, including repeat alerts.** If you keep touching, each repeat (set by the *Repeat while touching* slider, 10 s by default) adds another strike. With the defaults, one continuous touch of about 22 seconds (alerts at 2 s, 12 s and 22 s) is enough to sign you out. Set *Repeat while touching* to off and each touch counts once, however long it lasts. The Today card shows your current strikes and when the oldest one clears. Sign-out runs `shutdown /l` without `/f`, so apps with unsaved work get the normal "save changes?" chance and aren't force-closed. Lock uses `LockWorkStation`. This feature is desktop-only.

**Tray menu:** status, pause 15 min / 1 hour / until resumed, *Start with Windows*, quit.
Closing the window just hides it. Use **Quit** from the tray menu to exit.

### Laptop

Do the same steps on the laptop, or copy `release\FaceGuard-Setup-*.exe` over and run it.

## iPhone (later)

Camera access on iPhone requires HTTPS, so the easiest route is GitHub Pages:

1. Push this repo to GitHub.
2. Go to **Settings → Pages → Source** and pick **GitHub Actions**. The `pages.yml` workflow deploys `dist/web` on every push to `main`.
3. On your iPhone, open the Pages URL in Safari, then tap **Share → Add to Home Screen**.

iOS limits: the camera only runs while the app is open on screen (no background monitoring on iPhone). Notifications from Home Screen web apps need iOS 16.4 or later. The in-app banner and sound always work. Face Guard keeps the screen awake while it's watching.

A native Swift version using Apple's Vision framework (hand pose + face landmarks) is the natural next step if you want lock-screen notifications. The touch rules in `src/core/` port over almost line for line.

## Tuning

Open **Settings** in the app. The footer under the camera shows live diagnostics:
`fps · inference ms · GPU/CPU · frame source · face · hands · reason · hand/face ratio`.

- **Drinking still triggers alerts:** first check **Settings → Ignore drinking**. The green line under it should say *Cup/bottle detector ready*. If it's red, run `npm run fetch-models` and rebuild. Then watch the footer while you lift the drink: it should show something like `cup 64% · holding: Right` on the way up and `drinking` at your mouth. If it keeps saying `no drink seen`, the model isn't recognising that container. Lift it a little more slowly, so the camera sees its side before it reaches your mouth.
- **False alarms when you gesture near your face:** lower *Max hand/face size* (try 1.1).
- **Missed touches at the jaw or forehead:** raise *Face zone margin* (try 12–15%).
- **Detection stops while the window is hidden:** turn off *Use GPU*.
- **Eating, a video call, adjusting glasses:** use Pause (15 min / 1 hour). Pausing turns the camera off.
- **Alerts don't appear:** Windows *Do Not Disturb* hides toasts. Switch *Alert style* to **Always-on-top popup**.

## Develop

```bash
npm run dev:web      # web UI with live rebuild at http://localhost:5173 (camera works on localhost)
npm test             # unit tests for the detection core (node:test via tsx)
npm run typecheck
npm run test:smoke   # headless end-to-end run with Chromium's fake camera + mocked models
                     # (needs: npm i -D playwright && npx playwright install chromium)
```

```
src/
  core/         geometry, touch rules (incl. drink check), touch tracker, strikes, stats   (pure TS, unit-tested)
  renderer/     web UI: camera, MediaPipe wrapper, monitor loop, overlay, settings
    public/     index.html, styles, PWA manifest, icons, popup window
  electron/     main process (tray, notifications, popup, app:// protocol, login item) + preload
  shared/       typed bridge contract between the UI and the Electron shell
scripts/        esbuild build, model download, icon + Store tile generator
build/          icons, Store tiles (appx/), uninstaller script (installer.nsh), Store identity
docs/           DISTRIBUTING.md: Microsoft Store submission and code signing
tests/          unit tests, smoke test, MediaPipe mock
github-workflows/  CI, Windows release on tag, GitHub Pages deploy (move to .github/workflows/)
```

**Security:** the renderer runs sandboxed with context isolation and no Node access. It talks to the shell only through a small typed bridge (`src/shared/bridge.ts`). Pages are served from a custom `app://` scheme with a strict CSP. The camera is the only permission granted, and the microphone is never requested.

## Releasing

> The workflows are in `github-workflows/`. Move that folder to `.github/workflows/` before your first push (PowerShell: `mkdir .github; move github-workflows .github\workflows`).

Push a tag like `v1.0.1`. `release.yml` builds the installer on `windows-latest` and attaches it to a GitHub Release.

## License

MIT
