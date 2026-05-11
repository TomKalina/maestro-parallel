# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Port to Deno as the source of truth.
- JSR publishing target (`@kaln/maestro-parallel`).
- Auto-detect of project defaults so plain `maestro-parallel` Just Works:
  - `flowsDir` falls back to `.maestro/flows/` then `.maestro/`.
  - `bundleId` sniffed from `app.config.{ts,js}`, `app.json`, iOS `Info.plist`, or
    `android/app/build.gradle`.
  - Prerun command synthesised from `package.json scripts.start` + the project's lockfile (pnpm >
    yarn > bun > npm).
- Prerun background command (typically Metro / Expo dev server) with `--prerun` and `--prerun-ready`
  CLI flags. The runner asks once before spawning, probes `http://127.0.0.1:8081/status` to avoid
  asking when the bundler is already running, and tears the child down on exit.
- Android port forwarding via `adb reverse tcp:{8081,19000,19001}` so the RN app on the device can
  reach Metro on the Mac.
- iOS physical CoreDevice tunnel is woken with `xcrun devicectl device info details` right before
  each `maestro test`, fixing `"Device X was requested, but it is not connected"`.
- `appleTeamId` config field and `--apple-team-id` flag; also read from the `MAESTRO_APPLE_TEAM_ID`
  env var. Required for physical iPhones because Maestro builds an on-device WebDriver that must be
  code-signed.
- iOS simulator stay-awake via `defaults write com.apple.springboard SBIdleTimerDisabled true`.
- Broken-adb detection — warns on `unauthorized`/`offline` entries that cause Maestro 2.5.x to fail
  every `--device` lookup.
- Czech localisation for the iOS physical Auto-Lock and Metro-LAN hints (settings paths match
  Czech-localised iOS UI).
- Default Android Gradle build hook — when `android/gradlew` exists and no user hook is supplied,
  runs `:app:assembleDebug` once and installs the resulting APK on every Android device in the
  group. No more `pnpm android` per device.
- Expo dev-client deep link — when a `scheme` is detected (or set in config), each Android device
  receives `<scheme>://expo-development-client/?url=…` right before tests, so the dev client
  connects to local Metro instead of showing its launcher.
- `expoScheme` and `devServerUrl` config fields (and matching auto-detection).

### Fixed

- Maestro session-log race when several processes start in the same second (`NoSuchFileException` at
  finalise). Process launches are now staggered by 2 s (configurable via `processStartStaggerMs`).
- Picker render drift caused by raw-mode `\n` not implying carriage return. Now uses `\r\n` line
  endings and `\x1b[NF` (CPL) for redraw, with the correct line count.
- Picker leaves cursor visible on SIGINT — previously it could be left hidden if Ctrl-C hit during
  the raw-mode loop.
- iOS physical filter previously required `tunnelState === 'connected'` and hid usable paired
  devices. Now accepts any paired wired device.
- `process.exit`/`process.env` leftovers all swapped to `Deno.*`.

### Known limitations

- No Node/npm distribution yet. The runtime uses `Deno.Command` and `Deno.stdin.setRaw`, which
  `dnt`'s Deno shim does not cover. A small internal shim layer is needed to translate to
  `node:child_process` / `node:tty`. Use Deno for now.

## [0.1.0] - 2026-05-07

### Added

- Initial release.
- Device discovery for Android USB, Android emulators, iOS simulators, iOS USB.
- Interactive TTY checklist picker with selection memory.
- Configurable build & install hooks per platform with artifact reuse.
- Pre-test prep: wake Android, clear app state, reset iOS sim keychain, disable AutoFill Passwords.
- Parallel Maestro execution with per-device prefixed output.
- iOS sequential or shard-all modes.
- Merged JUnit report.
- Per-run pruning of old output dirs.
- CLI with `--config`, `--skip-build`, `--skip-clear`, `--cwd`, `setup-ios-sim` subcommand.
- Library API via `runMaestroParallel()`.
