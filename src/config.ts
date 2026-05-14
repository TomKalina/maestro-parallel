// Public configuration API for projects integrating maestro-parallel.
//
// Projects ship a `maestroparallel.config.{ts,js,mjs,cjs,json}` at the repo
// root (or another path passed via `--config`). The CLI auto-loads it.
// Library consumers may also import this module directly and pass a config
// object to `runMaestroParallel()`.

import type { BuildMode } from './buildMode.ts';
import type { Device, Platform } from './types.ts';

export interface BuildContext {
  /** First device picked in this platform group; the build is targeted at it. */
  device: Device;
  /** All devices in this group (the rest will get the artifact reuse-installed). */
  group: Device[];
  /** Project root (process cwd). */
  cwd: string;
  /** Logger that prefixes every line with the device tag + colour. */
  log: (line: string) => void;
  /** Selected build mode. Always `release` when this hook is invoked — `skip` short-circuits earlier. */
  mode: BuildMode;
  /**
   * Absolute path the hook should tee its raw build output to. The default
   * hooks write everything here and let mp render a single spinner line on
   * stdout. Custom hooks may ignore this and stream as before.
   */
  buildLogPath?: string;
  /**
   * Progress channel. When provided, the default hooks bypass their
   * internal clack spinner and report status through this callback
   * instead. mp uses this to feed checklist UI sub-text while the
   * top-level checklist manages the screen.
   */
  report?: (msg: string) => void;
}

export interface ResolvedArtifact {
  /** Absolute path to the built `.app` (iOS) or `.apk` (Android). */
  path: string;
}

export interface PlatformBuildHooks {
  /**
   * Build the app and install it on `ctx.device`. Must return the artifact
   * path so the runner can reuse-install it on the rest of the group.
   * Return `null` if the artifact cannot be located (per-device build will
   * be used instead, slower but still correct).
   */
  buildAndInstallFirst: (ctx: BuildContext) => Promise<ResolvedArtifact | null>;

  /**
   * Optional: install an existing artifact on a non-first device. If omitted,
   * the runner uses the platform default (`adb install -r` / `xcrun simctl install`).
   * Return non-zero exit code on failure.
   */
  installExisting?: (ctx: BuildContext, artifact: ResolvedArtifact) => Promise<number>;
}

export interface MaestroParallelConfig {
  /**
   * App bundle identifier. Optional. When set, the runner clears app data
   * between runs so each flow starts from a clean state. Without it, the
   * clear step is skipped automatically.
   */
  bundleId?: string;

  /** Maestro flows directory or single flow file, relative to cwd. Default `.maestro`. */
  flowsDir?: string;

  /** Output base directory (relative to cwd). Default `.maestro/output`. */
  outputDir?: string;

  /**
   * Number of past `parallel-*` runs to keep in `outputDir`. Older runs are
   * removed automatically to save disk. Default 3.
   */
  keepRuns?: number;

  /**
   * Path to the project's existing Maestro config (relative to cwd). If
   * present, `executionOrder.flowsOrder` is stripped before sharding so
   * `--shard-all` can run. Default `.maestro/config.yaml`.
   */
  maestroConfigPath?: string;

  /**
   * Extra environment variables forwarded to Maestro via `-e KEY=VALUE`.
   * Useful for backend URLs, account IDs, feature flags. The user's own
   * environment overrides these.
   */
  maestroEnv?: Record<string, string>;

  /** Per-platform build/install hooks. Omit a platform to disable it. */
  build?: {
    android?: PlatformBuildHooks;
    ios?: PlatformBuildHooks;
  };

  /** Hooks that run before any Maestro process starts. */
  hooks?: {
    /**
     * Runs after build/install but before clearAppState. Use to apply
     * device-specific tweaks (e.g. iOS sim keychain reset, Android
     * permission grants).
     */
    preTest?: (devices: Device[]) => Promise<void>;
  };

  /**
   * Force iOS to run sequentially (one device at a time). Default true:
   * Maestro 2.5 still races on per-sim XCTestService ports when more than
   * one iOS device is driven concurrently. Flip to false at your own risk.
   */
  iosSequential?: boolean;

  /**
   * For iOS, run a single Maestro process with `--shard-all=N` instead of
   * one process per device. Cannot be combined with `iosSequential`.
   * Default false.
   */
  iosShardAll?: boolean;

  /**
   * 10-character Apple Developer Team ID. REQUIRED for physical iOS devices —
   * Maestro 2.5.x builds its iOS WebDriver against the device and needs a
   * team to code-sign the driver. Without it, runs on a connected iPhone
   * fail with "Apple account team ID must be specified to build drivers".
   * Find it in Xcode → Settings → Accounts → your team (or App Store
   * Connect → Team ID). Ignored for simulators and Android.
   */
  appleTeamId?: string;

  /**
   * Delay (ms) between starting consecutive Maestro processes. Workaround
   * for a Maestro 2.5.x race: the per-process session log directory is
   * timestamped to the second (`~/Library/Logs/maestro/YYYY-MM-DD_HHMMSS`),
   * so two processes that start in the same second collide. The first one
   * to finalize zips and removes the dir; the rest fail with
   * `NoSuchFileException`. Default 2000 ms (> 1 s plus headroom). Set to
   * 0 to disable.
   */
  processStartStaggerMs?: number;

  /**
   * Pre-selected build mode. When set, skips the interactive prompt:
   *   - `release` (recommended): build a real production-style artifact.
   *   - `skip`: don't build or install; assume the app is already on each
   *     device. Equivalent to the legacy `--skip-build` flag.
   *
   * Dev / dev-client builds are intentionally NOT supported — they are
   * structurally flaky for E2E (dev-launcher picker, dev-menu onboarding
   * overlay, Fast Refresh races, Metro disconnects) and the workarounds
   * (preflight flows, adb reverse, deep links) trade one failure mode for
   * another. Build a release artifact instead.
   *
   * CLI flags `--release` / `--skip-build` override this. In a non-TTY
   * environment without any explicit choice, the default is `release`.
   */
  buildMode?: BuildMode;

  /**
   * Force a specific auto-detect build strategy. By default mp picks the
   * first match in priority order: `rock` > `eas` > `expo`. Use this when
   * your project has artifacts of more than one strategy (e.g. both
   * `rock.config.*` AND `eas.json`) and you want to pin which one wins.
   *
   *   - `auto`  (default): rock > eas > expo
   *   - `rock`  : require `rock.config.*`
   *   - `eas`   : require `eas.json` with one of `e2e-test`/`e2e`/`preview`
   *   - `expo`  : require `expo` in package.json + an app config
   *
   * Has no effect when `build.android` / `build.ios` are provided
   * explicitly — those always take precedence over auto-detect.
   */
  buildStrategy?: 'auto' | 'rock' | 'eas' | 'expo';

  /**
   * Extra environment variables forwarded to the auto-detected build
   * command (Rock / EAS / expo run:*). Useful for project-specific knobs
   * that need to be set at build time without polluting the user's shell —
   * e.g. `SENTRY_DISABLE_AUTO_UPLOAD: 'true'` to skip the Sentry source-map
   * upload Xcode build phase. The host environment overrides these.
   *
   * Has no effect on user-defined `build.{android,ios}` hooks — those
   * control their own env when they spawn child processes.
   */
  buildEnv?: Record<string, string>;

  /**
   * Run platform groups (android, ios-sim, ios-usb) concurrently instead
   * of sequentially. Wall time drops to max(group) instead of sum, but
   * RAM/CPU/disk pressure multiplies — three xcodebuild/gradle/Metro
   * pipelines at once can OOM a 16 GB Mac and Pods cache may race. Use
   * only on beefy machines (M-series with ≥32 GB) where you know your
   * project tolerates it. Default false.
   */
  concurrentBuilds?: boolean;
}

/** Identity helper for type-safe config in `.ts` config files. */
export function defineConfig(config: MaestroParallelConfig): MaestroParallelConfig {
  return config;
}

export type ResolvedConfig =
  & Required<
    Omit<
      MaestroParallelConfig,
      | 'build'
      | 'hooks'
      | 'maestroEnv'
      | 'bundleId'
      | 'appleTeamId'
      | 'buildMode'
      | 'buildStrategy'
      | 'buildEnv'
    >
  >
  & Pick<
    MaestroParallelConfig,
    | 'build'
    | 'hooks'
    | 'bundleId'
    | 'appleTeamId'
    | 'buildMode'
    | 'buildStrategy'
    | 'buildEnv'
  >
  & {
    maestroEnv: Record<string, string>;
  };

export function resolveConfig(c: MaestroParallelConfig): ResolvedConfig {
  if (c.iosSequential && c.iosShardAll) {
    throw new Error(
      "Invalid config: 'iosSequential' and 'iosShardAll' are mutually exclusive. shard-all already runs every sim through a single Maestro process; sequential makes no sense alongside it.",
    );
  }
  return {
    bundleId: c.bundleId,
    flowsDir: c.flowsDir ?? '.maestro',
    outputDir: c.outputDir ?? '.maestro/output',
    keepRuns: c.keepRuns ?? 3,
    maestroConfigPath: c.maestroConfigPath ?? '.maestro/config.yaml',
    maestroEnv: c.maestroEnv ?? {},
    build: c.build,
    hooks: c.hooks,
    iosSequential: c.iosSequential ?? true,
    iosShardAll: c.iosShardAll ?? false,
    processStartStaggerMs: c.processStartStaggerMs ?? 2000,
    appleTeamId: c.appleTeamId,
    buildMode: c.buildMode,
    buildStrategy: c.buildStrategy,
    buildEnv: c.buildEnv,
    concurrentBuilds: c.concurrentBuilds ?? false,
  };
}

export const CONFIG_FILENAMES = [
  'maestroparallel.config.ts',
  'maestroparallel.config.mts',
  'maestroparallel.config.js',
  'maestroparallel.config.mjs',
  'maestroparallel.config.cjs',
  'maestroparallel.config.json',
];

export type { Platform };
