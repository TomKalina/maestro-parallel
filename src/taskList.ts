// Stateful checklist renderer driven by `log-update` (Sindre Sorhus).
// We hand log-update a fresh "frame" string every time something
// changes; it handles the cursor manipulation needed to overwrite the
// previous frame in place — wrap-aware, scroll-aware, cursor-aware.
//
// Non-TTY: log-update is a no-op write under the hood; we fall back to
// forward-only logging so CI logs stay readable.

import logUpdate, { createLogUpdate } from 'npm:log-update@7.0.0';
import process from 'node:process';

import { C } from './ui.ts';

export type StepState = 'pending' | 'running' | 'done' | 'failed';

interface SubItem {
  state: StepState;
  text: string;
}

interface StepModel {
  title: string;
  state: StepState;
  finalSuffix?: string;
  subItems: SubItem[];
}

const GLYPH: Record<StepState, string> = {
  pending: `${C.gray}◯${C.reset}`,
  running: `${C.cyan}◐${C.reset}`,
  done: `${C.green}◇${C.reset}`,
  failed: `${C.red}■${C.reset}`,
};

const SUB_GLYPH: Record<StepState, string> = {
  pending: `${C.gray}•${C.reset}`,
  running: `${C.cyan}◐${C.reset}`,
  done: `${C.green}◇${C.reset}`,
  failed: `${C.red}■${C.reset}`,
};

const BAR_GRAY = `${C.gray}│${C.reset}`;
const SPIN_FRAMES = ['◐', '◓', '◑', '◒'];
const SPIN_INTERVAL_MS = 80;

// log-update writes string to stream.write; Deno.stderr.write expects
// typed array. Use node:process.stderr (Node compat layer accepts
// strings) so log-update's internal write() doesn't blow up with
// "expected typed ArrayBufferView".

export class TaskList {
  private steps: StepModel[];
  private tty: boolean;
  private spinFrame = 0;
  private spinTimer: number | null = null;
  /** Last time we called updater() — throttle redraws to avoid drowning
   *  log-update in 100s of writes/sec from rapid gradle task output. */
  private lastRenderAt = 0;
  private pendingRender: number | null = null;
  private readonly minRenderGapMs = 50;
  /** Per-instance updater. A shared module-level instance would carry
   *  stale internal line-count across library re-invocations. */
  private updater: (text: string) => void;

  constructor(titles: string[]) {
    this.steps = titles.map((t) => ({ title: t, state: 'pending', subItems: [] }));
    this.tty = Deno.stderr.isTerminal();
    this.updater = createLogUpdate(process.stderr, { showCursor: false });
  }

  /** Initial render — call once before any state changes. */
  render(): void {
    if (this.tty) this.refresh();
    else this.steps.forEach((s, i) => console.error(this.formatStepLine(s, i)));
  }

  setTitle(idx: number, title: string): void {
    this.steps[idx]!.title = title;
    this.tickOrEmit(idx);
  }

  start(idx: number): void {
    this.steps[idx]!.state = 'running';
    if (this.tty) {
      if (this.spinTimer === null) {
        this.spinTimer = setInterval(() => this.tick(), SPIN_INTERVAL_MS);
        Deno.unrefTimer(this.spinTimer);
      }
      this.refresh();
    } else {
      console.error(this.formatStepLine(this.steps[idx]!, idx));
    }
  }

  sub(idx: number, text: string, state: StepState = 'done'): void {
    this.steps[idx]!.subItems.push({ state, text });
    this.tickOrEmit(idx, `   ${SUB_GLYPH[state]}  ${text}`);
  }

  setSub(stepIdx: number, subIdx: number, text: string, state: StepState): void {
    const items = this.steps[stepIdx]!.subItems;
    while (items.length <= subIdx) items.push({ state: 'pending', text: '' });
    items[subIdx] = { state, text };
    this.tickOrEmit(stepIdx, `   ${SUB_GLYPH[state]}  ${text}`);
  }

  message(idx: number, text: string): void {
    const items = this.steps[idx]!.subItems;
    const last = items[items.length - 1];
    if (last && last.state === 'running') last.text = text;
    else items.push({ state: 'running', text });
    this.tickOrEmit(idx, `   ${SUB_GLYPH.running}  ${text}`);
  }

  done(idx: number, suffix?: string): void {
    this.finish(idx, 'done', suffix);
  }

  fail(idx: number, suffix?: string): void {
    this.finish(idx, 'failed', suffix);
  }

  /** Stop the spinner, freeze the final frame as plain output. */
  close(): void {
    if (this.spinTimer !== null) {
      clearInterval(this.spinTimer);
      this.spinTimer = null;
    }
    if (this.tty) {
      this.flush();
      // log-update top-level `done` finalises any updater; we use the
      // creator-bound instance so we call its `.done` method.
      logUpdate.done();
    }
  }

  // -------------------------------------------------------------------------

  private finish(idx: number, state: 'done' | 'failed', suffix?: string): void {
    this.steps[idx]!.state = state;
    this.steps[idx]!.finalSuffix = suffix;
    for (const s of this.steps[idx]!.subItems) {
      if (s.state === 'running') s.state = state;
    }
    this.tickOrEmit(idx);
  }

  private tickOrEmit(idx: number, fallbackLine?: string): void {
    if (this.tty) this.refresh();
    else if (fallbackLine !== undefined) console.error(fallbackLine);
    else console.error(this.formatStepLine(this.steps[idx]!, idx));
  }

  private tick(): void {
    this.spinFrame = (this.spinFrame + 1) % SPIN_FRAMES.length;
    if (this.tty) this.refresh();
  }

  private spinGlyph(): string {
    return `${C.cyan}${SPIN_FRAMES[this.spinFrame]!}${C.reset}`;
  }

  private formatStepLine(s: StepModel, _idx: number): string {
    const glyph = this.tty && s.state === 'running' ? this.spinGlyph() : GLYPH[s.state];
    let title: string;
    if (s.state === 'pending') title = `${C.dim}${s.title}${C.reset}`;
    else if (s.state === 'running') title = `${C.bold}${s.title}${C.reset}`;
    else title = s.title;
    const suffix = s.finalSuffix ? ` ${C.dim}${s.finalSuffix}${C.reset}` : '';
    return `${glyph}  ${title}${suffix}`;
  }

  private renderFrame(): string {
    const lines: string[] = [];
    for (let i = 0; i < this.steps.length; i++) {
      const s = this.steps[i]!;
      lines.push(this.formatStepLine(s, i));
      const showSubs = s.state === 'running' || s.state === 'failed';
      if (showSubs) {
        for (const sub of s.subItems) {
          const sg = sub.state === 'running' ? this.spinGlyph() : SUB_GLYPH[sub.state];
          lines.push(`${BAR_GRAY}  ${sg}  ${sub.text}`);
        }
      }
    }
    return lines.join('\n');
  }

  private refresh(): void {
    const now = Date.now();
    const gap = now - this.lastRenderAt;
    if (gap >= this.minRenderGapMs) {
      this.lastRenderAt = now;
      if (this.pendingRender !== null) {
        clearTimeout(this.pendingRender);
        this.pendingRender = null;
      }
      this.updater(this.renderFrame());
    } else if (this.pendingRender === null) {
      // Schedule one redraw at the boundary; subsequent refresh() calls
      // collapse into it.
      this.pendingRender = setTimeout(() => {
        this.pendingRender = null;
        this.lastRenderAt = Date.now();
        this.updater(this.renderFrame());
      }, this.minRenderGapMs - gap);
      Deno.unrefTimer(this.pendingRender);
    }
  }

  /** Force any pending throttled redraw to fire now. Called from close(). */
  private flush(): void {
    if (this.pendingRender !== null) {
      clearTimeout(this.pendingRender);
      this.pendingRender = null;
    }
    if (this.tty) {
      this.updater(this.renderFrame());
      this.lastRenderAt = Date.now();
    }
  }
}
