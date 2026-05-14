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
import type { Device, RunResult } from './types.ts';
import { Listr } from 'npm:listr2@10.2.1';
import {
  fatal,
  info,
  intro,
  note,
  outro,
  PALETTE,
  warn,
} from './ui.ts';

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

  // Preflight runs unconditionally — even in skip mode the iOS sim
  // destination probe is useful (it warns about missing runtimes before
  // Maestro fails with a confusing simctl error).
  const issues = await preflightChecks(cwd, chosen);
  logPreflight(issues);

  let iosTunnels: IosTunnelHandle = { stop: () => Promise.resolve() };
  const results: RunResult[] = [];

  // Build the Listr task list: phases visible upfront, fill in as they
  // run. Each phase task updates its own title and output; listr2 handles
  // ANSI redraw + non-TTY fallback for us.
  const phases = new Listr<unknown>([
    {
      title: 'Build & install',
      enabled: () => buildMode === 'release' && !!resolved.build,
      task: async (_, task) => {
        const report = (msg: string): void => {
          task.output = msg;
        };
        await buildAndInstall(
          chosen,
          cwd,
          resolved,
          colorOf,
          prefixWidth,
          buildMode,
          outBase,
          { quiet: true, report },
        );
      },
    },
    {
      title: 'Prepare devices',
      task: async (_, task) => {
        task.output = 'waking Android devices…';
        await wakeAndroidDevices(chosen, true);
        task.output = 'establishing iOS tunnel(s)…';
        iosTunnels = await wakeIosPhysicalTunnels(chosen, true);
        warnIosPhysicalAutoLock(chosen, true);
        const iosSims = chosen.filter((d) => d.platform === 'ios' && d.kind === 'simulator');
        if (iosSims.length > 0) {
          task.output = `configuring ${iosSims.length} iOS sim(s)…`;
          await Promise.all(iosSims.map((d) => setupIosSim(d.id)));
        }
        if (!options.skipClear && resolved.bundleId) {
          task.output = 'clearing app state…';
          await clearAppState(chosen, resolved.bundleId, true);
        }
        if (resolved.hooks?.preTest) {
          task.output = 'running preTest hook…';
          await resolved.hooks.preTest(chosen);
        }
      },
    },
    {
      title: `Maestro tests (${chosen.length} device${chosen.length > 1 ? 's' : ''})`,
      task: async (_, task) => {
        const androidDevices = chosen.filter((d) => d.platform === 'android');
        const iosDevices = chosen.filter((d) => d.platform === 'ios');

        const stagger = resolved.processStartStaggerMs;
        const makeStagger = () => {
          let idx = 0;
          return async <T>(fn: () => Promise<T>): Promise<T> => {
            const i = idx++;
            if (i > 0 && stagger > 0) {
              await new Promise<void>((r) => setTimeout(r, stagger * i));
            }
            return await fn();
          };
        };

        let mPass = 0;
        let mFail = 0;
        const baseTitle = task.title;
        const onEvent = (e: FlowEvent): void => {
          if (e.status === 'pass') mPass++;
          else mFail++;
          task.title = `${baseTitle} — ${mPass} ✓  ${mFail} ✗`;
          task.output = `${e.device.name}: ${e.flow}`;
        };
        const useEvents = !resolved.iosShardAll;

        const androidStagger = makeStagger();
        const androidPromise = Promise.all(
          androidDevices.map((d) =>
            androidStagger(() =>
              runDevice(d, colorOf(d), prefixWidth, cwd, outBase, resolved, useEvents ? onEvent : undefined)
            ).then((r) => {
              results.push(r);
            })
          ),
        );

        const iosPromise = (async () => {
          if (iosDevices.length === 0) return;
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
            );
            for (const d of iosDevices) {
              results.push({ device: d, exitCode: group.exitCode, outDir: group.outDir });
            }
            return;
          }
          if (resolved.iosSequential) {
            for (const d of iosDevices) {
              const r = await runDevice(d, colorOf(d), prefixWidth, cwd, outBase, resolved, onEvent);
              results.push(r);
            }
            return;
          }
          const iosStagger = makeStagger();
          await Promise.all(
            iosDevices.map((d) =>
              iosStagger(() =>
                runDevice(d, colorOf(d), prefixWidth, cwd, outBase, resolved, onEvent)
              ).then((r) => {
                results.push(r);
              })
            ),
          );
        })();

        await Promise.all([androidPromise, iosPromise]);
      },
    },
  ], {
    concurrent: false,
    rendererOptions: { collapseSubtasks: false, showSubtasks: true },
  });

  // Signal handler for the iOS CoreDevice tunnel keepalives + every
  // child spawned via exec.ts (maestro test, simctl install, rock run,
  // …). Without these reaps, Ctrl-C would orphan them: keepalives keep
  // the tunnel open, Maestro keeps holding XCTest sessions, xcodebuild
  // keeps DerivedData locked.
  const cleanup = async (): Promise<void> => {
    killAllChildren();
    await iosTunnels.stop();
  };
  const onSig = (): void => {
    // Race cleanup against a hard 3s deadline so a stuck child can't
    // hang Ctrl-C indefinitely. The keepalive children get SIGTERM in
    // iosTunnels.stop(); if they ignore it we just exit anyway.
    const deadline = new Promise<void>((r) => setTimeout(r, 3000));
    Promise.race([cleanup(), deadline]).finally(() => Deno.exit(130));
  };
  Deno.addSignalListener('SIGINT', onSig);
  Deno.addSignalListener('SIGTERM', onSig);

  try {
    await phases.run();
  } finally {
    Deno.removeSignalListener('SIGINT', onSig);
    Deno.removeSignalListener('SIGTERM', onSig);
    await cleanup();
  }

  const merged = await mergeJunit(results, outBase);
  await summarize(results, outBase, merged);

  const failed = results.filter((r) => r.exitCode !== 0).length;
  const passed = results.length - failed;
  if (failed === 0) {
    outro(`${passed}/${results.length} devices passed`, true);
  } else {
    outro(`${passed}/${results.length} devices passed — ${failed} failed`, false);
  }
  return failed > 0 ? 1 : 0;
}
