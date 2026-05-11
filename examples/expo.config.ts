// Example: a typical Expo / React Native project.
//
// Build hooks always produce a RELEASE artifact — dev / dev-client builds
// are structurally flaky for E2E and maestro-parallel does not support
// them. JS bundle is baked in, no Metro at runtime.
//
// First device in each platform group runs the build; the runner then
// reuse-installs the produced .apk / .app on the rest of the group.

import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '../index.js';

const SENTRY_DISABLE = { SENTRY_DISABLE_AUTO_UPLOAD: 'true' };

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function findApk(cwd: string): Promise<string | null> {
  const path = join(cwd, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
  return (await exists(path)) ? path : null;
}

async function findIosApp(cwd: string, kind: 'simulator' | 'usb'): Promise<string | null> {
  const sdk = kind === 'simulator' ? 'iphonesimulator' : 'iphoneos';
  const productDir = `Release-${sdk}`;
  const candidates = [
    join(homedir(), 'Library', 'Developer', 'Xcode', 'DerivedData'),
    join(cwd, 'ios', 'build', 'Build', 'Products'),
  ];
  let best: { path: string; mtime: number } | null = null;
  for (const root of candidates) {
    let topEntries;
    try {
      topEntries = await readdir(root, { withFileTypes: true });
    } catch { continue; }
    for (const top of topEntries) {
      if (!top.isDirectory()) continue;
      const productsRoot = root.includes('DerivedData')
        ? join(root, top.name, 'Build', 'Products', productDir)
        : join(root, productDir);
      let appEntries;
      try {
        appEntries = await readdir(productsRoot, { withFileTypes: true });
      } catch { continue; }
      for (const e of appEntries) {
        if (!e.isDirectory() || !e.name.endsWith('.app')) continue;
        const full = join(productsRoot, e.name);
        const mt = (await stat(full)).mtime.getTime();
        if (!best || mt > best.mtime) best = { path: full, mtime: mt };
      }
    }
  }
  return best?.path ?? null;
}

function spawnAsync(cmd: string, args: string[], cwd: string, env: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    child.on('error', () => resolve(127));
    child.on('close', (code) => resolve(code ?? 0));
  });
}

export default defineConfig({
  bundleId: 'com.example.myapp',
  flowsDir: '.maestro',
  maestroEnv: {
    APP_BASE_URL: 'https://staging.example.com',
  },

  build: {
    android: {
      async buildAndInstallFirst({ device, cwd, log }) {
        log('expo run:android (release)');
        const code = await spawnAsync(
          'pnpm',
          ['expo', 'run:android', '--variant', 'release', '--device', device.buildTargetId],
          cwd,
          SENTRY_DISABLE,
        );
        if (code !== 0) process.exit(code);
        const apk = await findApk(cwd);
        return apk ? { path: apk } : null;
      },
    },
    ios: {
      async buildAndInstallFirst({ device, cwd, log }) {
        log('expo run:ios (Release)');
        const code = await spawnAsync(
          'pnpm',
          ['expo', 'run:ios', '--configuration', 'Release', '--device', device.buildTargetId],
          cwd,
          SENTRY_DISABLE,
        );
        if (code !== 0) process.exit(code);
        const kind = device.kind === 'simulator' ? 'simulator' : 'usb';
        const app = await findIosApp(cwd, kind);
        return app ? { path: app } : null;
      },
    },
  },
});
