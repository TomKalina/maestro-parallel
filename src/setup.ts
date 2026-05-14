// Pre-test device preparation: wake Android screens, clear app data, and
// build/install the app once per platform group with reuse-install on the
// rest. The build step is delegated to the user's config — we do not know
// whether they use Expo, bare RN, native Xcode/Gradle, etc.

import { join } from '@std/path';
import type { BuildMode } from './buildMode.ts';
import type { ResolvedConfig } from './config.ts';
import { devicePrefix } from './devices.ts';
import { run, spawnPrefixed, spawnToFile } from './exec.ts';
import type { Device, Platform } from './types.ts';
import { C, log } from './ui.ts';

// Wake every Android device and keep its screen on so Maestro can interact
// with the app. A locked screen leaves NotificationShade focused above the
// activity, the surface is black, and every test fails with "Element not
// found". `svc power stayon true` requires USB power, which is the case
// here.
export async function wakeAndroidDevices(devices: Device[], quiet = false): Promise<void> {
  const androids = devices.filter((d) => d.platform === 'android');
  if (androids.length === 0) return;
  const stillLocked: string[] = [];
  await Promise.all(androids.map(async (d) => {
    await run('adb', ['-s', d.id, 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
    // Swipe up from bottom to dismiss the swipe-lock screen on devices without a PIN.
    // Coords are deliberately generic — work on phones from ~720p up.
    await run('adb', ['-s', d.id, 'shell', 'input', 'swipe', '500', '1500', '500', '300', '150']);
    await run('adb', ['-s', d.id, 'shell', 'input', 'keyevent', 'KEYCODE_MENU']);
    await run('adb', ['-s', d.id, 'shell', 'svc', 'power', 'stayon', 'true']);
    // Re-check keyguard state. If still locked, the device almost certainly has a PIN
    // and the user must unlock it manually — Maestro tests will fail until they do.
    const dump = await run('adb', ['-s', d.id, 'shell', 'dumpsys', 'window']);
    if (/mDreamingLockscreen=true|isStatusBarKeyguard=true/.test(dump.stdout)) {
      stillLocked.push(`${d.name} (${d.id})`);
    }
  }));
  if (!quiet) {
    log(
      `${C.dim}woke ${androids.length} Android device(s) and enabled stay-on-while-charging${C.reset}`,
    );
  }
  if (stillLocked.length > 0) {
    log(
      `${C.yellow}warning: device still locked (probably PIN-protected): ${
        stillLocked.join(', ')
      } — unlock manually before tests start${C.reset}`,
    );
  }
}

// iOS has no public programmatic equivalent of `svc power stayon` for physical
// devices — Auto-Lock is a Settings toggle and Apple does not expose it via
// xcrun/devicectl. Best we can do is warn so the user disables it manually
// (Settings → Display & Brightness → Auto-Lock → Never). iOS simulators ARE
// handled — `setupIosSim` writes `SBIdleTimerDisabled` for those.
export function warnIosPhysicalAutoLock(devices: Device[], quiet = false): void {
  if (quiet) return;
  const physical = devices.filter((d) => d.platform === 'ios' && d.kind === 'usb');
  if (physical.length === 0) return;
  log(
    `${C.yellow}note: physical iOS (${
      physical.map((d) => d.name).join(', ')
    }) — Auto-Lock cannot be disabled programmatically. Set: Settings → Display & Brightness → Auto-Lock → Never.${C.reset}`,
  );
}

/**
 * Handle for an active set of CoreDevice tunnels. Call `.stop()` once tests
 * finish to release them. Idempotent.
 */
export interface IosTunnelHandle {
  stop: () => Promise<void>;
}

// Bring up Apple's CoreDevice tunnel for each physical iOS device. Between
// runs `xcrun devicectl list devices` reports `tunnelState=disconnected`
// even for paired wired devices, and Maestro then refuses with
// "Device X was requested, but it is not connected.". `devicectl device
// info details` triggers the daemon to establish the tunnel — but the
// tunnel decays again shortly after the command exits, which is too soon
// when tests start staggered seconds later. So we keep the command running
// for the duration of the test run and kill it during teardown.
export async function wakeIosPhysicalTunnels(
  devices: Device[],
  quiet = false,
): Promise<IosTunnelHandle> {
  const physical = devices.filter((d) => d.platform === 'ios' && d.kind === 'usb');
  const empty: IosTunnelHandle = { stop: () => Promise.resolve() };
  if (physical.length === 0) return empty;

  if (!quiet) {
    log(
      `${C.dim}establishing iOS tunnel(s) for ${physical.map((d) => d.name).join(', ')}...${C.reset}`,
    );
  }

  const children: Deno.ChildProcess[] = [];
  await Promise.all(physical.map(async (d) => {
    let child: Deno.ChildProcess;
    try {
      child = new Deno.Command('xcrun', {
        args: ['devicectl', 'device', 'info', 'details', '--device', d.id],
        stdin: 'null',
        stdout: 'null',
        stderr: 'null',
      }).spawn();
    } catch {
      return;
    }
    children.push(child);
    // Give the daemon ~3 s to bring the tunnel up. The child is left running
    // afterwards to keep the tunnel alive for the rest of the run.
    await new Promise<void>((r) => setTimeout(r, 3000));
  }));

  if (!quiet) log(`${C.dim}iOS tunnel(s) ready (${children.length} keepalive process(es))${C.reset}`);

  let stopped = false;
  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      for (const c of children) {
        try {
          c.kill('SIGTERM');
        } catch { /* already gone */ }
      }
      await Promise.all(children.map((c) => c.status.catch(() => undefined)));
    },
  };
}

// Wipe app data on every selected device so each test run starts from a
// clean state. Done from the runner instead of via Maestro's
// `launchApp.clearState: true` — on iOS Maestro 2.5.x uninstalls the app
// then fails to reinstall it (no .app path cached after our runner-side
// install), and the test runs against an empty home screen.
export async function clearAppState(
  devices: Device[],
  bundleId: string,
  quiet = false,
): Promise<void> {
  await Promise.all(devices.map(async (d) => {
    if (d.platform === 'android') {
      await run('adb', ['-s', d.id, 'shell', 'pm', 'clear', bundleId]);
    } else if (d.kind === 'simulator') {
      await run('xcrun', ['simctl', 'terminate', d.id, bundleId]);
      await run('xcrun', ['simctl', 'privacy', d.id, 'reset', 'all', bundleId]);
      // `simctl privacy reset` only clears permission grants. To match the
      // Android `pm clear` semantics — wipe storage, preferences, keychain
      // — also rm the app's data container. Equivalent to a re-install but
      // leaves the .app bundle in place (no re-build needed).
      const r = await run('xcrun', ['simctl', 'get_app_container', d.id, bundleId, 'data']);
      const dataPath = r.code === 0 ? r.stdout.trim() : '';
      if (dataPath) {
        try {
          await Deno.remove(dataPath, { recursive: true });
        } catch { /* not present or already gone */ }
      }
      // NOTE: setupIosSim is invoked by main.ts for every selected sim
      // before this clear step runs, so we deliberately do NOT call it
      // a second time here — that was a leftover from before the
      // automatic pre-flight phase landed.
    }
  }));
  if (!quiet) log(`${C.dim}cleared app state on ${devices.length} device(s)${C.reset}`);
}

async function defaultInstallAndroid(
  d: Device,
  apk: string,
  prefix: string,
  quiet = false,
): Promise<number> {
  if (quiet) {
    const log = await Deno.makeTempFile({ prefix: 'mp-adb-install-' });
    return await spawnToFile('adb', ['-s', d.id, 'install', '-r', apk], '.', log);
  }
  log(`${prefix}${C.dim}$ adb -s ${d.id} install -r <apk>${C.reset}`);
  return await spawnPrefixed('adb', ['-s', d.id, 'install', '-r', apk], '.', prefix);
}

async function defaultInstallIosSim(
  d: Device,
  app: string,
  prefix: string,
  quiet = false,
): Promise<number> {
  if (quiet) {
    const log = await Deno.makeTempFile({ prefix: 'mp-simctl-install-' });
    return await spawnToFile('xcrun', ['simctl', 'install', d.id, app], '.', log);
  }
  log(`${prefix}${C.dim}$ xcrun simctl install ${d.id} <app>${C.reset}`);
  return await spawnPrefixed('xcrun', ['simctl', 'install', d.id, app], '.', prefix);
}

type GroupKey = 'android' | 'ios-sim' | 'ios-usb';

const groupKeyOf = (d: Device): GroupKey =>
  d.platform === 'android' ? 'android' : d.kind === 'simulator' ? 'ios-sim' : 'ios-usb';

const platformOf = (k: GroupKey): Platform => k === 'android' ? 'android' : 'ios';

// Build the app once per platform-group, then install in parallel on the
// remaining devices. The build itself is delegated to user-supplied hooks
// in the config (see `MaestroParallelConfig.build.{android,ios}`) — we have
// no way to know whether the project uses Expo, bare RN, native Xcode, etc.
export type DeviceBuildState =
  | 'building'
  | 'waiting'
  | 'installing'
  | 'installed'
  | 'failed';

export interface BuildAndInstallOpts {
  /** Suppress all internal log lines. Caller renders its own UI. */
  quiet?: boolean;
  /** Status channel forwarded to per-platform hooks via ctx.report. */
  report?: (msg: string) => void;
  /** Per-device build/install state event. */
  onDeviceState?: (deviceId: string, state: DeviceBuildState, detail?: string) => void;
}

export async function buildAndInstall(
  devices: Device[],
  cwd: string,
  config: ResolvedConfig,
  colorOf: (d: Device) => string,
  prefixWidth: number,
  mode: BuildMode,
  outBase?: string,
  opts: BuildAndInstallOpts = {},
): Promise<void> {
  const quiet = !!opts.quiet;
  const sayLine = quiet ? (_msg: string): void => {} : log;
  sayLine('');
  sayLine(
    `${C.bold}Build & install (${devices.length} device${
      devices.length > 1 ? 's' : ''
    }, mode: ${mode})${C.reset}`,
  );

  const groups = new Map<GroupKey, Device[]>();
  for (const d of devices) {
    const k = groupKeyOf(d);
    const arr = groups.get(k);
    if (arr) arr.push(d);
    else groups.set(k, [d]);
  }

  // Print plan up-front so the user sees exactly which build runs and
  // which devices get reuse-install before spawning any heavy commands.
  for (const [groupKey, groupDevices] of groups) {
    const first = groupDevices[0]!;
    const rest = groupDevices.slice(1);
    const restList = rest.length > 0
      ? `, reuse-install on: ${rest.map((d) => d.name).join(', ')}`
      : '';
    sayLine(`${C.dim}plan ${groupKey}: build on ${first.name}${restList}${C.reset}`);
  }

  for (const [groupKey, groupDevices] of groups) {
    const platform = platformOf(groupKey);
    const hooks = config.build?.[platform];
    if (!hooks) {
      sayLine(`${C.yellow}skip group ${groupKey}: no config.build.${platform} configured${C.reset}`);
      continue;
    }

    const first = groupDevices[0]!;
    const rest = groupDevices.slice(1);
    const firstPrefix = devicePrefix(first, colorOf(first), prefixWidth);
    const firstLog = quiet ? (_l: string): void => {} : (line: string): void => log(`${firstPrefix}${line}`);

    opts.onDeviceState?.(first.id, 'building');
    for (const r of rest) opts.onDeviceState?.(r.id, 'waiting');

    const buildLogPath = outBase
      ? join(cwd, outBase, `build-${groupKey}.log`)
      : undefined;
    const startedAt = Date.now();
    const artifact = await hooks.buildAndInstallFirst({
      device: first,
      group: groupDevices,
      cwd,
      log: firstLog,
      mode,
      buildLogPath,
      report: opts.report,
    });
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

    if (!artifact) {
      // Hook returned null = build OR first install failed. Skip the per-
      // device fan-out (it would just re-run the same broken build N times
      // for 8 s each). Tests can still run against whatever's already on
      // the devices.
      firstLog(
        `${C.yellow}build failed for ${groupKey} (${elapsed}s); skipping install on ${rest.length} other device(s). Tests will run against the previously-installed app — if any.${C.reset}`,
      );
      opts.onDeviceState?.(first.id, 'failed', `build failed (${elapsed}s)`);
      for (const r of rest) opts.onDeviceState?.(r.id, 'failed', 'no artifact');
      continue;
    }
    // First device's group build returned an artifact — the hook also
    // installed it on the first device.
    opts.onDeviceState?.(first.id, 'installed', `${elapsed}s`);

    if (rest.length === 0) continue;

    firstLog(`${C.dim}artifact: ${artifact.path}${C.reset}`);

    const installs = rest.map(async (d) => {
      const p = devicePrefix(d, colorOf(d), prefixWidth);
      const perDeviceLog = quiet ? (_l: string): void => {} : (line: string): void => log(`${p}${line}`);
      sayLine(`${p}${C.bold}install${C.reset} (reuse build from ${first.name})`);
      opts.report?.(`installing on ${d.name}…`);
      opts.onDeviceState?.(d.id, 'installing');
      let code: number;
      if (hooks.installExisting) {
        code = await hooks.installExisting(
          { device: d, group: [d], cwd, log: perDeviceLog, mode },
          artifact,
        );
      } else if (groupKey === 'android') {
        code = await defaultInstallAndroid(d, artifact.path, p, quiet);
      } else if (groupKey === 'ios-sim') {
        code = await defaultInstallIosSim(d, artifact.path, p, quiet);
      } else {
        sayLine(
          `${p}${C.yellow}physical iOS reuse-install not supported; using per-device build hook${C.reset}`,
        );
        const perDevice = await hooks.buildAndInstallFirst({
          device: d,
          group: [d],
          cwd,
          log: perDeviceLog,
          mode,
          report: opts.report,
        });
        code = perDevice ? 0 : 1;
      }
      if (code !== 0) {
        const msg = `install failed on ${d.name} (${d.id}) — exit ${code}`;
        sayLine(`${p}${C.red}${msg}${C.reset}`);
        opts.onDeviceState?.(d.id, 'failed', `install failed (exit ${code})`);
        throw new Error(msg);
      }
      sayLine(`${p}${C.green}installed${C.reset}`);
      opts.onDeviceState?.(d.id, 'installed');
    });
    // Promise.allSettled — one failed install must not cancel the
    // siblings (Promise.all interleaves their logs over the error path
    // and leaves partial installs running). After all settle, throw
    // an aggregate so the top-level catch in cli.ts sees it.
    const settled = await Promise.allSettled(installs);
    const failures = settled.filter((s) => s.status === 'rejected') as PromiseRejectedResult[];
    if (failures.length > 0) {
      const messages = failures.map((f) =>
        f.reason instanceof Error ? f.reason.message : String(f.reason)
      );
      throw new Error(
        `${failures.length}/${installs.length} install(s) failed:\n  - ${messages.join('\n  - ')}`,
      );
    }
  }
  sayLine('');
}
