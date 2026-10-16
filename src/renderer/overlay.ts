import { scalePolygon, toPixels, type Point } from '../core/geometry';
import type { FrameReport } from './monitor';

const HAND_CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function path(ctx: CanvasRenderingContext2D, pts: Point[], close = true): void {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  if (close) ctx.closePath();
}

export function drawOverlay(canvas: HTMLCanvasElement, report: FrameReport | null, marginPct: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  if (!report) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const { width, height } = report.detection;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  ctx.clearRect(0, 0, width, height);
  const scale = Math.max(1, width / 640);
  const touching = report.result.touching;
  const accent = touching ? css('--danger') : css('--accent');

  if (report.face) {
    const zone = scalePolygon(report.face.outline, 1 + marginPct / 100);
    ctx.lineWidth = 2 * scale;
    ctx.setLineDash(report.faceIsRemembered ? [6 * scale, 6 * scale] : []);
    ctx.strokeStyle = accent;
    ctx.fillStyle = touching ? 'rgba(239, 68, 68, 0.12)' : 'rgba(45, 212, 191, 0.08)';
    path(ctx, zone);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
  }

  report.detection.hands.forEach((hand, h) => {
    const pts = hand.map((p) => toPixels(p, width, height));
    const isHit = report.result.handIndex === h;
    ctx.strokeStyle = isHit ? (touching ? css('--danger') : css('--warn')) : 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 2 * scale;
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.beginPath();
      ctx.moveTo(pts[a].x, pts[a].y);
      ctx.lineTo(pts[b].x, pts[b].y);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5 * scale, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  // Cups / bottles recognised at the face.
  if (report.drinks.length) {
    ctx.strokeStyle = css('--accent');
    ctx.lineWidth = 2 * scale;
    ctx.setLineDash([8 * scale, 5 * scale]);
    for (const b of report.drinks) ctx.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
    ctx.setLineDash([]);
  }

  ctx.fillStyle = report.result.reason === 'drinking' ? css('--accent') : css('--danger');
  for (const p of report.result.contactPoints) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6 * scale, 0, Math.PI * 2);
    ctx.fill();
  }
}
