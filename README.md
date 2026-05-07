# maestro-parallel

[![JSR](https://jsr.io/badges/@kaln/maestro-parallel)](https://jsr.io/@kaln/maestro-parallel)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Run [Maestro](https://maestro.mobile.dev/) flows on multiple Android and iOS
devices in parallel — interactively. Picks devices from a TTY checklist,
builds and installs your app on each, runs the suite concurrently, then
prints a per-device pass/fail summary and merged JUnit report.

```
[and:Pixel 6 ]      ✓ login_flow.yaml
[and:Pixel 8 ]      ✓ login_flow.yaml
[ios:iPhone 15]     ✓ login_flow.yaml

Summary
  ✓ android Pixel 6  37a8c2d4    8 tests, 0 fail, 0 err, 0 skip
  ✓ android Pixel 8  9e1b3f57    8 tests, 0 fail, 0 err, 0 skip
  ✓ ios     iPhone 15 9F8C-...   8 tests, 0 fail, 0 err, 0 skip

  output dir:    .maestro/output/parallel-2026-05-07T20-31-12
  merged junit:  .maestro/output/parallel-2026-05-07T20-31-12/report.xml
```

## Why

Maestro Cloud is paid and remote. The Maestro CLI runs sequentially on one
device at a time. This package fills the gap: parallel execution on
locally-connected hardware (and simulators), with the orchestration plumbing
that the CLI doesn't ship with — device discovery, app build & install,
state reset between runs, JUnit aggregation.

## Features

- **Device discovery.** Android USB phones, Android emulators, booted iOS
  simulators, USB-connected iPhones (via `devicectl`).
- **Interactive picker.** Arrow keys, `space` to toggle, `a` to toggle all,
  `enter` to run. Last selection is remembered and pre-checked.
- **Build once, install many.** Builds the app on the first device of each
  platform group, then reuse-installs the artifact on the rest in parallel.
  Build hooks are user-supplied so the runner is build-system-agnostic
  (Expo, bare RN, native Xcode/Gradle, anything that produces an `.app` /
  `.apk`).
- **State reset.** Wipes app data on every device before each run so flows
  start from a clean slate. Replaces the broken `clearState: true` on iOS
  Maestro 2.5.x.
- **iOS quirks handled.** Wakes locked Android phones, disables iOS
  AutoFill Passwords overlay, resets simulator keychain, runs iOS
  sequentially by default to avoid XCTestService port races.
- **Per-device output.** Streamed Maestro output is colour-prefixed
  (`[and:Pixel 6]`, `[ios:iPhone 15]`) and tee'd to per-device `run.log`
  next to the JUnit report.
- **Merged JUnit.** All per-device reports are aggregated into a single
  `report.xml` for CI consumers.
- **Library and CLI.** Use `runMaestroParallel()` programmatically or run
  the bundled CLI.

## Install

Requires [Deno](https://deno.com/) ≥ 2.0.

```bash
# Install as a global command
deno install -A -g -n maestro-parallel jsr:@kaln/maestro-parallel/cli

# Or run ad-hoc, no install
deno run -A jsr:@kaln/maestro-parallel/cli
```

You also need:

- [Maestro CLI](https://maestro.mobile.dev/getting-started/installing-maestro) on `PATH`
- `adb` (for Android)
- `xcrun` (for iOS — bundled with Xcode)

## Quick start

1. Create `maestroparallel.config.ts` in your project root:

   ```ts
   import { defineConfig } from 'jsr:@kaln/maestro-parallel/config';

   export default defineConfig({
     bundleId: 'com.example.myapp',

     build: {
       android: {
         async buildAndInstallFirst({ device, cwd, log }) {
           log('building Android…');
           const code = await new Deno.Command('pnpm', {
             args: ['expo', 'run:android', '--variant', 'release', '--device', device.buildTargetId],
             cwd, stdout: 'inherit', stderr: 'inherit',
           }).spawn().status.then((s) => s.code);
           if (code !== 0) Deno.exit(code);
           return { path: `${cwd}/android/app/build/outputs/apk/release/app-release.apk` };
         },
       },
       ios: {
         async buildAndInstallFirst({ device, cwd, log }) {
           log('building iOS…');
           // ...your build…
           return { path: '/path/to/MyApp.app' };
         },
       },
     },
   });
   ```

2. Run:

   ```bash
   maestro-parallel
   ```

3. Pick devices in the checklist, hit `enter`. Done.

See [`examples/`](./examples) for fuller configs, including an Expo example
that locates the build artifact in Xcode's DerivedData.

## CLI

```
maestro-parallel [options]

Options:
  -c, --config <path>   Path to config file (default: auto-discover
                        maestroparallel.config.{ts,mts,js,mjs,json})
      --skip-build      Skip build & install (assume the app is installed)
      --skip-clear      Skip clearing app data before tests
      --cwd <path>      Project root (default: current directory)
  -h, --help            Show help
  -v, --version         Show version

maestro-parallel setup-ios-sim
                        Disable AutoFill Passwords on every booted simulator.
                        Useful before single-device runs too.
```

## Configuration

Full schema in [`src/config.ts`](./src/config.ts). Highlights:

| Option | Default | Description |
|---|---|---|
| `bundleId` | _required_ | App identifier; used to clear state between runs. |
| `flowsDir` | `.maestro` | Directory containing your Maestro flows. |
| `outputDir` | `.maestro/output` | Where each `parallel-<ts>/` run is written. |
| `keepRuns` | `3` | Older runs are pruned automatically. |
| `maestroConfigPath` | `.maestro/config.yaml` | Source for the shard-mode config rewrite. |
| `maestroEnv` | `{}` | Extra `-e KEY=VALUE` flags passed to Maestro. |
| `build.android` | — | Hooks for Android build + install. |
| `build.ios` | — | Hooks for iOS build + install. |
| `hooks.preTest` | — | Runs after build/clear, before Maestro starts. |
| `iosSequential` | `true` | Run iOS devices one-at-a-time (XCTestService races otherwise). |
| `iosShardAll` | `false` | Use a single `--shard-all=N` Maestro process for iOS. |

### Build hooks

Each platform hook receives a `BuildContext` and returns the path to the
produced artifact:

```ts
type PlatformBuildHooks = {
  buildAndInstallFirst: (ctx: BuildContext) => Promise<ResolvedArtifact | null>;
  installExisting?:    (ctx: BuildContext, artifact: ResolvedArtifact) => Promise<number>;
};
```

The runner builds + installs on the first device of each platform group via
`buildAndInstallFirst`, then installs the returned artifact on every other
device in parallel — using `adb install -r` (Android) or `xcrun simctl
install` (iOS sim) by default, or your `installExisting` hook if you supply
one. Returning `null` from `buildAndInstallFirst` falls back to a per-device
build for the rest of the group (slower, always correct).

## Library API

```ts
import {
  defineConfig,
  discoverDevices,
  runMaestroParallel,
} from 'jsr:@kaln/maestro-parallel';

const code = await runMaestroParallel(defineConfig({
  bundleId: 'com.example.myapp',
  build: { /* ... */ },
}), {
  // optional: pre-pick devices instead of showing the picker
  devices: (await discoverDevices()).filter((d) => d.platform === 'android'),
  skipBuild: true,
});
Deno.exit(code);
```

## How it runs

1. Discover devices via `adb devices`, `xcrun simctl list devices booted`,
   `xcrun devicectl list devices`.
2. Show interactive checklist (or use `options.devices`).
3. Persist selection to `.maestro/.last-devices`.
4. Per platform group (Android USB+emulator / iOS sim / iOS USB):
   - Build + install on the first device via your hook.
   - Reuse-install the artifact on the rest in parallel.
5. Wake every Android phone (`KEYCODE_WAKEUP` + `svc power stayon true`).
6. Clear app data on every device. Reset iOS sim keychain.
7. Run Maestro:
   - **Android:** one process per device, in parallel.
   - **iOS:** sequential by default; opt into `iosShardAll` for one shard
     process across all sims.
8. Merge per-device JUnit reports into a single `report.xml`.
9. Print a summary table.

## Known limitations

- **Physical iOS reuse-install is not built in.** The runner falls back to
  re-running your build hook for each USB iPhone (unless you provide
  `installExisting`).
- **Maestro 2.1.0 cannot reliably run multiple physical Androids in
  parallel.** dadb races on host TCP ports 7001 and 7039. Upgrade to 2.5+.
- **iOS Maestro 2.5.x** still races on per-sim XCTestService ports when
  multiple sims run concurrently. The default `iosSequential: true` works
  around this.
- **iOS `clearState: true`** in flows is broken on Maestro 2.5.x; this
  package clears state from the runner instead.

## License

[Apache-2.0](./LICENSE)
