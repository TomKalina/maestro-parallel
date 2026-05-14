// Stateful in-place checklist renderer with clack-style glyphs.
//
// Shows N top-level steps as a static block from the start, redrawing in
// place as each step transitions pending → running → done/failed.
// Sub-bullets live under the currently-running step and are kept after
// failure (for debugging) but collapsed on success (keeps the block tight).
//
// Implementation: keep an in-memory model + count of lines we last wrote.
// On each update emit ANSI cursor-up + erase + redraw of the whole block.
// In non-TTY (CI) the renderer falls back to plain forward-only logging
// so logs stay readable when piped to a file.

import { C } from './ui.ts';

export type StepState = 'pending' | 'running' | 'done' | 'failed';

interface SubItem {
  state: StepState;
  text: string;
}

interface StepModel {
  title: string;
  state: StepState;
  /** Suffix appended after the title in done/failed state (e.g. elapsed). */
  finalSuffix?: string;
  subItems: SubItem[];
}

const GLYPH: Record<StepState, string> = {
  pending: `${C.gray}◯${C.reset}`,
  running: `${C.cyan}◐${C.reset}`, // overwritten by spinGlyph() while ticking
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

const enc = new TextEncoder();

export class TaskList {
  private steps: StepModel[];
  private linesWritten = 0;
  private tty: boolean;
  private spinFrame = 0;
  private spinTimer: number | null = null;

  constructor(titles: string[]) {
    this.steps = titles.map((t) => ({ title: t, state: 'pending', subItems: [] }));
    this.tty = Deno.stderr.isTerminal();
  }

  /** Initial render — call once before any state changes. */
  render(): void {
    if (this.tty) this.redraw();
    else this.steps.forEach((s, i) => this.emit(this.formatStepLine(s, i, /*tty*/ false)));
  }

  /** Mark a step as running and (optionally) start the spinner timer. */
  /** Replace the title (used to embed live state text on the same row). */
  setTitle(idx: number, title: string): void {
    this.steps[idx]!.title = title;
    if (this.tty) this.redraw();
    else this.emit(this.formatStepLine(this.steps[idx]!, idx, false));
  }

  start(idx: number): void {
    this.steps[idx]!.state = 'running';
    if (this.tty) {
      if (this.spinTimer === null) {
        this.spinTimer = setInterval(() => this.tick(), SPIN_INTERVAL_MS);
        // Suppress the Deno op leak from setInterval — we clear it in close().
        Deno.unrefTimer(this.spinTimer);
      }
      this.redraw();
    } else {
      this.emit(`${GLYPH.running}  ${C.bold}${this.steps[idx]!.title}${C.reset}`);
    }
  }

  /** Add a sub-bullet to a step. Mark it `running` to show an active spinner glyph. */
  sub(idx: number, text: string, state: StepState = 'done'): void {
    this.steps[idx]!.subItems.push({ state, text });
    if (this.tty) this.redraw();
    else this.emit(`   ${SUB_GLYPH[state]}  ${text}`);
  }

  /** Update a specific sub-item by its position. Use when each sub
   *  represents a stable thing (e.g. a device) and you want to flip its
   *  state + text without appending duplicates. */
  setSub(stepIdx: number, subIdx: number, text: string, state: StepState): void {
    const items = this.steps[stepIdx]!.subItems;
    while (items.length <= subIdx) items.push({ state: 'pending', text: '' });
    items[subIdx] = { state, text };
    if (this.tty) this.redraw();
    else this.emit(`   ${SUB_GLYPH[state]}  ${text}`);
  }

  /**
   * Update the text (or state) of the most recent sub-item if it's still
   * `running`; otherwise push a new running sub. Used to show live
   * progress without bloating the visible list.
   */
  message(idx: number, text: string): void {
    const items = this.steps[idx]!.subItems;
    const last = items[items.length - 1];
    if (last && last.state === 'running') last.text = text;
    else items.push({ state: 'running', text });
    if (this.tty) this.redraw();
    else this.emit(`   ${SUB_GLYPH.running}  ${text}`);
  }

  done(idx: number, suffix?: string): void {
    this.finish(idx, 'done', suffix);
  }

  fail(idx: number, suffix?: string): void {
    this.finish(idx, 'failed', suffix);
  }

  /** Stop the spinner timer + final redraw. Call once when everything is done. */
  close(): void {
    if (this.spinTimer !== null) {
      clearInterval(this.spinTimer);
      this.spinTimer = null;
    }
    if (this.tty) this.redraw();
  }

  // -------------------------------------------------------------------------

  private finish(idx: number, state: 'done' | 'failed', suffix?: string): void {
    this.steps[idx]!.state = state;
    this.steps[idx]!.finalSuffix = suffix;
    // Collapse any sub-item that was still spinning so the line stops
    // animating once the parent step is over.
    for (const s of this.steps[idx]!.subItems) {
      if (s.state === 'running') s.state = state;
    }
    if (this.tty) this.redraw();
    else this.emit(this.formatStepLine(this.steps[idx]!, idx, /*tty*/ false));
  }

  private tick(): void {
    this.spinFrame = (this.spinFrame + 1) % SPIN_FRAMES.length;
    if (this.tty) this.redraw();
  }

  private spinGlyph(): string {
    return `${C.cyan}${SPIN_FRAMES[this.spinFrame]!}${C.reset}`;
  }

  private formatStepLine(s: StepModel, _idx: number, tty: boolean): string {
    const glyph = tty && s.state === 'running' ? this.spinGlyph() : GLYPH[s.state];
    let title: string;
    if (s.state === 'pending') title = `${C.dim}${s.title}${C.reset}`;
    else if (s.state === 'running') title = `${C.bold}${s.title}${C.reset}`;
    else title = s.title;
    const suffix = s.finalSuffix ? ` ${C.dim}${s.finalSuffix}${C.reset}` : '';
    return `${glyph}  ${title}${suffix}`;
  }

  private redraw(): void {
    if (this.linesWritten > 0) {
      // `\r` goes to column 0 first (some terminals leave the cursor
      // mid-line after our writes), then `\x1b[NA` moves up N rows,
      // then `\x1b[J` clears from there to end of screen. Without the
      // CR, partial overwrite leaves the previous line's right half
      // visible — observed as duplicated names.
      Deno.stderr.writeSync(enc.encode(`\r\x1b[${this.linesWritten}A\x1b[J`));
    }
    this.linesWritten = 0;
    for (let i = 0; i < this.steps.length; i++) {
      const s = this.steps[i]!;
      this.emit(this.formatStepLine(s, i, /*tty*/ true));
      // Show sub-items only while the step is running OR after it failed.
      // Successful steps collapse so the block doesn't grow unbounded.
      const showSubs = s.state === 'running' || s.state === 'failed';
      if (showSubs) {
        for (const sub of s.subItems) {
          const sg = sub.state === 'running' ? this.spinGlyph() : SUB_GLYPH[sub.state];
          this.emit(`${BAR_GRAY}  ${sg}  ${sub.text}`);
        }
      }
    }
  }

  private emit(content: string): void {
    Deno.stderr.writeSync(enc.encode(content + '\n'));
    this.linesWritten++;
  }
}
