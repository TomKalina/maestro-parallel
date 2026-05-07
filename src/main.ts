// Top-level orchestration. Used by both the CLI and library consumers.

import { join } from '@std/path';
import { type MaestroParallelConfig, resolveConfig } from './config.ts';
import { discoverDevices } from './devices.ts';
import { mergeJunit, summarize } from './junit.ts';
import { pickDevices, readLastSelection, writeLastSelection } from './picker.ts';
import { makeShardConfig, runDevice, runShardGroup } from './runner.ts';
import { buildAndInstall, clearAppState, wakeAndroidDevices } from './setup.ts';
import type { Device, RunResult } from './types.ts';
import { C, fatal, log, PALETTE } from './ui.ts';

export interface RunOptions {
  /** Project root. Default `Deno.cwd()`. */
  cwd?: string;
  /**
   * Pre-selected devices: skips the interactive picker. Useful for CI or
   * when wrapping the library in a custom command.
   */
  devices?: Device[];
  /**
   * Skip build & install (assume the app is already installed). Default false.
   */
  skipBuild?: boolean;
  /** Skip clearing app data. Default false. */
  skipClear?: boolean;
}

async function pruneOldRuns(cwd: string, outputDir: string, keep: number): Promise<void> {
  try {
    const entries: { name: string; mtime: number }[] = [];
    for await (const e of Deno.readDir(join(cwd, outputDir))) {
      if (e.isDirectory && e.name.startsWith('parallel-')) {
        const stat = await Deno.stat(join(cwd, outputDir, e.name));
        entries.push({ name: e.name, mtime: stat.mtime?.getTime() ?? 0 });
      }
    }
    entries.sort((a, b) => b.mtime - a.mtime);
    for (const old of entries.slice(keep)) {
      await Deno.remove(join(cwd, outputDir, old.name), { recursive: true });
    }
  } catch { /* ignore */ }
}

/**
 * End-to-end run: discover (or accept) devices, optionally pick, build &
 * install, prep, run Maestro, merge JUnit, summarise. Returns a non-zero
 * exit code if any device failed.
 */
export async function runMaestroParallel(
  config: MaestroParallelConfig,
  options: RunOptions = {},
): Promise<number> {
  const resolved = resolveConfig(config);
  const cwd = options.cwd ?? Deno.cwd();
  Deno.chdir(cwd);

  log(`${C.dim}cwd:${C.reset} ${cwd}`);

  let chosen: Device[];
  if (options.devices && options.devices.length > 0) {
    chosen = options.devices;
  } else {
    log(`${C.dim}discovering devices...${C.reset}`);
    const devs = await discoverDevices();
    if (devs.length === 0) {
      fatal('No devices found. Connect Android via USB (adb devices) or boot an iOS simulator.');
    }
    const last = await readLastSelection(cwd);
    chosen = await pickDevices(devs, last);
    if (chosen.length === 0) fatal('No device selected.');
    await writeLastSelection(cwd, chosen.map((d) => d.id));
  }

  await pruneOldRuns(cwd, resolved.outputDir, resolved.keepRuns);

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outBase = join(resolved.outputDir, `parallel-${ts}`);
  await Deno.mkdir(join(cwd, outBase), { recursive: true });

  const prefixWidth = Math.max(
    ...chosen.map((d) => (d.platform === 'android' ? 'and' : 'ios').length + 1 + d.name.length),
    12,
  );
  const colorByDevice = new Map(
    chosen.map((d, i) => [d.id, PALETTE[i % PALETTE.length] ?? PALETTE[0]!] as const),
  );
  const colorOf = (d: Device): string => colorByDevice.get(d.id) ?? PALETTE[0]!;

  if (!options.skipBuild) {
    await buildAndInstall(chosen, cwd, resolved, colorOf, prefixWidth);
  }

  await wakeAndroidDevices(chosen);

  if (!options.skipClear) {
    await clearAppState(chosen, resolved.bundleId);
  }

  if (resolved.hooks?.preTest) {
    await resolved.hooks.preTest(chosen);
  }

  const androidDevices = chosen.filter((d) => d.platform === 'android');
  const iosDevices = chosen.filter((d) => d.platform === 'ios');
  const results: RunResult[] = [];

  // Android: parallel processes. Maestro 2.5+ fixed the dadb host port race.
  const androidPromise = Promise.all(
    androidDevices.map((d) =>
      runDevice(d, colorOf(d), prefixWidth, cwd, outBase, resolved).then((r) => {
        results.push(r);
      })
    ),
  );

  // iOS: sequential by default — XCTestService races on per-sim ports when
  // multiple iOS simulators are driven concurrently. Opt into shard-all
  // when the user knows their setup tolerates it.
  const iosPromise = (async () => {
    if (iosDevices.length === 0) return;
    if (resolved.iosShardAll) {
      const shardConfig = await makeShardConfig(cwd, resolved.maestroConfigPath);
      const color = colorOf(iosDevices[0]!);
      const group = await runShardGroup(
        'ios',
        iosDevices,
        color,
        prefixWidth,
        cwd,
        outBase,
        shardConfig,
        resolved,
      );
      // Translate group result into per-device results so summary works.
      for (const d of iosDevices) {
        results.push({ device: d, exitCode: group.exitCode, outDir: group.outDir });
      }
      return;
    }
    if (resolved.iosSequential) {
      for (const d of iosDevices) {
        const r = await runDevice(d, colorOf(d), prefixWidth, cwd, outBase, resolved);
        results.push(r);
      }
      return;
    }
    await Promise.all(
      iosDevices.map((d) =>
        runDevice(d, colorOf(d), prefixWidth, cwd, outBase, resolved).then((r) => {
          results.push(r);
        })
      ),
    );
  })();

  await Promise.all([androidPromise, iosPromise]);

  const merged = await mergeJunit(results, outBase);
  await summarize(results, outBase, merged);

  return results.some((r) => r.exitCode !== 0) ? 1 : 0;
}
