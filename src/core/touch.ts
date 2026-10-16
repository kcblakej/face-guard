import {
  type NormalizedPoint,
  type Point,
  distance,
  pointInPolygon,
  scalePolygon,
  toPixels,
} from './geometry';

/**
 * Face-mesh landmark indices tracing the face silhouette, in order (MediaPipe FACEMESH_FACE_OVAL).
 * Starts at the top of the forehead (10) and goes clockwise around to the chin (152) and back.
 */
export const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
  172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
] as const;

const FOREHEAD = 10;
const CHIN = 152;
const LEFT_EDGE = 234;
const RIGHT_EDGE = 454;

/** Hand landmark indices (MediaPipe hand model, 21 points). */
export const HAND = {
  WRIST: 0,
  INDEX_MCP: 5,
  MIDDLE_MCP: 9,
  PINKY_MCP: 17,
  /** Finger tips + the joint just below each tip: the parts that actually touch skin. */
  FINGER_CONTACT: [3, 4, 7, 8, 11, 12, 15, 16, 19, 20] as const,
  /** Palm / knuckle points: resting a cheek or chin on the palm. */
  PALM: [0, 1, 5, 9, 13, 17] as const,
};

/** A face reduced to what the touch check needs, in pixel space. */
export interface FaceShape {
  outline: Point[];
  /** Characteristic size of the face in pixels (used to judge hand depth). */
  size: number;
}

export interface TouchSettings {
  /** Grow the face outline by this fraction before testing (0.08 = 8%). */
  margin: number;
  /** Reject a hand that looks much closer to the camera than the face. */
  depthFilter: boolean;
  /** Max palm-size / face-size ratio still considered "at the face" when depthFilter is on. */
  maxHandFaceRatio: number;
}

export const DEFAULT_TOUCH_SETTINGS: TouchSettings = {
  margin: 0.08,
  depthFilter: true,
  maxHandFaceRatio: 1.3,
};

export interface TouchResult {
  touching: boolean;
  /** Why the result is what it is — shown in the debug overlay. */
  reason: 'no-face' | 'no-hands' | 'clear' | 'touching' | 'hand-in-front' | 'drinking';
  /** Index of the hand that is touching (or rejected), if any. */
  handIndex: number | null;
  /** palm size / face size for the closest candidate hand. */
  ratio: number | null;
  /** Hand points (pixels) found inside the face outline, for drawing. */
  contactPoints: Point[];
}

export function faceShapeFromLandmarks(
  landmarks: readonly NormalizedPoint[],
  width: number,
  height: number,
): FaceShape | null {
  if (landmarks.length < 455) return null;
  const px = (i: number) => toPixels(landmarks[i], width, height);
  const outline = FACE_OVAL.map(px);
  const faceWidth = distance(px(LEFT_EDGE), px(RIGHT_EDGE));
  const faceHeight = distance(px(FOREHEAD), px(CHIN));
  // When the head turns sideways the width collapses, so lean on height too.
  const size = Math.max(faceWidth, faceHeight * 0.8);
  return { outline, size };
}

/** Rough apparent size of a palm, robust to the hand being rotated. */
export function palmSize(hand: readonly Point[]): number {
  return Math.max(
    distance(hand[HAND.WRIST], hand[HAND.MIDDLE_MCP]),
    distance(hand[HAND.INDEX_MCP], hand[HAND.PINKY_MCP]) * 1.25,
  );
}

/**
 * Optional veto for a hand that is at the face: return true to ignore it (e.g. it's holding a drink).
 * Only called for hands that would otherwise count as touching, so it can run expensive checks lazily.
 */
export type TouchExcuse = (hand: readonly Point[], handIndex: number, face: FaceShape) => boolean;

export function evaluateTouch(
  face: FaceShape | null,
  handsNormalized: readonly (readonly NormalizedPoint[])[],
  width: number,
  height: number,
  settings: TouchSettings = DEFAULT_TOUCH_SETTINGS,
  excuse?: TouchExcuse,
): TouchResult {
  const base = { handIndex: null, ratio: null, contactPoints: [] as Point[] };
  if (!face) return { touching: false, reason: 'no-face', ...base };
  if (handsNormalized.length === 0) return { touching: false, reason: 'no-hands', ...base };

  const zone = scalePolygon(face.outline, 1 + settings.margin);
  let rejected: TouchResult | null = null;

  for (let h = 0; h < handsNormalized.length; h++) {
    const hand = handsNormalized[h].map((p) => toPixels(p, width, height));
    if (hand.length < 21) continue;

    const fingerHits = HAND.FINGER_CONTACT.map((i) => hand[i]).filter((p) => pointInPolygon(p, zone));
    const palmHits = HAND.PALM.map((i) => hand[i]).filter((p) => pointInPolygon(p, zone));
    const overlaps = fingerHits.length >= 1 || palmHits.length >= 2;
    if (!overlaps) continue;

    const ratio = face.size > 0 ? palmSize(hand) / face.size : null;
    const contactPoints = [...fingerHits, ...palmHits];

    if (settings.depthFilter && ratio !== null && ratio > settings.maxHandFaceRatio) {
      // Hand overlaps the face in the image but is far closer to the camera: e.g. waving, reaching for the webcam.
      rejected ??= { touching: false, reason: 'hand-in-front', handIndex: h, ratio, contactPoints };
      continue;
    }
    if (excuse?.(hand, h, face)) {
      // Holding a cup or bottle to your mouth: drinking, not touching.
      rejected = { touching: false, reason: 'drinking', handIndex: h, ratio, contactPoints };
      continue;
    }
    return { touching: true, reason: 'touching', handIndex: h, ratio, contactPoints };
  }

  return rejected ?? { touching: false, reason: 'clear', ...base };
}

/**
 * Remembers the last seen face for a while. A hand over the face often makes the face
 * detector lose it — exactly when we most need to know where the face is.
 */
export class FaceMemory {
  private last: FaceShape | null = null;
  private lastSeen = -Infinity;

  constructor(
    /** How long to keep a lost face when nothing is covering it. */
    private readonly holdMs = 1200,
    /** How long to keep it while a hand sits where the face was. */
    private readonly occludedHoldMs = 10000,
  ) {}

  update(face: FaceShape | null, now: number, handOverLastFace: boolean): FaceShape | null {
    if (face) {
      this.last = face;
      this.lastSeen = now;
      return face;
    }
    if (!this.last) return null;
    const age = now - this.lastSeen;
    const limit = handOverLastFace ? this.occludedHoldMs : this.holdMs;
    if (age <= limit) return this.last;
    this.last = null;
    return null;
  }

  get current(): FaceShape | null {
    return this.last;
  }

  reset(): void {
    this.last = null;
    this.lastSeen = -Infinity;
  }
}
