import { contextBridge, ipcRenderer } from 'electron';
import type { AlertRequest, FaceGuardBridge, PenaltyRequest, ShellCommand, StatusUpdate } from '../shared/bridge';

const api: FaceGuardBridge = {
  isElectron: true,
  alert: (req: AlertRequest) => ipcRenderer.send('fg:alert', req),
  setStatus: (status: StatusUpdate) => ipcRenderer.send('fg:status', status),
  penalty: (req: PenaltyRequest) => ipcRenderer.send('fg:penalty', req),
  getOpenAtLogin: () => ipcRenderer.invoke('fg:get-open-at-login'),
  setOpenAtLogin: (enabled: boolean) => ipcRenderer.invoke('fg:set-open-at-login', enabled),
  onCommand: (callback: (cmd: ShellCommand) => void) => {
    const handler = (_e: unknown, cmd: ShellCommand) => callback(cmd);
    ipcRenderer.on('fg:command', handler);
    return () => ipcRenderer.removeListener('fg:command', handler);
  },
  getAppInfo: () => ipcRenderer.invoke('fg:app-info'),
  openStartupSettings: () => ipcRenderer.invoke('fg:open-startup-settings'),
  uninstall: () => ipcRenderer.invoke('fg:uninstall'),
};

contextBridge.exposeInMainWorld('faceGuard', api);
