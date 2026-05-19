# maestro-parallel

[![JSR](https://jsr.io/badges/@kaln/maestro-parallel)](https://jsr.io/@kaln/maestro-parallel)
[![npm](https://img.shields.io/npm/v/maestro-parallel.svg)](https://www.npmjs.com/package/maestro-parallel)
[![Docs](https://img.shields.io/badge/docs-maestro--parallel.pages.dev-2563eb)](https://maestro-parallel.pages.dev)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

**One command. Every device. Real release builds.** Run [Maestro](https://maestro.mobile.dev/) E2E flows on every connected Android + iOS device in parallel — zero config in Expo / React Native projects.

📚 **Full docs:** [maestro-parallel.pages.dev](https://maestro-parallel.pages.dev)

<!-- TODO(demo): replace with VHS-recorded GIF of a real parallel run -->
<!-- ![maestro-parallel demo](./docs/static/img/demo.gif) -->

## Quickstart

```bash
# JSR (Deno >=2.0)
deno install -g -A -n maestro-parallel jsr:@kaln/maestro-parallel/cli

# or npm (Node >=18.17)
npm i -g maestro-parallel

# In your app folder (needs .maestro/ flows + a connected device or booted sim)
maestro-parallel
```

The CLI discovers devices, asks which to use, auto-detects the right build strategy, builds a
release artifact (or hits the build cache), runs flows in parallel, prints pass / fail. Picker is
auto-skipped when only one device is present.

After the picker, mp renders a **device-centric live checklist** — one row per selected device,
status flips on the same row through `pending → building / waiting → installing → preparing →
running maestro · <flow> · N ✓  M ✗ → done`. Raw build / Maestro output is captured into per-run
log files; the terminal stays clean. In non-TTY (CI), the checklist degrades to forward-only lines.

```bash
maestro-parallel                              # auto-detect, build + run
maestro-parallel --all                        # every device, no picker
maestro-parallel --skip-build flow.yaml       # one flow, no rebuild
maestro-parallel --shard-split --all          # split flows across devices for speed
maestro-parallel setup-ios-sim                # one-off sim setup (also runs automatically)
```

### Coverage vs. speed: `shardMode`

By default every device runs the entire flow set (`shardMode: 'full'`) — full coverage across OS versions / form factors. Opt into `shardMode: 'split'` (CLI: `--shard-split`) to **distribute** flows across devices via Maestro's `--shard-split=N`: wall time drops ~linearly, but each flow runs on only one device. Use split for fast PR feedback, full for nightly regression. See [`docs/configuration#shardmode`](https://maestro-parallel.pages.dev/docs/configuration#shardmode-full--split).

## Auto-detected build defaults

When no `build.*` is configured, the runner picks the first strategy that fits:

| Trigger in `cwd`                                                     | Strategy         | Command                                                                                      |
| -------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------- |
| `rock.config.{js,ts,mjs,mts,cjs,cts}`                                | **[Rock][rock]** | `<pm> exec rock run:<platform> --configuration Release` (fingerprint cache → seconds on hit) |
| `eas.json` with profile `e2e-test` / `e2e` / `e2e-tests` / `preview` | **EAS local**    | `<pm> exec eas build --profile <p> --platform <p> --local`                                   |
| `expo` dep + `app.config.{ts,js}` or `app.json`                      | **expo run:**    | `<pm> expo run:ios --configuration Release` / `--variant release`                            |
| _(none)_                                                             | **skip build**   | use whatever is already installed                                                            |

`<pm>` is detected from the lockfile (pnpm > yarn > npm).

After the build, the artifact is reuse-installed on the rest of the group via `adb install -r`
(Android) or `xcrun simctl install` (iOS sim). Physical iOS reuse-install isn't supported, so the
build hook is invoked per device for that group.

**Dev / dev-client builds are intentionally not supported** — they're structurally flaky for E2E
(dev-launcher picker, dev-menu onboarding, Fast Refresh races, `adb reverse` decay). Build a release
artifact and run flows against it.

## Custom build hooks

When you need full control — different scheme, productFlavors, signing override — supply your own
hook. Auto-detection is skipped per-platform when you provide one.

```ts
// maestroparallel.config.ts
import { defineConfig } from 'jsr:@kaln/maestro-parallel/config';

export default defineConfig({
  bundleId: 'com.your.app', // enables app-data clearing between runs
  maestroEnv: { API_URL: '...' }, // forwarded to maestro -e
  appleTeamId: 'ABCDE12345', // physical iOS only

  build: {
    android: {
      async buildAndInstallFirst({ device, cwd, log }) {
        // Build + install on `device`. Return the artifact path so the
        // runner can reuse-install on the rest of the group.
        return { path: '/path/to/app.apk' };
      },
    },
    // ios: { … }
  },
});
```

Full schema: [`src/config.ts`](./src/config.ts). Working example:
[`examples/expo.config.ts`](./examples/expo.config.ts).

## iOS simulator auto-preflight

Every selected sim gets configured before flows run — no opt-in needed:

- `AutoFillPasswords = false` in both relevant defaults domains. Kills the "Save Password?" /
  "AutoFill Passwords" SpringBoard overlay that otherwise blocks Maestro after a credentials submit.
- Keychain reset via `xcrun simctl keychain <udid> reset`.
- `SBIdleTimerDisabled = true` — sim doesn't auto-lock mid-test.

Physical iOS can't be configured programmatically. The CLI prints a one-line reminder to disable
AutoFill manually under **Settings → Passwords → Password Options → AutoFill Passwords**.

## Physical iOS — Apple Team ID

Maestro 2.5+ builds an on-device WebDriver and must code-sign it. Without a 10-character team ID it
fails with `"Apple account team ID must be specified to build drivers for connected iPhone"`. Source
priority (highest wins):

```bash
maestro-parallel --apple-team-id ABCDE12345   # CLI
defineConfig({ appleTeamId: 'ABCDE12345' })   # config file
export MAESTRO_APPLE_TEAM_ID=ABCDE12345        # env var (recommended steady-state)
```

Find it at [developer.apple.com/account](https://developer.apple.com/account) → Membership Details →
Team ID, or in Xcode → Settings → Accounts.

## Requirements

- [Deno](https://deno.com/) ≥ 2.0 (`brew install deno`) **or** Node ≥ 18.17 via `npm i -g maestro-parallel`.
- [Maestro CLI](https://maestro.mobile.dev/getting-started/installing-maestro) on `PATH`.
- `adb` (Android), `xcrun` (iOS, ships with Xcode).
- Apple Developer Team ID for physical iPhones.

## Library API

```ts
import { runMaestroParallel } from 'jsr:@kaln/maestro-parallel';
const code = await runMaestroParallel({ bundleId: 'com.your.app' });
Deno.exit(code);
```

## Development

```bash
deno task check    # type-check
deno task lint     # lint
deno task fmt      # format
deno task run      # run CLI locally
```

## Roadmap

Not promises — directions. PRs welcome.

- **Prebuilt artifact mode**: `maestro-parallel --apk path.apk --app path.app` to skip the build
  hook entirely and just install + run. Closes the CI gap where the build is a separate step.
- **Distributable smoke artifact**: optional `--upload <provider>` after a green run (Firebase App
  Distribution / TestFlight).
- **Flow sharding by name pattern**: `--shard "auth/*"` to split flows across devices by glob.
- **Retry-flaky**: `--retry-failed 1` re-runs only failing flows once on the same device.
- **Per-device flow filter**: `flowsForDevice(device)` hook for platform-specific flows.
- **Physical iOS reuse-install** via `xcrun devicectl device install app` instead of per-device
  build.
- **WiFi Android discovery**: `adb connect <host>:<port>` auto-join.
- **Android emulator boot**: `--boot <avd-name>` cold-start an emulator for the run.
- **Cloud device pools**: BrowserStack / Sauce Labs adapter alongside local devices.
- **HTML report**: roll JUnit + Maestro debug bundles into a single browsable `index.html`.
- **Slack / Discord webhook**: summary post after the run.
- **`maestro-parallel doctor`**: pre-flight check (CLI versions, adb auth, sim state, Team ID).
- **Watch mode**: `maestro-parallel --watch flow.yaml` re-runs on file change.
- **Node distribution**: `dnt` build so `npx maestro-parallel` works without Deno.

## License

[Apache-2.0](./LICENSE)

[rock]: https://github.com/callstackincubator/rock
