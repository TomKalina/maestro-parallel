// Auto-discover and load `maestroparallel.config.{ts,mts,js,mjs,json}`
// from the project root or any explicit path passed via `--config`.

import { isAbsolute, join, resolve, toFileUrl } from '@std/path';
import { CONFIG_FILENAMES, type MaestroParallelConfig } from './config.ts';

async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await Deno.stat(path);
    return s.isFile;
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
    const txt = await Deno.readTextFile(path);
    return { path, config: JSON.parse(txt) as MaestroParallelConfig };
  }

  // Deno can natively import .ts/.mts/.js/.mjs via dynamic import.
  // toFileUrl is required on Windows to make the path a valid URL.
  const url = toFileUrl(path).href;
  const mod = await import(url) as
    & { default?: MaestroParallelConfig }
    & { config?: MaestroParallelConfig };
  const config = mod.default ?? mod.config;
  if (!config) {
    throw new Error(
      `${path}: config file must export a default config (export default defineConfig({...}))`,
    );
  }
  return { path, config };
}
