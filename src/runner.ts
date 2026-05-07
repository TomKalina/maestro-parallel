// Maestro execution: per-device single process and platform-shard mode.
// One process per device is the safe default; iOS shard-all is opt-in
// because the host XCTestDriver serialises gestures across simulators.

import { join } from '@std/path';
import type { ResolvedConfig } from './config.ts';
import { devicePrefix } from './devices.ts';
import { spawnPrefixedTee } from './exec.ts';
import type { Device, GroupRunResult, Platform, RunResult } from './types.ts';
import { C, log } from './ui.ts';

function deviceSlug(d: Device): string {
  return `${d.platform}-${d.name.replace(/[^A-Za-z0-9]+/g, '_')}-${d.id.slice(0, 8)}`;
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
export async function makeShardConfig(cwd: string, configPath: string): Promise<string | null> {
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
  const tmpDir = await Deno.makeTempDir({ prefix: 'maestro-parallel-' });
  const tmp = join(tmpDir, 'config.yaml');
  await Deno.writeTextFile(tmp, out.join('\n'));
  return tmp;
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
): Promise<RunResult> {
  const outDir = join(outBase, deviceSlug(d));
  await Deno.mkdir(outDir, { recursive: true });

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
    ...envFlags(config.maestroEnv),
    config.flowsDir,
  ];

  const prefix = devicePrefix(d, color, prefixWidth);
  log(`${prefix}${C.bold}start${C.reset} ${d.id}`);

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
