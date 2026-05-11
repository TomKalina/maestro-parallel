// Auto-detected default build hooks. Plug in when the user has not
// supplied their own `build.android` / `build.ios`.
//
// The default mirrors the canonical local release commands documented
// in the Shoptet AGENTS.md:
//
//   iOS:     pnpm expo run:ios --configuration Release
//   Android: pnpm expo run:android --variant release
//
// These are the same commands a human would run for a release build.
// They invoke the project's native toolchain (Xcode / Gradle) directly,
// avoid Metro entirely, and produce an installed artifact on the first
// device of each group. The runner's reuse-install step then mirrors
// the resulting .apk / .app onto the rest of the group.
//
// Auto-injection conditions: the project has a `package.json` listing
// `expo` as a dep (any kind) and either `app.config.ts/js` or
// `app.json`. Projects without an Expo setup get no default — the user
// must supply their own hook.

import { join } from '@std/path';
import type { PlatformBuildHooks } from './config.ts';
import { spawnPrefixedUntilMarker } from './exec.ts';
import { C } from './ui.ts';

// `expo run:*` does its real work (build + install + launch) and then
// keeps running indefinitely streaming Metro / app logs — that's fine for
// interactive dev but blocks an automated runner. We watch for the
// "Opening on <device>" line that the Expo CLI prints right after the
// install succeeds and before it starts streaming, then SIGTERM the
// child. After that we have the app installed on the first device and
// the artifact on disk for reuse-install on the rest of the group.
const EXPO_RUN_DONE_MARKER = /^›\s*Opening on /;

interface DetectedExpoDefaults {
  packageManager: 'pnpm' | 'yarn' | 'npm';
}

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

async function detectPackageManager(cwd: string): Promise<'pnpm' | 'yarn' | 'npm'> {
  if (await fileExists(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await fileExists(join(cwd, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

/**
 * Probe `cwd` for an Expo-shaped project. Returns the package manager
 * to use, or null when the project does not look like Expo.
 */
export async function detectExpoDefaults(cwd: string): Promise<DetectedExpoDefaults | null> {
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
  return { packageManager: await detectPackageManager(cwd) };
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
      // DerivedData has a per-project subdir layer to descend through.
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
      // Flat layout (e.g. `ios/build/Build/Products/<Config>-<sdk>/`).
      const candidate = await findNewestAppIn(join(root, productDir));
      if (candidate && (!best || candidate.mtime > best.mtime)) best = candidate;
    }
  }
  return best?.path ?? null;
}

// Build the `<pm> [exec] expo …` argv. pnpm and Yarn 1 both pass through
// unknown subcommands to the matching binary, so `pnpm expo` /
// `yarn expo` work. npm does NOT — it needs `npm exec expo`. Get this
// wrong and the auto-default fails immediately on any npm project.
function expoCliArgv(pm: 'pnpm' | 'yarn' | 'npm', expoArgs: string[]): [string, string[]] {
  if (pm === 'npm') return ['npm', ['exec', '--', 'expo', ...expoArgs]];
  return [pm, ['expo', ...expoArgs]];
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
        // `expo run:android` already installed on the first device; we
        // just need to surface the artifact path so the runner can
        // reuse-install on the rest of the group via `adb install -r`.
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
        // `expo run:ios` installs on the first device automatically;
        // look up the .app in DerivedData / ios/build for reuse-install
        // on the rest of the group.
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
