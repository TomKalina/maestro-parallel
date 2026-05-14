// Thin wrapper around `@expo/fingerprint` that lets mp skip a build
// group when the project's native fingerprint hasn't changed AND the
// previous artifact still exists. Same library Rock / Expo Build
// Cache use under the hood, so the hash matches their internal caches.

import { join } from '@std/path';
import { createFingerprintAsync } from 'npm:@expo/fingerprint@0.16.7';

import type { Platform } from './types.ts';

interface StoredFingerprint {
  hash: string;
  artifactPath: string;
  timestamp: number;
}

/** Compute the native fingerprint hash for the given platform. */
export async function compute(cwd: string, platform: Platform): Promise<string | null> {
  try {
    const fp = await createFingerprintAsync(cwd, { platforms: [platform] });
    return fp.hash;
  } catch {
    // Project not Expo-shaped, no app config, etc. — skip cache, build.
    return null;
  }
}

function storePath(cwd: string, outputDir: string, group: string): string {
  return join(cwd, outputDir, `.fingerprint-${group}.json`);
}

export async function loadStored(
  cwd: string,
  outputDir: string,
  group: string,
): Promise<StoredFingerprint | null> {
  try {
    const txt = await Deno.readTextFile(storePath(cwd, outputDir, group));
    return JSON.parse(txt) as StoredFingerprint;
  } catch {
    return null;
  }
}

export async function save(
  cwd: string,
  outputDir: string,
  group: string,
  hash: string,
  artifactPath: string,
): Promise<void> {
  const payload: StoredFingerprint = { hash, artifactPath, timestamp: Date.now() };
  await Deno.writeTextFile(storePath(cwd, outputDir, group), JSON.stringify(payload, null, 2));
}

export async function artifactExists(path: string): Promise<boolean> {
  try {
    const s = await Deno.stat(path);
    return s.isFile || s.isDirectory;
  } catch {
    return false;
  }
}
