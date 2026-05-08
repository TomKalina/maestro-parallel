// Auto-discover and load `maestroparallel.config.{ts,js,...}` from the
// project root or any explicit path passed via `--config`. TS configs are
// loaded via `jiti` so users don't need a build step for their config.

import { stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { CONFIG_FILENAMES, type MaestroParallelConfig } from './config.js';

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function findConfig(cwd: string): Promise<string | null> {
  for (const name of CONFIG_FILENAMES) {
    const path = join(cwd, name);
    if (await fileExists(path)) return path;
  }
  return null;
}

export async function loadConfig(
  cwd: string,
  explicitPath?: string,
): Promise<{ path: string; config: MaestroParallelConfig } | null> {
  const path = explicitPath
    ? (isAbsolute(explicitPath) ? explicitPath : resolve(cwd, explicitPath))
    : await findConfig(cwd);
  if (!path) return null;

  if (path.endsWith('.json')) {
    const txt = await (await import('node:fs/promises')).readFile(path, 'utf8');
    return { path, config: JSON.parse(txt) as MaestroParallelConfig };
  }

  let mod: Record<string, unknown>;
  if (path.endsWith('.ts') || path.endsWith('.mts')) {
    // jiti transpiles TS for Node without a build step.
    const { createJiti } = await import('jiti');
    const jiti = createJiti(import.meta.url, { interopDefault: true });
    mod = await jiti.import(path) as Record<string, unknown>;
  } else {
    mod = await import(path) as Record<string, unknown>;
  }
  const config = (mod.default ?? mod.config) as MaestroParallelConfig | undefined;
  if (!config) {
    throw new Error(
      `${path}: config file must export a default config (export default defineConfig({...}))`,
    );
  }
  return { path, config };
}
