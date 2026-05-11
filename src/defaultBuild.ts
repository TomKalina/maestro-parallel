// Auto-detected default build hooks. Plug in when the user has not
// supplied their own `build.android` / `build.ios`.
//
// Three strategies in priority order:
//
// 1. Rock (preferred): when `rock.config.{js,ts,mjs,mts,cjs,cts}` is
//    present, run `pnpm|yarn|npm exec rock run:ios --configuration
//    Release` / `rock run:android --variant release`. Rock fingerprints
//    the native dirs and reuses a cached artifact when nothing native
//    changed — first build is the usual 5–15 min, subsequent same-day
//    builds are seconds. Local cache works out-of-the-box without any
//    remote provider; opt into R2 / S3 / GitHub later for team-wide
//    sharing.
//
// 2. EAS local build: when the project ships an `eas.json` with an
//    `e2e-test` / `e2e` / `e2e-tests` / `preview` profile, run
//    `pnpm|yarn|npm exec eas build --profile <p> --platform <p> --local`.
//    Respects `developmentClient: false` in the profile so the
//    Release artifact has no `expo-dev-launcher` overlay.
//
// 3. `expo run:*` (fallback): plain Expo projects without Rock or an
//    EAS profile. Faster but inherits whatever the project's Release
//    config links in — projects with `expo-dev-client` linked will boot
//    through the dev-launcher overlay.
//
// All three install on the first device of each platform group; the
// runner reuse-installs the resulting .apk / .app on the rest.

import { join } from '@std/path';
import type { PlatformBuildHooks } from './config.ts';
import { run, spawnPrefixed, spawnPrefixedUntilMarker } from './exec.ts';
import { C } from './ui.ts';

const EAS_PROFILE_CANDIDATES = ['e2e-test', 'e2e', 'e2e-tests', 'preview'] as const;

const ROCK_CONFIG_EXTENSIONS = ['mjs', 'mts', 'js', 'ts', 'cjs', 'cts'] as const;

// `expo run:*` does its real work (build + install + launch) and then
// keeps running indefinitely streaming Metro / app logs. We kill on
// "Opening on <device>" — printed right after install, before streaming.
const EXPO_RUN_DONE_MARKER = /^›\s*Opening on /;

type PackageManager = 'pnpm' | 'yarn' | 'npm';

export interface DetectedRockDefaults {
  kind: 'rock';
  packageManager: PackageManager;
}

export interface DetectedEasDefaults {
  kind: 'eas';
  profile: string;
  packageManager: PackageManager;
}

export interface DetectedExpoDefaults {
  kind: 'expo';
  packageManager: PackageManager;
}

export type DetectedDefaults =
  | DetectedRockDefaults
  | DetectedEasDefaults
  | DetectedExpoDefaults;

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await Deno.readTextFile(path));
  } catch {
    return null;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await Deno.stat(p)).isFile;
  } catch {
    return false;
  }
}

async function detectPackageManager(cwd: string): Promise<PackageManager> {
  if (await fileExists(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await fileExists(join(cwd, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

/**
 * Probe `cwd` for a usable default build setup. Priority:
 *   1. Rock (`rock.config.*` present)
 *   2. EAS local build (matching profile in `eas.json`)
 *   3. Plain Expo (`expo` dep + an app config)
 */
export async function detectDefaultBuild(cwd: string): Promise<DetectedDefaults | null> {
  const pm = await detectPackageManager(cwd);

  // 1) Rock — explicit opt-in via `rock.config.*`.
  for (const ext of ROCK_CONFIG_EXTENSIONS) {
    if (await fileExists(join(cwd, `rock.config.${ext}`))) {
      return { kind: 'rock', packageManager: pm };
    }
  }

  // 2) EAS local build, if a matching profile exists.
  const eas = await readJson(join(cwd, 'eas.json')) as { build?: Record<string, unknown> } | null;
  if (eas?.build) {
    for (const candidate of EAS_PROFILE_CANDIDATES) {
      if (eas.build[candidate]) {
        return { kind: 'eas', profile: candidate, packageManager: pm };
      }
    }
  }

  // 3) Plain Expo project (package.json deps + an app config).
  const pkg = await readJson(join(cwd, 'package.json')) as
    | { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    | null;
  if (!pkg) return null;
  const hasExpo = !!pkg.dependencies?.expo || !!pkg.devDependencies?.expo;
  if (!hasExpo) return null;
  const hasAppConfig = (await fileExists(join(cwd, 'app.config.ts'))) ||
    (await fileExists(join(cwd, 'app.config.js'))) ||
    (await fileExists(join(cwd, 'app.json')));
  if (!hasAppConfig) return null;
  return { kind: 'expo', packageManager: pm };
}

function pmExecArgv(pm: PackageManager, cmd: string, rest: string[]): [string, string[]] {
  if (pm === 'npm') return ['npm', ['exec', '--', cmd, ...rest]];
  // pnpm / Yarn 1 both pass through unknown subcommands.
  return [pm, ['exec', cmd, ...rest]];
}

// --- Rock hooks --------------------------------------------------------------

// Rock's `run:*` commands print "› Installing" then "› Opening on" before
// streaming Metro / app logs forever — same shape as `expo run:*`, so we
// reuse the marker-kill strategy.
const ROCK_RUN_DONE_MARKER = /^›\s*Opening on |^›\s*Installing |Build cache hit/i;

export function rockDefaultHooks(
  defaults: DetectedRockDefaults,
): { android: PlatformBuildHooks; ios: PlatformBuildHooks } {
  const pm = defaults.packageManager;

  return {
    android: {
      buildAndInstallFirst: async (ctx) => {
        const [exe, args] = pmExecArgv(pm, 'rock', [
          'run:android',
          '--variant',
          'release',
          '--device',
          ctx.device.buildTargetId,
        ]);
        ctx.log(`${C.dim}$ ${exe} ${args.join(' ')}${C.reset}`);
        const code = await spawnPrefixedUntilMarker(exe, args, ctx.cwd, '', ROCK_RUN_DONE_MARKER);
        if (code !== 0) {
          ctx.log(`${C.red}rock run:android failed (exit ${code})${C.reset}`);
          return null;
        }
        // Rock places the artifact in its local cache and also leaves a
        // Gradle build output behind. We point the runner at the Gradle
        // output so `adb install -r` works for the rest of the group.
        const apk = join(
          ctx.cwd,
          'android',
          'app',
          'build',
          'outputs',
          'apk',
          'release',
          'app-release.apk',
        );
        try {
          await Deno.stat(apk);
        } catch {
          ctx.log(
            `${C.yellow}built, but no APK at ${apk} — group reuse-install will fall back to per-device builds${C.reset}`,
          );
          return null;
        }
        return { path: apk };
      },
    },
    ios: {
      buildAndInstallFirst: async (ctx) => {
        const destination = ctx.device.kind === 'simulator' ? 'simulator' : 'device';
        const [exe, args] = pmExecArgv(pm, 'rock', [
          'run:ios',
          '--configuration',
          'Release',
          '--destination',
          destination,
          '--device',
          ctx.device.buildTargetId,
        ]);
        ctx.log(`${C.dim}$ ${exe} ${args.join(' ')}${C.reset}`);
        const code = await spawnPrefixedUntilMarker(exe, args, ctx.cwd, '', ROCK_RUN_DONE_MARKER);
        if (code !== 0) {
          ctx.log(`${C.red}rock run:ios failed (exit ${code})${C.reset}`);
          return null;
        }
        // Rock builds into the standard Xcode DerivedData / ios/build
        // layout, same as `expo run:ios` does. Reuse the same lookup.
        const home = Deno.env.get('HOME') ?? '';
        const sdk = ctx.device.kind === 'simulator' ? 'iphonesimulator' : 'iphoneos';
        const productDir = `Release-${sdk}`;
        const roots = [
          home ? join(home, 'Library', 'Developer', 'Xcode', 'DerivedData') : '',
          join(ctx.cwd, 'ios', 'build', 'Build', 'Products'),
        ].filter((p) => p.length > 0);
        const app = await findFirstApp(roots, productDir);
        if (!app) {
          ctx.log(
            `${C.yellow}built, but no .app found under DerivedData / ios/build — group reuse-install will fall back to per-device builds${C.reset}`,
          );
          return null;
        }
        ctx.log(`${C.dim}artifact: ${app}${C.reset}`);
        return { path: app };
      },
    },
  };
}

// --- EAS local build hooks ---------------------------------------------------

async function newestMatching(
  dir: string,
  predicate: (name: string) => boolean,
): Promise<string | null> {
  let best: { path: string; mtime: number } | null = null;
  try {
    for await (const e of Deno.readDir(dir)) {
      if (!e.isFile || !predicate(e.name)) continue;
      const full = join(dir, e.name);
      const info = await Deno.stat(full);
      const mt = info.mtime?.getTime() ?? 0;
      if (!best || mt > best.mtime) best = { path: full, mtime: mt };
    }
  } catch { /* ignore */ }
  return best?.path ?? null;
}

/**
 * EAS local iOS builds emit `build-<id>.tar.gz` containing the `.app`.
 * Untar into a fresh sibling dir and return the path to the `.app`.
 */
async function extractIosArchive(tarball: string): Promise<string | null> {
  const dir = await Deno.makeTempDir({ prefix: 'maestro-parallel-ios-app-' });
  const r = await run('tar', ['-xzf', tarball, '-C', dir]);
  if (r.code !== 0) return null;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    try {
      for await (const e of Deno.readDir(cur)) {
        const full = join(cur, e.name);
        if (e.isDirectory && e.name.endsWith('.app')) return full;
        if (e.isDirectory) stack.push(full);
      }
    } catch { /* unreadable subtree */ }
  }
  return null;
}

export function easDefaultHooks(
  defaults: DetectedEasDefaults,
): { android: PlatformBuildHooks; ios: PlatformBuildHooks } {
  const { profile, packageManager: pm } = defaults;

  const buildArgs = (platform: 'android' | 'ios'): string[] => [
    'build',
    '--profile',
    profile,
    '--platform',
    platform,
    '--local',
  ];

  return {
    android: {
      buildAndInstallFirst: async (ctx) => {
        const [exe, args] = pmExecArgv(pm, 'eas', buildArgs('android'));
        ctx.log(`${C.dim}$ ${exe} ${args.join(' ')}${C.reset}`);
        const code = await spawnPrefixed(exe, args, ctx.cwd, '');
        if (code !== 0) {
          ctx.log(`${C.red}eas build android failed (exit ${code})${C.reset}`);
          return null;
        }
        const apk = await newestMatching(ctx.cwd, (n) => n.endsWith('.apk'));
        if (!apk) {
          ctx.log(`${C.red}no .apk found in ${ctx.cwd} after eas build${C.reset}`);
          return null;
        }
        ctx.log(`${C.dim}artifact: ${apk}${C.reset}`);
        const inst = await run('adb', ['-s', ctx.device.id, 'install', '-r', apk]);
        if (inst.code !== 0) {
          ctx.log(`${C.red}adb install failed (exit ${inst.code})${C.reset}`);
          return null;
        }
        return { path: apk };
      },
    },
    ios: {
      buildAndInstallFirst: async (ctx) => {
        const [exe, args] = pmExecArgv(pm, 'eas', buildArgs('ios'));
        ctx.log(`${C.dim}$ ${exe} ${args.join(' ')}${C.reset}`);
        const code = await spawnPrefixed(exe, args, ctx.cwd, '');
        if (code !== 0) {
          ctx.log(`${C.red}eas build ios failed (exit ${code})${C.reset}`);
          return null;
        }
        const tarball = await newestMatching(ctx.cwd, (n) => n.endsWith('.tar.gz'));
        if (!tarball) {
          ctx.log(`${C.red}no .tar.gz found in ${ctx.cwd} after eas build${C.reset}`);
          return null;
        }
        ctx.log(`${C.dim}extracting ${tarball}${C.reset}`);
        const appPath = await extractIosArchive(tarball);
        if (!appPath) {
          ctx.log(`${C.red}failed to locate .app inside ${tarball}${C.reset}`);
          return null;
        }
        ctx.log(`${C.dim}artifact: ${appPath}${C.reset}`);
        if (ctx.device.kind === 'simulator') {
          const inst = await run('xcrun', ['simctl', 'install', ctx.device.id, appPath]);
          if (inst.code !== 0) {
            ctx.log(`${C.red}simctl install failed (exit ${inst.code})${C.reset}`);
            return null;
          }
        } else {
          ctx.log(
            `${C.yellow}physical iOS install not auto-wired — the e2e-test EAS profile typically targets simulator. Add an ios.installExisting hook for device builds.${C.reset}`,
          );
        }
        return { path: appPath };
      },
    },
  };
}

// --- `expo run:*` fallback hooks ---------------------------------------------

function expoCliArgv(pm: PackageManager, expoArgs: string[]): [string, string[]] {
  if (pm === 'npm') return ['npm', ['exec', '--', 'expo', ...expoArgs]];
  return [pm, ['expo', ...expoArgs]];
}

async function findNewestAppIn(
  productsRoot: string,
): Promise<{ path: string; mtime: number } | null> {
  let best: { path: string; mtime: number } | null = null;
  try {
    for await (const e of Deno.readDir(productsRoot)) {
      if (!e.isDirectory || !e.name.endsWith('.app')) continue;
      const full = join(productsRoot, e.name);
      const info = await Deno.stat(full);
      const mt = info.mtime?.getTime() ?? 0;
      if (!best || mt > best.mtime) best = { path: full, mtime: mt };
    }
  } catch { /* dir does not exist */ }
  return best;
}

async function findFirstApp(roots: string[], productDir: string): Promise<string | null> {
  let best: { path: string; mtime: number } | null = null;
  for (const root of roots) {
    if (root.includes('DerivedData')) {
      let topEntries: Deno.DirEntry[];
      try {
        topEntries = [];
        for await (const e of Deno.readDir(root)) topEntries.push(e);
      } catch {
        continue;
      }
      for (const top of topEntries) {
        if (!top.isDirectory) continue;
        const candidate = await findNewestAppIn(
          join(root, top.name, 'Build', 'Products', productDir),
        );
        if (candidate && (!best || candidate.mtime > best.mtime)) best = candidate;
      }
    } else {
      const candidate = await findNewestAppIn(join(root, productDir));
      if (candidate && (!best || candidate.mtime > best.mtime)) best = candidate;
    }
  }
  return best?.path ?? null;
}

export function expoNativeDefaultHooks(
  defaults: DetectedExpoDefaults,
): { android: PlatformBuildHooks; ios: PlatformBuildHooks } {
  const pm = defaults.packageManager;

  return {
    android: {
      buildAndInstallFirst: async (ctx) => {
        const [exe, args] = expoCliArgv(pm, [
          'run:android',
          '--variant',
          'release',
          '--device',
          ctx.device.buildTargetId,
        ]);
        ctx.log(`${C.dim}$ ${exe} ${args.join(' ')}${C.reset}`);
        const code = await spawnPrefixedUntilMarker(exe, args, ctx.cwd, '', EXPO_RUN_DONE_MARKER);
        if (code !== 0) {
          ctx.log(`${C.red}expo run:android failed (exit ${code})${C.reset}`);
          return null;
        }
        const apk = join(
          ctx.cwd,
          'android',
          'app',
          'build',
          'outputs',
          'apk',
          'release',
          'app-release.apk',
        );
        try {
          await Deno.stat(apk);
        } catch {
          ctx.log(
            `${C.yellow}built, but no APK at ${apk} — group reuse-install will fall back to per-device builds${C.reset}`,
          );
          return null;
        }
        return { path: apk };
      },
    },
    ios: {
      buildAndInstallFirst: async (ctx) => {
        const [exe, args] = expoCliArgv(pm, [
          'run:ios',
          '--configuration',
          'Release',
          '--device',
          ctx.device.buildTargetId,
        ]);
        ctx.log(`${C.dim}$ ${exe} ${args.join(' ')}${C.reset}`);
        const code = await spawnPrefixedUntilMarker(exe, args, ctx.cwd, '', EXPO_RUN_DONE_MARKER);
        if (code !== 0) {
          ctx.log(`${C.red}expo run:ios failed (exit ${code})${C.reset}`);
          return null;
        }
        const home = Deno.env.get('HOME') ?? '';
        const sdk = ctx.device.kind === 'simulator' ? 'iphonesimulator' : 'iphoneos';
        const productDir = `Release-${sdk}`;
        const roots = [
          home ? join(home, 'Library', 'Developer', 'Xcode', 'DerivedData') : '',
          join(ctx.cwd, 'ios', 'build', 'Build', 'Products'),
        ].filter((p) => p.length > 0);
        const app = await findFirstApp(roots, productDir);
        if (!app) {
          ctx.log(
            `${C.yellow}built, but no .app found under DerivedData / ios/build — group reuse-install will fall back to per-device builds${C.reset}`,
          );
          return null;
        }
        ctx.log(`${C.dim}artifact: ${app}${C.reset}`);
        return { path: app };
      },
    },
  };
}

/**
 * One-shot helper used by main.ts: detect the best default for `cwd`
 * and return both the hook bundle and a short human-readable summary
 * to log at startup.
 */
export async function buildDefaultHooks(cwd: string): Promise<
  | { description: string; hooks: { android: PlatformBuildHooks; ios: PlatformBuildHooks } }
  | null
> {
  const d = await detectDefaultBuild(cwd);
  if (!d) return null;
  if (d.kind === 'rock') {
    return {
      description: `Rock (rock run:*, Release) via ${d.packageManager}`,
      hooks: rockDefaultHooks(d),
    };
  }
  if (d.kind === 'eas') {
    return {
      description: `EAS local build, profile '${d.profile}' (${d.packageManager})`,
      hooks: easDefaultHooks(d),
    };
  }
  return {
    description: `expo run:* (Release / release) via ${d.packageManager}`,
    hooks: expoNativeDefaultHooks(d),
  };
}
