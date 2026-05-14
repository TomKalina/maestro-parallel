---
title: Getting started
---

# Getting started

## Requirements

- macOS (for iOS testing) / Linux / Windows (Android only)
- [Deno](https://deno.com) ≥ 1.45 — `brew install deno`
- [Maestro CLI](https://maestro.mobile.dev) — `curl -fsSL https://get.maestro.mobile.dev | bash`
- For iOS: Xcode + at least one iOS simulator runtime installed
- For Android: `adb` (Android SDK platform-tools)

## Install

```bash
deno install --global --reload --allow-all -n maestro-parallel \
  jsr:@kaln/maestro-parallel/cli
```

Or run without installing:

```bash
deno run -A jsr:@kaln/maestro-parallel/cli
```

## First run

In your Expo / React Native project root:

```bash
# Boot one iOS sim and/or plug an Android device, then:
maestro-parallel
```

`maestro-parallel` will:

1. Detect the build strategy (Rock / EAS / expo run:*).
2. Show an interactive picker if you have more than one device.
3. Build a release artifact, install on every selected device.
4. Run flows from `.maestro/` (or wherever your config points).
5. Print a per-device summary + JUnit at `.maestro/output/parallel-<timestamp>/report.xml`.

## Common flags

```bash
maestro-parallel --all              # skip the picker, run on every device
maestro-parallel --skip-build       # reuse the already-installed app
maestro-parallel --cwd ../other-app # run against a different project
```

See [CLI reference](./cli.md) for the full list.

## Project config

Optional: drop a `maestroparallel.config.ts` at the repo root to pin build strategy, env vars, Maestro env, Apple Team ID, and more. See [Configuration](./configuration.md).
