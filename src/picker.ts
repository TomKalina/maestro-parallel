// Interactive multi-select TTY checklist. Arrows/jk move, space toggles,
// `a` toggles all, enter confirms, esc/Ctrl-C cancels. Selection memory
// is persisted to `.maestro/.last-devices` so re-running pre-checks the
// same devices.

import { join } from '@std/path';
import { deviceLabel } from './devices.ts';
import type { Device } from './types.ts';
import { C, fatal } from './ui.ts';

export const SELECTION_MEMORY_FILE = '.maestro/.last-devices';

export async function readLastSelection(
  cwd: string,
  file = SELECTION_MEMORY_FILE,
): Promise<Set<string>> {
  try {
    const txt = await Deno.readTextFile(join(cwd, file));
    return new Set(txt.split('\n').map((l) => l.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

export async function writeLastSelection(
  cwd: string,
  ids: string[],
  file = SELECTION_MEMORY_FILE,
): Promise<void> {
  await Deno.writeTextFile(join(cwd, file), ids.join('\n') + '\n');
}

export async function pickDevices(devs: Device[], preselect: Set<string>): Promise<Device[]> {
  const checked = devs.map((d) => preselect.has(d.id));
  let cursor = 0;
  const stdin = Deno.stdin;
  const stdout = Deno.stdout;
  const enc = new TextEncoder();
  const write = (s: string): void => {
    stdout.writeSync(enc.encode(s));
  };

  const render = (firstDraw: boolean): void => {
    if (!firstDraw) {
      write(`\x1b[${devs.length + 3}A`);
    }
    write('\x1b[?25l');
    write(`${C.bold}Select devices to run Maestro on${C.reset}\x1b[K\n`);
    write(
      `${C.dim}↑/↓ move · space toggle · a toggle all · enter run · esc cancel${C.reset}\x1b[K\n`,
    );
    devs.forEach((d, i) => {
      const box = checked[i] ? `${C.green}[x]${C.reset}` : '[ ]';
      const line = `${box} ${deviceLabel(d)}`;
      if (i === cursor) write(`${C.inverse}> ${line}${C.reset}\x1b[K\n`);
      else write(`  ${line}\x1b[K\n`);
    });
    write('\x1b[K');
  };

  const cleanup = (): void => {
    write('\x1b[?25h');
    try {
      stdin.setRaw(false);
    } catch { /* ignore */ }
  };

  try {
    stdin.setRaw(true);
  } catch (e) {
    fatal(`Cannot read stdin: ${(e as Error).message}`);
  }
  render(true);

  const buf = new Uint8Array(8);
  while (true) {
    const n = await stdin.read(buf);
    if (n === null) break;
    const seq = Array.from(buf.subarray(0, n));
    const s = String.fromCharCode(...seq);

    if (s === '\x03') {
      cleanup();
      fatal('Aborted.');
    }
    if (s === '\x1b' && n === 1) {
      cleanup();
      write('\n');
      fatal('Cancelled.');
    }
    if (s === '\r' || s === '\n') break;
    if (s === ' ') {
      checked[cursor] = !checked[cursor];
      render(false);
      continue;
    }
    if (s === 'a' || s === 'A') {
      const allOn = checked.every(Boolean);
      for (let i = 0; i < checked.length; i++) checked[i] = !allOn;
      render(false);
      continue;
    }
    if (seq[0] === 0x1b && seq[1] === 0x5b) {
      if (seq[2] === 0x41) {
        cursor = (cursor - 1 + devs.length) % devs.length;
        render(false);
        continue;
      }
      if (seq[2] === 0x42) {
        cursor = (cursor + 1) % devs.length;
        render(false);
        continue;
      }
    }
    if (s === 'k') {
      cursor = (cursor - 1 + devs.length) % devs.length;
      render(false);
      continue;
    }
    if (s === 'j') {
      cursor = (cursor + 1) % devs.length;
      render(false);
      continue;
    }
  }
  cleanup();
  write('\n');
  return devs.filter((_, i) => checked[i]);
}
