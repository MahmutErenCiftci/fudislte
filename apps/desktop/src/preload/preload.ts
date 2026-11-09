// Runs in the sandboxed renderer before page scripts. Exposes a minimal, typed bridge;
// the main process re-validates the caller and every argument.

import type { DesktopBridge } from '@fudislte/platform'
import { contextBridge, ipcRenderer } from 'electron'

const version = process.argv.find((a) => a.startsWith('--fudislte-version='))?.split('=')[1] ?? '0.0.0'
const os: DesktopBridge['os'] = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'

if (location.protocol === 'fudislte:') {
  // The bundled "connect to server" page.
  contextBridge.exposeInMainWorld('fudislteConnect', {
    version,
    probe: (url: string) => ipcRenderer.invoke('fudislte:server:probe', String(url)),
    connect: (url: string) => ipcRenderer.invoke('fudislte:server:connect', String(url)),
  })
} else {
  const bridge: DesktopBridge = {
    version,
    os,
    serverUrl: () => ipcRenderer.invoke('fudislte:server:get'),
    changeServer: () => ipcRenderer.invoke('fudislte:server:change'),
    openExternal: (url: string) => ipcRenderer.invoke('fudislte:shell:open-external', String(url)),
    onDisplayPick: (handler) => {
      const listener = (_e: Electron.IpcRendererEvent, request: Parameters<typeof handler>[0]) => handler(request)
      ipcRenderer.on('fudislte:display:pick', listener)
      return () => ipcRenderer.removeListener('fudislte:display:pick', listener)
    },
    chooseDisplaySource: (id: string, sourceId: string | null) =>
      ipcRenderer.invoke('fudislte:display:choose', String(id), sourceId === null ? null : String(sourceId)),
  }
  contextBridge.exposeInMainWorld('fudislteDesktop', bridge)
}
