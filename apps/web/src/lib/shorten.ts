/** `EQAb…wxyz`: enough of a hash or address to recognise it, short enough for a phone screen. */
export function shorten(value: string, keep = 4): string {
  if (value.length <= keep * 2 + 1) return value
  return `${value.slice(0, keep)}…${value.slice(-keep)}`
}
