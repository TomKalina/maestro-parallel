// Top-level orchestration. Used by both the CLI and library consumers.

import { join } from '@std/path';
import type { BuildMode } from './buildMode.ts';
import { type MaestroParallelConfig, resolveConfig } from './config.ts';
import { buildDefaultHooks } from './defaultBuild.ts';
import { detectBundleId, detectFlowsDir } from './detect.ts';
import { detectBrokenAndroidDevices, discoverDevices } from './devices.ts';
import { killAllChildren } from './exec.ts';
import { mergeJunit, summarize } from './junit.ts';
import { pickDevices, readLastSelection, writeLastSelection } from './picker.ts';
import { logPreflight, preflightChecks } from './preflight.ts';
import { type FlowEvent, makeShardConfig, runDevice, runShardGroup } from './runner.ts';
import {
  buildAndInstall,
  clearAppState,
  type IosTunnelHandle,
  wakeAndroidDevices,
  wakeIosPhysicalTunnels,
  warnIosPhysicalAutoLock,
} from './setup.ts';
import { setupIosSim } from './setupIosSim.ts';
import { TaskList } from './taskList.ts';
import type { Device, RunResult } from './types.ts';
import { C, fatal, info, intro, note, outro, PALETTE, warn } from './ui.ts';

export interface RunOptions {
  /** Project root. Default `Deno.cwd()`. */
  cwd?: string;
  /**
   * Pre-selected devices: skips the interactive picker. Useful for CI or
   * when wrapping the library in a custom command.
   */
  devices?: Device[];
  /**
   * Skip the interactive picker and use every discovered device. Default false.
   * The picker is also auto-skipped when only one device is available.
   */
  allDevices?: boolean;
  /**
   * Skip build & install (assume the app is already installed). Default false.
   * Equivalent to `buildMode: 'skip'`.
   */
  skipBuild?: boolean;
  /** Skip clearing app data. Default false. */
  skipClear?: boolean;
  /**
   * Pre-selected build mode. When set, skips the interactive prompt. CLI
   * `--release` / `--skip-build` set this. Default: prompt interactively
   * (TTY) or `release` (non-TTY).
   */
  buildMode?: BuildMode;
  /**
   * Path of the auto-discovered config file (used purely to display in
   * the configuration block). cli.ts forwards `loaded.path`; library
   * callers usually leave it undefined.
   */
  configPath?: string;
}

async function pruneOldRuns(cwd: string, outputDir: string, keep: number): Promise<void> {
  try {
    const dirPath = join(cwd, outputDir);
    const entries: { name: string; mtime: number }[] = [];
    for await (const e of Deno.readDir(dirPath)) {
      if (e.isDirectory && e.name.startsWith('parallel-')) {
        const s = await Deno.stat(join(dirPath, e.name));
        entries.push({ name: e.name, mtime: s.mtime?.getTime() ?? 0 });
      }
    }
    entries.sort((a, b) => b.mtime - a.mtime);
    for (const old of entries.slice(keep)) {
      await Deno.remove(join(dirPath, old.name), { recursive: true });
    }
  } catch { /* ignore */ }
}

/**
 * End-to-end run: discover (or accept) devices, optionally pick, build &
 * install (release artifact), prep, run Maestro, merge JUnit, summarise.
 * Returns a non-zero exit code if any device failed.
 */
export async function runMaestroParallel(
  config: MaestroParallelConfig,
  options: RunOptions = {},
): Promise<number> {
  intro();
  const cwd = options.cwd ?? Deno.cwd();
  // Do not Deno.chdir(cwd): mutating process-wide cwd breaks repeat /
  // concurrent calls from `index.ts`. All path resolution uses join(cwd, …)
  // and every spawn that needs a working directory passes it explicitly.

  // Fill in any unspecified fields by sniffing the project. Anything the
  // user (or a CLI flag) already set wins — auto-detect is fallback only.
  const augmented: MaestroParallelConfig = { ...config };
  if (!augmented.flowsDir) {
    augmented.flowsDir = await detectFlowsDir(cwd);
  }
  if (!augmented.bundleId) {
    const id = await detectBundleId(cwd);
    if (id) augmented.bundleId = id;
  }

  // Auto-detect a sensible default release build hook for Expo projects
  // when the user has not supplied their own. The canonical local
  // release commands are:
  //
  //   iOS:     pnpm expo run:ios --configuration Release
  //   Android: pnpm expo run:android --variant release
  //
  // They invoke the project's native toolchain (Xcode / Gradle), bake
  // the JS bundle in, and install the artifact on the first device. The
  // runner reuse-installs the resulting .apk / .app on the rest.
  // Fill in defaults per platform — if the user already wired up one
  // platform but not the other, only the missing one gets the auto-hook.
  // Strategy is determined by `buildDefaultHooks`: it prefers an EAS
  // local build (when a matching `e2e-test` / `e2e` / `preview` profile
  // exists in `eas.json`) and falls back to `expo run:*` for plain Expo
  // projects.
  let detectedDescription: string | undefined;
  if (!augmented.build?.android || !augmented.build?.ios) {
    const defaults = await buildDefaultHooks(
      cwd,
      augmented.buildStrategy ?? 'auto',
      augmented.buildEnv ?? {},
    );
    if (defaults) {
      const filled: string[] = [];
      if (!augmented.build?.android) {
        augmented.build = { ...augmented.build, android: defaults.hooks.android };
        filled.push('android');
      }
      if (!augmented.build?.ios) {
        augmented.build = { ...augmented.build, ios: defaults.hooks.ios };
        filled.push('ios');
      }
      if (filled.length > 0) {
        detectedDescription = `${defaults.description} (for ${filled.join(' + ')})`;
      }
    }
  }

  const resolved = resolveConfig(augmented);

  const configLines: Record<string, string> = {
    cwd,
    flows: resolved.flowsDir,
  };
  if (options.configPath) configLines.config = options.configPath;
  if (resolved.bundleId) configLines.bundleId = resolved.bundleId;
  if (detectedDescription) configLines.build = detectedDescription;

  // Resolve the build mode. Source priority:
  //   1. RunOptions.buildMode (CLI flag forwarded by cli.ts)
  //   2. options.skipBuild (--skip-build flag)
  //   3. resolved.buildMode (from config file)
  //   4. 'release' when build hooks exist, 'skip' otherwise.
  //
  // We never prompt anymore — Rock / EAS already fingerprint-cache the
  // build, so always-on release is the right default. Cache hits run in
  // seconds; cache misses are the rebuild you'd have to do either way.
  // Use --skip-build to explicitly run flows against the already-
  // installed app.
  const haveBuildHooks = !!(resolved.build?.android || resolved.build?.ios);
  let buildMode: BuildMode;
  if (options.buildMode) {
    buildMode = options.buildMode;
  } else if (options.skipBuild) {
    buildMode = 'skip';
  } else if (resolved.buildMode) {
    buildMode = resolved.buildMode;
  } else if (!haveBuildHooks) {
    warn(
      'no build.android / build.ios hooks configured — skipping build & install. Add a config to enable release builds (see examples/expo.config.ts).',
    );
    buildMode = 'skip';
  } else {
    buildMode = 'release';
  }
  if (buildMode === 'release' && !haveBuildHooks) {
    fatal(
      'release build requested, but no build.android / build.ios hooks are configured. Add a build hook in maestroparallel.config.ts (see examples/expo.config.ts or examples/eas-local.config.ts), or pass --skip-build to run flows against the already-installed app.',
    );
  }
  configLines.buildMode = buildMode;
  note('configuration', configLines);

  let chosen: Device[];
  if (options.devices && options.devices.length > 0) {
    chosen = options.devices;
  } else {
    info('discovering devices…');
    // Maestro 2.5.1 cannot match ANY device by UDID when adb has an
    // unauthorized/offline entry in its list — every `--device` lookup
    // returns "not connected". Warn loudly so the user fixes it before tests.
    const broken = await detectBrokenAndroidDevices();
    if (broken.length > 0) {
      warn(
        `adb has ${broken.length} non-ready device(s): ${
          broken.map((b) => `${b.id} (${b.state})`).join(', ')
        } — Maestro 2.5.x fails on these. Unplug them, accept the USB-debug prompt, or run 'adb -s <id> reconnect'.`,
      );
    }
    const devs = await discoverDevices();
    if (devs.length === 0) {
      fatal('No devices found. Connect Android via USB (adb devices) or boot an iOS simulator.');
    }
    if (options.allDevices) {
      chosen = devs;
      info(`using all ${devs.length} discovered device(s)`);
    } else if (devs.length === 1) {
      // Skip the picker when there's nothing to choose from.
      chosen = devs;
      info('only 1 device found, running on it directly');
    } else {
      const last = await readLastSelection(cwd);
      chosen = await pickDevices(devs, last);
      if (chosen.length === 0) fatal('No device selected.');
      await writeLastSelection(cwd, chosen.map((d) => d.id));
    }
  }

  // Device-centric checklist — one row per device, status flips on
  // the same row as the device progresses through build/install/
  // prepare/maestro phases.
  const nameWidth = Math.max(...chosen.map((d) => d.name.length));
  const padName = (n: string) => n.padEnd(nameWidth);
  const renderRow = (d: Device, status: string): string =>
    `${padName(d.name)}  ${status}`;
  const tl = new TaskList(chosen.map((d) => renderRow(d, `${C.dim}pending${C.reset}`)));
  tl.render();
  const deviceIndex = new Map<string, number>(chosen.map((d, i) => [d.id, i]));
  // Single tally store + a helper that re-renders the row text with the
  // device's current "status text" (left-of-tally) + counts.
  const tally = new Map<string, { pass: number; fail: number; current?: string }>();
  for (const d of chosen) tally.set(d.id, { pass: 0, fail: 0 });
  const updateRow = (d: Device, status: string): void => {
    tl.setTitle(deviceIndex.get(d.id)!, renderRow(d, status));
  };

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

  // Signal handler registered upfront so any child spawned by preflight,
  // build, prepare, or maestro phases is reaped on Ctrl-C — not only
  // those spawned AFTER the prepare phase (where this handler used to
  // live).
  let iosTunnels: IosTunnelHandle = { stop: () => Promise.resolve() };
  const cleanup = async (): Promise<void> => {
    killAllChildren();
    await iosTunnels.stop();
  };
  let deadlineTimer: number | null = null;
  const onSig = (): void => {
    // Race cleanup against a hard 3 s deadline; stuck children can't
    // hang Ctrl-C. The timer ID is cleared on cleanup resolution so
    // it doesn't dangle after exit() is called.
    const deadline = new Promise<void>((r) => {
      deadlineTimer = setTimeout(r, 3000);
      Deno.unrefTimer(deadlineTimer);
    });
    Promise.race([cleanup(), deadline]).finally(() => {
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      Deno.exit(130);
    });
  };
  Deno.addSignalListener('SIGINT', onSig);
  Deno.addSignalListener('SIGTERM', onSig);

  // Preflight runs unconditionally — even in skip mode the iOS sim
  // destination probe is useful (it warns about missing runtimes before
  // Maestro fails with a confusing simctl error).
  const issues = await preflightChecks(cwd, chosen);
  logPreflight(issues);

  const deviceById = new Map<string, Device>(chosen.map((d) => [d.id, d]));
  // Devices that hit a fatal error in the build/install stage — skip the
  // maestro phase for them but keep their row in its terminal state.
  const failedBeforeTest = new Set<string>();

  if (buildMode === 'release' && resolved.build) {
    // No pre-mark loop — setup.ts emits onDeviceState 'building' per
    // group as it starts, so non-active groups stay 'pending' (no
    // spinner rotation) until their turn.
    await buildAndInstall(chosen, cwd, resolved, colorOf, prefixWidth, buildMode, outBase, {
      quiet: true,
      concurrent: resolved.concurrentBuilds,
      onDeviceState: (deviceId, state, detail) => {
        const d = deviceById.get(deviceId);
        if (!d) return;
        const i = deviceIndex.get(deviceId)!;
        switch (state) {
          case 'building': {
            // Flip to running so the spinner glyph rotates only while
            // this device is actively being worked on. tl.start is
            // idempotent.
            tl.start(i);
            const cols = (Deno.consoleSize?.()?.columns) ?? 80;
            const fixedOverhead = 3 /* glyph + 2sp */ +
              nameWidth + 2 /* "name  " */ +
              8 /* "building" */ +
              2 /* " (" */ +
              1 /* ")" */ +
              5 /* safety */;
            const budget = Math.max(10, cols - fixedOverhead);
            const tail = detail && detail.length > budget
              ? detail.slice(0, budget - 1) + '…'
              : detail;
            updateRow(
              d,
              `${C.cyan}building${C.reset}${tail ? ` ${C.dim}(${tail})${C.reset}` : ''}`,
            );
            break;
          }
          case 'waiting':
            // Legacy state — current setup.ts emits 'building' for the
            // whole group instead. Keep handler for back-compat with
            // user-supplied hooks that may still emit 'waiting'.
            updateRow(d, `${C.dim}waiting (queued)${C.reset}`);
            break;
          case 'installing':
            tl.start(i);
            updateRow(d, `${C.cyan}installing${C.reset}`);
            break;
          case 'installed':
            // Build/install for this device is done — freeze the spinner
            // until the prepare phase flips it back to running. While
            // other groups are still building (concurrent mode), this
            // row sits at static ◇ instead of pretending to spin.
            updateRow(d, `${C.green}built${C.reset}${detail ? ` ${C.dim}${detail}${C.reset}` : ''}`);
            tl.done(i);
            break;
          case 'failed':
            updateRow(d, `${C.red}failed${C.reset}${detail ? ` ${C.dim}${detail}${C.reset}` : ''}`);
            tl.fail(i);
            failedBeforeTest.add(deviceId);
            break;
        }
      },
    });
  } else if (buildMode === 'skip') {
    /* skip — devices remain pending until prepare flips them */
  }

  for (const d of chosen) {
    if (failedBeforeTest.has(d.id)) continue;
    const i = deviceIndex.get(d.id)!;
    tl.start(i);
    updateRow(d, `${C.cyan}preparing${C.reset}`);
  }
  await wakeAndroidDevices(chosen, true);
  iosTunnels = await wakeIosPhysicalTunnels(chosen, true);
  warnIosPhysicalAutoLock(chosen, true);

  const iosSims = chosen.filter((d) => d.platform === 'ios' && d.kind === 'simulator');
  if (iosSims.length > 0) {
    await Promise.all(iosSims.map((d) => setupIosSim(d.id)));
  }
  if (!options.skipClear && resolved.bundleId) {
    await clearAppState(chosen, resolved.bundleId, true);
  }
  if (resolved.hooks?.preTest) {
    await resolved.hooks.preTest(chosen);
  }

  const androidDevices = chosen.filter((d) => d.platform === 'android');
  const iosDevices = chosen.filter((d) => d.platform === 'ios');
  const results: RunResult[] = [];

  // Stagger applies ONLY within a parallel batch. Maestro 2.5.x collides
  // on its per-second session-log directory when two processes start in
  // the same wall-clock second, so siblings in a Promise.all need to be
  // spaced. Sequential queues already have a natural gap (next starts
  // after previous finishes), so they don't need it.
  //
  // Gap is incremental — each call advances a shared timestamp by
  // `stagger`, so the N-th call starts at most `stagger` ms after the
  // (N-1)-th regardless of how many calls preceded it. Previously the
  // delay was cumulative (`stagger * i`), which made the 10th of 10
  // devices wait 20 s for no reason.
  const stagger = resolved.processStartStaggerMs;
  const makeStagger = () => {
    let nextStartAt = 0;
    return async <T>(fn: () => Promise<T>): Promise<T> => {
      if (stagger > 0) {
        const now = Date.now();
        const target = Math.max(now, nextStartAt);
        nextStartAt = target + stagger;
        const wait = target - now;
        if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
      }
      return await fn();
    };
  };

  // Maestro phase — each device's row shows current flow + tally.
  for (const d of chosen) {
    if (failedBeforeTest.has(d.id)) continue;
    updateRow(d, `${C.cyan}starting maestro${C.reset}`);
  }
  const renderTestingRow = (d: Device): void => {
    const t = tally.get(d.id)!;
    const counts = `${C.green}${t.pass} ✓${C.reset}  ${C.red}${t.fail} ✗${C.reset}`;
    const tail = t.current ? `${counts} ${C.dim}·${C.reset} ${t.current}` : counts;
    updateRow(d, tail);
  };
  const onEvent = (e: FlowEvent): void => {
    const t = tally.get(e.device.id)!;
    if (e.status === 'pass') t.pass++;
    else t.fail++;
    t.current = e.flow;
    renderTestingRow(e.device);
  };
  const useEvents = !resolved.iosShardAll;

  const finishDevice = (d: Device, exitCode: number): void => {
    const t = tally.get(d.id)!;
    t.current = undefined;
    const counts = `${C.green}${t.pass} ✓${C.reset}  ${C.red}${t.fail} ✗${C.reset}`;
    const i = deviceIndex.get(d.id)!;
    updateRow(d, counts);
    if (exitCode === 0) tl.done(i);
    else tl.fail(i);
  };

  // When shardMode='split' and a platform group has >1 device, run a SINGLE
  // Maestro process per group with `--shard-split=N`. Maestro 2.5+ handles
  // the per-device distribution internally — there is no `--shard-index`
  // flag, the whole group is driven by one invocation that takes
  // `--device id1,id2,...`. Groups with 1 device fall back to the normal
  // per-device path silently.
  const splitting = resolved.shardMode === 'split';

  // Android: split → one process, full → parallel processes.
  const androidPromise = (async () => {
    if (androidDevices.length === 0) return;
    if (splitting && androidDevices.length > 1) {
      const shardConfig = await makeShardConfig(cwd, resolved.maestroConfigPath, outBase);
      const color = colorOf(androidDevices[0]!);
      const group = await runShardGroup(
        'android',
        androidDevices,
        color,
        prefixWidth,
        cwd,
        outBase,
        shardConfig,
        resolved,
        'split',
      );
      for (const d of androidDevices) {
        results.push({ device: d, exitCode: group.exitCode, outDir: group.outDir });
        finishDevice(d, group.exitCode);
      }
      return;
    }
    const androidStagger = makeStagger();
    await Promise.all(
      androidDevices.map((d) =>
        androidStagger(() =>
          runDevice(d, colorOf(d), prefixWidth, cwd, outBase, resolved, useEvents ? onEvent : undefined)
        ).then(
          (r) => {
            results.push(r);
            finishDevice(d, r.exitCode);
          },
        )
      ),
    );
  })();

  // iOS: split / shard-all → one process; otherwise sequential (default) or
  // parallel staggered processes.
  const iosPromise = (async () => {
    if (iosDevices.length === 0) return;
    if (splitting && iosDevices.length > 1) {
      const shardConfig = await makeShardConfig(cwd, resolved.maestroConfigPath, outBase);
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
        'split',
      );
      for (const d of iosDevices) {
        results.push({ device: d, exitCode: group.exitCode, outDir: group.outDir });
        finishDevice(d, group.exitCode);
      }
      return;
    }
    if (resolved.iosShardAll) {
      const shardConfig = await makeShardConfig(cwd, resolved.maestroConfigPath, outBase);
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
        'all',
      );
      for (const d of iosDevices) {
        results.push({ device: d, exitCode: group.exitCode, outDir: group.outDir });
        finishDevice(d, group.exitCode);
      }
      return;
    }
    if (resolved.iosSequential) {
      // Sequential: previous finishes before next starts — no stagger needed.
      for (const d of iosDevices) {
        const r = await runDevice(d, colorOf(d), prefixWidth, cwd, outBase, resolved, onEvent);
        results.push(r);
        finishDevice(d, r.exitCode);
      }
      return;
    }
    // Parallel iOS: own stagger counter, independent of Android's.
    const iosStagger = makeStagger();
    await Promise.all(
      iosDevices.map((d) =>
        iosStagger(() => runDevice(d, colorOf(d), prefixWidth, cwd, outBase, resolved, onEvent)).then(
          (r) => {
            results.push(r);
            finishDevice(d, r.exitCode);
          },
        )
      ),
    );
  })();

  try {
    await Promise.all([androidPromise, iosPromise]);
  } finally {
    Deno.removeSignalListener('SIGINT', onSig);
    Deno.removeSignalListener('SIGTERM', onSig);
    await cleanup();
  }

  tl.close();

  const merged = await mergeJunit(results, outBase);
  await summarize(results, outBase, merged);

  // Devices that died in the build/install stage never produced a
  // RunResult; count them as failed in the headline so the summary
  // total = N devices the user picked, and exit code reflects partial
  // never-ran failures.
  const ranFailed = results.filter((r) => r.exitCode !== 0).length;
  const totalFailed = ranFailed + failedBeforeTest.size;
  const totalDevices = chosen.length;
  const passed = totalDevices - totalFailed;
  if (totalFailed === 0) {
    outro(`${passed}/${totalDevices} devices passed`, true);
  } else {
    outro(`${passed}/${totalDevices} devices passed — ${totalFailed} failed`, false);
  }
  return totalFailed > 0 ? 1 : 0;
}
