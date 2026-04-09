import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import {
  SharedMemory,
  formatSharedMemoryForPrompt,
  formatSharedMemoryForTerminal,
  type SharedMemorySnapshot,
} from "./shared-memory.js";

function createTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gnhf-shared-memory-test-"));
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git commit --allow-empty -m 'init'", { cwd: dir, stdio: "pipe" });
  return dir;
}

describe("SharedMemory", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = createTempGitRepo();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("creates the shared memory directory on construction", () => {
    new SharedMemory(repoDir, "run-1");
    expect(existsSync(join(repoDir, ".gnhf", "shared-memory"))).toBe(true);
    expect(existsSync(join(repoDir, ".gnhf", "shared-memory", "entries"))).toBe(
      true,
    );
  });

  it("registers a run and reads it back", () => {
    const sm = new SharedMemory(repoDir, "run-1");
    sm.register("Build feature X", "gnhf/run-1", repoDir);

    const snapshot = sm.readAll();
    expect(Object.keys(snapshot.runs)).toEqual(["run-1"]);
    expect(snapshot.runs["run-1"]!.objective).toBe("Build feature X");
    expect(snapshot.runs["run-1"]!.branch).toBe("gnhf/run-1");
    expect(snapshot.runs["run-1"]!.cwd).toBe(repoDir);
  });

  it("supports multiple concurrent registrations", () => {
    const sm1 = new SharedMemory(repoDir, "run-1");
    const sm2 = new SharedMemory(repoDir, "run-2");

    sm1.register("Build feature X", "gnhf/run-1", "/path/1");
    sm2.register("Fix bug Y", "gnhf/run-2", "/path/2");

    const snapshot = sm1.readAll();
    expect(Object.keys(snapshot.runs).sort()).toEqual(["run-1", "run-2"]);
    expect(snapshot.runs["run-2"]!.objective).toBe("Fix bug Y");
  });

  it("updates heartbeat timestamp", () => {
    const sm = new SharedMemory(repoDir, "run-1");
    sm.register("Build feature X", "gnhf/run-1", repoDir);

    const before = sm.readAll().runs["run-1"]!.lastHeartbeat;

    // Small delay to ensure timestamp difference
    const now = new Date(Date.now() + 1000);
    vi.setSystemTime(now);
    sm.heartbeat();
    vi.useRealTimers();

    const after = sm.readAll().runs["run-1"]!.lastHeartbeat;
    expect(new Date(after).getTime()).toBeGreaterThanOrEqual(
      new Date(before).getTime(),
    );
  });

  it("posts and reads entries", () => {
    const sm = new SharedMemory(repoDir, "run-1");
    sm.register("Build feature X", "gnhf/run-1", repoDir);
    sm.post("status", "Working on auth module");
    sm.post("file-lock", "Modifying src/auth/*.ts");

    const snapshot = sm.readAll();
    expect(snapshot.entries).toHaveLength(2);
    const types = snapshot.entries.map((e) => e.type).sort();
    expect(types).toEqual(["file-lock", "status"]);
    const contents = snapshot.entries.map((e) => e.content).sort();
    expect(contents).toEqual([
      "Modifying src/auth/*.ts",
      "Working on auth module",
    ]);
  });

  it("deregisters a run and cleans up entries", () => {
    const sm1 = new SharedMemory(repoDir, "run-1");
    const sm2 = new SharedMemory(repoDir, "run-2");

    sm1.register("Build feature X", "gnhf/run-1", "/path/1");
    sm2.register("Fix bug Y", "gnhf/run-2", "/path/2");
    sm1.post("status", "Working on X");
    sm2.post("status", "Working on Y");

    sm1.deregister();

    const snapshot = sm2.readAll();
    expect(Object.keys(snapshot.runs)).toEqual(["run-2"]);
    // run-1 entries should be cleaned up by deregister, and readAll should
    // not return entries from deregistered runs
    expect(snapshot.entries.every((e) => e.runId === "run-2")).toBe(true);
  });

  it("readOtherRuns excludes the current run", () => {
    const sm1 = new SharedMemory(repoDir, "run-1");
    const sm2 = new SharedMemory(repoDir, "run-2");

    sm1.register("Build feature X", "gnhf/run-1", "/path/1");
    sm2.register("Fix bug Y", "gnhf/run-2", "/path/2");
    sm1.post("status", "Working on X");
    sm2.post("status", "Working on Y");

    const snapshot = sm1.readOtherRuns();
    expect(Object.keys(snapshot.runs)).toEqual(["run-2"]);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]!.runId).toBe("run-2");
  });

  it("prunes stale runs on readAll", () => {
    const sm1 = new SharedMemory(repoDir, "run-1");
    const sm2 = new SharedMemory(repoDir, "run-2");

    sm1.register("Build feature X", "gnhf/run-1", "/path/1");
    sm2.register("Fix bug Y", "gnhf/run-2", "/path/2");

    // Manually set run-1's heartbeat to 15 minutes ago
    const registryPath = join(
      repoDir,
      ".gnhf",
      "shared-memory",
      "registry.json",
    );
    const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
    registry.runs["run-1"].lastHeartbeat = new Date(
      Date.now() - 15 * 60 * 1000,
    ).toISOString();
    writeFileSync(registryPath, JSON.stringify(registry), "utf-8");

    const snapshot = sm2.readAll();
    expect(Object.keys(snapshot.runs)).toEqual(["run-2"]);
  });

  it("handles missing registry file gracefully", () => {
    const sm = new SharedMemory(repoDir, "run-1");
    const snapshot = sm.readAll();
    expect(snapshot.runs).toEqual({});
    expect(snapshot.entries).toEqual([]);
  });

  it("handles corrupted registry file gracefully", () => {
    const sm = new SharedMemory(repoDir, "run-1");
    const registryPath = join(
      repoDir,
      ".gnhf",
      "shared-memory",
      "registry.json",
    );
    writeFileSync(registryPath, "not valid json", "utf-8");

    const snapshot = sm.readAll();
    expect(snapshot.runs).toEqual({});
  });

  it("evicts entries older than 30 minutes", () => {
    const sm = new SharedMemory(repoDir, "run-1");
    sm.register("Build feature X", "gnhf/run-1", repoDir);

    // Write an entry file with a timestamp 35 minutes ago
    const entriesDir = join(repoDir, ".gnhf", "shared-memory", "entries");
    const oldEntry = {
      runId: "run-1",
      type: "status",
      content: "Old work",
      timestamp: new Date(Date.now() - 35 * 60 * 1000).toISOString(),
    };
    writeFileSync(
      join(entriesDir, "run-1-old-0000.json"),
      JSON.stringify(oldEntry),
    );

    // Write a recent entry
    sm.post("status", "Current work");

    const snapshot = sm.readAll();
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]!.content).toBe("Current work");

    // Old entry file should be cleaned up
    const remaining = readdirSync(entriesDir).filter((f) =>
      f.endsWith(".json"),
    );
    expect(remaining).toHaveLength(1);
  });

  it("caps entries at 10 per run, keeping most recent", () => {
    const sm = new SharedMemory(repoDir, "run-1");
    sm.register("Build feature X", "gnhf/run-1", repoDir);

    // Write 15 entries with sequential timestamps
    const entriesDir = join(repoDir, ".gnhf", "shared-memory", "entries");
    for (let i = 0; i < 15; i++) {
      const entry = {
        runId: "run-1",
        type: "status",
        content: `Entry ${i}`,
        timestamp: new Date(Date.now() - (15 - i) * 1000).toISOString(),
      };
      writeFileSync(
        join(entriesDir, `run-1-${1000 + i}-abcd.json`),
        JSON.stringify(entry),
      );
    }

    const snapshot = sm.readAll();
    expect(snapshot.entries).toHaveLength(10);
    // Should have entries 5-14 (the 10 most recent)
    expect(snapshot.entries[0]!.content).toBe("Entry 5");
    expect(snapshot.entries[9]!.content).toBe("Entry 14");

    // Excess files should be cleaned up
    const remaining = readdirSync(entriesDir).filter((f) =>
      f.endsWith(".json"),
    );
    expect(remaining).toHaveLength(10);
  });

  it("applies per-run cap independently across runs", () => {
    const sm1 = new SharedMemory(repoDir, "run-1");
    const sm2 = new SharedMemory(repoDir, "run-2");
    sm1.register("Build feature X", "gnhf/run-1", "/path/1");
    sm2.register("Fix bug Y", "gnhf/run-2", "/path/2");

    const entriesDir = join(repoDir, ".gnhf", "shared-memory", "entries");

    // Write 12 entries for run-1 and 3 for run-2
    for (let i = 0; i < 12; i++) {
      const entry = {
        runId: "run-1",
        type: "status",
        content: `R1 Entry ${i}`,
        timestamp: new Date(Date.now() - (12 - i) * 1000).toISOString(),
      };
      writeFileSync(
        join(entriesDir, `run-1-${1000 + i}-aaaa.json`),
        JSON.stringify(entry),
      );
    }
    for (let i = 0; i < 3; i++) {
      const entry = {
        runId: "run-2",
        type: "status",
        content: `R2 Entry ${i}`,
        timestamp: new Date(Date.now() - (3 - i) * 1000).toISOString(),
      };
      writeFileSync(
        join(entriesDir, `run-2-${2000 + i}-bbbb.json`),
        JSON.stringify(entry),
      );
    }

    const snapshot = sm1.readAll();
    const r1Entries = snapshot.entries.filter((e) => e.runId === "run-1");
    const r2Entries = snapshot.entries.filter((e) => e.runId === "run-2");
    expect(r1Entries).toHaveLength(10); // capped
    expect(r2Entries).toHaveLength(3); // under cap, unchanged
  });
});

describe("formatSharedMemoryForPrompt", () => {
  it("returns empty string when no runs or entries", () => {
    const snapshot: SharedMemorySnapshot = { runs: {}, entries: [] };
    expect(formatSharedMemoryForPrompt(snapshot)).toBe("");
  });

  it("formats active runs", () => {
    const snapshot: SharedMemorySnapshot = {
      runs: {
        "run-2": {
          objective: "Fix bug Y",
          branch: "gnhf/run-2",
          startedAt: "2026-04-09T10:00:00Z",
          lastHeartbeat: "2026-04-09T10:05:00Z",
          cwd: "/path/2",
        },
      },
      entries: [],
    };

    const result = formatSharedMemoryForPrompt(snapshot);
    expect(result).toContain("## Parallel Runs");
    expect(result).toContain("Run: run-2");
    expect(result).toContain("Fix bug Y");
    expect(result).toContain("gnhf/run-2");
  });

  it("formats entries with type labels", () => {
    const snapshot: SharedMemorySnapshot = {
      runs: {
        "run-2": {
          objective: "Fix bug Y",
          branch: "gnhf/run-2",
          startedAt: "2026-04-09T10:00:00Z",
          lastHeartbeat: "2026-04-09T10:05:00Z",
          cwd: "/path/2",
        },
      },
      entries: [
        {
          runId: "run-2",
          type: "status",
          content: "Working on auth",
          timestamp: "2026-04-09T10:05:00Z",
        },
        {
          runId: "run-2",
          type: "file-lock",
          content: "Modifying src/auth/*.ts",
          timestamp: "2026-04-09T10:06:00Z",
        },
      ],
    };

    const result = formatSharedMemoryForPrompt(snapshot);
    expect(result).toContain("[STATUS] (run-2): Working on auth");
    expect(result).toContain("[FILE-LOCK] (run-2): Modifying src/auth/*.ts");
  });

  it("limits entries to last 20", () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({
      runId: "run-2",
      type: "info" as const,
      content: `Entry ${i}`,
      timestamp: new Date(Date.now() + i * 1000).toISOString(),
    }));

    const snapshot: SharedMemorySnapshot = {
      runs: {
        "run-2": {
          objective: "X",
          branch: "gnhf/run-2",
          startedAt: "2026-04-09T10:00:00Z",
          lastHeartbeat: "2026-04-09T10:05:00Z",
          cwd: "/path/2",
        },
      },
      entries,
    };

    const result = formatSharedMemoryForPrompt(snapshot);
    // Should contain Entry 5 through Entry 24 (last 20)
    expect(result).not.toContain("Entry 4");
    expect(result).toContain("Entry 5");
    expect(result).toContain("Entry 24");
  });
});

describe("formatSharedMemoryForTerminal", () => {
  it("returns no-runs message when snapshot is empty", () => {
    const snapshot: SharedMemorySnapshot = { runs: {}, entries: [] };
    expect(formatSharedMemoryForTerminal(snapshot)).toBe("  No active runs.\n");
  });

  it("formats active runs with time-ago labels", () => {
    const now = Date.now();
    const snapshot: SharedMemorySnapshot = {
      runs: {
        "build-auth-abc123": {
          objective: "Build the auth module",
          branch: "gnhf/build-auth-abc123",
          startedAt: new Date(now - 5 * 60 * 1000).toISOString(),
          lastHeartbeat: new Date(now - 30 * 1000).toISOString(),
          cwd: "/path/1",
        },
      },
      entries: [],
    };

    const result = formatSharedMemoryForTerminal(snapshot);
    expect(result).toContain("Active Runs (1)");
    expect(result).toContain("build-auth-abc123");
    expect(result).toContain("Objective: Build the auth module");
    expect(result).toContain("Branch:    gnhf/build-auth-abc123");
    expect(result).toContain("Started:   5m ago");
    expect(result).toContain("Heartbeat: 30s ago");
  });

  it("formats entries with type labels and time-ago", () => {
    const now = Date.now();
    const snapshot: SharedMemorySnapshot = {
      runs: {},
      entries: [
        {
          runId: "run-1",
          type: "status",
          content: "Iteration 3 succeeded: built auth",
          timestamp: new Date(now - 2 * 60 * 1000).toISOString(),
        },
        {
          runId: "run-2",
          type: "file-lock",
          content: "Modifying src/db/*.ts",
          timestamp: new Date(now - 30 * 1000).toISOString(),
        },
        {
          runId: "run-1",
          type: "info",
          content: "Auth module depends on new config format",
          timestamp: new Date(now - 10 * 1000).toISOString(),
        },
      ],
    };

    const result = formatSharedMemoryForTerminal(snapshot);
    expect(result).toContain("Recent Entries (3)");
    expect(result).toContain(
      "[STATUS] (run-1) Iteration 3 succeeded: built auth",
    );
    expect(result).toContain("[FILE-LOCK] (run-2) Modifying src/db/*.ts");
    expect(result).toContain(
      "[INFO] (run-1) Auth module depends on new config format",
    );
    expect(result).toContain("2m ago");
    expect(result).toContain("30s ago");
    expect(result).toContain("10s ago");
  });

  it("shows both runs and entries together", () => {
    const now = Date.now();
    const snapshot: SharedMemorySnapshot = {
      runs: {
        "run-1": {
          objective: "Build X",
          branch: "gnhf/run-1",
          startedAt: new Date(now - 10 * 60 * 1000).toISOString(),
          lastHeartbeat: new Date(now - 60 * 1000).toISOString(),
          cwd: "/path/1",
        },
      },
      entries: [
        {
          runId: "run-1",
          type: "status",
          content: "Working",
          timestamp: new Date(now - 60 * 1000).toISOString(),
        },
      ],
    };

    const result = formatSharedMemoryForTerminal(snapshot);
    expect(result).toContain("Active Runs (1)");
    expect(result).toContain("Recent Entries (1)");
  });
});
