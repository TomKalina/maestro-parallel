---
title: Recipes
---

# Recipes

## Disable Sentry source-map upload during builds

Sentry's "Upload Debug Symbols" Xcode build phase + the Android gradle equivalent both fail when `SENTRY_AUTH_TOKEN` is missing or lacks scope. For local CI / dev runs, skip the upload.

```ts title="maestroparallel.config.ts"
export default {
  buildEnv: { SENTRY_DISABLE_AUTO_UPLOAD: 'true' },
};
```

The var is merged into the build child process automatically.

## Sign physical iOS

mp builds the app via the auto-detected strategy; iOS code signing is handled by Xcode automatic signing or by your custom hook. mp itself only needs the Team ID for Maestro's WebDriver build:

```ts title="maestroparallel.config.ts"
export default {
  appleTeamId: 'YOUR10CHARS',
};
```

One-time setup on the Mac:

1. **Xcode → Settings → Accounts → +** — sign in with an Apple ID that's a member of the target Developer team.
2. Open `ios/<App>.xcworkspace` → target settings → **Signing & Capabilities** → ✓ Automatically manage signing → pick team.
3. Xcode downloads cert into login Keychain and generates the provisioning profile. Verify:

   ```bash
   security find-identity -v -p codesigning
   ```

For CI, use App Store Connect API key (`-allowProvisioningUpdates -authenticationKey*`) — no interactive 2FA.

## Pin build strategy

Project has both `rock.config.mjs` AND `eas.json`? mp picks Rock by default. Override:

```ts title="maestroparallel.config.ts"
export default {
  buildStrategy: 'expo',  // or 'rock' / 'eas' / 'auto'
};
```

## Inject Maestro env

```ts
export default {
  maestroEnv: {
    APP_BASE_URL: 'https://staging.example.com',
    TEST_USER: 'qa+ci@example.com',
  },
};
```

In your flow YAML:

```yaml
- runScript: |
    output.url = `${APP_BASE_URL}/healthcheck`;
```

## Run on every connected device in CI

```bash
maestro-parallel --all --apple-team-id $MAESTRO_APPLE_TEAM_ID
```

`--all` skips the interactive picker (CI has no TTY). Use `--apple-team-id` or set `MAESTRO_APPLE_TEAM_ID` if physical iOS is in scope.
