// Interactive multi-select TTY checklist. Arrows/jk move, space toggles,
// `a` toggles all, enter confirms, esc/Ctrl-C cancels. Selection memory
// is persisted to `.maestro/.last-devices` so re-running pre-checks the
// same devices.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deviceLabel } from './devices.js';
import type { Device } from './types.js';
import { C, fatal } from './ui.js';

export const SELECTION_MEMORY_FILE = '.maestro/.last-devices';

export async function readLastSelection(
  cwd: string,
  file = SELECTION_MEMORY_FILE,
): Promise<Set<string>> {
  try {
    const txt = await readFile(join(cwd, file), 'utf8');
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
  await writeFile(join(cwd, file), ids.join('\n') + '\n');
}

export function pickDevices(devs: Device[], preselect: Set<string>): Promise<Device[]> {
  const checked = devs.map((d) => preselect.has(d.id));
  let cursor = 0;
  const stdin = process.stdin;
  const stdout = process.stdout;
  const write = (s: string): void => {
    stdout.write(s);
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
      stdin.setRawMode(false);
    } catch { /* ignore */ }
    stdin.pause();
  };

  return new Promise<Device[]>((resolve) => {
    if (!stdin.isTTY) {
      fatal('Interactive picker requires a TTY. Run from a terminal.');
    }
    try {
      stdin.setRawMode(true);
    } catch (e) {
      fatal(`Cannot set raw mode on stdin: ${(e as Error).message}`);
    }
    stdin.resume();
    render(true);

    const onData = (chunk: Buffer): void => {
      const seq = Array.from(chunk);
      const s = chunk.toString('utf8');

      if (s === '\x03') {
        cleanup();
        stdin.off('data', onData);
        fatal('Aborted.');
      }
      if (s === '\x1b' && chunk.length === 1) {
        cleanup();
        write('\n');
        stdin.off('data', onData);
        fatal('Cancelled.');
      }
      if (s === '\r' || s === '\n') {
        cleanup();
        write('\n');
        stdin.off('data', onData);
        resolve(devs.filter((_, i) => checked[i]));
        return;
      }
      if (s === ' ') {
        checked[cursor] = !checked[cursor];
        render(false);
        return;
      }
      if (s === 'a' || s === 'A') {
        const allOn = checked.every(Boolean);
        for (let i = 0; i < checked.length; i++) checked[i] = !allOn;
        render(false);
        return;
      }
      if (seq[0] === 0x1b && seq[1] === 0x5b) {
        if (seq[2] === 0x41) {
          cursor = (cursor - 1 + devs.length) % devs.length;
          render(false);
          return;
        }
        if (seq[2] === 0x42) {
          cursor = (cursor + 1) % devs.length;
          render(false);
          return;
        }
      }
      if (s === 'k') {
        cursor = (cursor - 1 + devs.length) % devs.length;
        render(false);
        return;
      }
      if (s === 'j') {
        cursor = (cursor + 1) % devs.length;
        render(false);
        return;
      }
    };

    stdin.on('data', onData);
  });
}
