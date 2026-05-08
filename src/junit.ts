// Merge per-device JUnit reports into a single rolled-up document and
// print a per-device summary table at the end.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JunitCounts, RunResult } from './types.js';
import { C, log } from './ui.js';

export async function mergeJunit(results: RunResult[], outBase: string): Promise<string | null> {
  const xmls: string[] = [];
  for (const r of results) {
    try {
      xmls.push(await readFile(join(r.outDir, 'report.xml'), 'utf8'));
    } catch { /* ignore */ }
  }
  if (xmls.length === 0) return null;
  const inner = xmls.map((x) =>
    x
      .replace(/<\?xml[^?]*\?>\s*/, '')
      .replace(/^\s*<testsuites[^>]*>/, '')
      .replace(/<\/testsuites>\s*$/, '')
      .trim()
  ).join('\n');
  const path = join(outBase, 'report.xml');
  await writeFile(
    path,
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="maestro-parallel">\n${inner}\n</testsuites>\n`,
  );
  return path;
}

export function parseCounts(xml: string): JunitCounts {
  const sum = (re: RegExp): number =>
    [...xml.matchAll(re)].reduce((s, m) => s + Number(m[1] ?? 0), 0);
  return {
    tests: sum(/<testsuite\b[^>]*\btests="(\d+)"/g),
    failures: sum(/<testsuite\b[^>]*\bfailures="(\d+)"/g),
    errors: sum(/<testsuite\b[^>]*\berrors="(\d+)"/g),
    skipped: sum(/<testsuite\b[^>]*\bskipped="(\d+)"/g),
  };
}

export async function summarize(
  results: RunResult[],
  outBase: string,
  mergedPath: string | null,
): Promise<void> {
  log('');
  log(`${C.bold}Summary${C.reset}`);
  for (const r of results) {
    let counts: JunitCounts | null = null;
    try {
      counts = parseCounts(await readFile(join(r.outDir, 'report.xml'), 'utf8'));
    } catch { /* ignore */ }
    const ok = r.exitCode === 0;
    const tally = counts
      ? `  ${counts.tests} tests, ${C.red}${counts.failures} fail${C.reset}, ${C.yellow}${counts.errors} err${C.reset}, ${C.dim}${counts.skipped} skip${C.reset}`
      : '';
    const mark = ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
    log(
      `  ${mark} ${C.bold}${r.device.platform}${C.reset} ${r.device.name} ${C.gray}${r.device.id}${C.reset}${tally}`,
    );
    log(`     ${C.dim}log:${C.reset} ${join(r.outDir, 'run.log')}`);
  }
  log('');
  log(`  ${C.dim}output dir:${C.reset} ${outBase}`);
  if (mergedPath) log(`  ${C.dim}merged junit:${C.reset} ${mergedPath}`);
}
