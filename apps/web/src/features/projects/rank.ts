// Task ranks: fractional-indexing keys, the same algorithm as the API
// (services/api/internal/projects/rank.go). A rank sorts as a plain string; between any
// two ranks there is always another, so moving a card rewrites only that card.

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const SMALLEST_INTEGER = 'A' + '0'.repeat(26)

function integerLength(head: string): number {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 97 + 2
  if (head >= 'A' && head <= 'Z') return 90 - head.charCodeAt(0) + 2
  return 0
}

/** A rank's integer and fraction parts, or null when it is not a valid rank. */
function split(key: string): { integer: string; fraction: string } | null {
  const n = key ? integerLength(key[0]!) : 0
  if (n === 0 || n > key.length || key === SMALLEST_INTEGER) return null
  const fraction = key.slice(n)
  if (fraction.endsWith('0')) return null
  for (const ch of key.slice(1)) if (!DIGITS.includes(ch)) return null
  return { integer: key.slice(0, n), fraction }
}

export function isValidRank(key: string): boolean {
  return key.length <= 128 && split(key) !== null
}

function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0
    while (n < b.length && (a[n] ?? '0') === b[n]) n++
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n))
  }
  const lo = a ? DIGITS.indexOf(a[0]!) : 0
  const hi = b !== null ? DIGITS.indexOf(b[0]!) : DIGITS.length
  if (hi - lo > 1) return DIGITS[Math.round((lo + hi) / 2)]!
  if (b !== null && b.length > 1) return b.slice(0, 1)
  return DIGITS[lo]! + midpoint(a.slice(1), null)
}

function incrementInteger(x: string): string | null {
  const head = x[0]!
  const digits = x.slice(1).split('')
  let carry = true
  for (let i = digits.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digits[i]!) + 1
    if (d === DIGITS.length) digits[i] = '0'
    else {
      digits[i] = DIGITS[d]!
      carry = false
    }
  }
  if (!carry) return head + digits.join('')
  if (head === 'Z') return 'a0'
  if (head === 'z') return null
  const h = String.fromCharCode(head.charCodeAt(0) + 1)
  if (h > 'a') digits.push('0')
  else digits.pop()
  return h + digits.join('')
}

function decrementInteger(x: string): string | null {
  const head = x[0]!
  const digits = x.slice(1).split('')
  let borrow = true
  for (let i = digits.length - 1; borrow && i >= 0; i--) {
    const d = DIGITS.indexOf(digits[i]!) - 1
    if (d === -1) digits[i] = 'z'
    else {
      digits[i] = DIGITS[d]!
      borrow = false
    }
  }
  if (!borrow) return head + digits.join('')
  if (head === 'a') return 'Zz'
  if (head === 'A') return null
  const h = String.fromCharCode(head.charCodeAt(0) - 1)
  if (h < 'Z') digits.push('z')
  else digits.pop()
  return h + digits.join('')
}

/**
 * A rank strictly between a and b; null leaves that side open. Throws when a >= b or
 * either is not a valid rank.
 */
export function rankBetween(a: string | null, b: string | null): string {
  const pa = a === null ? null : split(a)
  const pb = b === null ? null : split(b)
  if ((a !== null && !pa) || (b !== null && !pb)) throw new Error('invalid rank')
  if (a !== null && b !== null && a >= b) throw new Error(`${a} >= ${b}`)
  if (!pa) {
    if (!pb) return 'a0'
    if (pb.integer === SMALLEST_INTEGER) return pb.integer + midpoint('', pb.fraction)
    if (pb.integer < b!) return pb.integer
    const r = decrementInteger(pb.integer)
    if (r === null) throw new Error('no rank before ' + b)
    return r
  }
  if (!pb) return incrementInteger(pa.integer) ?? pa.integer + midpoint(pa.fraction, null)
  if (pa.integer === pb.integer) return pa.integer + midpoint(pa.fraction, pb.fraction)
  const i = incrementInteger(pa.integer)
  if (i === null) throw new Error('no rank after ' + a)
  return i < b! ? i : pa.integer + midpoint(pa.fraction, null)
}

/**
 * The rank that puts a card at index in a column whose other cards have ranks (in
 * order, the moving card left out). Equal neighbours — two people moved cards to the
 * same place at once — are skipped, so the result always sorts where it should.
 */
export function rankAt(ranks: readonly string[], index: number): string {
  let lo = index > 0 ? (ranks[index - 1] ?? null) : null
  let hi = index < ranks.length ? (ranks[index] ?? null) : null
  if (lo !== null && hi !== null && lo >= hi) {
    // Look past equal ranks after the slot; fall back to the end of the column.
    const next = ranks.slice(index).find((r) => r > lo!)
    hi = next ?? null
  }
  if (lo !== null && !isValidRank(lo)) lo = null
  if (hi !== null && !isValidRank(hi)) hi = null
  return rankBetween(lo, hi)
}

/** Compares tasks the way the API orders a column: by rank, then ID. */
export function byRank(a: { rank: string; id: string }, b: { rank: string; id: string }): number {
  return a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
