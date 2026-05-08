// Public configuration API for projects integrating maestro-parallel.
//
// Projects ship a `maestroparallel.config.{ts,js,mjs,cjs,json}` at the repo
// root (or another path passed via `--config`). The CLI auto-loads it.
// Library consumers may also import this module directly and pass a config
// object to `runMaestroParallel()`.

import type { Device, Platform } from './types.js';

export interface BuildContext {
  /** First device picked in this platform group; the build is targeted at it. */
  device: Device;
  /** All devices in this group (the rest will get the artifact reuse-installed). */
  group: Device[];
  /** Project root (process cwd). */
  cwd: string;
  /** Logger that prefixes every line with the device tag + colour. */
  log: (line: string) => void;
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
}

/** Identity helper for type-safe config in `.ts` config files. */
export function defineConfig(config: MaestroParallelConfig): MaestroParallelConfig {
  return config;
}

export type ResolvedConfig =
  & Required<Omit<MaestroParallelConfig, 'build' | 'hooks' | 'maestroEnv' | 'bundleId'>>
  & Pick<MaestroParallelConfig, 'build' | 'hooks' | 'bundleId'>
  & {
    maestroEnv: Record<string, string>;
  };

export function resolveConfig(c: MaestroParallelConfig): ResolvedConfig {
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
