/** Minimal 2D geometry helpers. All points are in pixel space unless noted. */

export interface Point {
  x: number;
  y: number;
}

/** A landmark as returned by MediaPipe: x/y normalized to [0,1] of the frame. */
export interface NormalizedPoint {
  x: number;
  y: number;
  z?: number;
}

export function toPixels(p: NormalizedPoint, width: number, height: number): Point {
  return { x: p.x * width, y: p.y * height };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function centroid(points: readonly Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  const n = Math.max(points.length, 1);
  return { x: x / n, y: y / n };
}

/** Grow (factor > 1) or shrink (factor < 1) a polygon around its centroid. */
export function scalePolygon(polygon: readonly Point[], factor: number): Point[] {
  const c = centroid(polygon);
  return polygon.map((p) => ({ x: c.x + (p.x - c.x) * factor, y: c.y + (p.y - c.y) * factor }));
}

/** Ray-casting point-in-polygon test. Works for any simple (non self-intersecting) polygon. */
export function pointInPolygon(p: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const crosses = a.y > p.y !== b.y > p.y;
    if (crosses && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boundingBox(points: readonly Point[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function boxesIntersect(a: Box, b: Box): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

/** Grow a box by `frac` of its size on every side. */
export function expandBox(b: Box, frac: number): Box {
  const dx = (b.maxX - b.minX) * frac;
  const dy = (b.maxY - b.minY) * frac;
  return { minX: b.minX - dx, minY: b.minY - dy, maxX: b.maxX + dx, maxY: b.maxY + dy };
}
