---
title: Build strategies
---

# Build strategies

mp auto-detects how to build your project. Priority: **Rock → EAS local → `expo run:*`**.

Set `buildStrategy` in [config](./configuration.md) to pin a specific one.

## Rock

Detected when `rock.config.{mjs,mts,js,ts,cjs,cts}` exists.

```
pnpm exec rock run:ios     --configuration Release --destination simulator --device <udid>
pnpm exec rock run:android --variant release --device <serial>
```

mp watches for `› Opening … on <device>` then SIGTERMs Rock (it would otherwise stream Metro logs forever).

**Cache:** Rock has built-in `.rock/` local cache + remote providers (GitHub Releases, S3, R2, BYO). See [Rock remote cache](https://rockjs.dev/docs/remote-cache/introduction).

## EAS local

Detected when `eas.json` has a profile named `e2e-test`, `e2e`, or `preview`.

```
pnpm exec eas build --profile <profile> --platform ios --local
pnpm exec eas build --profile <profile> --platform android --local
```

EAS local emits `.tar.gz` (iOS) and `.apk` (Android). mp extracts and installs.

**Cache:** Uses Expo Remote Build Cache when `buildCacheProvider: 'eas'` is set in `app.json`. Quota per billing cycle: 10 (free), 50 (Production), 100 (Enterprise).

**Requires:** `fastlane` installed (`brew install fastlane`).

## `expo run:*`

Detected when `package.json` has `expo` + an app config (`app.config.{ts,js}` or `app.json`) and the previous two strategies didn't match.

```
pnpm expo run:ios     --configuration Release --device <udid>
pnpm expo run:android --variant release --device <serial>
```

mp watches for `› Opening … on <device>` then SIGTERMs the child.

## Custom hooks

When auto-detect doesn't fit, declare your own:

```ts title="maestroparallel.config.ts"
import { spawn } from 'node:child_process';
import { join } from 'node:path';

function spawnAsync(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
    child.on('error', () => resolve(127));
    child.on('close', (code) => resolve(code ?? 0));
  });
}

export default {
  bundleId: 'com.example.app',
  build: {
    android: {
      async buildAndInstallFirst({ device, cwd, log }) {
        log('custom build android');
        const code = await spawnAsync(
          'pnpm', ['expo', 'run:android', '--variant', 'release', '--device', device.buildTargetId],
          cwd,
        );
        if (code !== 0) return null;
        return { path: join(cwd, 'android/app/build/outputs/apk/release/app-release.apk') };
      },
      // Optional — defaults to `adb install -r <apk>`.
      // installExisting: async ({ device }, artifact) => { ... },
    },
    // ios analogous
  },
};
```

`buildAndInstallFirst` runs on the **first** device of each platform group. Return the artifact path so mp can reuse-install it on the rest via `adb install -r` / `xcrun simctl install`. Return `null` on failure — mp falls back to existing install.
