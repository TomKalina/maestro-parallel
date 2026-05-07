# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.0] - 2026-05-07

### Added

- CLI accepts positional arguments to run a subset of flows:
  `maestro-parallel .maestro/flows/login.yaml .maestro/flows/checkout.yaml`.
- `RunOptions.flows?: string[]` for the same on the library API.
- `restoreAndroidDevices()` exported helper to revert Android display
  defaults (stayon off, 30 s screen timeout, adaptive sleep on).

### Changed

- `wakeAndroidDevices()` now also bumps `screen_off_timeout` to 30 minutes,
  disables `screen_off_timeout_adaptive`, and runs `wm dismiss-keyguard`.
  Some OEMs override `svc power stayon` mid-suite — these settings make the
  test run robust on stock Pixels and a wider range of vendor ROMs.
- `runMaestroParallel()` always restores Android display defaults in a
  `finally` block, even when the suite fails or the runner crashes.

## [0.1.0] - 2026-05-07

### Added

- Initial release.
- Device discovery for Android USB, Android emulators, iOS simulators, iOS USB.
- Interactive TTY checklist picker with selection memory.
- Configurable build & install hooks per platform with artifact reuse.
- Pre-test prep: wake Android, clear app state, reset iOS sim keychain,
  disable AutoFill Passwords.
- Parallel Maestro execution with per-device prefixed output.
- iOS sequential or shard-all modes.
- Merged JUnit report.
- Per-run pruning of old output dirs.
- CLI with `--config`, `--skip-build`, `--skip-clear`, `--cwd`,
  `setup-ios-sim` subcommand.
- Library API via `runMaestroParallel()`.
