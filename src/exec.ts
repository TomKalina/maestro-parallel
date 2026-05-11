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
  } catch {
    return { code: 127, stdout: '', stderr: '' };
  }
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
  await Deno.writeTextFile(logFilePath, '');
  const file = await Deno.open(logFilePath, { append: true });
  try {
    return await spawnPrefixedInternal(cmd, args, cwd, prefix, extraEnv, file);
  } finally {
    file.close();
  }
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
