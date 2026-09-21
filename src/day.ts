/** Границы дня — всегда UTC. */

const DAY_MS = 86_400_000

export function dayKeyFromUnix(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10)
}

export function dayKeyFromDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export function dayStartUnix(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000)
}

export function isValidDay(day: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`))
}

/** Сравнение дней в формате YYYY-MM-DD лексикографически совпадает с хронологическим. */
export function isBefore(a: string, b: string): boolean {
  return a < b
}

export function addDays(day: string, delta: number): string {
  return dayKeyFromUnix(dayStartUnix(day) + delta * (DAY_MS / 1000))
}
