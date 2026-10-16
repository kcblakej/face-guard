import type { NormalizedPoint } from '../src/core/geometry';
import { FACE_OVAL } from '../src/core/touch';

export const W = 640;
export const H = 480;

/** 478 face-mesh landmarks where the silhouette is an ellipse. Width/height are in pixels. */
export function syntheticFace(cx = 320, cy = 220, rx = 80, ry = 105): NormalizedPoint[] {
  const pts: NormalizedPoint[] = Array.from({ length: 478 }, () => ({ x: cx / W, y: cy / H, z: 0 }));
  FACE_OVAL.forEach((idx, k) => {
    const a = -Math.PI / 2 + (k / FACE_OVAL.length) * Math.PI * 2;
    pts[idx] = { x: (cx + rx * Math.cos(a)) / W, y: (cy + ry * Math.sin(a)) / H, z: 0 };
  });
  // Pin the four extremes the size estimate uses.
  pts[10] = { x: cx / W, y: (cy - ry) / H };
  pts[152] = { x: cx / W, y: (cy + ry) / H };
  pts[234] = { x: (cx - rx) / W, y: cy / H };
  pts[454] = { x: (cx + rx) / W, y: cy / H };
  return pts;
}

/**
 * 21 hand landmarks for an open hand pointing up, wrist at (wx, wy) pixels,
 * palm length `s` pixels. Fingertips end ~0.9*s above the knuckles.
 */
export function syntheticHand(wx: number, wy: number, s: number): NormalizedPoint[] {
  const p = (x: number, y: number): NormalizedPoint => ({ x: x / W, y: y / H, z: 0 });
  const finger = (dx: number) => [0.3, 0.6, 0.9].map((f) => p(wx + dx * s, wy - s - f * s));
  return [
    p(wx, wy), // 0 wrist
    p(wx - 0.3 * s, wy - 0.2 * s), // 1..4 thumb
    p(wx - 0.5 * s, wy - 0.45 * s),
    p(wx - 0.65 * s, wy - 0.65 * s),
    p(wx - 0.75 * s, wy - 0.85 * s),
    p(wx - 0.35 * s, wy - s), // 5 index mcp
    ...finger(-0.4),
    p(wx - 0.12 * s, wy - s), // 9 middle mcp
    ...finger(-0.13),
    p(wx + 0.12 * s, wy - s), // 13 ring mcp
    ...finger(0.13),
    p(wx + 0.33 * s, wy - 0.95 * s), // 17 pinky mcp
    ...finger(0.38),
  ];
}
