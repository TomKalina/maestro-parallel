// Subprocess wrappers used everywhere. `run` captures, `spawnPrefixed`
// streams with a per-line prefix (used for build/install + maestro).

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function run(cmd: string, args: string[]): Promise<RunResult> {
  try {
    const { code, stdout, stderr } = await new Deno.Command(cmd, {
      args,
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    return {
      code,
      stdout: new TextDecoder().decode(stdout),
      stderr: new TextDecoder().decode(stderr),
    };
  } catch (e) {
    return { code: 127, stdout: '', stderr: (e as Error).message };
  }
}

export async function has(cmd: string): Promise<boolean> {
  return (await run('which', [cmd])).code === 0;
}

/**
 * Spawn a child process and stream every output line prefixed with `prefix`.
 * Returns the child's exit code. `extraEnv` is merged into the parent env.
 */
export async function spawnPrefixed(
  cmd: string,
  args: string[],
  cwd: string,
  prefix: string,
  extraEnv: Record<string, string> = {},
): Promise<number> {
  const child = new Deno.Command(cmd, {
    args,
    cwd,
    stdout: 'piped',
    stderr: 'piped',
    env: { ...Deno.env.toObject(), ...extraEnv },
  }).spawn();

  const enc = new TextEncoder();
  const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const dec = new TextDecoder();
    let carry = '';
    for await (const chunk of stream) {
      const text = carry + dec.decode(chunk);
      const lines = text.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) {
        await Deno.stdout.write(enc.encode(`${prefix}${line}\n`));
      }
    }
    if (carry) await Deno.stdout.write(enc.encode(prefix + carry + '\n'));
  };

  const [, , status] = await Promise.all([pump(child.stdout), pump(child.stderr), child.status]);
  return status.code;
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
  const logFile = await Deno.open(logFilePath, { create: true, write: true, truncate: true });
  try {
    const child = new Deno.Command(cmd, {
      args,
      cwd,
      stdout: 'piped',
      stderr: 'piped',
      env: { ...Deno.env.toObject(), ...extraEnv },
    }).spawn();

    const enc = new TextEncoder();
    const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const dec = new TextDecoder();
      let carry = '';
      for await (const chunk of stream) {
        const text = carry + dec.decode(chunk);
        const lines = text.split('\n');
        carry = lines.pop() ?? '';
        for (const line of lines) {
          await Deno.stdout.write(enc.encode(`${prefix}${line}\n`));
          await logFile.write(enc.encode(line + '\n'));
        }
      }
      if (carry) {
        await Deno.stdout.write(enc.encode(prefix + carry + '\n'));
        await logFile.write(enc.encode(carry + '\n'));
      }
    };

    const [, , status] = await Promise.all([pump(child.stdout), pump(child.stderr), child.status]);
    return status.code;
  } finally {
    logFile.close();
  }
}
