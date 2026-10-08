import { describe, it, expect, vi } from "vitest";
import {
  detectCodexLimitBanner,
  recordCodexLimitBanner,
} from "../src/domain/provider/codex-limit-banner.js";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { attachAgentActivity } from "../src/domain/node-inventory.js";
import type { AgentActivity } from "../src/domain/types.js";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";

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

  it("ignores a banner with a newer user message and reply below it", () => {
    const pane = [
      "■ You've hit your usage limit. try again at 4:14 AM.",
      "",
      "❯ please continue with the task",
      "Done, I continued and finished the remaining work.",
      "› Ask Codex to do anything",
    ].join("\n");
    expect(detectCodexLimitBanner(pane)).toBeNull();
  });

  it("ignores a banner inside a fenced block the agent printed", () => {
    const pane = [
      "here is what the error looked like:",
      "```",
      "■ You've hit your usage limit. try again at 4:14 AM.",
      "```",
      "› Ask Codex to do anything",
    ].join("\n");
    expect(detectCodexLimitBanner(pane)).toBeNull();
  });

  it("still detects a new banner printed at the bottom after recovery", () => {
    const pane = [
      "■ You've hit your usage limit. try again at 4:14 AM.",
      "",
      "❯ please continue with the task",
      "Done, I continued and finished the remaining work.",
      "■ You've hit your usage limit. try again at 6:02 AM.",
      "› Ask Codex to do anything",
    ].join("\n");
    expect(detectCodexLimitBanner(pane)).toMatchObject({ resetText: "6:02 AM" });
  });

  it("accepts input area and footer below a current banner", () => {
    const pane = [
      "■ You've hit your usage limit. try again at 4:14 AM.",
      "",
      "› Ask Codex to do anything",
      "gpt-5.1-codex-max · Context [12%]",
    ].join("\n");
    expect(detectCodexLimitBanner(pane)).toMatchObject({ resetText: "4:14 AM" });
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
    state: "needs_input",
    reason: "usage_limit",
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

const T0 = new Date("2026-10-07T00:00:00.000Z");

describe("recordCodexLimitBanner", () => {
  it("records a typed at_limit row with the carried generation", () => {
    const store = fakeStore(null);
    const recorded = recordCodexLimitBanner({
      store,
      resolveGeneration: () => "gen-1",
      sessionName: "dev@rig",
      banner: { resetText: "4:14 AM", evidence: "■ ..." },
      now: () => T0,
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

  it("skips a still-fresh report (no per-second event spam)", () => {
    const store = fakeStore(hookRow({ eventAt: "2026-10-06T23:59:00.000Z" }));
    const recorded = recordCodexLimitBanner({
      store,
      resolveGeneration: () => "gen-1",
      sessionName: "dev@rig",
      banner: { resetText: "4:14 AM", evidence: "■ ..." },
      now: () => T0,
    });
    expect(recorded).toBe(false);
    expect(store.recordHookEvent).not.toHaveBeenCalled();
  });

  it("reports again once the report ages out while the banner persists", () => {
    const store = fakeStore(hookRow({ eventAt: "2026-10-06T23:50:00.000Z", stale: true }));
    const recorded = recordCodexLimitBanner({
      store,
      resolveGeneration: () => "gen-1",
      sessionName: "dev@rig",
      banner: { resetText: "4:14 AM", evidence: "■ ..." },
      now: () => T0,
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
      now: () => T0,
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

describe("codex-limit-banner — store mapping and seat status", () => {
  const NOW = new Date("2026-10-07T00:00:00.000Z");

  function seedCodexSeat(db: Database.Database) {
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev.qa", { runtime: "codex" });
    const session = sessionRegistry.registerSession(node.id, "dev-qa@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-qa@test-rig", attachmentType: "tmux" });
    return { sessionName: "dev-qa@test-rig" as string };
  }

  function entries(sessionName: string) {
    return [{
      canonicalSessionName: sessionName,
      runtime: "codex",
      attachmentType: "tmux",
      logicalId: "dev.qa",
    }] as never;
  }

  it("maps a recorded at_limit row to needs_input/usage_limit, not idle", async () => {
    const db = createFullTestDb();
    try {
      const { sessionName } = seedCodexSeat(db);
      const store = new AgentActivityStore({ db, eventBus: new EventBus(db), now: () => NOW });
      const recorded = store.recordHookEvent({
        runtime: "codex",
        sessionName,
        hookEvent: "at_limit",
        subtype: "try again at 4:14 AM",
        occurredAt: "2026-10-06T23:59:00.000Z",
      });
      expect(recorded.ok).toBe(true);

      const out = (await attachAgentActivity(entries(sessionName), {
        tmuxAdapter: { capturePaneContent: async () => BANNER } as never,
        activityStore: store,
        now: NOW,
      } as never)) as Array<{ agentActivity: AgentActivity }>;
      expect(out[0]!.agentActivity.state).toBe("needs_input");
      expect(out[0]!.agentActivity.reason).toBe("usage_limit");
    } finally {
      db.close();
    }
  });
});
