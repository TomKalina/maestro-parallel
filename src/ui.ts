// ANSI colour helpers + boxed-section UI à la @clack/prompts (similar
// look to Rock CLI). All output goes to stderr so stdout stays clean for
// piping (merged JUnit, etc.).

// deno-lint-ignore no-import-prefix
import * as clack from 'npm:@clack/prompts@1.4.0';

export const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
  inverse: '\x1b[7m',
};

export const PALETTE = [
  '\x1b[36m',
  '\x1b[35m',
  '\x1b[33m',
  '\x1b[34m',
  '\x1b[96m',
  '\x1b[95m',
  '\x1b[93m',
  '\x1b[94m',
];

// Plain streaming print — used by spawnPrefixed for build / maestro
// output where we want raw per-device line-by-line. Goes to stderr.
export const log = (msg: string): void => console.error(msg);

export const fatal = (msg: string): never => {
  clack.cancel(msg);
  Deno.exit(1);
};

// --- boxed-section helpers ---------------------------------------------------

/** Top-of-run banner. Call once at process start. */
export function intro(title = 'maestro-parallel'): void {
  clack.intro(`${C.bold}${C.cyan}${title}${C.reset}`);
}

/** Multi-line info block inside the run skeleton.
 *
 * Useful for "config snapshot" sections (cwd, flows, bundleId, …) where
 * one note is much nicer than 5 separate `log:` lines. */
export function note(title: string, lines: Record<string, string | number>): void {
  const body = Object.entries(lines)
    .map(([k, v]) => `${C.dim}${k}:${C.reset} ${v}`)
    .join('\n');
  clack.note(body, title);
}

/** Section header — solid diamond, bold title. */
export function step(title: string): void {
  clack.log.step(`${C.bold}${title}${C.reset}`);
}

export function info(msg: string): void {
  clack.log.info(msg);
}

export function success(msg: string): void {
  clack.log.success(msg);
}

export function warn(msg: string): void {
  clack.log.warn(msg);
}

export function error(msg: string): void {
  clack.log.error(msg);
}

/** Closing line. Pass `ok = false` to print a red cross. */
export function outro(msg: string, ok = true): void {
  if (ok) clack.outro(`${C.green}${msg}${C.reset}`);
  else clack.outro(`${C.red}${msg}${C.reset}`);
}

export interface Spinner {
  message: (text: string) => void;
  /** Success stop — green check + text. */
  stop: (text?: string) => void;
  /** Error stop — red cross + text. */
  fail: (text?: string) => void;
}

/** Inline rotating-glyph spinner. */
export function spinner(initial: string): Spinner {
  const s = clack.spinner();
  s.start(initial);
  return {
    message: (text) => s.message(text),
    stop: (text) => s.stop(text ?? ''),
    fail: (text) => s.error(text ?? ''),
  };
}
