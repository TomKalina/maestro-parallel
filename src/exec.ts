// Subprocess wrappers used everywhere. `run` captures, `spawnPrefixed`
// streams with a per-line prefix (used for build/install + maestro).

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function run(cmd: string, args: string[]): Promise<RunResult> {
  try {
    const out = await new Deno.Command(cmd, {
      args,
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    const dec = new TextDecoder();
    return {
      code: out.code,
      stdout: dec.decode(out.stdout),
      stderr: dec.decode(out.stderr),
    };
  } catch (e) {
    // Most often ENOENT for missing binary; log it so the user can
    // diagnose without diffing strace. `has(cmd)` itself relies on this
    // path returning a non-zero code, so we keep the 127 return shape.
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`\x1b[33mrun(${cmd}) threw: ${msg}\x1b[0m`);
    return { code: 127, stdout: '', stderr: msg };
  }
}

export async function has(cmd: string): Promise<boolean> {
  // Suppress the stderr log from `run` — `has` is the one path where a
  // missing binary is an expected outcome, not a problem.
  try {
    const out = await new Deno.Command('which', {
      args: [cmd],
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    return out.code === 0;
  } catch {
    return false;
  }
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
  await Deno.writeTextFile(logFilePath, '');
  const file = await Deno.open(logFilePath, { append: true });
  try {
    return await spawnPrefixedInternal(cmd, args, cwd, prefix, extraEnv, file);
  } finally {
    file.close();
  }
}

/**
 * Like `spawnPrefixed` but kills the child as soon as a line matching
 * `marker` is observed on stdout or stderr.
 *
 * Use when wrapping a command that does the work we care about
 * synchronously and then keeps running indefinitely (e.g. `expo run:ios`
 * builds + installs + then streams Metro / app logs forever). We watch
 * for a known "done" line, send SIGTERM, and return 0 — the child's
 * eventual exit code is ignored because we triggered the shutdown.
 *
 * If the child exits on its own before the marker is seen, the actual
 * exit code is returned so a real failure isn't silently treated as
 * success.
 */
export async function spawnPrefixedUntilMarker(
  cmd: string,
  args: string[],
  cwd: string,
  prefix: string,
  marker: RegExp,
  extraEnv: Record<string, string> = {},
): Promise<number> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(cmd, {
      args,
      cwd,
      stdin: 'null',
      stdout: 'piped',
      stderr: 'piped',
      env: extraEnv,
    }).spawn();
  } catch {
    return 127;
  }

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let killedOnMarker = false;

  const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    let carry = '';
    for await (const chunk of stream) {
      const text = carry + dec.decode(chunk, { stream: true });
      const lines = text.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) {
        await Deno.stdout.write(enc.encode(`${prefix}${line}\n`));
        if (!killedOnMarker && marker.test(line)) {
          killedOnMarker = true;
          try {
            child.kill('SIGTERM');
          } catch { /* already gone */ }
        }
      }
    }
    if (carry) {
      await Deno.stdout.write(enc.encode(prefix + carry + '\n'));
    }
  };

  // Pumps may keep going after kill while the pipe drains; that's fine,
  // we still await both before returning so logs aren't truncated.
  const [status] = await Promise.all([
    child.status,
    pump(child.stdout).catch(() => {}),
    pump(child.stderr).catch(() => {}),
  ]);
  if (!killedOnMarker) {
    // Child exited on its own — return its real code.
    return status.code;
  }
  // We sent SIGTERM. Treat a clean SIGTERM exit as success (= marker
  // fired, work done). Anything else means the child failed for an
  // unrelated reason AFTER the marker — surface that exit code so the
  // caller doesn't quietly proceed with a broken artifact.
  if (status.signal === 'SIGTERM') return 0;
  return status.code;
}

async function spawnPrefixedInternal(
  cmd: string,
  args: string[],
  cwd: string,
  prefix: string,
  extraEnv: Record<string, string>,
  logFile: Deno.FsFile | null,
): Promise<number> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(cmd, {
      args,
      cwd,
      stdin: 'null',
      stdout: 'piped',
      stderr: 'piped',
      env: extraEnv,
    }).spawn();
  } catch {
    return 127;
  }

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    let carry = '';
    for await (const chunk of stream) {
      const text = carry + dec.decode(chunk, { stream: true });
      const lines = text.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) {
        await Deno.stdout.write(enc.encode(`${prefix}${line}\n`));
        if (logFile) await logFile.write(enc.encode(line + '\n'));
      }
    }
    if (carry) {
      await Deno.stdout.write(enc.encode(prefix + carry + '\n'));
      if (logFile) await logFile.write(enc.encode(carry + '\n'));
    }
  };

  const [{ code }] = await Promise.all([
    child.status,
    pump(child.stdout),
    pump(child.stderr),
  ]);
  return code;
}
