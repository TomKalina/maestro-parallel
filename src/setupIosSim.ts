// Pre-Maestro setup for booted iOS simulators.
//
// Disables the iOS keychain "Save Password?" / "AutoFill Passwords" system
// overlay that otherwise pops up after a credentials submit and blocks
// Maestro from reaching the next screen — the prompt is rendered by
// SpringBoard above the app surface and cannot be dismissed from inside a
// flow.

import { run } from './exec.ts';
import { C, log } from './ui.ts';

export async function setupIosSim(udid: string): Promise<void> {
  // The 'Save Password?' overlay is actually fired by passd (Password
  // Daemon), not the Settings app, so we have to set both the
  // user-visible Settings preference AND the same key in the global
  // defaults that passd reads at startup. Cover every domain variant
  // shipped across iOS 14 → iOS 26 — iOS picks up whichever one its
  // build links against.
  const writes: Array<[domain: string | '-g', key: string]> = [
    // Settings app — sim-specific bridge domain (iOS 14-16).
    ['com.apple.preferences.password.RemoteUI.SimulatorBundleSettings', 'AutoFillPasswords'],
    ['com.apple.preferences.password.RemoteUI.SimulatorBundleSettings', 'AutoFillPasswordsAndPasskeys'],
    ['com.apple.preferences.password.RemoteUI.SimulatorBundleSettings', 'SaveSuggestedPassword'],
    // Settings app — device-style domain (iOS 17+).
    ['com.apple.preferences.password', 'AutoFillPasswords'],
    ['com.apple.preferences.password', 'AutoFillPasswordsAndPasskeys'],
    ['com.apple.preferences.password', 'SaveSuggestedPassword'],
    // Global defaults — passd / AutoFillFramework read here.
    ['-g', 'AutoFillPasswords'],
    ['-g', 'AutoFillPasswordsAndPasskeys'],
    ['-g', 'SaveSuggestedPassword'],
    // Framework-level fallback.
    ['com.apple.AutoFillFramework', 'AutoFillEnabled'],
    ['com.apple.AutoFillFramework', 'SaveSuggestedPassword'],
  ];
  for (const [domain, key] of writes) {
    await run('xcrun', ['simctl', 'spawn', udid, 'defaults', 'write', domain, key, '-bool', 'false']);
  }
  // Wipe any saved credential so the prompt has nothing to offer to save.
  await run('xcrun', ['simctl', 'keychain', udid, 'reset']);
  // Keep the simulator's screen awake during the run. Without this the sim
  // auto-locks after ~1 min and Maestro starts failing on the blank
  // SpringBoard surface above the app.
  await run('xcrun', [
    'simctl',
    'spawn',
    udid,
    'defaults',
    'write',
    'com.apple.springboard',
    'SBIdleTimerDisabled',
    '-bool',
    'true',
  ]);
  // Respring both daemons so they re-read the toggles. Without this
  // the already-running passd keeps cached values and the overlay
  // still fires.
  await run('xcrun', ['simctl', 'spawn', udid, 'killall', '-HUP', 'SpringBoard']);
  await run('xcrun', ['simctl', 'spawn', udid, 'killall', '-9', 'passd']);
}

/** Run setupIosSim against every currently-booted simulator. CLI helper. */
export async function setupAllBootedSimulators(): Promise<void> {
  const r = await run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']);
  if (r.code !== 0) return;
  let parsed: { devices: Record<string, Array<{ udid: string; state: string; name: string }>> };
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return;
  }
  const udids: { udid: string; name: string }[] = [];
  for (const devs of Object.values(parsed.devices)) {
    for (const d of devs) if (d.state === 'Booted') udids.push({ udid: d.udid, name: d.name });
  }
  if (udids.length === 0) return;
  for (const { udid, name } of udids) {
    log(
      `${C.dim}[ios-sim] ${name} (${udid}): disabling AutoFill Passwords + reset keychain${C.reset}`,
    );
    await setupIosSim(udid);
  }
}
