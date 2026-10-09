import { describe, expect, it } from "vitest";
import { applyAgentSnapshot, deriveLifecycle, deriveLiveness, newRecord, type SnapshotLike } from "./lifecycle";

const base: SnapshotLike = {
  id: "a1",
  provider: "claude",
  cwd: "/work",
  status: "idle",
  title: "标题",
  model: "opus",
  updatedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2025-12-31T00:00:00.000Z",
};

describe("lifecycle mapping", () => {
  it("derives liveness", () => {
    expect(deriveLiveness({ ...base, archivedAt: "2026-01-02T00:00:00Z" })).toBe("archived");
    expect(deriveLiveness({ ...base, status: "closed" })).toBe("closed");
    expect(deriveLiveness(base)).toBe("live");
  });

  it("derives lifecycle in priority order", () => {
    expect(deriveLifecycle({ ...base, status: "running", pendingPermissions: [{}] })).toBe("waiting_permission");
    expect(deriveLifecycle({ ...base, status: "running" })).toBe("working");
    expect(deriveLifecycle({ ...base, status: "idle", activeTurn: { turnId: "t" } })).toBe("working");
    expect(deriveLifecycle({ ...base, status: "error" })).toBe("error");
    expect(deriveLifecycle(base)).toBe("idle");
    expect(deriveLifecycle({ ...base, status: "initializing" })).toBe("unknown");
  });
});

describe("applyAgentSnapshot", () => {
  it("copies fields and reports changes", () => {
    const record = newRecord({ id: "a1", provider: "claude", cwd: "/work" }, 5);
    const project = {
      projectKey: "pk",
      projectName: "Proj",
      workspaceName: "ws",
      checkout: { currentBranch: "main", worktreeRoot: "/work" },
    };
    expect(applyAgentSnapshot(record, { ...base, attentionReason: "finished" }, project)).toBe(true);
    expect(record).toMatchObject({
      agentTitle: "标题",
      model: "opus",
      projectKey: "pk",
      projectName: "Proj",
      workspaceName: "ws",
      branch: "main",
      worktreeRoot: "/work",
      attentionReason: "finished",
      updatedAt: Date.parse("2026-01-01T00:00:00.000Z"),
      lifecycle: "idle",
      liveness: "live",
    });
    expect(applyAgentSnapshot(record, { ...base, attentionReason: "finished" }, project)).toBe(false);
  });

  it("records the pending permission count and archive time", () => {
    const record = newRecord(base, 5);
    applyAgentSnapshot(record, {
      ...base,
      status: "running",
      pendingPermissions: [{}, {}],
      archivedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(record.pendingPermissionCount).toBe(2);
    expect(record.archivedAt).toBe(Date.parse("2026-02-01T00:00:00.000Z"));
    expect(record.liveness).toBe("archived");
  });
});
