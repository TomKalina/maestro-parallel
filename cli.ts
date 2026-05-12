#!/usr/bin/env -S deno run -A
// CLI entry. Run as:
//   - JSR : deno run -A jsr:@kaln/maestro-parallel/cli
//   - npm : npx maestro-parallel (after dnt build & publish)

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
      --all             Run on every discovered device (skip the picker).
      --skip-build      Don't build or install; use whatever is already on
                        each device. Useful for iterating on flow YAML
                        against a stable build. By default the runner
                        invokes the auto-detected build hook (Rock > EAS
                        > expo run:*) — fingerprint-cached, so repeat
                        runs land in seconds.
      --skip-clear      Skip clearing app data before tests.
      --cwd <path>      Project root (default: current directory).
      --apple-team-id <ID>
                        10-character Apple Developer Team ID. REQUIRED for
                        physical iOS. Find in Xcode → Settings → Accounts,
                        or set MAESTRO_APPLE_TEAM_ID.
  -h, --help            Show this help.
  -v, --version         Show version.

Examples:
  maestro-parallel                                 # auto-detect, build + run flows
  maestro-parallel --all                           # every device, no picker
  maestro-parallel --skip-build .maestro/login.yaml  # re-run one flow, no rebuild
  maestro-parallel --config ./e2e.config.ts        # explicit config file
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
    boolean: ['all', 'skip-build', 'skip-clear', 'help', 'version'],
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

  // Apple Team ID source priority: CLI flag > config file > env var.
  const teamIdFromCli = args['apple-team-id'] as string | undefined;
  const teamIdFromEnv = Deno.env.get('MAESTRO_APPLE_TEAM_ID');
  const teamId = teamIdFromCli ?? config.appleTeamId ?? teamIdFromEnv;
  if (teamId) {
    config = { ...config, appleTeamId: teamId };
  }

  const code = await runMaestroParallel(config, {
    cwd,
    allDevices: args.all as boolean | undefined,
    skipBuild: args['skip-build'] as boolean | undefined,
    skipClear: args['skip-clear'] as boolean | undefined,
  });
  Deno.exit(code);
}

main().catch((e) => {
  console.error(`${C.red}fatal:${C.reset}`, e);
  Deno.exit(1);
});
