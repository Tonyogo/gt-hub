/**
 * Safely quotes a shell argument for POSIX shells.
 */
export function quoteShellArg(arg: string): string {
  if (typeof arg !== 'string') return '';
  if (/^[a-zA-Z0-9_.\-\/=:@]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
