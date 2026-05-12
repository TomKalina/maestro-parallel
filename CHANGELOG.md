# Changelog

All notable changes to this project will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Auto-detected default build hooks** when no `build.*` is configured. Priority: Rock
  (`rock.config.{js,ts,mjs,mts,cjs,cts}`) > EAS (matching profile in `eas.json`: `e2e-test`, `e2e`,
  `e2e-tests`, `preview`) > Expo (`expo` dep + app config). Spawns the right release command
  (`pnpm|yarn|npm exec rock run:* --configuration
  Release` / `eas build --profile <p> --local` /
  `expo run:* --configuration
  Release`) and reuse-installs on the rest of the group.
- **Rock fingerprint cache integration** — cache-hit repeat builds run in seconds instead of
  minutes.
- **iOS simulator auto-preflight** before every run on every selected sim: disable AutoFill (both
  `com.apple.preferences.password.RemoteUI.SimulatorBundleSettings` and
  `com.apple.AutoFillFramework`), reset the keychain, set `SBIdleTimerDisabled` to keep the screen
  awake. Standalone `setup-ios-sim` subcommand still applies the same config to every booted
  simulator on demand.
- **iOS physical CoreDevice tunnel keepalive** — long-lived `xcrun devicectl device
  info details`
  per iPhone, killed on signal, so Maestro doesn't hit
  `"Device X was requested, but it is not connected"` mid-run.
- **Per-user device-selection cache** at `~/Library/Caches/maestro-parallel/last-devices.json` (or
  `$XDG_CACHE_HOME/maestro-parallel/...`), keyed by absolute cwd. Stops polluting the project tree
  with `.maestro/.last-devices`.
- **`expo run:*` hang fix** — kills the post-install Metro / app log stream on the
  `"Opening on <device>"` marker so the runner can proceed to flows.
- **`appleTeamId`** — config field, `--apple-team-id` CLI flag, and `MAESTRO_APPLE_TEAM_ID` env var.
  Auto-piped through to Maestro for every physical iPhone.
- **Broken-adb detection** — warns on `unauthorized`/`offline` entries that cause Maestro 2.5.x to
  fail every device lookup.
- **JUnit merge across devices** to a single `merged.xml` + per-device run logs under
  `<outputDir>/parallel-<timestamp>/<device-slug>/`.
- **Process-start stagger** (default 2000 ms cumulative) — workaround for Maestro 2.5.x's per-second
  session-log directory race.

### Removed

- Dev / dev-client build mode and every workaround it required (preflight flows, `adb reverse` Metro
  ports, `expo-development-client` deep link, Metro prerun prompt). Release builds are the only
  supported path — dev builds are structurally flaky for E2E.
- Interactive `[Y/n]` build-mode prompt. With Rock / EAS fingerprint-caching the build, the prompt
  was pure friction.
- `--release`, `--dev`, `--prerun`, `--prerun-ready` CLI flags.
- Default Android Gradle debug build hook — replaced by per-platform auto-detection.

### Changed

- Port to Deno as the source of truth; JSR target `@kaln/maestro-parallel`. Node distribution via
  `dnt` is on the roadmap (needs a shim for `Deno.Command` / `Deno.stdin.setRaw`).

## [0.1.0] — 2026-05-07

Initial release.
