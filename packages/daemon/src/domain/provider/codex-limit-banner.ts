import type { AgentActivityStore } from "../agent-activity-store.js";

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

/**
 * Match the banner's own line form: the ■ marker must lead (after indent).
 * An agent quoting the sentence, or an error line merely containing the
 * words without the marker, never matches.
 */
export function detectCodexLimitBanner(paneContent: string): CodexLimitBanner | null {
  const lines = paneContent.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!BANNER_LINE_RE.test(line)) continue;
    // The reset phrase can wrap onto the following lines in a capture.
    const window = lines.slice(i, i + 3).join("\n");
    const reset = RESET_RE.exec(window);
    return {
      resetText: reset ? reset[1]!.trim() : null,
      evidence: line.trim().slice(0, 200),
    };
  }
  return null;
}

/**
 * Record a banner observation as a typed `at_limit` hook row.
 *
 * Transition-only: an already-reported banner stays until superseding
 * evidence (the seat's next turn or hook event) replaces it — never a timer.
 * A stale row means the evidence aged out, so a still-visible banner reports
 * again. The occupant generation is carried from the live registry read at
 * observation time (same-tick pairing with the pane content); a mismatch at
 * read resolves fail-visible, never false-fresh.
 */
export function recordCodexLimitBanner(deps: {
  store: Pick<AgentActivityStore, "getLatestForNode" | "recordHookEvent">;
  resolveGeneration: (sessionName: string) => string | null;
  sessionName: string;
  banner: CodexLimitBanner;
}): boolean {
  const latest = deps.store.getLatestForNode({ sessionName: deps.sessionName });
  if (latest?.rawEvent === "at_limit" && !latest.stale) return false;
  deps.store.recordHookEvent({
    runtime: "codex",
    sessionName: deps.sessionName,
    hookEvent: "at_limit",
    subtype: deps.banner.resetText,
    generation: deps.resolveGeneration(deps.sessionName),
  });
  return true;
}
