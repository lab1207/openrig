import { describe, it, expect, vi } from "vitest";
import {
  detectCodexLimitBanner,
  recordCodexLimitBanner,
} from "../src/domain/provider/codex-limit-banner.js";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";
import type { AgentActivity } from "../src/domain/types.js";

const BANNER = [
  " long output above",
  "■ You've hit your usage limit. Upgrade to Pro (...), visit",
  "https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 4:14 AM.",
].join("\n");

describe("detectCodexLimitBanner", () => {
  it("matches the banner's own line form and carries the reset text", () => {
    expect(detectCodexLimitBanner(BANNER)).toMatchObject({ resetText: "4:14 AM" });
  });

  it("tolerates leading indent but still requires the marker first", () => {
    expect(detectCodexLimitBanner("   ■ You've hit your usage limit. try again at 4:14 AM.")).toMatchObject({
      resetText: "4:14 AM",
    });
  });

  it("still reports when the reset phrase is absent", () => {
    expect(detectCodexLimitBanner("■ You've hit your usage limit.")).toMatchObject({ resetText: null });
  });

  it("ignores an agent quoting the sentence", () => {
    expect(
      detectCodexLimitBanner("> ■ You've hit your usage limit. try again at 4:14 AM.")
    ).toBeNull();
  });

  it("ignores an error line merely containing the words without the marker", () => {
    expect(
      detectCodexLimitBanner("Error running remote compact task: You've hit your usage limit …")
    ).toBeNull();
  });

  it("ignores prose mentioning the limit without the marker", () => {
    expect(detectCodexLimitBanner("I think you've hit your usage limit, try again later")).toBeNull();
  });

  it("ignores ordinary panes", () => {
    expect(detectCodexLimitBanner("output\n❯ ")).toBeNull();
  });
});

function fakeStore(latest: AgentActivity | null) {
  return {
    getLatestForNode: vi.fn().mockReturnValue(latest),
    recordHookEvent: vi.fn().mockReturnValue({ ok: true }),
  };
}

function hookRow(overrides: Partial<AgentActivity> = {}): AgentActivity {
  return {
    state: "unknown",
    reason: "at_limit",
    evidenceSource: "runtime_hook",
    sampledAt: "2026-10-07T00:00:00.000Z",
    evidence: "try again at 4:14 AM",
    eventAt: "2026-10-07T00:00:00.000Z",
    rawEvent: "at_limit",
    rawSubtype: "try again at 4:14 AM",
    runtime: "codex",
    generation: "gen-1",
    fallback: false,
    stale: false,
    ...overrides,
  };
}

describe("recordCodexLimitBanner", () => {
  it("records a typed at_limit row with the carried generation", () => {
    const store = fakeStore(null);
    const recorded = recordCodexLimitBanner({
      store,
      resolveGeneration: () => "gen-1",
      sessionName: "dev@rig",
      banner: { resetText: "4:14 AM", evidence: "■ ..." },
    });
    expect(recorded).toBe(true);
    expect(store.recordHookEvent).toHaveBeenCalledWith({
      runtime: "codex",
      sessionName: "dev@rig",
      hookEvent: "at_limit",
      subtype: "4:14 AM",
      generation: "gen-1",
    });
  });

  it("skips an already-reported fresh banner (transition-only)", () => {
    const store = fakeStore(hookRow());
    const recorded = recordCodexLimitBanner({
      store,
      resolveGeneration: () => "gen-1",
      sessionName: "dev@rig",
      banner: { resetText: "4:14 AM", evidence: "■ ..." },
    });
    expect(recorded).toBe(false);
    expect(store.recordHookEvent).not.toHaveBeenCalled();
  });

  it("reports again when the row went stale while the banner persists", () => {
    const store = fakeStore(hookRow({ stale: true }));
    const recorded = recordCodexLimitBanner({
      store,
      resolveGeneration: () => "gen-1",
      sessionName: "dev@rig",
      banner: { resetText: "4:14 AM", evidence: "■ ..." },
    });
    expect(recorded).toBe(true);
    expect(store.recordHookEvent).toHaveBeenCalledTimes(1);
  });

  it("reports again once superseding evidence arrives and the banner returns", () => {
    // A Stop row superseded the banner (clearing on evidence); the banner is
    // back, so a fresh typed row is due.
    const store = fakeStore(hookRow({ rawEvent: "Stop", reason: "stop", rawSubtype: null }));
    const recorded = recordCodexLimitBanner({
      store,
      resolveGeneration: () => "gen-1",
      sessionName: "dev@rig",
      banner: { resetText: "5:00 AM", evidence: "■ ..." },
    });
    expect(recorded).toBe(true);
  });
});

describe("SeatStructuralActivityService — Codex limit banner emission", () => {
  it("emits the banner for a Codex seat showing it", async () => {
    const svc = new SeatStructuralActivityService({
      capturePaneContent: async () => BANNER,
    } as never);
    const seen: Array<{ session: string; reset: string | null }> = [];
    svc.attachCodexLimitBanner((sessionName, banner) => {
      seen.push({ session: sessionName, reset: banner.resetText });
    });
    await svc.pollSeat("dev@rig", null, "codex");
    expect(seen).toEqual([{ session: "dev@rig", reset: "4:14 AM" }]);
  });

  it("never emits for other runtimes or banner-free panes", async () => {
    const svc = new SeatStructuralActivityService({
      capturePaneContent: async () => BANNER,
    } as never);
    const seen: unknown[] = [];
    svc.attachCodexLimitBanner((...args: unknown[]) => {
      seen.push(args);
    });
    await svc.pollSeat("dev@rig", null, "claude-code");
    await svc.pollSeat("other@rig", null, null);
    expect(seen).toEqual([]);
  });

  it("works unattached (no emitter, no behavior change)", async () => {
    const svc = new SeatStructuralActivityService({
      capturePaneContent: async () => BANNER,
    } as never);
    await expect(svc.pollSeat("dev@rig", null, "codex")).resolves.not.toBeNull();
  });
});
