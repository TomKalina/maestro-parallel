// Auto-detected default build hooks. Plug in when the user has not
// supplied their own `build.android` / `build.ios`. Strategies in
// priority order: Rock (https://github.com/callstackincubator/rock) >
// EAS local build > `expo run:*`.
//
// Each strategy boils down to the same three steps:
//   1. spawn a release-build command
//   2. when it exits (or hits a "done" marker), locate the artifact
//   3. install on the first device, return the path for reuse-install
// `createReleaseHook` codifies that flow; per-strategy callbacks supply
// the spawn argv, the artifact lookup, and the first-device install.

import { join } from '@std/path';
import type { BuildContext, PlatformBuildHooks, ResolvedArtifact } from './config.ts';
import { run, spawnToFile } from './exec.ts';
import type { Device } from './types.ts';
import { C, spinner } from './ui.ts';

type PackageManager = 'pnpm' | 'yarn' | 'npm';
type Platform = 'android' | 'ios';

const EAS_PROFILE_CANDIDATES = ['e2e-test', 'e2e', 'e2e-tests', 'preview'] as const;
const ROCK_CONFIG_EXTENSIONS = ['mjs', 'mts', 'js', 'ts', 'cjs', 'cts'] as const;

// `rock run:*` and `expo run:*` build + install + then stream Metro / app
// logs indefinitely. Kill after the "Opening … on <device>" line so the
// runner can proceed. `Build cache hit` / `Installing` fire BEFORE the
// install completes on warm caches, so matching them caused the child to
// be SIGTERMed mid-install and the device ran against a stale build.
//
// Two output shapes the marker has to handle:
//   1. Plain expo / rock:   `› Opening on <device>`
//   2. expo-dev-client:     `› Opening exp+<scheme>://...?url=... on <device>`
//      (deep link launches Metro inside the dev client)
// `Logs for your project` is a stable fallback — it appears right after
// install on every code path, even when the Opening line wraps oddly.
const ROCK_RUN_DONE_MARKER = /^›\s*Opening (?:.* )?on |^›\s*Logs for your project/;
const EXPO_RUN_DONE_MARKER = /^›\s*Opening (?:.* )?on |^›\s*Logs for your project/;

// --- detection ---------------------------------------------------------------

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

export type BuildStrategy = 'auto' | 'rock' | 'eas' | 'expo';

async function tryRock(cwd: string, pm: PackageManager): Promise<DetectedRockDefaults | null> {
  for (const ext of ROCK_CONFIG_EXTENSIONS) {
    if (await fileExists(join(cwd, `rock.config.${ext}`))) {
      return { kind: 'rock', packageManager: pm };
    }
  }
  return null;
}

async function tryEas(cwd: string, pm: PackageManager): Promise<DetectedEasDefaults | null> {
  const eas = await readJson(join(cwd, 'eas.json')) as { build?: Record<string, unknown> } | null;
  if (!eas?.build) return null;
  for (const candidate of EAS_PROFILE_CANDIDATES) {
    if (eas.build[candidate]) {
      return { kind: 'eas', profile: candidate, packageManager: pm };
    }
  }
  return null;
}

async function tryExpo(cwd: string, pm: PackageManager): Promise<DetectedExpoDefaults | null> {
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

export async function detectDefaultBuild(
  cwd: string,
  strategy: BuildStrategy = 'auto',
): Promise<DetectedDefaults | null> {
  const pm = await detectPackageManager(cwd);
  if (strategy === 'rock') return tryRock(cwd, pm);
  if (strategy === 'eas') return tryEas(cwd, pm);
  if (strategy === 'expo') return tryExpo(cwd, pm);
  return (await tryRock(cwd, pm)) ?? (await tryEas(cwd, pm)) ?? (await tryExpo(cwd, pm));
}

// --- shared helpers ----------------------------------------------------------

function pmExecArgv(pm: PackageManager, cmd: string, rest: string[]): [string, string[]] {
  if (pm === 'npm') return ['npm', ['exec', '--', cmd, ...rest]];
  // pnpm / Yarn 1 both pass through unknown subcommands.
  return [pm, ['exec', cmd, ...rest]];
}

function expoCliArgv(pm: PackageManager, expoArgs: string[]): [string, string[]] {
  if (pm === 'npm') return ['npm', ['exec', '--', 'expo', ...expoArgs]];
  return [pm, ['expo', ...expoArgs]];
}

async function newestFileMatching(
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

async function newestAppIn(productsRoot: string): Promise<{ path: string; mtime: number } | null> {
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

// Look for the freshest `.app` under either the per-project DerivedData
// subtree or the flat `ios/build/Build/Products/<Config>-<sdk>/` layout
// that `expo run:ios` writes to.
async function findIosApp(cwd: string, deviceKind: Device['kind']): Promise<string | null> {
  const home = Deno.env.get('HOME') ?? '';
  const sdk = deviceKind === 'simulator' ? 'iphonesimulator' : 'iphoneos';
  const productDir = `Release-${sdk}`;
  const roots = [
    home ? join(home, 'Library', 'Developer', 'Xcode', 'DerivedData') : '',
    join(cwd, 'ios', 'build', 'Build', 'Products'),
  ].filter((p) => p.length > 0);

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
        const candidate = await newestAppIn(
          join(root, top.name, 'Build', 'Products', productDir),
        );
        if (candidate && (!best || candidate.mtime > best.mtime)) best = candidate;
      }
    } else {
      const candidate = await newestAppIn(join(root, productDir));
      if (candidate && (!best || candidate.mtime > best.mtime)) best = candidate;
    }
  }
  return best?.path ?? null;
}

// EAS local iOS builds emit `build-<id>.tar.gz` containing the `.app`.
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

// --- core hook factory -------------------------------------------------------

interface ReleaseHookSpec {
  /** Display name used in error logs (e.g. 'rock run:android'). */
  label: string;
  /** argv that produces the release artifact. */
  argv: (ctx: BuildContext) => [string, string[]];
  /** When set, kill the child on the first matching output line. */
  killMarker?: RegExp;
  /** Locate the artifact post-build. Return null to fall back per-device. */
  findArtifact: (ctx: BuildContext) => Promise<string | null>;
  /** Optionally install the artifact on `ctx.device`. Default: rely on
   *  the runner's reuse-install for the rest of the group. */
  installFirst?: (ctx: BuildContext, artifactPath: string) => Promise<number>;
  /** Extra env merged into the build child process. */
  env?: Record<string, string>;
}

function createReleaseHook(spec: ReleaseHookSpec): PlatformBuildHooks {
  return {
    buildAndInstallFirst: async (ctx): Promise<ResolvedArtifact | null> => {
      const [exe, args] = spec.argv(ctx);
      const env = spec.env ?? {};
      const logHint = ctx.buildLogPath ? `\n${C.dim}log: ${ctx.buildLogPath}${C.reset}` : '';
      // If ctx.report is set (caller renders its own UI), bypass the
      // internal clack spinner and push status through the channel.
      const useReport = !!ctx.report;
      const sp = useReport ? null : spinner(`${spec.label} on ${ctx.device.name}…`);
      ctx.report?.(`${spec.label} on ${ctx.device.name}…`);
      const startedAt = Date.now();
      // If the caller didn't give us a log path, fall back to a tempfile
      // so we still get quiet output for the spinner UX.
      const logPath = ctx.buildLogPath ??
        (await Deno.makeTempFile({ prefix: 'maestro-parallel-build-', suffix: '.log' }));
      const code = await spawnToFile(exe, args, ctx.cwd, logPath, spec.killMarker, env);
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (code !== 0) {
        if (sp) sp.fail(`${spec.label} failed (exit ${code}, ${elapsed}s)${logHint}`);
        else ctx.report?.(`failed (exit ${code}, ${elapsed}s)`);
        return null;
      }
      if (sp) sp.stop(`${spec.label} done (${elapsed}s)`);
      else ctx.report?.(`done (${elapsed}s)`);
      const path = await spec.findArtifact(ctx);
      if (!path) {
        ctx.log(
          `${C.yellow}built, but artifact not located — group reuse-install will fall back to per-device builds${C.reset}`,
        );
        return null;
      }
      ctx.log(`${C.dim}artifact: ${path}${C.reset}`);
      if (spec.installFirst) {
        const inst = await spec.installFirst(ctx, path);
        if (inst !== 0) {
          ctx.log(`${C.red}install on first device failed (exit ${inst})${C.reset}`);
          return null;
        }
      }
      return { path };
    },
  };
}

const ANDROID_RELEASE_APK = (cwd: string): string =>
  join(cwd, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');

async function ensureFile(path: string): Promise<string | null> {
  try {
    await Deno.stat(path);
    return path;
  } catch {
    return null;
  }
}

// --- per-strategy hooks ------------------------------------------------------

export function rockDefaultHooks(
  d: DetectedRockDefaults,
  env: Record<string, string> = {},
): {
  android: PlatformBuildHooks;
  ios: PlatformBuildHooks;
} {
  return {
    android: createReleaseHook({
      label: 'rock run:android',
      argv: (ctx) =>
        pmExecArgv(d.packageManager, 'rock', [
          'run:android',
          '--variant',
          'release',
          '--device',
          ctx.device.buildTargetId,
        ]),
      killMarker: ROCK_RUN_DONE_MARKER,
      findArtifact: (ctx) => ensureFile(ANDROID_RELEASE_APK(ctx.cwd)),
      env,
    }),
    ios: createReleaseHook({
      label: 'rock run:ios',
      argv: (ctx) =>
        pmExecArgv(d.packageManager, 'rock', [
          'run:ios',
          '--configuration',
          'Release',
          '--destination',
          ctx.device.kind === 'simulator' ? 'simulator' : 'device',
          '--device',
          ctx.device.buildTargetId,
        ]),
      killMarker: ROCK_RUN_DONE_MARKER,
      findArtifact: (ctx) => findIosApp(ctx.cwd, ctx.device.kind),
      env,
    }),
  };
}

export function easDefaultHooks(
  d: DetectedEasDefaults,
  env: Record<string, string> = {},
): {
  android: PlatformBuildHooks;
  ios: PlatformBuildHooks;
} {
  const buildArgs = (platform: Platform): string[] => [
    'build',
    '--profile',
    d.profile,
    '--platform',
    platform,
    '--local',
  ];

  return {
    android: createReleaseHook({
      label: 'eas build android',
      argv: () => pmExecArgv(d.packageManager, 'eas', buildArgs('android')),
      findArtifact: (ctx) => newestFileMatching(ctx.cwd, (n) => n.endsWith('.apk')),
      installFirst: async (ctx, apk) =>
        (await run('adb', ['-s', ctx.device.id, 'install', '-r', apk])).code,
      env,
    }),
    ios: createReleaseHook({
      label: 'eas build ios',
      argv: () => pmExecArgv(d.packageManager, 'eas', buildArgs('ios')),
      findArtifact: async (ctx) => {
        const tarball = await newestFileMatching(ctx.cwd, (n) => n.endsWith('.tar.gz'));
        if (!tarball) return null;
        ctx.log(`${C.dim}extracting ${tarball}${C.reset}`);
        return await extractIosArchive(tarball);
      },
      installFirst: async (ctx, appPath) => {
        if (ctx.device.kind === 'simulator') {
          return (await run('xcrun', ['simctl', 'install', ctx.device.id, appPath])).code;
        }
        ctx.log(
          `${C.yellow}physical iOS install not auto-wired — the e2e-test EAS profile typically targets simulator. Add an ios.installExisting hook for device builds.${C.reset}`,
        );
        return 0;
      },
      env,
    }),
  };
}

export function expoNativeDefaultHooks(
  d: DetectedExpoDefaults,
  env: Record<string, string> = {},
): {
  android: PlatformBuildHooks;
  ios: PlatformBuildHooks;
} {
  return {
    android: createReleaseHook({
      label: 'expo run:android',
      argv: (ctx) =>
        expoCliArgv(d.packageManager, [
          'run:android',
          '--variant',
          'release',
          '--device',
          ctx.device.buildTargetId,
        ]),
      killMarker: EXPO_RUN_DONE_MARKER,
      findArtifact: (ctx) => ensureFile(ANDROID_RELEASE_APK(ctx.cwd)),
      env,
    }),
    ios: createReleaseHook({
      label: 'expo run:ios',
      argv: (ctx) =>
        expoCliArgv(d.packageManager, [
          'run:ios',
          '--configuration',
          'Release',
          '--device',
          ctx.device.buildTargetId,
        ]),
      killMarker: EXPO_RUN_DONE_MARKER,
      findArtifact: (ctx) => findIosApp(ctx.cwd, ctx.device.kind),
      env,
    }),
  };
}

/**
 * One-shot helper used by main.ts: detect the best default for `cwd`
 * and return both the hook bundle and a short human-readable summary.
 */
export async function buildDefaultHooks(
  cwd: string,
  strategy: BuildStrategy = 'auto',
  env: Record<string, string> = {},
): Promise<
  | { description: string; hooks: { android: PlatformBuildHooks; ios: PlatformBuildHooks } }
  | null
> {
  const d = await detectDefaultBuild(cwd, strategy);
  if (!d) return null;
  if (d.kind === 'rock') {
    return {
      description: `Rock (rock run:*, Release) via ${d.packageManager}`,
      hooks: rockDefaultHooks(d, env),
    };
  }
  if (d.kind === 'eas') {
    return {
      description: `EAS local build, profile '${d.profile}' (${d.packageManager})`,
      hooks: easDefaultHooks(d, env),
    };
  }
  return {
    description: `expo run:* (Release / release) via ${d.packageManager}`,
    hooks: expoNativeDefaultHooks(d, env),
  };
}
