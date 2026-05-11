// Build mode: how the app gets onto devices before flows run.
//
//   release — a real production-style artifact (release variant / Release
//             config / EAS profile). The JS bundle is baked in. This is
//             the only supported build mode: dev / dev-client builds are
//             structurally flaky for E2E (dev-launcher picker, dev-menu
//             onboarding overlay, Fast Refresh races, adb reverse decay,
//             Metro disconnects) and maestro-parallel does not bother
//             working around them — use a release build instead.
//   skip    — assume the app is already installed; don't build or install
//             anything. Use when you've just installed an artifact by
//             hand and want to re-run flows against it.

import { C, log } from './ui.ts';

export type BuildMode = 'release' | 'skip';

/**
 * Ask the user whether to build a release artifact or skip and use the
 * app already installed on each device. Non-TTY callers (CI) get the
 * `release` default without prompting.
 */
export function promptBuildMode(): BuildMode {
  if (!Deno.stdin.isTerminal()) {
    log(`${C.dim}non-TTY: defaulting to release build${C.reset}`);
    return 'release';
  }
  const ans = prompt(
    `${C.bold}Build a release artifact now?${C.reset} ${C.dim}[Y/n — n skips build, uses app already on each device]${C.reset}`,
  )?.trim().toLowerCase();
  if (ans === 'n' || ans === 'no' || ans === 's' || ans === 'skip') return 'skip';
  return 'release';
}
