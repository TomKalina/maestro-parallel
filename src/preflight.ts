// Cheap pre-flight checks run AFTER the picker and BEFORE the build, so
// the user sees actionable hints (install iOS runtime, prebuild Android,
// etc.) instead of a wall of xcodebuild / Rock noise.

import { join } from '@std/path';
import { run } from './exec.ts';
import type { Device } from './types.ts';
import { C, log } from './ui.ts';

type GroupKey = 'android' | 'ios-sim' | 'ios-usb';

export interface PreflightIssue {
  group: GroupKey;
  message: string;
  hint: string;
}

const groupKeyOf = (d: Device): GroupKey =>
  d.platform === 'android' ? 'android' : d.kind === 'simulator' ? 'ios-sim' : 'ios-usb';

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await Deno.stat(p)).isDirectory;
  } catch {
    return false;
  }
}

async function findFirstWorkspace(iosDir: string): Promise<string | null> {
  try {
    for await (const e of Deno.readDir(iosDir)) {
      if (e.isDirectory && e.name.endsWith('.xcworkspace')) return e.name;
    }
  } catch { /* no ios dir */ }
  return null;
}

async function checkIosDestinations(cwd: string): Promise<PreflightIssue | null> {
  const iosDir = join(cwd, 'ios');
  if (!(await dirExists(iosDir))) return null;
  const wsName = await findFirstWorkspace(iosDir);
  if (!wsName) return null;
  const scheme = wsName.replace(/\.xcworkspace$/, '');
  const r = await run('xcodebuild', [
    '-workspace',
    join(iosDir, wsName),
    '-scheme',
    scheme,
    '-showdestinations',
  ]);
  if (r.code !== 0) return null; // unknown scheme / project state — let the build fail with its own message
  const out = r.stdout + r.stderr;
  // "Available destinations" present means at least one usable destination.
  if (/Available destinations/i.test(out)) return null;
  const missing = out.match(/iOS (\d+\.\d+) is not installed/);
  if (missing) {
    return {
      group: 'ios-sim',
      message: `no eligible iOS destination; iOS ${missing[1]} runtime not installed`,
      hint: `xcodebuild -downloadPlatform iOS   # or: Xcode → Settings → Components`,
    };
  }
  return {
    group: 'ios-sim',
    message: `no eligible iOS destinations for scheme ${scheme}`,
    hint: `cd ios && xcodebuild -workspace ${wsName} -scheme ${scheme} -showdestinations`,
  };
}

async function checkAndroidPrebuild(cwd: string): Promise<PreflightIssue | null> {
  if (await dirExists(join(cwd, 'android'))) return null;
  return {
    group: 'android',
    message: `android/ directory missing — Expo project not prebuilt`,
    hint: `npx expo prebuild --platform android   # generates android/ for Rock/Gradle`,
  };
}

/** Returns issues for the groups present in `chosen`. Caller decides whether to abort. */
export async function preflightChecks(
  cwd: string,
  chosen: Device[],
): Promise<PreflightIssue[]> {
  const groups = new Set(chosen.map(groupKeyOf));
  const issues: PreflightIssue[] = [];
  if (groups.has('ios-sim') || groups.has('ios-usb')) {
    const iss = await checkIosDestinations(cwd);
    if (iss) issues.push(iss);
  }
  if (groups.has('android')) {
    const iss = await checkAndroidPrebuild(cwd);
    if (iss) issues.push(iss);
  }
  return issues;
}

export function logPreflight(issues: PreflightIssue[]): void {
  if (issues.length === 0) return;
  log('');
  log(`${C.yellow}${C.bold}Pre-flight: ${issues.length} issue(s) may break the build${C.reset}`);
  for (const iss of issues) {
    log(`${C.yellow}  [${iss.group}] ${iss.message}${C.reset}`);
    log(`${C.dim}      hint: ${iss.hint}${C.reset}`);
  }
}
