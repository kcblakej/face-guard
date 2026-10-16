/**
 * Turns a noisy per-frame "touching / not touching" signal into touch episodes and alerts.
 *
 *  - A short dropout (graceMs) doesn't end a touch — detectors flicker for a frame or two.
 *  - An alert fires once the touch has lasted thresholdMs.
 *  - If repeatMs > 0 the alert repeats while the touch continues.
 */

export interface TrackerOptions {
  thresholdMs: number;
  graceMs: number;
  repeatMs: number;
}

export const DEFAULT_TRACKER_OPTIONS: TrackerOptions = {
  thresholdMs: 2000,
  graceMs: 400,
  repeatMs: 10000,
};

export type TrackerEvent =
  | { type: 'start'; at: number }
  | { type: 'alert'; at: number; durationMs: number; repeat: boolean }
  | { type: 'end'; at: number; durationMs: number; alerted: boolean };

export class TouchTracker {
  private since: number | null = null;
  private lastTouch = 0;
  private lastAlert: number | null = null;

  constructor(public options: TrackerOptions = DEFAULT_TRACKER_OPTIONS) {}

  /** True while inside a touch episode (including the grace window). */
  get active(): boolean {
    return this.since !== null;
  }

  get alerted(): boolean {
    return this.lastAlert !== null;
  }

  /** How long the current touch has lasted, or 0. */
  durationAt(now: number): number {
    return this.since === null ? 0 : Math.max(0, now - this.since);
  }

  /** 0..1 progress toward the alert threshold. */
  progressAt(now: number): number {
    if (this.since === null) return 0;
    return Math.min(1, this.durationAt(now) / Math.max(1, this.options.thresholdMs));
  }

  update(touching: boolean, now: number): TrackerEvent[] {
    const events: TrackerEvent[] = [];

    if (touching) {
      this.lastTouch = now;
      if (this.since === null) {
        this.since = now;
        events.push({ type: 'start', at: now });
      }
      const durationMs = now - this.since;
      if (this.lastAlert === null) {
        if (durationMs >= this.options.thresholdMs) {
          this.lastAlert = now;
          events.push({ type: 'alert', at: now, durationMs, repeat: false });
        }
        return events;
      }
      if (this.options.repeatMs > 0 && now - this.lastAlert >= this.options.repeatMs) {
        this.lastAlert = now;
        events.push({ type: 'alert', at: now, durationMs, repeat: true });
      }
      return events;
    }

    if (this.since !== null && now - this.lastTouch > this.options.graceMs) {
      events.push({
        type: 'end',
        at: now,
        durationMs: this.lastTouch - this.since,
        alerted: this.lastAlert !== null,
      });
      this.reset();
    }
    return events;
  }

  reset(): void {
    this.since = null;
    this.lastAlert = null;
    this.lastTouch = 0;
  }
}
