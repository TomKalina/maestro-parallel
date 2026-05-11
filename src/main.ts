// Top-level orchestration. Used by both the CLI and library consumers.

import { join } from '@std/path';
import { type BuildMode, promptBuildMode } from './buildMode.ts';
import { type MaestroParallelConfig, resolveConfig } from './config.ts';
import { detectExpoDefaults, expoNativeDefaultHooks } from './defaultBuild.ts';
import { detectBundleId, detectFlowsDir } from './detect.ts';
import { detectBrokenAndroidDevices, discoverDevices } from './devices.ts';
import { mergeJunit, summarize } from './junit.ts';
import { pickDevices, readLastSelection, writeLastSelection } from './picker.ts';
import { makeShardConfig, runDevice, runShardGroup } from './runner.ts';
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
  const cwd = options.cwd ?? Deno.cwd();
  Deno.chdir(cwd);

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
  if (!augmented.build?.android || !augmented.build?.ios) {
    const expoDefaults = await detectExpoDefaults(cwd);
    if (expoDefaults) {
      const hooks = expoNativeDefaultHooks(expoDefaults);
      const filled: string[] = [];
      if (!augmented.build?.android) {
        augmented.build = { ...augmented.build, android: hooks.android };
        filled.push('android');
      }
      if (!augmented.build?.ios) {
        augmented.build = { ...augmented.build, ios: hooks.ios };
        filled.push('ios');
      }
      if (filled.length > 0) {
        log(
          `${C.dim}default build: ${expoDefaults.packageManager} expo run:* (Release / release) for ${
            filled.join(' + ')
          }${C.reset}`,
        );
      }
    }
  }

  const resolved = resolveConfig(augmented);

  log(`${C.dim}cwd:${C.reset} ${cwd}`);
  log(`${C.dim}flows:${C.reset} ${resolved.flowsDir}`);
  if (resolved.bundleId) {
    log(`${C.dim}bundleId:${C.reset} ${resolved.bundleId}`);
  }

  // Resolve the build mode. Source priority:
  //   1. RunOptions.buildMode (CLI flag forwarded by cli.ts)
  //   2. options.skipBuild (legacy --skip-build flag)
  //   3. resolved.buildMode (from config file)
  //   4. Interactive prompt (TTY) / 'release' (non-TTY)
  //
  // Only two modes exist: `release` (build a real production-style
  // artifact and run flows against it) and `skip` (use the app already
  // installed on each device). Dev / dev-client builds are intentionally
  // unsupported — they are structurally flaky for E2E and the workarounds
  // (preflight flows, Metro forwards, deep links) move the failure mode
  // around without removing it. Build a release artifact.
  const haveBuildHooks = !!(resolved.build?.android || resolved.build?.ios);
  let buildMode: BuildMode;
  if (options.buildMode) {
    buildMode = options.buildMode;
  } else if (options.skipBuild) {
    buildMode = 'skip';
  } else if (resolved.buildMode) {
    buildMode = resolved.buildMode;
  } else if (!haveBuildHooks) {
    // No config file or config without `build.*` hooks → there is nothing
    // to build. Skip the prompt entirely and proceed against the
    // already-installed app. Loud log so the user notices.
    log(
      `${C.yellow}no build.android / build.ios hooks configured — skipping build & install. Add a config to enable release builds (see examples/expo.config.ts).${C.reset}`,
    );
    buildMode = 'skip';
  } else {
    buildMode = promptBuildMode();
  }
  if (buildMode === 'release' && !haveBuildHooks) {
    // Belt-and-braces: if release was selected via CLI/config but there
    // are no hooks, fail loudly rather than silently running flows
    // against a stale app the user wasn't expecting.
    fatal(
      'release build requested, but no build.android / build.ios hooks are configured. Add a build hook in maestroparallel.config.ts (see examples/expo.config.ts or examples/eas-local.config.ts), or pass --skip-build to run flows against the already-installed app.',
    );
  }
  log(`${C.dim}buildMode:${C.reset} ${C.bold}${buildMode}${C.reset}`);

  let chosen: Device[];
  if (options.devices && options.devices.length > 0) {
    chosen = options.devices;
  } else {
    log(`${C.dim}discovering devices...${C.reset}`);
    // Maestro 2.5.1 cannot match ANY device by UDID when adb has an
    // unauthorized/offline entry in its list — every `--device` lookup
    // returns "not connected". Warn loudly so the user fixes it before tests.
    const broken = await detectBrokenAndroidDevices();
    if (broken.length > 0) {
      log(
        `${C.yellow}warning: adb has ${broken.length} non-ready device(s): ${
          broken.map((b) => `${b.id} (${b.state})`).join(', ')
        }${C.reset}`,
      );
      log(
        `${C.yellow}    Maestro 2.5.x fails on these. Unplug them, accept the USB-debug prompt, or run 'adb -s <id> reconnect'.${C.reset}`,
      );
    }
    const devs = await discoverDevices();
    if (devs.length === 0) {
      fatal('No devices found. Connect Android via USB (adb devices) or boot an iOS simulator.');
    }
    if (options.allDevices) {
      chosen = devs;
      log(`${C.dim}using all ${devs.length} discovered device(s)${C.reset}`);
    } else if (devs.length === 1) {
      // Skip the picker when there's nothing to choose from.
      chosen = devs;
      log(`${C.dim}only 1 device found, running on it directly${C.reset}`);
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

  if (buildMode === 'release' && resolved.build) {
    await buildAndInstall(chosen, cwd, resolved, colorOf, prefixWidth, buildMode);
  } else if (buildMode === 'skip') {
    log(`${C.dim}skip build — using whatever's already installed${C.reset}`);
  }

  await wakeAndroidDevices(chosen);
  const iosTunnels: IosTunnelHandle = await wakeIosPhysicalTunnels(chosen);
  warnIosPhysicalAutoLock(chosen);

  // Disable the iOS "Save Password?" / AutoFill prompt and keep the
  // simulator's screen awake. Without this the AutoFill overlay floats
  // above the app after any password submit and blocks Maestro's next
  // step — the overlay is rendered by SpringBoard so the flow can't
  // dismiss it. Sims only: physical iOS can't be configured programmatically.
  const iosSims = chosen.filter((d) => d.platform === 'ios' && d.kind === 'simulator');
  if (iosSims.length > 0) {
    log(
      `${C.dim}configuring ${iosSims.length} iOS sim(s): disable AutoFill, reset keychain, keep awake${C.reset}`,
    );
    await Promise.all(iosSims.map((d) => setupIosSim(d.id)));
  }
  const iosPhysical = chosen.filter((d) => d.platform === 'ios' && d.kind === 'usb');
  if (iosPhysical.length > 0) {
    log(
      `${C.yellow}note: physical iOS (${
        iosPhysical.map((d) => d.name).join(', ')
      }) — disable AutoFill manually: Settings → Passwords → Password Options → AutoFill Passwords (off).${C.reset}`,
    );
  }

  // bundleId is required for the clear step; if absent we silently skip it.
  if (!options.skipClear && resolved.bundleId) {
    await clearAppState(chosen, resolved.bundleId);
  }

  if (resolved.hooks?.preTest) {
    await resolved.hooks.preTest(chosen);
  }

  // Signal handler for the iOS CoreDevice tunnel keepalives. Without this,
  // Ctrl-C would orphan the background `devicectl` processes.
  const cleanup = async (): Promise<void> => {
    await iosTunnels.stop();
  };
  const onSig = (): void => {
    cleanup().finally(() => Deno.exit(130));
  };
  Deno.addSignalListener('SIGINT', onSig);
  Deno.addSignalListener('SIGTERM', onSig);

  const androidDevices = chosen.filter((d) => d.platform === 'android');
  const iosDevices = chosen.filter((d) => d.platform === 'ios');
  const results: RunResult[] = [];

  // Stagger consecutive launches across BOTH platforms — Maestro 2.5.x
  // collides on its per-second session-log directory when two processes
  // start in the same wall-clock second. A shared counter ensures the very
  // first Android and the very first iOS process also get spaced.
  //
  // Delay is CUMULATIVE: i=0 → 0 ms, i=1 → stagger, i=2 → 2*stagger, …
  // Otherwise all parallel callers would await the same fixed timeout and
  // land in the same second together.
  const stagger = resolved.processStartStaggerMs;
  let staggerIdx = 0;
  const launchStaggered = async <T>(fn: () => Promise<T>): Promise<T> => {
    const i = staggerIdx++;
    if (i > 0 && stagger > 0) {
      await new Promise<void>((r) => setTimeout(r, stagger * i));
    }
    return await fn();
  };

  // Android: parallel processes (staggered). Maestro 2.5+ fixed the dadb host
  // port race so multiple Maestro processes are safe; only the log-dir race
  // remains and the stagger handles it.
  const androidPromise = Promise.all(
    androidDevices.map((d) =>
      launchStaggered(() => runDevice(d, colorOf(d), prefixWidth, cwd, outBase, resolved)).then(
        (r) => {
          results.push(r);
        },
      )
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
      const group = await launchStaggered(() =>
        runShardGroup(
          'ios',
          iosDevices,
          color,
          prefixWidth,
          cwd,
          outBase,
          shardConfig,
          resolved,
        )
      );
      for (const d of iosDevices) {
        results.push({ device: d, exitCode: group.exitCode, outDir: group.outDir });
      }
      return;
    }
    if (resolved.iosSequential) {
      for (const d of iosDevices) {
        const r = await launchStaggered(() =>
          runDevice(d, colorOf(d), prefixWidth, cwd, outBase, resolved)
        );
        results.push(r);
      }
      return;
    }
    await Promise.all(
      iosDevices.map((d) =>
        launchStaggered(() => runDevice(d, colorOf(d), prefixWidth, cwd, outBase, resolved)).then(
          (r) => {
            results.push(r);
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

  const merged = await mergeJunit(results, outBase);
  await summarize(results, outBase, merged);

  return results.some((r) => r.exitCode !== 0) ? 1 : 0;
}
