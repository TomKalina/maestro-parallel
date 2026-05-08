#!/usr/bin/env node
// CLI entry — run as `maestro-parallel` after `npm i -D maestro-parallel`
// (or globally via `npm i -g`).
//
// Usage patterns:
//   maestro-parallel                      # auto-detect .maestro/ flows
//   maestro-parallel ./e2e/login.yaml     # explicit flow path
//   maestro-parallel --config ./mp.config.ts
//   maestro-parallel setup-ios-sim        # disable AutoFill on every booted sim

import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { defineConfig, type MaestroParallelConfig } from './src/config.js';
import { loadConfig } from './src/loadConfig.js';
import { runMaestroParallel } from './src/main.js';
import { setupAllBootedSimulators } from './src/setupIosSim.js';
import { C, fatal, log } from './src/ui.js';

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
      --skip-build      Skip build & install. Assumes the app is installed.
      --skip-clear      Skip clearing app data before tests.
      --cwd <path>      Project root (default: current directory).
  -h, --help            Show this help.
  -v, --version         Show version.

Examples:
  # Zero-config: just run flows from .maestro/, no build, no clear
  maestro-parallel

  # Run a specific flow file
  maestro-parallel .maestro/login_flow.yaml

  # With config (build hooks, bundleId for clearing app data, env vars)
  maestro-parallel --config ./e2e.config.ts
`;

const VERSION = '0.1.0';

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const { values: args, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      config: { type: 'string', short: 'c' },
      cwd: { type: 'string' },
      all: { type: 'boolean' },
      'skip-build': { type: 'boolean' },
      'skip-clear': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
    allowPositionals: true,
  });

  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.version) {
    console.log(VERSION);
    return;
  }

  if (positionals[0] === 'setup-ios-sim') {
    await setupAllBootedSimulators();
    return;
  }

  const cwd = args.cwd ? resolve(args.cwd) : process.cwd();
  const flowsArg = positionals[0];

  const loaded = await loadConfig(cwd, args.config);
  let config: MaestroParallelConfig;

  if (loaded) {
    log(`${C.dim}config:${C.reset} ${loaded.path}`);
    config = loaded.config;
  } else if (args.config) {
    return fatal(`Config file not found: ${args.config}`);
  } else {
    // Zero-config mode. Use sane defaults — flowsArg or .maestro/.
    config = defineConfig({});
    log(
      `${C.dim}no config file found; running with defaults (skip-build/skip-clear implied)${C.reset}`,
    );
  }

  if (flowsArg) {
    const abs = resolve(cwd, flowsArg);
    if (!(await pathExists(abs))) {
      return fatal(`Flows path does not exist: ${flowsArg}`);
    }
    config = { ...config, flowsDir: flowsArg };
  }

  // Without a config or with no build hooks, build/clear are silently skipped
  // by main.ts; the explicit flags here are for users who DO have a config
  // but want to override on the fly.
  const code = await runMaestroParallel(config, {
    cwd,
    allDevices: args.all,
    skipBuild: args['skip-build'],
    skipClear: args['skip-clear'],
  });
  process.exit(code);
}

main().catch((e) => {
  console.error(`${C.red}fatal:${C.reset}`, e);
  process.exit(1);
});
