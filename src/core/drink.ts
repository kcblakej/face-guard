import { type Box, type Point, boundingBox, boxesIntersect, expandBox } from './geometry';

/** A drink the object detector found (pixel box). */
export interface Drink extends Box {
  label: string;
  score: number;
}

/** A hand in this frame, with a key that stays stable from frame to frame (its handedness). */
export interface TrackedHand {
  key: string;
  points: readonly Point[];
}

/** Does this drink box touch this hand? Generous, because a mug is held by the handle beside it. */
export function drinkInHand(drink: Box, hand: readonly Point[]): boolean {
  return boxesIntersect(expandBox(drink, 0.1), expandBox(boundingBox(hand), 0.25));
}

/**
 * Remembers which hand is holding a drink.
 *
 * The object detector is good at spotting a mug or bottle on its way up, but often loses it once
 * it's tipped against your mouth and half hidden by your hand and face. So instead of needing
 * to see the drink at the exact moment of the "touch", we remember that a hand was holding one
 * and excuse that hand for `holdMs` after the drink was last seen in it.
 */
export class DrinkTracker {
  private held = new Map<string, number>();

  constructor(private readonly holdMs = 4000) {}

  /** Feed one run of the drink detector. */
  observe(hands: readonly TrackedHand[], drinks: readonly Box[], now: number): void {
    for (const hand of hands) {
      if (drinks.some((d) => drinkInHand(d, hand.points))) this.held.set(hand.key, now);
    }
  }

  isHolding(key: string, now: number): boolean {
    const seen = this.held.get(key);
    return seen !== undefined && now - seen <= this.holdMs;
  }

  /** Any hand currently counted as holding a drink (for the status line). */
  anyHolding(now: number): string[] {
    return [...this.held.entries()].filter(([, t]) => now - t <= this.holdMs).map(([k]) => k);
  }

  reset(): void {
    this.held.clear();
  }
}

/**
 * The part of the frame worth searching for a drink: the face plus any hands near it, padded.
 * Cropping gives the small detector model roughly twice the resolution on the mug or bottle.
 */
export function drinkSearchRegion(
  face: Box | null,
  hands: readonly (readonly Point[])[],
  width: number,
  height: number,
): Box | null {
  if (!face) return null;
  let region = face;
  for (const h of hands) {
    const b = boundingBox(h);
    region = {
      minX: Math.min(region.minX, b.minX),
      minY: Math.min(region.minY, b.minY),
      maxX: Math.max(region.maxX, b.maxX),
      maxY: Math.max(region.maxY, b.maxY),
    };
  }
  const padded = expandBox(region, 0.3);
  const clamped = {
    minX: Math.max(0, padded.minX),
    minY: Math.max(0, padded.minY),
    maxX: Math.min(width, padded.maxX),
    maxY: Math.min(height, padded.maxY),
  };
  return clamped.maxX - clamped.minX > 8 && clamped.maxY - clamped.minY > 8 ? clamped : null;
}

/** Is any hand close enough to the face that it might be bringing a drink up? */
export function handNearFace(face: Box, hands: readonly (readonly Point[])[]): boolean {
  const near = expandBox(face, 0.75);
  return hands.some((h) => boxesIntersect(boundingBox(h), near));
}
