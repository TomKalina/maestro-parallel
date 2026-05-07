# maestro-parallel

[![JSR](https://jsr.io/badges/@kaln/maestro-parallel)](https://jsr.io/@kaln/maestro-parallel)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Run [Maestro](https://maestro.mobile.dev/) flows on multiple Android and iOS
devices in parallel. Interactive picker, build & install once per platform,
merged JUnit report.

## Quickstart

```bash
# 1. Install
deno install -A -g -n maestro-parallel jsr:@kaln/maestro-parallel/cli

# 2. In your project (must contain a .maestro/ flows directory)
cat > maestroparallel.config.ts <<'EOF'
import { defineConfig } from 'jsr:@kaln/maestro-parallel/config';
export default defineConfig({ bundleId: 'com.your.app' });
EOF

# 3. Plug in devices / boot simulators, then:
maestro-parallel --skip-build
```

A checklist appears, space toggles, enter runs.

## With build & install

Drop the `--skip-build` and add build hooks to the config — see
[`examples/expo.config.ts`](./examples/expo.config.ts) for an Expo / React
Native setup. Copy-paste, change `bundleId`, done.

## CLI

```
maestro-parallel              # pick devices, run flows
maestro-parallel --skip-build # app already installed
maestro-parallel --skip-clear # don't wipe app data
maestro-parallel setup-ios-sim # disable AutoFill on every booted sim
maestro-parallel --help
```

## Library

```ts
import { runMaestroParallel } from 'jsr:@kaln/maestro-parallel';
const code = await runMaestroParallel({ bundleId: 'com.your.app' });
Deno.exit(code);
```

## Configuration reference

Full schema with JSDoc: [`src/config.ts`](./src/config.ts).
Every option is optional except `bundleId`. Common ones:

- `flowsDir` — where your Maestro flows live (default `.maestro`)
- `maestroEnv` — extra `-e KEY=VALUE` flags for Maestro
- `build.{android,ios}` — build & install hooks (omit to skip)
- `iosSequential` / `iosShardAll` — iOS execution mode

## Requirements

- [Deno](https://deno.com/) ≥ 2.0
- [Maestro CLI](https://maestro.mobile.dev/getting-started/installing-maestro) on `PATH`
- `adb` (Android) and/or `xcrun` (iOS, with Xcode)

## License

[Apache-2.0](./LICENSE)
