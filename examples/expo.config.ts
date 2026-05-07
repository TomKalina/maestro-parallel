// Example: a typical Expo / React Native project. The build hooks shell
// out to `pnpm expo run:<platform>` for the first device in each group;
// the runner then reuses the produced .apk / .app on the rest.

import { defineConfig } from '../mod.ts';
import { join } from '@std/path';

const SENTRY_DISABLE = { SENTRY_DISABLE_AUTO_UPLOAD: 'true' };

async function findApk(cwd: string): Promise<string | null> {
  const path = join(cwd, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
  try {
    await Deno.stat(path);
    return path;
  } catch {
    return null;
  }
}

async function findIosApp(cwd: string, kind: 'simulator' | 'usb'): Promise<string | null> {
  const productDir = kind === 'simulator' ? 'Release-iphonesimulator' : 'Release-iphoneos';
  const candidates = [
    join(Deno.env.get('HOME') ?? '', 'Library', 'Developer', 'Xcode', 'DerivedData'),
    join(cwd, 'ios', 'build', 'Build', 'Products'),
  ];
  let best: { path: string; mtime: number } | null = null;
  for (const root of candidates) {
    try {
      for await (const top of Deno.readDir(root)) {
        if (!top.isDirectory) continue;
        const productsRoot = root.includes('DerivedData')
          ? join(root, top.name, 'Build', 'Products', productDir)
          : join(root, productDir);
        try {
          for await (const e of Deno.readDir(productsRoot)) {
            if (!e.isDirectory || !e.name.endsWith('.app')) continue;
            const full = join(productsRoot, e.name);
            const stat = await Deno.stat(full);
            const mt = stat.mtime?.getTime() ?? 0;
            if (!best || mt > best.mtime) best = { path: full, mtime: mt };
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
  return best?.path ?? null;
}

async function spawn(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<number> {
  const child = new Deno.Command(cmd, {
    args,
    cwd,
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...Deno.env.toObject(), ...env },
  }).spawn();
  return (await child.status).code;
}

export default defineConfig({
  bundleId: 'com.example.myapp',
  flowsDir: '.maestro',
  // Forwarded to Maestro as `-e KEY=VALUE`. Use it for environment-specific
  // config that your flows reference (e.g. backend URL, account IDs).
  maestroEnv: {
    APP_BASE_URL: 'https://staging.example.com',
  },

  build: {
    android: {
      async buildAndInstallFirst({ device, cwd, log }) {
        log('expo run:android (release)');
        const code = await spawn(
          'pnpm',
          ['expo', 'run:android', '--variant', 'release', '--device', device.buildTargetId],
          cwd,
          SENTRY_DISABLE,
        );
        if (code !== 0) Deno.exit(code);
        const apk = await findApk(cwd);
        return apk ? { path: apk } : null;
      },
    },
    ios: {
      async buildAndInstallFirst({ device, cwd, log }) {
        log('expo run:ios (release)');
        const code = await spawn(
          'pnpm',
          ['expo', 'run:ios', '--configuration', 'Release', '--device', device.buildTargetId],
          cwd,
          SENTRY_DISABLE,
        );
        if (code !== 0) Deno.exit(code);
        const kind = device.kind === 'simulator' ? 'simulator' : 'usb';
        const app = await findIosApp(cwd, kind);
        return app ? { path: app } : null;
      },
    },
  },
});
