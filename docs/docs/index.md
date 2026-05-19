---
slug: /
title: Overview
---

# maestro-parallel

Run Maestro flows on every connected iOS simulator, iOS device and Android device in parallel — with a single command.

```bash
maestro-parallel
```

## What it does

1. **Discovers** every booted iOS simulator, paired iOS device, and `adb`-attached Android.
2. **Builds release artifacts** per platform group using auto-detected strategy (Rock → EAS local → `expo run:*`).
3. **Reuse-installs** the same `.apk` / `.app` on every additional device in the group — one build, many installs.
4. **Foregrounds** the app on each device (`simctl launch`, `adb monkey`, `devicectl launch`).
5. **Runs Maestro** in parallel (Android: parallel processes; iOS: sequential by default; opt-in `iosShardAll` for `--shard-all`).
6. **Merges JUnit** reports and prints a per-device summary.

## Why

Maestro itself can target only one device per process. Running 5 devices means launching 5 Maestro CLIs by hand, building the app 5 times, copy-pasting commands, juggling logs.

`maestro-parallel` does the orchestration so you don't.

## Status

**Alpha.** Tested daily against real Expo projects (RN 0.81 + Expo 54). API may break before 1.0 — pin a version if you depend on stability.

## Source

[github.com/TomKalina/maestro-parallel](https://github.com/TomKalina/maestro-parallel) — Apache-2.0.
