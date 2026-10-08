import {
  AGENT_ACTIVITY_FRESHNESS_MS,
  type AgentActivityStore,
} from "../agent-activity-store.js";

/**
 * Codex usage-limit banner detector (#763).
 *
 * The reactive tap only accepts a typed `at_limit` hook row, and no hook
 * producer emits one for Codex — the limit surfaces solely as a pane banner.
 * This module matches that banner and records it, so `rig provider signals`
 * and seat status report what the seat itself shows.
 */
export interface CodexLimitBanner {
  /** The "try again at …" text exactly as observed, or null when absent. */
  resetText: string | null;
  /** The banner line, truncated — audit trail for the verdict. */
  evidence: string;
}

const BANNER_LINE_RE = /^\s*■ You've hit your usage limit\b/;
const RESET_RE = /try again at ([^.!\n]+)/i;

// Fenced code blocks: banner-shaped text an agent printed is quoted content,
// not the seat's own state.
const FENCE_RE = /^\s*```/;

// Trailing content that may sit below a genuine banner without displacing it:
// blank lines, the empty composer, and the model/context footer. Anything
// else (a user message, a reply, agent output) means the banner is no longer
// the most recent content and must not report.
const TRAILING_OK_RES = [
  /^\s*$/,
  /^[❯›]\s*$/,
  /^›\s+Ask Codex to do anything\s*$/,
  /gpt-\S+ · Context \[/,
];

/**
 * Match the banner's own line form: the ■ marker must lead (after indent).
 * An agent quoting the sentence, or an error line merely containing the
 * words without the marker, never matches. A match inside a fenced code
 * block is quoted agent output, not seat state. And the banner must still be
 * the most recent content: anything below it other than the empty composer
 * or footer (a user message, a reply, further output) means a recovered seat
 * whose old banner merely scrolled into view — Codex prints a new banner at
 * the bottom when the limit hits again, so that is still detected.
 */
export function detectCodexLimitBanner(paneContent: string): CodexLimitBanner | null {
  const lines = paneContent.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!BANNER_LINE_RE.test(line)) continue;
    if (isFenced(lines, i)) continue;
    // The reset phrase can wrap onto the following lines in a capture; the
    // banner block runs through the line carrying it. Everything after the
    // block must be input area or footer — a user message, a reply, or
    // further output below means a recovered seat whose old banner merely
    // scrolled into view. Codex prints a new banner at the bottom when the
    // limit hits again, so that is still detected.
    let blockEnd = i;
    for (let j = i + 1; j <= Math.min(i + 2, lines.length - 1); j++) {
      if (RESET_RE.test(lines.slice(i, j + 1).join("\n"))) {
        blockEnd = j;
        break;
      }
    }
    const window = lines.slice(i, blockEnd + 1).join("\n");
    const reset = RESET_RE.exec(window);
    if (!isMostRecent(lines, blockEnd)) continue;
    return {
      resetText: reset ? reset[1]!.trim() : null,
      evidence: line.trim().slice(0, 200),
    };
  }
  return null;
}

function isFenced(lines: string[], index: number): boolean {
  let fenced = false;
  for (let i = 0; i < index; i++) {
    if (FENCE_RE.test(lines[i]!)) fenced = !fenced;
  }
  return fenced;
}

function isMostRecent(lines: string[], index: number): boolean {
  return lines
    .slice(index + 1)
    .every((line) => TRAILING_OK_RES.some((pattern) => pattern.test(line)));
}

/**
 * Record a banner observation as a typed `at_limit` hook row.
 *
 * Transition-only with a bounded refresh: an already-reported banner stays
 * until superseding evidence (the seat's next turn or hook event) replaces
 * it — never a timer. A still-fresh report is not rewritten every sweep
 * (no per-second event spam overnight); once the report ages past the
 * activity freshness window, a still-visible banner reports again. The
 * occupant generation is carried from the live registry read at observation
 * time (same-tick pairing with the pane content); a mismatch at read
 * resolves fail-visible, never false-fresh.
 */
export function recordCodexLimitBanner(deps: {
  store: Pick<AgentActivityStore, "getLatestForNode" | "recordHookEvent">;
  resolveGeneration: (sessionName: string) => string | null;
  sessionName: string;
  banner: CodexLimitBanner;
  now?: () => Date;
}): boolean {
  const nowFn = deps.now ?? (() => new Date());
  const nowMs = nowFn().getTime();
  const latest = deps.store.getLatestForNode({ sessionName: deps.sessionName });
  if (latest?.rawEvent === "at_limit") {
    const eventMs = latest.eventAt ? Date.parse(latest.eventAt) : Number.NaN;
    if (Number.isFinite(eventMs) && nowMs - eventMs < AGENT_ACTIVITY_FRESHNESS_MS) return false;
  }
  deps.store.recordHookEvent({
    runtime: "codex",
    sessionName: deps.sessionName,
    hookEvent: "at_limit",
    subtype: deps.banner.resetText,
    generation: deps.resolveGeneration(deps.sessionName),
  });
  return true;
}
