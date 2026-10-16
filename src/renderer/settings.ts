import type { AlertStyle, PenaltyAction } from '../shared/bridge';

export interface Settings {
  /** Seconds of continuous touching before an alert. */
  thresholdSec: number;
  /** Repeat the alert every N seconds while still touching (0 = once per touch). */
  repeatSec: number;
  /** Extra margin around the face outline, percent. */
  marginPct: number;
  depthFilter: boolean;
  maxHandFaceRatio: number;
  /** Don't count a hand holding a cup / bottle at your mouth. */
  ignoreDrinking: boolean;
  alertStyle: AlertStyle;
  sound: boolean;
  /** Run the models on the GPU (faster). Turn off if detection stalls. */
  useGpu: boolean;
  cameraId: string;
  showPreview: boolean;
  showLandmarks: boolean;
  /** Desktop only: sign out (or lock) after too many alerts. */
  penaltyEnabled: boolean;
  penaltyAction: PenaltyAction;
  /** Alerts needed to trigger... */
  penaltyStrikes: number;
  /** ...within this many minutes. */
  penaltyWindowMin: number;
  /** Warning countdown before signing out, seconds. */
  penaltyGraceSec: number;
  penaltyAllowCancel: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  thresholdSec: 2,
  repeatSec: 10,
  marginPct: 8,
  depthFilter: true,
  maxHandFaceRatio: 1.3,
  ignoreDrinking: true,
  alertStyle: 'toast',
  sound: true,
  useGpu: true,
  cameraId: '',
  showPreview: true,
  showLandmarks: true,
  // Off for new installs: signing people out should be something they opt into.
  penaltyEnabled: false,
  penaltyAction: 'signout',
  penaltyStrikes: 3,
  penaltyWindowMin: 5,
  penaltyGraceSec: 15,
  penaltyAllowCancel: true,
};

const KEY = 'faceguard.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Settings> & Record<string, unknown>;
      delete saved.fps; // no longer a setting
      if ((saved.alertStyle as string) === 'both') saved.alertStyle = 'popup'; // "both" was removed
      return { ...DEFAULT_SETTINGS, ...saved };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
