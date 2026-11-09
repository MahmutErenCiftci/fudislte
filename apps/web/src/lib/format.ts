import { getLanguage, intlLocale, t } from '../i18n'

const locale = () => intlLocale[getLanguage()]

export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(locale(), { dateStyle: 'medium' }).format(new Date(iso))
}

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))
}

/** "12 KB", "3,4 MB" in the current language. */
export function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1
  return `${new Intl.NumberFormat(locale(), { maximumFractionDigits: digits }).format(value)} ${units[unit]}`
}

export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat(locale(), { timeStyle: 'short' }).format(new Date(iso))
}

/** "10:30 – 11:15" in the current language and the viewer's time zone. */
export function formatTimeRange(startIso: string, endIso: string): string {
  return `${formatTime(startIso)} – ${formatTime(endIso)}`
}

/** A date as a calendar tile shows it: "Kas" and "3". */
export function formatCalendarTile(iso: string): { month: string; day: string } {
  const date = new Date(iso)
  return {
    month: new Intl.DateTimeFormat(locale(), { month: 'short' }).format(date).replace('.', ''),
    day: new Intl.DateTimeFormat(locale(), { day: 'numeric' }).format(date),
  }
}

/** "Bugün", "Dün" or a long date, for separators between days. */
export function formatDay(iso: string, now = new Date()): string {
  const day = new Date(iso)
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (day.toDateString() === now.toDateString()) return t('chat.today')
  if (day.toDateString() === yesterday.toDateString()) return t('chat.yesterday')
  return formatLongDate(day)
}

/** "30 Ekim Perşembe" / "Thursday, October 30". */
export function formatLongDate(date: Date): string {
  return new Intl.DateTimeFormat(locale(), { weekday: 'long', day: 'numeric', month: 'long' }).format(date)
}

const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
]

export function formatRelative(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000)
  const relative = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' })
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit)
  }
  return t('time.justNow')
}

/** A short human description of a session's user agent, e.g. "Chrome · Windows". */
export function describeUserAgent(ua: string): string {
  if (!ua) return t('ua.unknown')
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua)
      ? 'macOS'
      : /Android/.test(ua)
        ? 'Android'
        : /iPhone|iPad/.test(ua)
          ? 'iOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : undefined
  const app = /FudislteDesktop\//.test(ua)
    ? t('ua.desktop')
    : /Edg\//.test(ua)
      ? 'Edge'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : /^curl\//.test(ua)
              ? 'curl'
              : t('ua.browser')
  return os ? t('ua.on', { app, os }) : app
}
