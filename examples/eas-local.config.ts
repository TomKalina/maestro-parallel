// Example: build release artifacts via `eas build --local` and run flows
// against them. Recommended for CI and any reliable E2E pipeline — the
// artifact matches what your users install, the JS bundle is baked in,
// no Metro / dev-launcher / dev-menu in the way.
//
// Requires an `e2e` profile in eas.json that produces an installable
// artifact (apk for Android, simulator .app for iOS):
//
// {
//   "build": {
//     "e2e": {
//       "developmentClient": false,
//       "distribution": "internal",
//       "android": { "buildType": "apk" },
//       "ios": { "simulator": true }
//     }
//   }
// }
//
// Pattern:
//   1. `pnpm exec eas build --profile e2e --platform android --local`
//      → drops `build-*.apk` in cwd.
//   2. `pnpm exec eas build --profile e2e --platform ios --local`
//      → drops `build-*.tar.gz` (extract to get the .app).
//   3. `maestro-parallel --release` runs flows against those artifacts.

import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { defineConfig } from '../index.js';

async function newestMatching(
  cwd: string,
  predicate: (name: string) => boolean,
): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(cwd, { withFileTypes: true });
  } catch {
    return null;
  }
  let best: { path: string; mtime: number } | null = null;
  for (const e of entries) {
    if (!e.isFile() || !predicate(e.name)) continue;
    const full = join(cwd, e.name);
    const mt = (await stat(full)).mtime.getTime();
    if (!best || mt > best.mtime) best = { path: full, mtime: mt };
  }
  return best?.path ?? null;
}

function spawnAsync(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
    child.on('error', () => resolve(127));
    child.on('close', (code) => resolve(code ?? 0));
  });
}

export default defineConfig({
  bundleId: 'com.example.myapp',
  flowsDir: '.maestro',

  build: {
    android: {
      async buildAndInstallFirst({ cwd, log }) {
        // Look for a pre-built EAS local artifact in cwd; if absent, build one.
        let apk = await newestMatching(cwd, (n) => n.endsWith('.apk') && n.startsWith('build-'));
        if (!apk) {
          log('no build-*.apk found in cwd — running eas build --local now');
          const code = await spawnAsync(
            'pnpm',
            ['exec', 'eas', 'build', '--profile', 'e2e', '--platform', 'android', '--local'],
            cwd,
          );
          if (code !== 0) return null;
          apk = await newestMatching(cwd, (n) => n.endsWith('.apk') && n.startsWith('build-'));
        }
        return apk ? { path: apk } : null;
      },
    },
    ios: {
      async buildAndInstallFirst({ cwd, log }) {
        // EAS local for iOS emits a tarball that contains the .app. Caller
        // is expected to extract the .app manually (or wire up extraction
        // here). We just look for an unpacked .app in cwd.
        const app = await newestMatching(cwd, (n) => n.endsWith('.app'));
        if (!app) {
          log('no .app found in cwd — run `eas build --profile e2e --platform ios --local` and untar first');
          return null;
        }
        return { path: app };
      },
    },
  },
});
