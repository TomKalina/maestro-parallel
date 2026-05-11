#!/usr/bin/env -S deno run -A
// CLI entry — run as `maestro-parallel`:
//   - via JSR: `deno run -A jsr:@kaln/maestro-parallel/cli`
//   - via npm: `npx maestro-parallel` (after dnt build & publish)
//
// Usage patterns:
//   maestro-parallel                      # auto-detect .maestro/ flows
//   maestro-parallel ./e2e/login.yaml     # explicit flow path
//   maestro-parallel --config ./mp.config.ts
//   maestro-parallel setup-ios-sim        # disable AutoFill on every booted sim

import { resolve } from '@std/path';
import { parseArgs } from '@std/cli/parse-args';
import { defineConfig, type MaestroParallelConfig } from './src/config.ts';
import { loadConfig } from './src/loadConfig.ts';
import { runMaestroParallel } from './src/main.ts';
import { setupAllBootedSimulators } from './src/setupIosSim.ts';
import { C, fatal, log } from './src/ui.ts';

const HELP = `
maestro-parallel — run Maestro flows on multiple devices in parallel.

Usage:
  maestro-parallel [path]                Run flows from [path] (default: .maestro)
  maestro-parallel setup-ios-sim         Disable AutoFill on every booted sim

Options:
  -c, --config <path>   Path to config file. If omitted, auto-discovers
                        maestroparallel.config.{ts,mts,js,mjs,cjs,json}.
                        With no config and no [path], defaults to .maestro/.
      --all             Run on every discovered device (skip the picker).
      --release         Build a release artifact via the configured build
                        hook, then run flows against it. This is the
                        default whenever a build hook is configured —
                        Rock / EAS fingerprint-cache the build so the
                        repeat-run cost is seconds.
      --skip-build      Don't build or install; use whatever is already
                        on each device. Useful for iterating on flow YAML
                        against a stable build.
      --skip-clear      Skip clearing app data before tests.
      --cwd <path>      Project root (default: current directory).
      --apple-team-id <ID>
                        10-character Apple Developer Team ID. REQUIRED for
                        physical iOS — Maestro builds an on-device WebDriver
                        and must sign it. Find in Xcode → Settings → Accounts.
                        Also read from the MAESTRO_APPLE_TEAM_ID env var.
  -h, --help            Show this help.
  -v, --version         Show version.

Examples:
  # Zero-config: auto-detect build hook (Rock > EAS > expo run:*), build
  # release, run flows from .maestro/
  maestro-parallel

  # CI: build release on every connected device
  maestro-parallel --all

  # Re-run flows against an already-installed build
  maestro-parallel --skip-build .maestro/login_flow.yaml

  # With config (build hooks, bundleId for clearing app data, env vars)
  maestro-parallel --config ./e2e.config.ts
`;

const VERSION = '0.1.0';

async function pathExists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(Deno.args, {
    alias: { c: 'config', h: 'help', v: 'version' },
    string: ['config', 'cwd', 'apple-team-id'],
    boolean: ['all', 'skip-build', 'skip-clear', 'release', 'help', 'version'],
  });

  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.version) {
    console.log(VERSION);
    return;
  }

  const positionals = args._.map(String);

  if (positionals[0] === 'setup-ios-sim') {
    await setupAllBootedSimulators();
    return;
  }

  const cwd = args.cwd ? resolve(args.cwd as string) : Deno.cwd();
  const flowsArg = positionals[0];

  const loaded = await loadConfig(cwd, args.config as string | undefined);
  let config: MaestroParallelConfig;

  if (loaded) {
    log(`${C.dim}config:${C.reset} ${loaded.path}`);
    config = loaded.config;
  } else if (args.config) {
    return fatal(`Config file not found: ${args.config}`);
  } else {
    // Zero-config mode. Use sane defaults — flowsArg or .maestro/. Without
    // a config there are no build hooks, so the build step is skipped
    // (the runner re-checks this and logs accordingly).
    config = defineConfig({});
    log(`${C.dim}no config file found; running with defaults${C.reset}`);
  }

  if (flowsArg) {
    const abs = resolve(cwd, flowsArg);
    if (!(await pathExists(abs))) {
      return fatal(`Flows path does not exist: ${flowsArg}`);
    }
    config = { ...config, flowsDir: flowsArg };
  }

  // Source priority for the Apple Developer Team ID: CLI flag > config file >
  // MAESTRO_APPLE_TEAM_ID env var. Env var is the recommended steady-state
  // setup so the tool Just Works on every iPhone run.
  const teamIdFromCli = args['apple-team-id'] as string | undefined;
  const teamIdFromEnv = Deno.env.get('MAESTRO_APPLE_TEAM_ID');
  const teamId = teamIdFromCli ?? config.appleTeamId ?? teamIdFromEnv;
  if (teamId) {
    config = { ...config, appleTeamId: teamId };
  }

  // Build mode resolution: --skip-build > --release > prompt.
  let buildMode: 'release' | 'skip' | undefined;
  if (args['skip-build']) buildMode = 'skip';
  else if (args.release) buildMode = 'release';

  const code = await runMaestroParallel(config, {
    cwd,
    allDevices: args.all as boolean | undefined,
    skipBuild: args['skip-build'] as boolean | undefined,
    skipClear: args['skip-clear'] as boolean | undefined,
    buildMode,
  });
  Deno.exit(code);
}

main().catch((e) => {
  console.error(`${C.red}fatal:${C.reset}`, e);
  Deno.exit(1);
});
