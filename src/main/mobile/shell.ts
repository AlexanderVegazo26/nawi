/** Single-quote a token for the device's `sh` (adb shell joins its arguments into one command line). */
export function shQuote(token: string): string {
  return `'${token.replace(/'/g, `'\\''`)}'`
}
