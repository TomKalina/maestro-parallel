// Smallest config: only adds clear-app-state between runs. Without this
// the runner already works (just call `maestro-parallel` with no config),
// but app data persists across runs.

import { defineConfig } from 'jsr:@kaln/maestro-parallel/config';

export default defineConfig({
  bundleId: 'com.example.myapp',
});
