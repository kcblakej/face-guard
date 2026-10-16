import { FaceLandmarker, FilesetResolver, HandLandmarker, ObjectDetector } from '@mediapipe/tasks-vision';
import type { Box, NormalizedPoint } from '../core/geometry';
import type { Drink } from '../core/drink';

/** Where the build script puts the WASM runtime and models (relative to index.html). */
const WASM_DIR = new URL('./wasm', document.baseURI).href;
const LOCAL_MODELS = {
  face: new URL('./models/face_landmarker.task', document.baseURI).href,
  hand: new URL('./models/hand_landmarker.task', document.baseURI).href,
  objects: new URL('./models/efficientdet_lite0.tflite', document.baseURI).href,
};
/** Used only if the local copy is missing (e.g. `npm run fetch-models` never ran). */
const REMOTE_MODELS = {
  face: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  hand: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
};

/** Drink detector model: bundled copy first, then the published variants (any one of them works). */
const OBJECT_MODEL_URLS = [
  'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite',
  'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite',
  'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/1/efficientdet_lite0.tflite',
];

/** COCO classes that mean "a drink". */
const DRINK_CLASSES = ['cup', 'bottle', 'wine glass'];

export type FrameInput = HTMLVideoElement | ImageBitmap;

export interface Detection {
  face: NormalizedPoint[] | null;
  hands: NormalizedPoint[][];
  /** Stable-ish id per hand ("Left" / "Right" from the model), parallel to `hands`. */
  handKeys: string[];
  width: number;
  height: number;
  inferenceMs: number;
}

type Delegate = 'GPU' | 'CPU';

async function exists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}

export class Detector {
  private lastTs = 0;
  private lastObjectTs = 0;
  private cropCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;

  private constructor(
    private readonly face: FaceLandmarker,
    private readonly hand: HandLandmarker,
    readonly delegate: Delegate,
    /** Cup / bottle detector; null if it couldn't be loaded (drink detection is then off). */
    private readonly objects: ObjectDetector | null,
    /** Human-readable state of the drink detector, shown in Settings. */
    readonly drinkStatus: string,
  ) {}

  get canDetectDrinks(): boolean {
    return this.objects !== null;
  }

  static async create(useGpu: boolean, onProgress?: (msg: string) => void): Promise<Detector> {
    onProgress?.('Loading vision runtime…');
    const vision = await FilesetResolver.forVisionTasks(WASM_DIR);

    const faceModel = (await exists(LOCAL_MODELS.face)) ? LOCAL_MODELS.face : REMOTE_MODELS.face;
    const handModel = (await exists(LOCAL_MODELS.hand)) ? LOCAL_MODELS.hand : REMOTE_MODELS.hand;
    const localObjects = await exists(LOCAL_MODELS.objects);
    const objectModels = localObjects ? [LOCAL_MODELS.objects, ...OBJECT_MODEL_URLS] : OBJECT_MODEL_URLS;

    const buildObjects = async (delegate: Delegate): Promise<{ det: ObjectDetector | null; status: string }> => {
      let lastError = '';
      for (const url of objectModels) {
        for (const d of delegate === 'GPU' ? (['GPU', 'CPU'] as const) : (['CPU'] as const)) {
          try {
            const det = await ObjectDetector.createFromOptions(vision, {
              baseOptions: { modelAssetPath: url, delegate: d },
              runningMode: 'VIDEO',
              scoreThreshold: 0.2,
              maxResults: 5,
              categoryAllowlist: DRINK_CLASSES,
            });
            const where = url === LOCAL_MODELS.objects ? 'bundled model' : 'downloaded at startup';
            return { det, status: `Cup/bottle detector ready (${where}, ${d}).` };
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            console.warn(`[face-guard] drink detector failed (${url}, ${d})`, err);
          }
        }
      }
      // Not fatal: touch detection still works, drinks just aren't recognised.
      const hint = localObjects ? '' : ' Run "npm run fetch-models", then rebuild.';
      return { det: null, status: `Cup/bottle detector failed to load: ${lastError || 'unknown error'}.${hint}` };
    };

    const build = async (delegate: Delegate) => {
      const face = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: faceModel, delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      const hand = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: handModel, delegate },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      const objects = await buildObjects(delegate);
      return new Detector(face, hand, delegate, objects.det, objects.status);
    };

    onProgress?.('Loading face & hand models…');
    if (!useGpu) return build('CPU');
    try {
      return await build('GPU');
    } catch (err) {
      console.warn('[face-guard] GPU delegate failed, falling back to CPU', err);
      onProgress?.('GPU unavailable — using CPU…');
      return await build('CPU');
    }
  }

  detect(frame: FrameInput): Detection {
    // MediaPipe requires strictly increasing timestamps in VIDEO mode.
    const ts = Math.max(performance.now(), this.lastTs + 1);
    this.lastTs = ts;
    const t0 = performance.now();
    const faceRes = this.face.detectForVideo(frame, ts);
    const handRes = this.hand.detectForVideo(frame, ts);
    const width = frame instanceof HTMLVideoElement ? frame.videoWidth : frame.width;
    const height = frame instanceof HTMLVideoElement ? frame.videoHeight : frame.height;
    return {
      face: faceRes.faceLandmarks[0] ?? null,
      handKeys: handRes.landmarks.map((_, i) => handRes.handedness?.[i]?.[0]?.categoryName || `hand${i}`),
      hands: handRes.landmarks,
      width,
      height,
      inferenceMs: performance.now() - t0,
    };
  }

  /**
   * Cups / bottles / glasses, as pixel boxes in full-frame coordinates.
   * `region` (pixels) crops the search to the face-and-hands area for better resolution.
   */
  detectDrinks(frame: FrameInput, region: Box | null, frameW: number, frameH: number): Drink[] {
    if (!this.objects) return [];
    const r = region ?? { minX: 0, minY: 0, maxX: frameW, maxY: frameH };
    const sw = Math.max(1, Math.round(r.maxX - r.minX));
    const sh = Math.max(1, Math.round(r.maxY - r.minY));
    // Upscale small crops a little; cap the size to keep it fast.
    const scale = Math.min(2, 480 / Math.max(sw, sh));
    const dw = Math.max(1, Math.round(sw * scale));
    const dh = Math.max(1, Math.round(sh * scale));

    this.cropCanvas ??= typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(dw, dh) : document.createElement('canvas');
    const canvas = this.cropCanvas;
    if (canvas.width !== dw) canvas.width = dw;
    if (canvas.height !== dh) canvas.height = dh;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) return [];
    ctx.drawImage(frame, Math.round(r.minX), Math.round(r.minY), sw, sh, 0, 0, dw, dh);

    const crop = { sx: Math.round(r.minX), sy: Math.round(r.minY), scale };
    // Exposed so the headless test's fake model can map its boxes into this crop.
    (globalThis as { __fgDrinkCrop?: typeof crop }).__fgDrinkCrop = crop;

    const ts = Math.max(performance.now(), this.lastObjectTs + 1);
    this.lastObjectTs = ts;
    const res = this.objects.detectForVideo(canvas, ts);
    return res.detections.flatMap((d) => {
      const b = d.boundingBox;
      if (!b) return [];
      const cat = d.categories[0];
      return [
        {
          minX: crop.sx + b.originX / scale,
          minY: crop.sy + b.originY / scale,
          maxX: crop.sx + (b.originX + b.width) / scale,
          maxY: crop.sy + (b.originY + b.height) / scale,
          label: cat?.categoryName ?? 'drink',
          score: cat?.score ?? 0,
        },
      ];
    });
  }

  close(): void {
    this.face.close();
    this.hand.close();
    this.objects?.close();
  }
}
