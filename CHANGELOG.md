# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
