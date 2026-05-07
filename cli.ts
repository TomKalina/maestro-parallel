// CLI entry. Run via `deno run -A jsr:@kaln/maestro-parallel/cli`,
// `deno install`, or a compiled binary.

import { parseArgs } from '@std/cli/parse-args';
import { loadConfig } from './src/loadConfig.ts';
import { runMaestroParallel } from './src/main.ts';
import { setupAllBootedSimulators } from './src/setupIosSim.ts';
import { C, fatal, log } from './src/ui.ts';

const HELP = `
maestro-parallel — run Maestro flows in parallel on multiple local devices.

Usage:
  maestro-parallel [options] [flow ...]
  maestro-parallel setup-ios-sim     # disable AutoFill on every booted sim

Arguments:
  flow                  Specific Maestro flow file(s) or directory(ies) to run.
                        Passed straight to \`maestro test\`. Shell glob
                        expansion works (e.g. .maestro/flows/*.yaml). When
                        omitted, the configured flowsDir is used.

Options:
  -c, --config <path>   Path to config file (default: auto-discover
                        maestroparallel.config.{ts,mts,js,mjs,json})
      --skip-build      Skip build & install. Assumes the app is installed.
      --skip-clear      Skip clearing app data before tests.
      --cwd <path>      Project root (default: current directory).
  -h, --help            Show this help.
  -v, --version         Show version.

Examples:
  # Full suite, interactive device picker
  maestro-parallel

  # Run two specific flows on the picked devices
  maestro-parallel .maestro/flows/login_flow.yaml .maestro/flows/checkout.yaml

  # Glob expansion via the shell
  maestro-parallel .maestro/flows/login_*.yaml

Configuration:
  See https://github.com/TomKalina/maestro-parallel#configuration
`;

const VERSION = '0.2.0';

async function main(): Promise<void> {
  const args = parseArgs(Deno.args, {
    string: ['config', 'cwd'],
    boolean: ['help', 'version', 'skip-build', 'skip-clear'],
    alias: { c: 'config', h: 'help', v: 'version' },
    stopEarly: false,
  });

  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.version) {
    console.log(VERSION);
    return;
  }

  const positional = args._.map((x) => String(x));
  if (positional[0] === 'setup-ios-sim') {
    await setupAllBootedSimulators();
    return;
  }

  const cwd = args.cwd ?? Deno.cwd();
  const loaded = await loadConfig(cwd, args.config);
  if (!loaded) {
    return fatal(
      'No config file found. Create maestroparallel.config.ts in your project root, ' +
        'or pass --config <path>.',
    );
  }

  log(`${C.dim}config:${C.reset} ${loaded.path}`);
  const code = await runMaestroParallel(loaded.config, {
    cwd,
    skipBuild: args['skip-build'],
    skipClear: args['skip-clear'],
    flows: positional,
  });
  Deno.exit(code);
}

if (import.meta.main) {
  await main();
}
