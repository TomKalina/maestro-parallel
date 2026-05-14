// Auto-discover and load `maestroparallel.config.{ts,js,...}` from the
// project root or any explicit path passed via `--config`. Deno runs TS
// natively, so config files in TypeScript work without a separate loader.

import { isAbsolute, join, resolve, toFileUrl } from '@std/path';
import { CONFIG_FILENAMES, type MaestroParallelConfig } from './config.ts';

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
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

  // Deno can import .ts / .mts / .js / .mjs / .cjs natively. file:// URL is
  // required for absolute filesystem paths in dynamic imports.
  let mod: Record<string, unknown>;
  try {
    mod = await import(toFileUrl(path).href) as Record<string, unknown>;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`Config file failed to load: ${path}\n  ${reason}`);
  }
  const config = (mod.default ?? mod.config) as MaestroParallelConfig | undefined;
  if (!config) {
    throw new Error(
      `${path}: config file must export a default config (export default defineConfig({...}))`,
    );
  }
  return { path, config };
}
