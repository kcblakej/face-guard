/**
 * Contract between the web UI (renderer) and the Electron shell.
 * In a plain browser / PWA `window.faceGuard` is undefined and the web fallbacks are used.
 */

export type MonitorState = 'idle' | 'starting' | 'watching' | 'touching' | 'alert' | 'away' | 'paused' | 'error';

export type AlertStyle = 'toast' | 'popup';

export interface StatusUpdate {
  state: MonitorState;
  touchesToday: number;
  alertsToday: number;
  /** Epoch ms when a timed pause ends, if paused with a timer. */
  pausedUntil: number | null;
}

export interface AlertRequest {
  title: string;
  body: string;
  style: AlertStyle;
  silent: boolean;
}

export type PenaltyAction = 'signout' | 'lock';

export interface PenaltyRequest {
  action: PenaltyAction;
  /** Seconds of on-screen warning before acting (0 = act immediately). */
  graceSec: number;
  /** Show a Cancel button on the warning. */
  allowCancel: boolean;
  /** Why it's happening, shown on the warning. */
  reason: string;
}

export type ShellCommand = { type: 'pause'; minutes: number | null } | { type: 'resume' } | { type: 'toggle' };

export interface AppInfo {
  version: string;
  /** Installed from the Microsoft Store: Windows manages startup and uninstall. */
  store: boolean;
  packaged: boolean;
}

export interface FaceGuardBridge {
  readonly isElectron: true;
  alert(req: AlertRequest): void;
  setStatus(status: StatusUpdate): void;
  penalty(req: PenaltyRequest): void;
  getOpenAtLogin(): Promise<boolean>;
  setOpenAtLogin(enabled: boolean): Promise<boolean>;
  onCommand(callback: (cmd: ShellCommand) => void): () => void;
  getAppInfo(): Promise<AppInfo>;
  openStartupSettings(): Promise<void>;
  /** 'started' = uninstaller launched (app quits), 'settings' = Windows app list opened, 'dev' = not installed. */
  uninstall(): Promise<'started' | 'settings' | 'dev'>;
}

declare global {
  interface Window {
    faceGuard?: FaceGuardBridge;
  }
}
