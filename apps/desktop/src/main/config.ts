import { app } from 'electron'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface DesktopConfig {
  /** Origin of the organization's FUDISLTE server, validated on save. */
  serverUrl?: string
}

const file = () => path.join(app.getPath('userData'), 'config.json')

export function loadConfig(): DesktopConfig {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as unknown
    if (raw && typeof raw === 'object' && typeof (raw as DesktopConfig).serverUrl === 'string') {
      return { serverUrl: (raw as DesktopConfig).serverUrl }
    }
  } catch {
    // Missing or unreadable config: start at the connect screen.
  }
  return {}
}

/** Writes atomically so a crash never leaves a half-written file. */
export function saveConfig(config: DesktopConfig): void {
  const target = file()
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, target)
}
