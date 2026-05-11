// Interactive multi-select TTY checklist. Arrows/jk move, space toggles,
// `a` toggles all, enter confirms, esc/Ctrl-C cancels.
//
// Selection memory is persisted to a per-user cache file (NOT inside the
// project tree) keyed by absolute cwd, so re-running pre-checks the same
// devices without polluting the repo with `.maestro/.last-devices`.

import { join } from '@std/path';
import { deviceLabel } from './devices.ts';
import type { Device } from './types.ts';
import { C, fatal } from './ui.ts';

// Per-user cache directory.
//   macOS  : ~/Library/Caches/maestro-parallel
//   Other  : $XDG_CACHE_HOME/maestro-parallel || ~/.cache/maestro-parallel
function cacheBase(): string {
  const home = Deno.env.get('HOME') ?? '';
  if (Deno.build.os === 'darwin' && home) {
    return join(home, 'Library', 'Caches', 'maestro-parallel');
  }
  const xdg = Deno.env.get('XDG_CACHE_HOME');
  if (xdg) return join(xdg, 'maestro-parallel');
  return join(home || '.', '.cache', 'maestro-parallel');
}

function cachePath(): string {
  return join(cacheBase(), 'last-devices.json');
}

type SelectionMap = Record<string, string[]>;

async function readSelectionMap(): Promise<SelectionMap> {
  try {
    const txt = await Deno.readTextFile(cachePath());
    const parsed = JSON.parse(txt) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as SelectionMap;
    }
    return {};
  } catch {
    return {};
  }
}

export async function readLastSelection(cwd: string): Promise<Set<string>> {
  const map = await readSelectionMap();
  return new Set(map[cwd] ?? []);
}

export async function writeLastSelection(cwd: string, ids: string[]): Promise<void> {
  const map = await readSelectionMap();
  map[cwd] = ids;
  try {
    await Deno.mkdir(cacheBase(), { recursive: true });
    await Deno.writeTextFile(cachePath(), JSON.stringify(map, null, 2) + '\n');
  } catch {
    // Best-effort — failing to remember the selection should not abort the run.
  }
}

export async function pickDevices(devs: Device[], preselect: Set<string>): Promise<Device[]> {
  if (!Deno.stdin.isTerminal()) {
    fatal('Interactive picker requires a TTY. Run from a terminal.');
  }

  const checked = devs.map((d) => preselect.has(d.id));
  let cursor = 0;
  const enc = new TextEncoder();
  const write = (s: string): Promise<number> => Deno.stdout.write(enc.encode(s));

  // Raw mode disables ONLCR — `\n` no longer carriage-returns. Use `\r\n` line
  // endings and `\x1b[NF` (CPL = up N AND col 0) for redraw. Total lines per
  // draw = 2 header + devs.length; after the last `\r\n` the cursor sits at
  // column 0 of the line one past the list, so move up that many to reach
  // the header again.
  const headerLines = 2;
  const totalLines = headerLines + devs.length;

  const render = async (firstDraw: boolean): Promise<void> => {
    if (!firstDraw) {
      await write(`\x1b[${totalLines}F`);
    }
    await write('\x1b[?25l');
    await write(`${C.bold}Select devices to run Maestro on${C.reset}\x1b[K\r\n`);
    await write(
      `${C.dim}↑/↓ move · space toggle · a toggle all · enter run · esc cancel${C.reset}\x1b[K\r\n`,
    );
    for (let i = 0; i < devs.length; i++) {
      const d = devs[i]!;
      const box = checked[i] ? `${C.green}[x]${C.reset}` : '[ ]';
      const line = `${box} ${deviceLabel(d)}`;
      if (i === cursor) await write(`${C.inverse}> ${line}${C.reset}\x1b[K\r\n`);
      else await write(`  ${line}\x1b[K\r\n`);
    }
  };

  const cleanup = async (): Promise<void> => {
    await write('\x1b[?25h');
    try {
      Deno.stdin.setRaw(false);
    } catch { /* ignore */ }
  };

  // If the user hits Ctrl-C while the raw-mode picker is up, restore the
  // terminal before exiting so they aren't left without a cursor or with
  // raw-mode stdin. The handler is removed once the picker returns normally.
  const onSig = (): void => {
    cleanup().finally(() => Deno.exit(130));
  };
  Deno.addSignalListener('SIGINT', onSig);
  Deno.addSignalListener('SIGTERM', onSig);

  try {
    Deno.stdin.setRaw(true);
  } catch (e) {
    await cleanup();
    Deno.removeSignalListener('SIGINT', onSig);
    Deno.removeSignalListener('SIGTERM', onSig);
    fatal(`Cannot set raw mode on stdin: ${(e as Error).message}`);
  }
  await render(true);

  const removeSig = (): void => {
    Deno.removeSignalListener('SIGINT', onSig);
    Deno.removeSignalListener('SIGTERM', onSig);
  };

  const buf = new Uint8Array(8);
  const dec = new TextDecoder();
  for (;;) {
    const n = await Deno.stdin.read(buf);
    if (n === null) {
      await cleanup();
      removeSig();
      return fatal('Stdin closed.');
    }
    const chunk = buf.subarray(0, n);
    const s = dec.decode(chunk);

    if (s === '\x03') {
      await cleanup();
      removeSig();
      fatal('Aborted.');
    }
    if (s === '\x1b' && chunk.length === 1) {
      await cleanup();
      await write('\n');
      removeSig();
      fatal('Cancelled.');
    }
    if (s === '\r' || s === '\n') {
      await cleanup();
      await write('\n');
      removeSig();
      return devs.filter((_, i) => checked[i]);
    }
    if (s === ' ') {
      checked[cursor] = !checked[cursor];
      await render(false);
      continue;
    }
    if (s === 'a' || s === 'A') {
      const allOn = checked.every(Boolean);
      for (let i = 0; i < checked.length; i++) checked[i] = !allOn;
      await render(false);
      continue;
    }
    if (chunk[0] === 0x1b && chunk[1] === 0x5b) {
      if (chunk[2] === 0x41) {
        cursor = (cursor - 1 + devs.length) % devs.length;
        await render(false);
        continue;
      }
      if (chunk[2] === 0x42) {
        cursor = (cursor + 1) % devs.length;
        await render(false);
        continue;
      }
    }
    if (s === 'k') {
      cursor = (cursor - 1 + devs.length) % devs.length;
      await render(false);
      continue;
    }
    if (s === 'j') {
      cursor = (cursor + 1) % devs.length;
      await render(false);
      continue;
    }
  }
}
