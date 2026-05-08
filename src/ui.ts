// ANSI colour helpers + console output. Goes to stderr so stdout stays
// clean for piping (merged JUnit, etc.).

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

export const log = (msg: string): void => console.error(msg);

export const fatal = (msg: string): never => {
  console.error(`${C.red}error:${C.reset} ${msg}`);
  process.exit(1);
};
