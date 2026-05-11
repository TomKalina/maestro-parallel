# maestro-parallel

[![JSR](https://jsr.io/badges/@kaln/maestro-parallel)](https://jsr.io/@kaln/maestro-parallel)
[![npm](https://img.shields.io/npm/v/maestro-parallel.svg)](https://www.npmjs.com/package/maestro-parallel)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Run [Maestro](https://maestro.mobile.dev/) E2E flows on every connected Android and iOS device at
once. Zero config required.

## Use it

### With Deno (after publish on JSR)

```bash
# In your app folder (must have a .maestro/ folder with flows)
deno run -A jsr:@kaln/maestro-parallel/cli
```

Or install globally:

```bash
deno install -g -A -n maestro-parallel jsr:@kaln/maestro-parallel/cli
maestro-parallel
```

### With Node / npm

Not yet available — the runtime uses `Deno.Command` and `Deno.stdin.setRaw` directly. A Node build
via `dnt` is on the roadmap; it needs a small shim layer that translates those to
`node:child_process` / `tty.ReadStream`.

For now, [install Deno](https://docs.deno.com/runtime/getting_started/installation/)
(`brew install deno` on macOS). The single binary has no dependencies of its own. The Maestro CLI,
`adb`, and `xcrun` are the only required external tools.

### Local checkout (now, while the package is unpublished)

```bash
git clone https://github.com/TomKalina/maestro-parallel.git
deno install -g -A -f -n maestro-parallel \
  --config /path/to/maestro-parallel/deno.json \
  /path/to/maestro-parallel/cli.ts
```

The wrapper installed under `~/.deno/bin/maestro-parallel` re-reads the source tree on every run, so
edits show up immediately. Reinstall only if you move the checkout or change `deno.json`.

That's it. The CLI discovers your devices, asks which to use, asks whether to build a release
artifact, runs your flows in parallel, prints pass/fail.

If only one device is connected, it skips the picker and just runs.

### Common variants

```bash
maestro-parallel                          # auto: .maestro/ folder, ask whether to build
maestro-parallel --release                # build release, then run flows (recommended for CI)
maestro-parallel --skip-build             # don't build; use what's installed
maestro-parallel ./e2e/login.yaml         # specific flow
maestro-parallel --all                    # every device, no picker
maestro-parallel setup-ios-sim            # one-off: disable AutoFill on all booted sims
```

## Build mode

On every run, after the device picker, the CLI asks:

```
Build a release artifact now? [Y/n — n skips build, uses app already on each device]
```

There are two modes:

- **release** — invoke your `build.*` hook to produce a real production-style artifact (release
  variant / Release config / EAS profile), reuse-install it on every device in each platform group,
  then run flows. The JS bundle is baked in, the app launches straight into its real UI — no
  `expo-dev-launcher` picker, no `expo-dev-menu` onboarding overlay, no Metro to disconnect, no Fast
  Refresh races. This is the default in non-TTY environments (CI) and the recommended answer for
  local runs too.
- **skip** — don't build or install; run flows against whatever is already on each device. Useful
  for iterating on flow YAML against a stable build.

Dev / dev-client builds are **intentionally not supported**. They're structurally flaky for E2E
(dev-launcher picker, dev-menu onboarding overlay, Fast Refresh races, `adb reverse` decay, Metro
disconnects) and the workarounds (preflight flows, deep links, port forwarding) trade one failure
mode for another. Build a release artifact and run flows against it; that is the supported path.

### Recommended CI pipeline

Build the artifact once, run flows against it on every device:

```bash
# 1. Produce a real artifact via EAS local build (or your own build step).
pnpm exec eas build --profile e2e --platform android --local
pnpm exec eas build --profile e2e --platform ios --local
# (extract the iOS .app from the resulting tar.gz)

# 2. Run flows against it on every connected device.
maestro-parallel --all --release
```

`eas.json`:

```json
{
  "build": {
    "e2e": {
      "developmentClient": false,
      "distribution": "internal",
      "android": { "buildType": "apk" },
      "ios": { "simulator": true }
    }
  }
}
```

See [`examples/eas-local.config.ts`](./examples/eas-local.config.ts) for the corresponding
maestro-parallel config that picks up the EAS artifact.

## Physical iOS — Apple Developer Team ID

Maestro 2.5+ builds an on-device WebDriver app for each connected iPhone, and **must code-sign it**.
The signing certificate belongs to an Apple Developer team, so Maestro asks for the Team ID —
without it, runs fail with
`"Apple account team ID must be specified to build drivers for connected
iPhone"`.

Simulators and Android don't need this.

### Get your Team ID

It is a 10-character string of uppercase letters and digits (e.g. `ABCDE12345`).

- **Web (fastest):** [developer.apple.com/account](https://developer.apple.com/account) → Membership
  Details → Team ID.
- **Xcode:** Settings (⌘,) → Accounts → select your Apple ID → the Team row shows the ID.
- **Local certs (if you have any):** `security find-identity -v -p codesigning` — the 10 chars in
  parentheses on each line.

### Provide it to maestro-parallel

Pick whichever fits — they cascade in this order (highest wins):

```bash
# 1. CLI flag (per-run)
maestro-parallel --apple-team-id ABCDE12345

# 2. Config file (per-project)
# maestroparallel.config.ts
export default defineConfig({ appleTeamId: 'ABCDE12345' });

# 3. Environment variable (recommended for steady state)
export MAESTRO_APPLE_TEAM_ID=ABCDE12345     # add to ~/.zshrc
maestro-parallel
```

Once set, `maestro-parallel` passes `--apple-team-id` to Maestro automatically for every physical
iOS device in the run.

## iOS simulator pre-flight (automatic)

Every selected iOS simulator gets configured before tests start:

- `AutoFillPasswords` disabled in both
  `com.apple.preferences.password.RemoteUI.SimulatorBundleSettings` and
  `com.apple.AutoFillFramework` (the toggle moved between iOS versions) — kills the "Save Password?"
  / "AutoFill Passwords" SpringBoard overlay that otherwise floats above the app after a credentials
  submit and blocks Maestro's next step.
- Keychain reset via `xcrun simctl keychain <udid> reset` — no saved credential, nothing to offer to
  save.
- `SBIdleTimerDisabled = true` on `com.apple.springboard` — keeps the sim screen awake (default
  auto-lock is ~1 min and lands you on a blank SpringBoard mid-test).

Physical iOS can't be configured programmatically — Apple doesn't expose those toggles via `xcrun` /
`devicectl`. If a physical iPhone is in the run, the CLI logs a one-line reminder to disable
AutoFill manually: **Settings → Passwords → Password Options → AutoFill Passwords (off)**.

The standalone `maestro-parallel setup-ios-sim` subcommand applies the same configuration to every
currently-booted simulator without doing a full run — useful right after spinning up a fresh sim.

## Build & install

There is no default release build hook bundled — release builds vary too much across projects
(Gradle release vs EAS, simulator vs device, signing, productFlavors). Supply your own in
`maestroparallel.config.ts`:

- [`examples/expo.config.ts`](./examples/expo.config.ts) — `pnpm expo run:android --variant release`
  / `expo run:ios --configuration Release`, locates the resulting `.apk` / `.app` and reuse-installs
  on every device in the group.
- [`examples/eas-local.config.ts`](./examples/eas-local.config.ts) — picks up the artifact from
  `eas build --profile e2e --local` (or runs the EAS build itself on first use).

The runner only reuse-installs on iOS simulators and Android via the built-in defaults
(`adb install -r`, `xcrun simctl install`); physical iOS reuse-install isn't supported, so for
iPhone groups the build hook is invoked per device.

## Add a config (only when you need it)

A config is **optional**. Add one only if you want maestro-parallel to also build & install your
app, clear app data between runs, or pass env vars.

```ts
// maestroparallel.config.ts
import { defineConfig } from 'jsr:@kaln/maestro-parallel/config';
// (or 'maestro-parallel/config' on npm)

export default defineConfig({
  bundleId: 'com.your.app', // enables app-data clearing
  maestroEnv: { API_URL: '...' }, // forwarded to maestro -e
  // build: { android: { ... }, ios: { ... } } — see examples/
});
```

See [`examples/expo.config.ts`](./examples/expo.config.ts) for an Expo / React Native build setup.
Full schema in [`src/config.ts`](./src/config.ts).

## Library API

```ts
import { runMaestroParallel } from 'jsr:@kaln/maestro-parallel';
const code = await runMaestroParallel({ bundleId: 'com.your.app' });
Deno.exit(code);
```

## Requirements

- [Deno](https://deno.com/) ≥ 2.0 (Node support is on the roadmap, see Known limitations below).
- [Maestro CLI](https://maestro.mobile.dev/getting-started/installing-maestro) on `PATH`.
- `adb` (for Android), `xcrun` (for iOS, ships with Xcode).
- For physical iOS: an Apple Developer Team ID — see the section above.

## Development

```bash
deno task check          # type-check
deno task run            # run CLI locally
deno task fmt            # format
deno task lint           # lint
```

## License

[Apache-2.0](./LICENSE)
