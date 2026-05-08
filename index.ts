// Public library entry. Use this when embedding maestro-parallel in your
// own scripts. For the standard CLI experience, install the package and
// run the bundled `maestro-parallel` bin.

export {
  type BuildContext,
  CONFIG_FILENAMES,
  defineConfig,
  type MaestroParallelConfig,
  type PlatformBuildHooks,
  type ResolvedArtifact,
  type ResolvedConfig,
  resolveConfig,
} from './src/config.js';

export { discoverDevices } from './src/devices.js';
export { setupAllBootedSimulators, setupIosSim } from './src/setupIosSim.js';
export { runMaestroParallel, type RunOptions } from './src/main.js';
export type {
  Device,
  DeviceKind,
  GroupRunResult,
  JunitCounts,
  Platform,
  RunResult,
} from './src/types.js';
