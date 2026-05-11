// Public library entry. Use this when embedding maestro-parallel in your
// own scripts. For the standard CLI experience, install the package and
// run the bundled `maestro-parallel` bin.

export {
  type BuildContext,
  CONFIG_FILENAMES,
  defineConfig,
  type MaestroParallelConfig,
  type PlatformBuildHooks,
  resolveConfig,
  type ResolvedArtifact,
  type ResolvedConfig,
} from './src/config.ts';

export { discoverDevices } from './src/devices.ts';
export { setupAllBootedSimulators, setupIosSim } from './src/setupIosSim.ts';
export { runMaestroParallel, type RunOptions } from './src/main.ts';
export type {
  Device,
  DeviceKind,
  GroupRunResult,
  JunitCounts,
  Platform,
  RunResult,
} from './src/types.ts';
