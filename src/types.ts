// Shared types used across the parallel-runner pipeline.

export type Platform = 'android' | 'ios';
export type DeviceKind = 'usb' | 'emulator' | 'simulator';

export interface Device {
  platform: Platform;
  kind: DeviceKind;
  /** adb serial (Android) or UDID (iOS). Used for `maestro --device` and platform CLIs. */
  id: string;
  /** Human display name. */
  name: string;
  /**
   * Native build-tool identifier. For Android this is the model with underscores
   * (what `expo run:android --device` expects). For iOS it is the UDID.
   */
  buildTargetId: string;
  os?: string;
  battery?: string;
}

export interface RunResult {
  device: Device;
  exitCode: number;
  outDir: string;
}

export interface GroupRunResult {
  platform: Platform;
  ids: string[];
  exitCode: number;
  outDir: string;
}

export interface JunitCounts {
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
}
