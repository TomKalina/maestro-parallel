---
title: Troubleshooting
---

# Troubleshooting

## `xcodebuild: error: Unable to find a destination matching the provided destination specifier`

Xcode is newer than the installed iOS simulator runtime — e.g. Xcode 26.5 but only iOS 26.4 sim installed.

```bash
xcodebuild -downloadPlatform iOS
# or: Xcode → Settings → Components → install the missing runtime
```

mp's pre-flight surfaces this with an actionable hint before the build even starts.

## `error: unable to attach DB: ... build.db: database is locked`

A previous `expo run:*` / `xcodebuild` zombie is holding the DerivedData lock.

```bash
ps -A | grep -iE 'xcodebuild|expo run'
kill <pid>
```

## `error: sentry-cli — API request failed: You do not have permission to perform this action`

Sentry source-map upload phase has an invalid / unscoped token. Skip it for local builds:

```ts title="maestroparallel.config.ts"
export default {
  buildEnv: { SENTRY_DISABLE_AUTO_UPLOAD: 'true' },
};
```

## `Fastlane is not available — spawn fastlane ENOENT`

EAS local builds shell out to fastlane. Install it:

```bash
brew install fastlane
```

Or pin a different `buildStrategy` that doesn't need fastlane:

```ts
export default { buildStrategy: 'expo' };
```

## `RockError: Android project not found`

Expo project hasn't been prebuilt — `android/` directory missing.

```bash
npx expo prebuild --platform android
```

mp's pre-flight detects this and prints the hint up front.

## `7/7 Flows Failed — Element not found`

The installed APK / `.app` is stale and doesn't contain the testIDs the flows reference. mp's `clearAppState` wipes app data, but it doesn't reinstall a fresh binary — it relies on the build artifact. If the build hook returned `null`, mp falls back to the previously-installed app, which may be old.

Check the build phase ran successfully. Logs are in `.maestro/output/parallel-<timestamp>/<device>/run.log`.

## Where is the raw Maestro output?

The terminal shows an in-place checklist; under the Maestro step each device gets one row with a live tally (`N ✓  M ✗`) and the currently running flow. Per-device Maestro stdout/stderr is captured into `.maestro/output/parallel-<timestamp>/<platform>-<name>-<udid8>/run.log`. Build phase output goes to `<outBase>/build-<group>.log`. Tail those when you need to dig into a single failure.

When piped (`| tee`, `> file`), the checklist degrades to forward-only lines — every state change becomes one line — so CI logs stay readable.

## Maestro CLI hangs in shutdown (`NoSuchFileException: ~/Library/Logs/maestro/<timestamp>`)

Two Maestro processes started in the same wall-clock second; the first one to finalize zips and deletes the shared log dir, the second one trips a race in `DebugLogStore.finalizeRun`. Increase `processStartStaggerMs`:

```ts title="maestroparallel.config.ts"
export default {
  processStartStaggerMs: 3000,
};
```

If it still hangs, kill the zombie:

```bash
pgrep -f maestro.cli.AppKt | xargs kill
```

## `No code signing certificates are available to use` (physical iOS)

Mac's Keychain has no Apple Development cert for the team.

1. Xcode → Settings → Accounts → sign in with an Apple ID in the target team.
2. Open the workspace → target → Signing & Capabilities → ✓ Automatically manage signing.
3. Xcode generates the cert and provisioning profile.

Verify:

```bash
security find-identity -v -p codesigning
```

## `adb has N non-ready device(s): X (unauthorized)`

The phone hasn't accepted the USB-debug prompt. Plug it back in, watch the screen, tap **Allow**. Then:

```bash
adb -s <serial> reconnect
```

Maestro 2.5.x fails on every device when adb has any unauthorized entry, not just the broken one — fix it before the run.
