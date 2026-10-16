import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pointInPolygon, scalePolygon } from '../src/core/geometry';
import { DEFAULT_TOUCH_SETTINGS, FaceMemory, evaluateTouch, faceShapeFromLandmarks } from '../src/core/touch';
import { DrinkTracker, drinkInHand, drinkSearchRegion, handNearFace } from '../src/core/drink';
import { boundingBox } from '../src/core/geometry';
import { TouchTracker } from '../src/core/tracker';
import { Stats, type KeyValueStore } from '../src/core/stats';
import { StrikeCounter } from '../src/core/strikes';
import { H, W, syntheticFace, syntheticHand } from './fixtures';

const face = () => faceShapeFromLandmarks(syntheticFace(), W, H)!;

test('pointInPolygon on a square', () => {
  const sq = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  assert.equal(pointInPolygon({ x: 5, y: 5 }, sq), true);
  assert.equal(pointInPolygon({ x: 11, y: 5 }, sq), false);
  assert.equal(pointInPolygon({ x: 10.5, y: 5 }, scalePolygon(sq, 1.2)), true);
});

test('face shape size uses the larger of width and 0.8 * height', () => {
  const f = face();
  assert.equal(f.outline.length, 36);
  assert.ok(Math.abs(f.size - 168) < 1e-6, `size ${f.size}`);
});

test('no face -> not touching', () => {
  const r = evaluateTouch(null, [syntheticHand(400, 420, 110)], W, H);
  assert.equal(r.touching, false);
  assert.equal(r.reason, 'no-face');
});

test('hand away from the face -> clear', () => {
  const r = evaluateTouch(face(), [syntheticHand(590, 475, 60)], W, H);
  assert.equal(r.touching, false);
  assert.equal(r.reason, 'clear');
});

test('fingers on the cheek -> touching', () => {
  const r = evaluateTouch(face(), [syntheticHand(400, 420, 110)], W, H);
  assert.equal(r.touching, true);
  assert.equal(r.reason, 'touching');
  assert.ok(r.contactPoints.length > 0);
  assert.ok(r.ratio! > 0.5 && r.ratio! < 0.8, `ratio ${r.ratio}`);
});

test('second hand touching is detected even if the first is not', () => {
  const r = evaluateTouch(face(), [syntheticHand(590, 475, 60), syntheticHand(400, 420, 110)], W, H);
  assert.equal(r.touching, true);
  assert.equal(r.handIndex, 1);
});

test('huge hand close to the camera is rejected by the depth filter', () => {
  const hand = syntheticHand(320, 600, 300);
  const filtered = evaluateTouch(face(), [hand], W, H);
  assert.equal(filtered.touching, false);
  assert.equal(filtered.reason, 'hand-in-front');

  const unfiltered = evaluateTouch(face(), [hand], W, H, { ...DEFAULT_TOUCH_SETTINGS, depthFilter: false });
  assert.equal(unfiltered.touching, true);
});

test('margin lets a fingertip just outside the jawline count', () => {
  // Wrist placed so the index tip sits a few pixels outside the right edge of the face.
  const hand = syntheticHand(452, 420, 110); // index tip x = 452 - 0.4*110 = 408 (edge at 400)
  const tight = evaluateTouch(face(), [hand], W, H, { ...DEFAULT_TOUCH_SETTINGS, margin: 0 });
  const loose = evaluateTouch(face(), [hand], W, H, { ...DEFAULT_TOUCH_SETTINGS, margin: 0.15 });
  assert.equal(tight.touching, false);
  assert.equal(loose.touching, true);
});

// Face spans x 240..400, y 115..325 (px). The touching hand (wrist 400,420) spans roughly x 318..444, y 211..420.
const MUG_IN_HAND = { minX: 340, minY: 250, maxX: 450, maxY: 400 };
const MUG_ON_DESK = { minX: 10, minY: 360, maxX: 90, maxY: 470 };
const px = (hand: ReturnType<typeof syntheticHand>) => hand.map((p) => ({ x: p.x * W, y: p.y * H }));

test('drink tracker: a hand seen holding a mug is excused, even once the mug is hidden', () => {
  const hand = syntheticHand(400, 420, 110);
  const t = new DrinkTracker(4000);
  t.observe([{ key: 'Right', points: px(hand) }], [MUG_IN_HAND], 0); // mug seen on the way up
  t.observe([{ key: 'Right', points: px(hand) }], [], 1500); // tipped up at the mouth: detector misses it
  const excuse = (_h: unknown, i: number) => t.isHolding(['Right'][i], 2500);
  const r = evaluateTouch(face(), [hand], W, H, DEFAULT_TOUCH_SETTINGS, excuse);
  assert.equal(r.touching, false);
  assert.equal(r.reason, 'drinking');
  assert.equal(t.isHolding('Right', 4001), false); // 4 s after last seeing it in the hand
});

test('drink tracker: a mug on the desk does not excuse a touch', () => {
  const hand = syntheticHand(400, 420, 110);
  const t = new DrinkTracker();
  t.observe([{ key: 'Right', points: px(hand) }], [MUG_ON_DESK], 0);
  const r = evaluateTouch(face(), [hand], W, H, DEFAULT_TOUCH_SETTINGS, (_h, i) => t.isHolding(['Right'][i], 100));
  assert.equal(r.touching, true);
});

test('drink tracker: the other hand touching your face still counts', () => {
  const drinkingHand = syntheticHand(400, 420, 110);
  const otherHand = syntheticHand(280, 420, 110); // fingertips on the left cheek
  const t = new DrinkTracker();
  t.observe(
    [
      { key: 'Right', points: px(drinkingHand) },
      { key: 'Left', points: px(otherHand) },
    ],
    [{ minX: 420, minY: 250, maxX: 470, maxY: 400 }], // mug only in the right hand
    0,
  );
  const keys = ['Right', 'Left'];
  const r = evaluateTouch(face(), [drinkingHand, otherHand], W, H, DEFAULT_TOUCH_SETTINGS, (_h, i) => t.isHolding(keys[i], 100));
  assert.equal(r.touching, true);
  assert.equal(r.handIndex, 1);
});

test('drinkInHand: a mug held by the handle (beside the fingers) counts', () => {
  const hand = px(syntheticHand(400, 420, 110)); // x 318..444
  assert.equal(drinkInHand({ minX: 450, minY: 260, maxX: 520, maxY: 360 }, hand), true); // just right of the knuckles
  assert.equal(drinkInHand({ minX: 560, minY: 260, maxX: 630, maxY: 360 }, hand), false);
});

test('drink search region covers face and hands, clamped to the frame', () => {
  const f = boundingBox(face().outline);
  const hands = [px(syntheticHand(400, 420, 110))];
  const r = drinkSearchRegion(f, hands, W, H)!;
  assert.ok(r.minX <= 240 && r.maxX >= 444 && r.minY <= 115 && r.maxY <= H && r.maxY >= 420);
  assert.equal(handNearFace(f, hands), true);
  assert.equal(handNearFace(f, [px(syntheticHand(620, 478, 10))]), false);
});

test('drinking: the excuse is only consulted for hands at the face', () => {
  let calls = 0;
  evaluateTouch(face(), [syntheticHand(590, 475, 60)], W, H, DEFAULT_TOUCH_SETTINGS, () => (calls++, true));
  assert.equal(calls, 0);
});

test('FaceMemory holds a lost face longer while a hand covers it', () => {
  const m = new FaceMemory(1000, 8000);
  const f = face();
  assert.equal(m.update(f, 0, false), f);
  assert.equal(m.update(null, 900, false), f);
  assert.equal(m.update(null, 5000, true), f);
  assert.equal(m.update(null, 9000, true), null);

  m.update(f, 10000, false);
  assert.equal(m.update(null, 11500, false), null);
});

test('tracker alerts after the threshold, tolerates flicker, repeats, and ends', () => {
  const t = new TouchTracker({ thresholdMs: 2000, graceMs: 400, repeatMs: 5000 });
  const types = (now: number, touching: boolean) => t.update(touching, now).map((e) => e.type);

  assert.deepEqual(types(0, true), ['start']);
  assert.deepEqual(types(1000, true), []);
  assert.deepEqual(types(1200, false), []); // flicker inside grace window
  assert.deepEqual(types(1500, true), []);
  assert.deepEqual(types(1999, true), []);
  assert.deepEqual(types(2000, true), ['alert']);
  assert.deepEqual(types(4000, true), []);
  assert.deepEqual(types(7000, true), ['alert']); // repeat after 5s
  assert.deepEqual(types(7300, false), []);
  const end = t.update(false, 7500);
  assert.equal(end.length, 1);
  assert.equal(end[0].type, 'end');
  assert.ok(end[0].type === 'end' && end[0].durationMs === 7000 && end[0].alerted);
  assert.equal(t.active, false);
});

test('tracker: short touch never alerts', () => {
  const t = new TouchTracker({ thresholdMs: 2000, graceMs: 300, repeatMs: 0 });
  const all = [
    ...t.update(true, 0),
    ...t.update(true, 1500),
    ...t.update(false, 1600),
    ...t.update(false, 1900),
  ];
  assert.deepEqual(
    all.map((e) => e.type),
    ['start', 'end'],
  );
});

test('tracker: repeatMs = 0 alerts once per touch', () => {
  const t = new TouchTracker({ thresholdMs: 1000, graceMs: 300, repeatMs: 0 });
  const alerts = [0, 500, 1000, 5000, 20000].flatMap((n) => t.update(true, n)).filter((e) => e.type === 'alert');
  assert.equal(alerts.length, 1);
});

test('tracker: repeat alerts follow the repeat interval (each one is a strike in the app)', () => {
  const t = new TouchTracker({ thresholdMs: 2000, graceMs: 400, repeatMs: 10000 });
  const frames = Array.from({ length: 231 }, (_, i) => i * 100); // 0..23 s continuous touch at 10 fps
  const alerts = frames.flatMap((n) => t.update(true, n)).filter((e) => e.type === 'alert');
  assert.deepEqual(
    alerts.map((e) => [e.at, e.type === 'alert' && e.repeat]),
    [
      [2000, false],
      [12000, true],
      [22000, true],
    ],
  );
});

test('strike counter: 3 strikes inside 5 minutes triggers, then starts over', () => {
  const min = 60_000;
  const s = new StrikeCounter(3, 5 * min);
  assert.equal(s.record(0), false);
  assert.equal(s.record(2 * min), false);
  assert.equal(s.count(2 * min), 2);
  assert.equal(s.record(4 * min), true); // 3 within 5 min
  assert.equal(s.count(4 * min), 0); // reset after triggering
});

test('strike counter: strikes older than the window expire', () => {
  const min = 60_000;
  const s = new StrikeCounter(3, 5 * min);
  s.record(0);
  s.record(3 * min);
  assert.equal(s.nextExpiry(3 * min), 5 * min);
  assert.equal(s.record(5 * min + 1), false); // first strike aged out -> only 2 in window
  assert.equal(s.count(5 * min + 1), 2);
  assert.equal(s.record(6 * min), true);
});

test('stats count touches and alerts per day', () => {
  const mem = new Map<string, string>();
  const store: KeyValueStore = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) };
  const now = new Date(2026, 8, 23, 12).getTime();

  const s = new Stats(store);
  s.recordTouchEnd(now, 200, false); // brush: ignored
  s.recordTouchEnd(now, 1500, false);
  s.recordAlert(now);
  s.recordTouchEnd(now, 3000, true);
  assert.deepEqual(s.day(now), { touches: 2, alerts: 1, touchMs: 4500 });

  const reloaded = new Stats(store);
  assert.equal(reloaded.day(now).touches, 2);
  const hist = reloaded.history(now, 7);
  assert.equal(hist.length, 7);
  assert.equal(hist[6].stats.touches, 2);
  assert.equal(hist[0].stats.touches, 0);
});
