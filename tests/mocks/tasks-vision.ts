/**
 * Stand-in for @mediapipe/tasks-vision used by the headless smoke test (tests/smoke.mjs).
 * The test drives what the "models" see by setting window.__scene.
 */
import { syntheticFace, syntheticHand } from '../fixtures';

/**
 * drink:        mug in the hand at the mouth, visible to the cup detector
 * drink-hidden: same pose, but the detector can't see the mug (tipped up / occluded)
 * drink-far:    hand on the face, mug sitting on the desk
 */
type Scene = 'clear' | 'touch' | 'wave' | 'away' | 'drink' | 'drink-hidden' | 'drink-far';
declare global {
  interface Window {
    __scene?: Scene;
    __detectCalls?: number;
    __drinkCalls?: number;
  }
}

const FACE = syntheticFace();
const TOUCH_HAND = syntheticHand(400, 420, 110);
const WAVE_HAND = syntheticHand(320, 600, 300);

export class FilesetResolver {
  static async forVisionTasks(): Promise<object> {
    return {};
  }
}

const scene = (): Scene => window.__scene ?? 'clear';

export class FaceLandmarker {
  static async createFromOptions(): Promise<FaceLandmarker> {
    return new FaceLandmarker();
  }
  detectForVideo(_src: unknown, _ts: number) {
    window.__detectCalls = (window.__detectCalls ?? 0) + 1;
    return { faceLandmarks: scene() === 'away' ? [] : [FACE] };
  }
  close(): void {}
}

export class HandLandmarker {
  static async createFromOptions(): Promise<HandLandmarker> {
    return new HandLandmarker();
  }
  detectForVideo(_src: unknown, _ts: number) {
    const s = scene();
    const touching = s === 'touch' || s.startsWith('drink');
    const landmarks = touching ? [TOUCH_HAND] : s === 'wave' ? [WAVE_HAND] : [];
    const handedness = landmarks.map(() => [{ categoryName: 'Right', score: 0.9, index: 0, displayName: '' }]);
    return { landmarks, worldLandmarks: [], handedness, handednesses: handedness };
  }
  close(): void {}
}

/** 'drink': a cup in the hand at the mouth. 'drink-far': a cup on the desk, nowhere near the hand. */
export class ObjectDetector {
  static async createFromOptions(): Promise<ObjectDetector> {
    if ((window as { __failDrinkModel?: boolean }).__failDrinkModel) throw new Error('Failed to fetch model');
    return new ObjectDetector();
  }
  detectForVideo(src: { width: number; height: number }, _ts: number) {
    window.__drinkCalls = (window.__drinkCalls ?? 0) + 1;
    // Scene boxes are defined in full-frame fractions; the app hands us a crop, so map into it.
    const video = document.querySelector('video') as HTMLVideoElement;
    const W = video.videoWidth || 640;
    const H = video.videoHeight || 480;
    const crop = (globalThis as { __fgDrinkCrop?: { sx: number; sy: number; scale: number } }).__fgDrinkCrop ?? {
      sx: 0,
      sy: 0,
      scale: 1,
    };
    const s = scene();
    const f = s === 'drink' ? [0.53, 0.52, 0.17, 0.31] : s === 'drink-far' ? [0.02, 0.75, 0.12, 0.2] : null;
    const detections = [];
    if (f) {
      const box = {
        originX: (f[0] * W - crop.sx) * crop.scale,
        originY: (f[1] * H - crop.sy) * crop.scale,
        width: f[2] * W * crop.scale,
        height: f[3] * H * crop.scale,
        angle: 0,
      };
      // Like the real model, only report what's inside the image we were given.
      if (box.originX + box.width > 0 && box.originY + box.height > 0 && box.originX < src.width && box.originY < src.height) {
        detections.push({ boundingBox: box, categories: [{ categoryName: 'cup', score: 0.8, index: 0, displayName: '' }], keypoints: [] });
      }
    }
    return { detections };
  }
  close(): void {}
}
