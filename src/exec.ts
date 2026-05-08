// Subprocess wrappers used everywhere. `run` captures, `spawnPrefixed`
// streams with a per-line prefix (used for build/install + maestro).

import { spawn } from 'node:child_process';
import { writeFile, open } from 'node:fs/promises';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString('utf8')));
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString('utf8')));
    child.on('error', () => resolve({ code: 127, stdout, stderr }));
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

export async function has(cmd: string): Promise<boolean> {
  return (await run('which', [cmd])).code === 0;
}

/**
 * Spawn a child process and stream every output line prefixed with `prefix`.
 * Returns the child's exit code. `extraEnv` is merged into the parent env.
 */
export function spawnPrefixed(
  cmd: string,
  args: string[],
  cwd: string,
  prefix: string,
  extraEnv: Record<string, string> = {},
): Promise<number> {
  return spawnPrefixedInternal(cmd, args, cwd, prefix, extraEnv, null);
}

/**
 * Like `spawnPrefixed` but also tees every line to a log file. Used for the
 * Maestro processes so each device has a `run.log` next to its JUnit report.
 */
export async function spawnPrefixedTee(
  cmd: string,
  args: string[],
  cwd: string,
  prefix: string,
  logFilePath: string,
  extraEnv: Record<string, string> = {},
): Promise<number> {
  // Truncate the file first so re-runs overwrite cleanly.
  await writeFile(logFilePath, '');
  const handle = await open(logFilePath, 'a');
  try {
    return await spawnPrefixedInternal(cmd, args, cwd, prefix, extraEnv, handle);
  } finally {
    await handle.close();
  }
}

function spawnPrefixedInternal(
  cmd: string,
  args: string[],
  cwd: string,
  prefix: string,
  extraEnv: Record<string, string>,
  // deno-lint-ignore no-explicit-any
  logHandle: any,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv },
    });

    const enc = new TextEncoder();
    let stdoutCarry = '';
    let stderrCarry = '';

    const handleChunk = async (b: Buffer, isStderr: boolean): Promise<void> => {
      const text = (isStderr ? stderrCarry : stdoutCarry) + b.toString('utf8');
      const lines = text.split('\n');
      const carry = lines.pop() ?? '';
      if (isStderr) stderrCarry = carry;
      else stdoutCarry = carry;
      for (const line of lines) {
        process.stdout.write(`${prefix}${line}\n`);
        if (logHandle) await logHandle.write(enc.encode(line + '\n'));
      }
    };

    child.stdout.on('data', (b: Buffer) => void handleChunk(b, false));
    child.stderr.on('data', (b: Buffer) => void handleChunk(b, true));
    child.on('error', () => resolve(127));
    child.on('close', async (code) => {
      // Flush any final partial line.
      for (const carry of [stdoutCarry, stderrCarry]) {
        if (carry) {
          process.stdout.write(prefix + carry + '\n');
          if (logHandle) await logHandle.write(enc.encode(carry + '\n'));
        }
      }
      resolve(code ?? 0);
    });
  });
}
