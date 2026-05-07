// Pre-test device preparation: wake Android screens, clear app data, and
// build/install the app once per platform group with reuse-install on the
// rest. The build step is delegated to the user's config — we do not know
// whether they use Expo, bare RN, native Xcode/Gradle, etc.

import type { ResolvedConfig } from './config.ts';
import { devicePrefix } from './devices.ts';
import { run, spawnPrefixed } from './exec.ts';
import { setupIosSim } from './setupIosSim.ts';
import type { Device, Platform } from './types.ts';
import { C, log } from './ui.ts';

// Wake every Android device and keep its screen on so Maestro can interact
// with the app. A locked screen leaves NotificationShade focused above the
// activity, the surface is black, and every test fails with "Element not
// found". `svc power stayon true` requires USB power, which is the case
// here.
export async function wakeAndroidDevices(devices: Device[]): Promise<void> {
  const androids = devices.filter((d) => d.platform === 'android');
  if (androids.length === 0) return;
  await Promise.all(androids.map(async (d) => {
    await run('adb', ['-s', d.id, 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
    await run('adb', ['-s', d.id, 'shell', 'input', 'keyevent', 'KEYCODE_MENU']);
    await run('adb', ['-s', d.id, 'shell', 'svc', 'power', 'stayon', 'true']);
  }));
  log(
    `${C.dim}woke ${androids.length} Android device(s) and enabled stay-on-while-charging${C.reset}`,
  );
}

// Wipe app data on every selected device so each test run starts from a
// clean state. Done from the runner instead of via Maestro's
// `launchApp.clearState: true` — on iOS Maestro 2.5.x uninstalls the app
// then fails to reinstall it (no .app path cached after our runner-side
// install), and the test runs against an empty home screen.
export async function clearAppState(devices: Device[], bundleId: string): Promise<void> {
  await Promise.all(devices.map(async (d) => {
    if (d.platform === 'android') {
      await run('adb', ['-s', d.id, 'shell', 'pm', 'clear', bundleId]);
    } else if (d.kind === 'simulator') {
      await run('xcrun', ['simctl', 'terminate', d.id, bundleId]);
      await run('xcrun', ['simctl', 'privacy', d.id, 'reset', 'all', bundleId]);
      // Disable iOS keychain "Save Password?" prompt which otherwise blocks flows.
      await setupIosSim(d.id);
    }
  }));
  log(`${C.dim}cleared app state on ${devices.length} device(s)${C.reset}`);
}

async function defaultInstallAndroid(d: Device, apk: string, prefix: string): Promise<number> {
  log(`${prefix}${C.dim}$ adb -s ${d.id} install -r <apk>${C.reset}`);
  return await spawnPrefixed('adb', ['-s', d.id, 'install', '-r', apk], '.', prefix);
}

async function defaultInstallIosSim(d: Device, app: string, prefix: string): Promise<number> {
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
export async function buildAndInstall(
  devices: Device[],
  cwd: string,
  config: ResolvedConfig,
  colorOf: (d: Device) => string,
  prefixWidth: number,
): Promise<void> {
  log('');
  log(
    `${C.bold}Build & install (${devices.length} device${devices.length > 1 ? 's' : ''})${C.reset}`,
  );

  const groups = new Map<GroupKey, Device[]>();
  for (const d of devices) {
    const k = groupKeyOf(d);
    const arr = groups.get(k);
    if (arr) arr.push(d);
    else groups.set(k, [d]);
  }

  for (const [groupKey, groupDevices] of groups) {
    const platform = platformOf(groupKey);
    const hooks = config.build?.[platform];
    if (!hooks) {
      log(
        `${C.yellow}skip group ${groupKey}: no config.build.${platform} configured${C.reset}`,
      );
      continue;
    }

    const first = groupDevices[0]!;
    const rest = groupDevices.slice(1);
    const firstPrefix = devicePrefix(first, colorOf(first), prefixWidth);
    const firstLog = (line: string): void => log(`${firstPrefix}${line}`);

    firstLog(`${C.bold}build & install (group: ${groupKey})${C.reset}`);
    const artifact = await hooks.buildAndInstallFirst({
      device: first,
      group: groupDevices,
      cwd,
      log: firstLog,
    });
    firstLog(`${C.green}built & installed${C.reset}`);

    if (rest.length === 0) continue;

    if (!artifact) {
      firstLog(
        `${C.yellow}artifact path not returned from hook; falling back to per-device build for ${rest.length} device(s)${C.reset}`,
      );
      for (const d of rest) {
        const p = devicePrefix(d, colorOf(d), prefixWidth);
        const dLog = (line: string): void => log(`${p}${line}`);
        dLog(`${C.bold}build & install (per-device fallback)${C.reset}`);
        await hooks.buildAndInstallFirst({ device: d, group: [d], cwd, log: dLog });
        dLog(`${C.green}installed${C.reset}`);
      }
      continue;
    }

    firstLog(`${C.dim}artifact: ${artifact.path}${C.reset}`);

    const installs = rest.map(async (d) => {
      const p = devicePrefix(d, colorOf(d), prefixWidth);
      log(`${p}${C.bold}install${C.reset} (reuse build from ${first.name})`);
      let code: number;
      if (hooks.installExisting) {
        code = await hooks.installExisting(
          { device: d, group: [d], cwd, log: (line) => log(`${p}${line}`) },
          artifact,
        );
      } else if (groupKey === 'android') {
        code = await defaultInstallAndroid(d, artifact.path, p);
      } else if (groupKey === 'ios-sim') {
        code = await defaultInstallIosSim(d, artifact.path, p);
      } else {
        // ios-usb has no shell-installable artifact reuse path: fall back
        // to a per-device build through the user's hook.
        log(
          `${p}${C.yellow}physical iOS reuse-install not supported; using per-device build hook${C.reset}`,
        );
        await hooks.buildAndInstallFirst({
          device: d,
          group: [d],
          cwd,
          log: (line) => log(`${p}${line}`),
        });
        code = 0;
      }
      if (code !== 0) {
        log(`${p}${C.red}install failed (exit ${code})${C.reset}`);
        Deno.exit(code);
      }
      log(`${p}${C.green}installed${C.reset}`);
    });
    await Promise.all(installs);
  }
  log('');
}
