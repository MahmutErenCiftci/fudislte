// Project keys: 2–6 letters A–Z (the API's rule). Task keys are "<key>-<number>".

const latin: Record<string, string> = { Ç: 'C', Ğ: 'G', I: 'I', İ: 'I', Ö: 'O', Ş: 'S', Ü: 'U', Â: 'A', Î: 'I', Û: 'U' }

/** Upper-cases what was typed and keeps the letters A–Z (Turkish letters become their Latin base). */
export function normalizeKey(input: string): string {
  return Array.from(input.toLocaleUpperCase('tr'), (ch) => latin[ch] ?? ch)
    .join('')
    .replace(/[^A-Z]/g, '')
    .slice(0, 6)
}

/** A key suggested for a project name: the initials of several words, or a single word's first letters. */
export function suggestKey(name: string): string {
  const words = name.split(/[\s\-_.]+/).map(normalizeKey).filter(Boolean)
  if (words.length === 0) return ''
  if (words.length === 1) return words[0]!.slice(0, 3)
  const initials = words.map((w) => w[0]).join('').slice(0, 4)
  return initials.length >= 2 ? initials : words[0]!.slice(0, 3)
}
