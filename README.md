# maestro-parallel

[![npm](https://img.shields.io/npm/v/maestro-parallel.svg)](https://www.npmjs.com/package/maestro-parallel)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Run [Maestro](https://maestro.mobile.dev/) E2E flows on every connected
Android and iOS device at once. Zero config required.

## Use it

```bash
# Install
npm install --save-dev maestro-parallel

# Run (must have a .maestro/ folder with flows)
npx maestro-parallel
```

That's it. The CLI discovers your devices, asks which to use, runs your
flows in parallel, prints pass/fail.

If only one device is connected, it skips the picker and just runs.

### Or globally

```bash
npm install -g maestro-parallel
maestro-parallel
```

### Common variants

```bash
maestro-parallel                          # auto: .maestro/ folder
maestro-parallel ./e2e/login.yaml         # specific flow
maestro-parallel --all                    # every device, no picker
maestro-parallel setup-ios-sim            # disable iOS AutoFill prompt
```

## Add a config (only when you need it)

A config is **optional**. Add one only if you want maestro-parallel to also
build & install your app, clear app data between runs, or pass env vars.

```ts
// maestroparallel.config.ts
import { defineConfig } from 'maestro-parallel/config';

export default defineConfig({
  bundleId: 'com.your.app',          // enables app-data clearing
  maestroEnv: { API_URL: '...' },    // forwarded to maestro -e
  // build: { android: { ... }, ios: { ... } } — see examples/
});
```

See [`examples/expo.config.ts`](./examples/expo.config.ts) for an
Expo / React Native build setup. Full schema in
[`src/config.ts`](./src/config.ts).

## Library API

```ts
import { runMaestroParallel } from 'maestro-parallel';
const code = await runMaestroParallel({ bundleId: 'com.your.app' });
process.exit(code);
```

## Requirements

- Node ≥ 18.17
- [Maestro CLI](https://maestro.mobile.dev/getting-started/installing-maestro) on `PATH`
- `adb` (for Android), `xcrun` (for iOS, ships with Xcode)

## License

[Apache-2.0](./LICENSE)
