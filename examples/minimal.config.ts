// Smallest possible config: app already installed on devices, just run
// the flows. Useful when you build separately (e.g. CI build artifact)
// and want maestro-parallel only for the run step.

import { defineConfig } from '../mod.ts';

export default defineConfig({
  bundleId: 'com.example.myapp',
});

// Then run with --skip-build:
//   maestro-parallel --skip-build
