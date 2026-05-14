// Maestro execution: per-device single process and platform-shard mode.
// One process per device is the safe default; iOS shard-all is opt-in
// because the host XCTestDriver serialises gestures across simulators.

import { join } from '@std/path';
import type { ResolvedConfig } from './config.ts';
import { devicePrefix } from './devices.ts';
import { run, spawnPrefixedTee, spawnSilentWithProgress } from './exec.ts';
import type { Device, GroupRunResult, Platform, RunResult } from './types.ts';
import { C, log } from './ui.ts';

function deviceSlug(d: Device): string {
  return `${d.platform}-${d.name.replace(/[^A-Za-z0-9]+/g, '_')}-${d.id.slice(0, 8)}`;
}

// `true`  = present, `false` = absent, `null` = check unsupported (we don't
// guess: physical iOS lacks a cheap "is installed?" probe).
async function isAppInstalled(d: Device, bundleId: string): Promise<boolean | null> {
  if (d.platform === 'android') {
    const r = await run('adb', ['-s', d.id, 'shell', 'pm', 'path', bundleId]);
    return r.code === 0 && r.stdout.trim().length > 0;
  }
  if (d.platform === 'ios' && d.kind === 'simulator') {
    const r = await run('xcrun', ['simctl', 'get_app_container', d.id, bundleId, 'app']);
    return r.code === 0;
  }
  return null;
}

function syntheticJunit(d: Device, message: string): string {
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const suite = `${d.platform}-${d.name}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="${esc(suite)}" tests="1" failures="1" errors="0" skipped="0">
    <testcase name="app-installed" classname="maestro-parallel">
      <failure type="AppNotInstalled" message="${esc(message)}"/>
    </testcase>
  </testsuite>
</testsuites>
`;
}

function envFlags(extraEnv: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(extraEnv)) {
    if (Deno.env.get(k) !== undefined) continue;
    out.push('-e', `${k}=${v}`);
  }
  return out;
}

// Generate a temporary Maestro config that drops `executionOrder.flowsOrder`
// (which forces sequential mode and thus blocks `--shard-all`). The user's
// real config.yaml stays untouched.
export async function makeShardConfig(
  cwd: string,
  configPath: string,
  outBase: string,
): Promise<string | null> {
  const src = join(cwd, configPath);
  let txt: string;
  try {
    txt = await Deno.readTextFile(src);
  } catch {
    return null;
  }
  const lines = txt.split('\n');
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (skipping) {
      if (
        line.length === 0 || line.startsWith(' ') || line.startsWith('\t') || line.startsWith('-')
      ) continue;
      skipping = false;
    }
    if (/^executionOrder\s*:/.test(line)) {
      skipping = true;
      continue;
    }
    out.push(line);
  }
  // Write inside the run's output dir so pruneOldRuns reaps it together
  // with the rest of the artifacts. Previously this went to $TMPDIR and
  // was never deleted.
  const dest = join(cwd, outBase, 'shard-config.yaml');
  await Deno.writeTextFile(dest, out.join('\n'));
  return dest;
}

/** Live event emitted as Maestro flows finish on a device. */
export interface FlowEvent {
  device: Device;
  status: 'pass' | 'fail';
  flow: string;
  durationMs: number;
}

// Run Maestro on a single device. One process per device, plain `maestro test`
// without --shard-all. Maestro 2.5+ fixed the Android dadb host port race so
// multiple Maestro processes can target several Android devices at once.
export async function runDevice(
  d: Device,
  color: string,
  prefixWidth: number,
  cwd: string,
  outBase: string,
  config: ResolvedConfig,
  onEvent?: (e: FlowEvent) => void,
): Promise<RunResult> {
  const outDir = join(outBase, deviceSlug(d));
  await Deno.mkdir(outDir, { recursive: true });

  const isIosPhysical = d.platform === 'ios' && d.kind === 'usb';
  const args = [
    'test',
    '-p',
    d.platform,
    '--device',
    d.id,
    '--test-output-dir',
    outDir,
    '--debug-output',
    join(outDir, 'debug'),
    '--format',
    'JUNIT',
    '--output',
    join(outDir, 'report.xml'),
    '--no-ansi',
    // Maestro 2.5.x builds the iOS WebDriver on demand for physical iPhones
    // and needs a team to code-sign it. Pass through when configured.
    ...(isIosPhysical && config.appleTeamId ? ['--apple-team-id', config.appleTeamId] : []),
    ...envFlags(config.maestroEnv),
    config.flowsDir,
  ];

  const prefix = devicePrefix(d, color, prefixWidth);

  // Bail early when the app is not on the device. After a failed build the
  // runner falls back to "tests will run against the previously-installed
  // app" — but if no previous install exists Maestro spends 17 s per flow
  // looking for elements that can never appear, flooding the log with
  // identical errors. Detect this once, here, and short-circuit.
  if (config.bundleId) {
    const installed = await isAppInstalled(d, config.bundleId);
    if (installed === false) {
      const msg = `${config.bundleId} not installed; skipping Maestro run on this device. Build a release artifact or pre-install the app.`;
      log(`${prefix}${C.red}${msg}${C.reset}`);
      // Write a synthetic JUnit so the merged report and CI parsers
      // see this as a failure with a clear cause, not a silent gap.
      await Deno.writeTextFile(join(outDir, 'report.xml'), syntheticJunit(d, msg));
      return { device: d, exitCode: 1, outDir };
    }
  }

  // Foreground the app before Maestro's first step. Without this, flows
  // that lack an explicit `- launchApp` step (Maestro does not auto-launch
  // from `appId` alone) sit on the home screen and fail with "Element not
  // found". `monkey` is used on Android because it resolves the launcher
  // activity itself — no need to know the activity name. In silent mode
  // (caller subscribes to onEvent), skip the per-launch log line so the
  // shared spinner stays clean.
  const silent = !!onEvent;
  if (d.platform === 'ios' && d.kind === 'simulator' && config.bundleId) {
    const r = await run('xcrun', ['simctl', 'launch', d.id, config.bundleId]);
    if (r.code === 0 && !silent) {
      log(`${prefix}${C.dim}launched ${config.bundleId} on sim${C.reset}`);
    }
  } else if (d.platform === 'android' && config.bundleId) {
    const r = await run('adb', [
      '-s',
      d.id,
      'shell',
      'monkey',
      '-p',
      config.bundleId,
      '-c',
      'android.intent.category.LAUNCHER',
      '1',
    ]);
    if (r.code === 0 && !silent) {
      log(`${prefix}${C.dim}launched ${config.bundleId} on android${C.reset}`);
    }
  } else if (isIosPhysical && config.bundleId) {
    const r = await run('xcrun', [
      'devicectl',
      'device',
      'process',
      'launch',
      '--device',
      d.id,
      config.bundleId,
    ]);
    if (r.code === 0 && !silent) {
      log(`${prefix}${C.dim}launched ${config.bundleId} on ${d.name}${C.reset}`);
    }
  }

  // The CoreDevice tunnel decays ~10 s after the last `devicectl` call. For
  // physical iOS we refresh it immediately before `maestro test` so the
  // tunnel is live when Maestro looks up the device.
  if (isIosPhysical) {
    try {
      const wake = new Deno.Command('xcrun', {
        args: ['devicectl', 'device', 'info', 'details', '--device', d.id],
        stdin: 'null',
        stdout: 'null',
        stderr: 'null',
      }).spawn();
      // Give the daemon ~1.5 s to establish the tunnel. After maestro takes
      // over, we kill the wake child — it has done its job.
      await new Promise<void>((r) => setTimeout(r, 1500));
      try {
        wake.kill('SIGTERM');
      } catch { /* already done */ }
      // Reap the child so its status promise does not become an unhandled
      // rejection on shutdown.
      await wake.status.catch(() => undefined);
    } catch { /* xcrun missing — let maestro fail clearly */ }
    if (!config.appleTeamId) {
      log(
        `${prefix}${C.yellow}warning: physical iOS without appleTeamId — Maestro will fail to build the iOS driver. Set 'appleTeamId' in your config or use --apple-team-id.${C.reset}`,
      );
    }
  }

  // If a caller subscribes via onEvent we go silent — they're rendering
  // their own progress UI. Otherwise fall back to the per-line streamed
  // output so library users get the legacy behaviour.
  const logPath = join(outDir, 'run.log');
  let exitCode: number;
  if (onEvent) {
    exitCode = await spawnSilentWithProgress(
      'maestro',
      args,
      cwd,
      logPath,
      (line) => {
        const m = line.match(/^\[(Passed|Failed)\]\s+(\S+)\s+\((\d+)s\)/);
        if (!m) return;
        onEvent({
          device: d,
          status: m[1] === 'Passed' ? 'pass' : 'fail',
          flow: m[2]!,
          durationMs: Number(m[3]) * 1000,
        });
      },
      { NO_COLOR: '1' },
      // Maestro 2.5.1 sometimes hangs in DebugLogStore.finalizeRun after
      // the last flow. 30s of silence after any output = watchdog kill.
      { idleKillMs: 30000 },
    );
  } else {
    log(`${prefix}${C.bold}start${C.reset} ${d.id}`);
    exitCode = await spawnPrefixedTee(
      'maestro',
      args,
      cwd,
      prefix,
      logPath,
      { NO_COLOR: '1' },
    );
    log(
      `${prefix}${exitCode === 0 ? C.green + 'pass' : C.red + 'fail'} (exit ${exitCode})${C.reset}`,
    );
  }
  return { device: d, exitCode, outDir };
}

// Run Maestro on a platform group as a SINGLE process with --shard-all=N.
// Used for iOS when `iosShardAll: true` — the host XCTestDriver serialises
// gestures across simulators and parallel Maestro processes collide with
// "only one gesture can be performed at a time".
export async function runShardGroup(
  platform: Platform,
  devices: Device[],
  color: string,
  prefixLabelWidth: number,
  cwd: string,
  outBase: string,
  shardConfigPath: string | null,
  config: ResolvedConfig,
): Promise<GroupRunResult> {
  const outDir = join(outBase, `${platform}-shard`);
  await Deno.mkdir(outDir, { recursive: true });
  const ids = devices.map((d) => d.id);

  const args: string[] = [
    'test',
    '-p',
    platform,
    '--device',
    ids.join(','),
    '--test-output-dir',
    outDir,
    '--debug-output',
    join(outDir, 'debug'),
    '--format',
    'JUNIT',
    '--output',
    join(outDir, 'report.xml'),
    '--no-ansi',
    `--shard-all=${ids.length}`,
    ...(shardConfigPath ? ['--config', shardConfigPath] : []),
    ...envFlags(config.maestroEnv),
    config.flowsDir,
  ];

  const tagLabel = `${platform === 'android' ? 'and' : 'ios'}:*`;
  const padded = tagLabel.length > prefixLabelWidth
    ? tagLabel.slice(0, prefixLabelWidth)
    : tagLabel.padEnd(prefixLabelWidth);
  const prefix = `${color}[${padded}]${C.reset} `;

  log(
    `${prefix}${C.bold}start${C.reset} ${ids.length} ${platform} devices in shard mode: ${
      ids.join(', ')
    }`,
  );

  const exitCode = await spawnPrefixedTee(
    'maestro',
    args,
    cwd,
    prefix,
    join(outDir, 'run.log'),
    { NO_COLOR: '1' },
  );
  log(
    `${prefix}${exitCode === 0 ? C.green + 'pass' : C.red + 'fail'} (exit ${exitCode})${C.reset}`,
  );
  return { platform, ids, exitCode, outDir };
}
