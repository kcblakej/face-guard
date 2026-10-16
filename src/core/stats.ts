/** Daily touch statistics, kept locally. Nothing ever leaves the device. */

export interface DayStats {
  /** Touch episodes of at least MIN_COUNTED_MS. */
  touches: number;
  /** Episodes that lasted long enough to trigger an alert. */
  alerts: number;
  /** Total time spent touching, ms. */
  touchMs: number;
}

export interface StatsData {
  days: Record<string, DayStats>;
  lastTouchAt: number | null;
}

/** Ignore sub-half-second brushes when counting touches. */
export const MIN_COUNTED_MS = 500;
const KEEP_DAYS = 60;

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function dayKey(time: number): string {
  const d = new Date(time);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

const empty = (): DayStats => ({ touches: 0, alerts: 0, touchMs: 0 });

export class Stats {
  private data: StatsData;

  constructor(
    private readonly store: KeyValueStore | null,
    private readonly key = 'faceguard.stats.v1',
  ) {
    this.data = this.load();
  }

  private load(): StatsData {
    try {
      const raw = this.store?.getItem(this.key);
      if (raw) {
        const parsed = JSON.parse(raw) as StatsData;
        if (parsed && typeof parsed.days === 'object') return parsed;
      }
    } catch {
      /* corrupted or unavailable storage: start fresh */
    }
    return { days: {}, lastTouchAt: null };
  }

  private save(): void {
    try {
      this.store?.setItem(this.key, JSON.stringify(this.data));
    } catch {
      /* storage full or blocked: stats are best-effort */
    }
  }

  private prune(now: number): void {
    const cutoff = dayKey(now - KEEP_DAYS * 86_400_000);
    for (const k of Object.keys(this.data.days)) if (k < cutoff) delete this.data.days[k];
  }

  recordTouchEnd(at: number, durationMs: number, alerted: boolean): void {
    if (durationMs < MIN_COUNTED_MS && !alerted) return;
    const k = dayKey(at);
    const day = (this.data.days[k] ??= empty());
    day.touches += 1;
    day.touchMs += durationMs;
    this.data.lastTouchAt = at;
    this.prune(at);
    this.save();
  }

  recordAlert(at: number): void {
    const day = (this.data.days[dayKey(at)] ??= empty());
    day.alerts += 1;
    this.save();
  }

  day(time: number): DayStats {
    return { ...empty(), ...this.data.days[dayKey(time)] };
  }

  /** The last `count` days ending today, oldest first. */
  history(now: number, count = 7): { key: string; stats: DayStats }[] {
    const out: { key: string; stats: DayStats }[] = [];
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = dayKey(d.getTime());
      out.push({ key, stats: { ...empty(), ...this.data.days[key] } });
    }
    return out;
  }

  get lastTouchAt(): number | null {
    return this.data.lastTouchAt;
  }

  clear(): void {
    this.data = { days: {}, lastTouchAt: null };
    this.save();
  }
}
