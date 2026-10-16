/**
 * Counts alerts inside a sliding time window ("3 strikes in 5 minutes").
 * When the limit is reached, record() returns true and the count starts over.
 */
export class StrikeCounter {
  private times: number[] = [];

  constructor(
    public limit: number,
    public windowMs: number,
  ) {}

  /** Records a strike. Returns true when this strike reaches the limit. */
  record(at: number): boolean {
    this.prune(at);
    this.times.push(at);
    if (this.times.length >= this.limit) {
      this.times = [];
      return true;
    }
    return false;
  }

  /** Strikes still inside the window at `now`. */
  count(now: number): number {
    this.prune(now);
    return this.times.length;
  }

  /** When the oldest strike in the window expires, or null if there are none. */
  nextExpiry(now: number): number | null {
    this.prune(now);
    return this.times.length ? this.times[0] + this.windowMs : null;
  }

  reset(): void {
    this.times = [];
  }

  private prune(now: number): void {
    this.times = this.times.filter((t) => now - t < this.windowMs);
  }
}
