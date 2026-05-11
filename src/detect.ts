// Best-effort autodetection of project defaults so plain `maestro-parallel`
// in a typical RN/Expo project Just Works. Everything here is opportunistic
// — a miss returns null and the caller falls back to the static default.

import { join } from '@std/path';

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await Deno.stat(p)).isFile;
  } catch {
    return false;
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await Deno.stat(p)).isDirectory;
  } catch {
    return false;
  }
}

/**
 * Resolve where Maestro should pick up flows. Convention is `.maestro/flows/`
 * with a sibling `.maestro/config.yaml`; falls back to `.maestro/` for
 * projects that put YAMLs at the top level.
 */
export async function detectFlowsDir(cwd: string): Promise<string> {
  if (await dirExists(join(cwd, '.maestro/flows'))) return '.maestro/flows';
  return '.maestro';
}

/**
 * Look for the app's bundle identifier in the usual places:
 *   1. `app.config.ts` / `app.config.js` (Expo, dynamic config)
 *   2. `app.json` (Expo, static config)
 *   3. `ios/<App>/Info.plist` (bare RN / native)
 *   4. `android/app/build.gradle` (bare RN / native)
 * Returns the first match.
 */
export async function detectBundleId(cwd: string): Promise<string | null> {
  // 1) Expo dynamic config — text-grep is enough; we don't actually evaluate
  // the file (would require running it). Looks for either iOS or Android.
  for (const file of ['app.config.ts', 'app.config.js']) {
    const path = join(cwd, file);
    if (!(await fileExists(path))) continue;
    try {
      const txt = await Deno.readTextFile(path);
      const m = txt.match(
        /bundleIdentifier\s*:\s*['"]([^'"]+)['"]|package\s*:\s*['"]([^'"]+)['"]/,
      );
      const id = m?.[1] ?? m?.[2];
      if (id) return id;
    } catch { /* unreadable, try next */ }
  }

  // 2) Expo static config.
  const appJson = join(cwd, 'app.json');
  if (await fileExists(appJson)) {
    try {
      const parsed = JSON.parse(await Deno.readTextFile(appJson)) as {
        expo?: { ios?: { bundleIdentifier?: string }; android?: { package?: string } };
      };
      const id = parsed.expo?.ios?.bundleIdentifier ?? parsed.expo?.android?.package;
      if (id) return id;
    } catch { /* malformed, skip */ }
  }

  // 3) Bare iOS — Info.plist under any subdir of ios/.
  const iosDir = join(cwd, 'ios');
  if (await dirExists(iosDir)) {
    try {
      for await (const e of Deno.readDir(iosDir)) {
        if (!e.isDirectory) continue;
        const plist = join(iosDir, e.name, 'Info.plist');
        if (!(await fileExists(plist))) continue;
        const txt = await Deno.readTextFile(plist);
        const m = txt.match(
          /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/,
        );
        // PRODUCT_BUNDLE_IDENTIFIER placeholder is the default in Xcode-managed
        // projects; ignore it (would need the .pbxproj to resolve).
        if (m?.[1] && !m[1].includes('$')) return m[1];
      }
    } catch { /* skip */ }
  }

  // 4) Bare Android — applicationId in build.gradle.
  const gradle = join(cwd, 'android/app/build.gradle');
  if (await fileExists(gradle)) {
    try {
      const txt = await Deno.readTextFile(gradle);
      const m = txt.match(/applicationId\s+['"]([^'"]+)['"]/);
      if (m?.[1]) return m[1];
    } catch { /* skip */ }
  }

  return null;
}
