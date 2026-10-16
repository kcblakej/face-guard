import type { AlertRequest, FaceGuardBridge, StatusUpdate } from '../shared/bridge';

export const bridge: FaceGuardBridge | undefined = window.faceGuard;
export const isElectron = !!bridge;
export const isIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** Ask for notification permission in the browser (Electron doesn't need it). */
export async function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (isElectron) return 'granted';
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

export async function sendAlert(req: AlertRequest): Promise<void> {
  if (bridge) {
    bridge.alert(req);
    return;
  }
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const options: NotificationOptions = { body: req.body, icon: 'icons/icon-192.png', tag: 'face-guard', silent: true };
  try {
    // Installed PWAs (and iOS) require notifications to go through the service worker.
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) {
      await reg.showNotification(req.title, options);
      return;
    }
  } catch {
    /* fall through */
  }
  try {
    new Notification(req.title, options);
  } catch {
    /* some browsers only allow SW notifications */
  }
}

export function publishStatus(status: StatusUpdate): void {
  bridge?.setStatus(status);
}

/** Keep the phone screen on while watching (the camera stops if the screen locks). */
export class ScreenWakeLock {
  private lock: { release(): Promise<void> } | null = null;

  async acquire(): Promise<void> {
    if (isElectron) return;
    const wl = (navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } })
      .wakeLock;
    if (!wl) return;
    try {
      this.lock = await wl.request('screen');
    } catch {
      this.lock = null;
    }
  }

  async release(): Promise<void> {
    await this.lock?.release().catch(() => undefined);
    this.lock = null;
  }
}
