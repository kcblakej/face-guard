import type { MonitorState } from '../shared/bridge';
import { boundingBox, toPixels } from '../core/geometry';
import { DrinkTracker, drinkSearchRegion, handNearFace, type Drink } from '../core/drink';
import {
  FaceMemory,
  evaluateTouch,
  faceShapeFromLandmarks,
  type FaceShape,
  type TouchExcuse,
  type TouchResult,
} from '../core/touch';
import { TouchTracker, type TrackerEvent } from '../core/tracker';
import { Detector, type Detection, type FrameInput } from './detector';
import { Ticker, createFrameSource, openCamera, stopStream, type FrameSource } from './camera';
import type { Settings } from './settings';

/** No face for this long => you've stepped away; stop counting. */
const AWAY_AFTER_MS = 3000;
const CAMERA_RETRY_MS = 5000;
/** Detection checks per second. */
const DETECTION_FPS = 10;
/** How often to look for a cup / bottle while a hand is near the face. */
const DRINK_SCAN_MS = 400;

export interface FrameReport {
  detection: Detection;
  face: FaceShape | null;
  faceIsRemembered: boolean;
  result: TouchResult;
  /** Drinks (cup / bottle boxes, pixels) seen near the face in the last second. */
  drinks: Drink[];
  /** Short drink-detector status for the diagnostics footer ('' when idle). */
  drinkNote: string;
  state: MonitorState;
  progress: number;
  durationMs: number;
  fps: number;
}

export interface MonitorCallbacks {
  onState(state: MonitorState, detail?: string): void;
  onFrame(report: FrameReport): void;
  onEvent(event: TrackerEvent): void;
}

export class Monitor {
  state: MonitorState = 'idle';
  frameSourceKind = '';
  private detector: Detector | null = null;
  private stream: MediaStream | null = null;
  private source: FrameSource | null = null;
  private readonly ticker = new Ticker(() => void this.tick());
  private readonly tracker = new TouchTracker();
  private readonly faceMemory = new FaceMemory();
  private readonly drinkTracker = new DrinkTracker();
  private lastDrinkScan = -Infinity;
  private lastDrinks: Drink[] = [];
  private busy = false;
  private lastFaceAt = 0;
  private frameTimes: number[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private wanted = false;
  private starting: Promise<void> | null = null;

  constructor(
    private readonly video: HTMLVideoElement,
    private settings: Settings,
    private readonly cb: MonitorCallbacks,
  ) {
    this.applySettings(settings);
  }

  /** Whether the cup/bottle detector loaded (shown in Settings). */
  get drinkStatus(): string {
    return this.detector?.drinkStatus ?? '';
  }

  get delegate(): string {
    return this.detector?.delegate ?? '';
  }

  applySettings(s: Settings): void {
    const cameraChanged = s.cameraId !== this.settings.cameraId;
    const gpuChanged = s.useGpu !== this.settings.useGpu;
    this.settings = s;
    this.tracker.options = {
      thresholdMs: s.thresholdSec * 1000,
      repeatMs: s.repeatSec * 1000,
      graceMs: 400,
    };
    if (gpuChanged && this.detector) {
      // Rebuild the models on the new backend.
      const wasRunning = this.isRunning;
      if (wasRunning) this.stop();
      this.detector.close();
      this.detector = null;
      if (wasRunning) void this.start();
      return;
    }
    if (this.isRunning && cameraChanged) void this.restartCamera();
  }

  get isRunning(): boolean {
    return this.stream !== null;
  }

  start(): Promise<void> {
    this.wanted = true;
    if (this.isRunning) return Promise.resolve();
    this.starting ??= this.doStart().finally(() => (this.starting = null));
    return this.starting;
  }

  private async doStart(): Promise<void> {
    this.clearRetry();
    this.setState('starting', 'Loading models…');
    try {
      this.detector ??= await Detector.create(this.settings.useGpu, (msg) => this.setState('starting', msg));
      if (!this.wanted) return; // stopped while loading
      this.setState('starting', 'Opening camera…');
      await this.openCamera();
      if (!this.wanted) {
        this.closeCamera(); // paused while the camera was opening
        return;
      }
      this.setState('watching');
    } catch (err) {
      this.handleStartError(err);
    }
  }

  /** Stop watching and release the camera (webcam light goes off). */
  stop(state: MonitorState = 'idle'): void {
    this.wanted = false;
    this.clearRetry();
    this.closeCamera();
    this.tracker.reset();
    this.faceMemory.reset();
    this.drinkTracker.reset();
    this.lastDrinks = [];
    this.setState(state);
  }

  private async openCamera(): Promise<void> {
    this.stream = await openCamera(this.settings.cameraId);
    const track = this.stream.getVideoTracks()[0];
    track?.addEventListener('ended', () => this.onCameraLost());
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => undefined);
    this.source = createFrameSource(this.stream, this.video);
    this.frameSourceKind = this.source.kind;
    this.lastFaceAt = performance.now();
    this.ticker.start(1000 / DETECTION_FPS);
  }

  private closeCamera(): void {
    this.ticker.stop();
    this.source?.stop();
    this.source = null;
    stopStream(this.stream);
    this.stream = null;
    this.video.srcObject = null;
  }

  private async restartCamera(): Promise<void> {
    this.closeCamera();
    try {
      await this.openCamera();
      this.setState('watching');
    } catch (err) {
      this.handleStartError(err);
    }
  }

  private onCameraLost(): void {
    if (!this.wanted) return;
    this.closeCamera();
    this.setState('error', 'Camera disconnected — retrying…');
    this.scheduleRetry();
  }

  private handleStartError(err: unknown): void {
    const e = err as { name?: string; message?: string };
    this.closeCamera();
    let msg = e?.message || String(err);
    if (e?.name === 'NotAllowedError') msg = 'Camera permission was denied.';
    else if (e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError') msg = 'No camera found.';
    else if (e?.name === 'NotReadableError') msg = 'Camera is busy or unavailable — retrying…';
    console.error('[face-guard]', err);
    this.setState('error', msg);
    if (this.wanted && this.detector && e?.name !== 'NotAllowedError') this.scheduleRetry();
  }

  private scheduleRetry(): void {
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.wanted && !this.isRunning) void this.restartCamera();
    }, CAMERA_RETRY_MS);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private setState(state: MonitorState, detail?: string): void {
    const changed = state !== this.state;
    this.state = state;
    if (changed || detail) this.cb.onState(state, detail);
  }

  private async tick(): Promise<void> {
    if (this.busy || !this.source || !this.detector) return;
    this.busy = true;
    try {
      const frame = await this.source.grab();
      if (!frame || !this.source) return;
      try {
        const detection: Detection = this.detector.detect(frame);
        // The frame stays alive through process() so the drink detector can look at it if needed.
        this.process(detection, frame, performance.now());
      } finally {
        this.source?.release(frame);
      }
    } catch (err) {
      console.error('[face-guard] detection failed', err);
    } finally {
      this.busy = false;
    }
  }

  private process(detection: Detection, frame: FrameInput, now: number): void {
    const { width, height } = detection;
    const touchSettings = {
      margin: this.settings.marginPct / 100,
      depthFilter: this.settings.depthFilter,
      maxHandFaceRatio: this.settings.maxHandFaceRatio,
    };

    const seenFace = detection.face ? faceShapeFromLandmarks(detection.face, width, height) : null;
    const remembered = this.faceMemory.current;
    const handOverLastFace =
      !seenFace && remembered !== null && evaluateTouch(remembered, detection.hands, width, height, touchSettings).touching;
    const face = this.faceMemory.update(seenFace, now, handOverLastFace);
    if (seenFace) this.lastFaceAt = now;

    // Drinks: while a hand is near the face, look for a cup / bottle a few times a second (starting
    // on the way up, before the mug is hidden against your mouth) and remember which hand holds it.
    const detector = this.detector;
    const handsPx = detection.hands.map((h) => h.map((p) => toPixels(p, width, height)));
    const handKey = (i: number) => detection.handKeys[i] ?? `hand${i}`;
    if (this.settings.ignoreDrinking && detector?.canDetectDrinks && face && handsPx.length) {
      const faceBox = boundingBox(face.outline);
      if (handNearFace(faceBox, handsPx) && now - this.lastDrinkScan >= DRINK_SCAN_MS) {
        this.lastDrinkScan = now;
        const region = drinkSearchRegion(faceBox, handsPx, width, height);
        this.lastDrinks = detector.detectDrinks(frame, region, width, height);
        this.drinkTracker.observe(
          handsPx.map((points, i) => ({ key: handKey(i), points })),
          this.lastDrinks,
          now,
        );
      }
    }
    const drinking: TouchExcuse | undefined = this.settings.ignoreDrinking
      ? (_hand, i) => this.drinkTracker.isHolding(handKey(i), now)
      : undefined;
    const result = evaluateTouch(face, detection.hands, width, height, touchSettings, drinking);
    for (const ev of this.tracker.update(result.touching, now)) this.cb.onEvent(ev);

    let state: MonitorState;
    if (this.tracker.active) state = this.tracker.alerted ? 'alert' : 'touching';
    else if (now - this.lastFaceAt > AWAY_AFTER_MS) state = 'away';
    else state = 'watching';
    this.setState(state);

    this.frameTimes.push(now);
    while (this.frameTimes.length && now - this.frameTimes[0] > 2000) this.frameTimes.shift();
    const fps = this.frameTimes.length > 1 ? (this.frameTimes.length - 1) / ((now - this.frameTimes[0]) / 1000) : 0;

    const recentDrinks = now - this.lastDrinkScan < 1000 ? this.lastDrinks : [];
    let drinkNote = '';
    if (this.settings.ignoreDrinking && now - this.lastDrinkScan < 1000) {
      const best = [...recentDrinks].sort((a, b) => b.score - a.score)[0];
      const holding = this.drinkTracker.anyHolding(now);
      drinkNote = best ? `${best.label} ${Math.round(best.score * 100)}%` : 'no drink seen';
      if (holding.length) drinkNote += ` · holding: ${holding.join('+')}`;
    }

    this.cb.onFrame({
      detection,
      face,
      faceIsRemembered: face !== null && seenFace === null,
      result,
      drinks: recentDrinks,
      drinkNote,
      state,
      progress: this.tracker.progressAt(now),
      durationMs: this.tracker.durationAt(now),
      fps,
    });
  }
}
