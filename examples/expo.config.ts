// Custom Expo build hook example. Auto-detection in `defaultBuild.ts`
// already runs `pnpm|yarn|npm exec expo run:* --configuration Release` /
// `--variant release` out of the box when the project has a
// `package.json` with `expo` + an app config. Use this file only when
// you need to override that default — e.g. pass extra Sentry env vars,
// pick a specific scheme, or skip CocoaPods install on iOS.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { defineConfig } from 'jsr:@kaln/maestro-parallel/config';

const SENTRY_DISABLE = { SENTRY_DISABLE_AUTO_UPLOAD: 'true' };

function spawnAsync(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<number> {
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
        if (code !== 0) return null;
        const apk = join(
          cwd,
          'android/app/build/outputs/apk/release/app-release.apk',
        );
        return { path: apk };
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
        if (code !== 0) return null;
        // Locate the .app under DerivedData for reuse-install on other
        // sims in the group. See `src/defaultBuild.ts:findFirstApp` for
        // a more thorough lookup if your project doesn't use the default
        // DerivedData / ios/build path.
        return null;
      },
    },
  },
});
