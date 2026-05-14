---
title: Configuration
---

# Configuration

`maestro-parallel` reads an optional `maestroparallel.config.{ts,mts,js,mjs,cjs,json}` from the project root.

## Minimal

```ts title="maestroparallel.config.ts"
export default {
  bundleId: 'com.example.app',
};
```

## Full example

```ts title="maestroparallel.config.ts"
export default {
  bundleId: 'com.shoptet.admin',
  flowsDir: '.maestro/flows',
  appleTeamId: 'MTHKX3U9QF',

  buildStrategy: 'expo',                              // override auto-detect
  buildEnv: { SENTRY_DISABLE_AUTO_UPLOAD: 'true' },   // env for build child

  maestroEnv: { APP_BASE_URL: 'https://779779.myshoptet.com' },

  iosSequential: true,   // default true — XCTestService races on per-sim ports
  iosShardAll: false,    // mutually exclusive with iosSequential

  processStartStaggerMs: 2000,  // workaround for Maestro 2.5.x log-dir race
  keepRuns: 3,
};
```

## Fields

### `bundleId?: string`
App bundle identifier (`com.example.app`). Required for `clearAppState` (skipped silently when absent).

### `flowsDir?: string`
Maestro flows directory or single flow file, relative to cwd. Default `.maestro`.

### `outputDir?: string`
Where to write per-run output. Default `.maestro/output`.

### `keepRuns?: number`
Past `parallel-*` runs kept in `outputDir`. Default 3.

### `maestroConfigPath?: string`
Path to project's existing Maestro config. Used when `iosShardAll` is true — `executionOrder.flowsOrder` is stripped from a temp copy so `--shard-all` works. Default `.maestro/config.yaml`.

### `maestroEnv?: Record<string, string>`
Extra env vars forwarded to Maestro via `-e KEY=VALUE`. Host env wins.

### `build?: { android?: PlatformBuildHooks; ios?: PlatformBuildHooks }`
Per-platform build hooks. Omit a platform to disable it. When you set these, auto-detect is skipped for that platform. See [Build strategies → Custom hooks](./build-strategies.md#custom-hooks).

### `hooks?: { preTest?: (devices: Device[]) => Promise<void> }`
Run between build/install and Maestro. Useful for permission grants, keychain reset, etc.

### `iosSequential?: boolean`
Default `true`. Maestro 2.5.x races on per-sim XCTestService ports when more than one iOS device is driven concurrently.

### `iosShardAll?: boolean`
Default `false`. Run one Maestro process with `--shard-all=N` instead of one process per device. Mutually exclusive with `iosSequential`.

### `appleTeamId?: string`
10-char Apple Developer Team ID. **Required for physical iOS** — Maestro builds its iOS WebDriver against the device and needs a team to code-sign it. CLI `--apple-team-id` and env `MAESTRO_APPLE_TEAM_ID` both override this.

### `processStartStaggerMs?: number`
Delay (ms) between starting consecutive Maestro processes. Workaround for the Maestro 2.5.x per-second session-log-dir race. Default 2000. Set to 0 to disable.

### `buildMode?: 'release' | 'skip'`
Pre-selected build mode. CLI `--release` / `--skip-build` override.

### `buildStrategy?: 'auto' | 'rock' | 'eas' | 'expo'`
Pin the auto-detect choice. Default `'auto'` (priority: rock > eas > expo). Use when your project has artifacts of more than one strategy.

### `buildEnv?: Record<string, string>`
Env merged into the auto-detected build child (Rock / EAS / expo run:*). Has no effect on user-defined `build.*` hooks — those control their own env. Common use: `SENTRY_DISABLE_AUTO_UPLOAD: 'true'`.

### `concurrentBuilds?: boolean`
Run platform groups (android, ios-sim, ios-usb) in parallel instead of sequentially. Wall time drops to `max(group)` instead of `sum`. **Default false.** RAM/CPU/disk pressure multiplies — three xcodebuild/gradle/Metro pipelines at once can OOM a 16 GB Mac and the Pods cache may race. Enable only on beefy machines (M-series with ≥ 32 GB).
