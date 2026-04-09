import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";

export type EntryType = "status" | "file-lock" | "info";

export interface RunRegistration {
  objective: string;
  branch: string;
  startedAt: string;
  lastHeartbeat: string;
  cwd: string;
}

export interface Registry {
  runs: Record<string, RunRegistration>;
}

export interface MemoryEntry {
  runId: string;
  type: EntryType;
  content: string;
  timestamp: string;
}

export interface SharedMemorySnapshot {
  runs: Record<string, RunRegistration>;
  entries: MemoryEntry[];
}

const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const ENTRY_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
const MAX_ENTRIES_PER_RUN = 10;
const SHARED_MEMORY_DIR = "shared-memory";
const RUNS_DIR = "runs";
const ENTRIES_DIR = "entries";

function getGitCommonDir(cwd: string): string {
  return execSync("git rev-parse --git-common-dir", {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
}

function getRepoRoot(cwd: string): string {
  // For worktrees, --show-toplevel returns the worktree root, but we need
  // the main repo root. We derive it from the git common dir.
  const gitCommonDir = getGitCommonDir(cwd);
  if (gitCommonDir === ".git") {
    // Normal repo — cwd is (or is under) the repo root
    return execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  }
  // Worktree — common dir points to the main repo's .git directory
  // e.g., /path/to/main-repo/.git => repo root is /path/to/main-repo
  const resolvedCommonDir = resolve(cwd, gitCommonDir);
  return dirname(resolvedCommonDir);
}

function atomicWriteFile(filePath: string, content: string): void {
  const tmpPath = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, filePath);
}

export class SharedMemory {
  private readonly baseDir: string;
  private readonly entriesDir: string;
  private readonly registryPath: string;
  private readonly runId: string;

  constructor(cwd: string, runId: string) {
    const repoRoot = getRepoRoot(cwd);
    this.baseDir = join(repoRoot, ".gnhf", SHARED_MEMORY_DIR);
    this.entriesDir = join(this.baseDir, ENTRIES_DIR);
    this.registryPath = join(this.baseDir, REGISTRY_FILENAME);
    this.runId = runId;
    mkdirSync(this.entriesDir, { recursive: true });
  }

  register(objective: string, branch: string, cwd: string): void {
    const now = new Date().toISOString();
    const registry = this.readRegistry();
    registry.runs[this.runId] = {
      objective,
      branch,
      startedAt: now,
      lastHeartbeat: now,
      cwd,
    };
    this.writeRegistry(registry);
  }

  heartbeat(): void {
    const registry = this.readRegistry();
    const run = registry.runs[this.runId];
    if (run) {
      run.lastHeartbeat = new Date().toISOString();
      this.writeRegistry(registry);
    }
  }

  post(type: EntryType, content: string): void {
    const entry: MemoryEntry = {
      runId: this.runId,
      type,
      content,
      timestamp: new Date().toISOString(),
    };
    const filename = `${this.runId}-${Date.now()}-${randomBytes(4).toString("hex")}.json`;
    atomicWriteFile(join(this.entriesDir, filename), JSON.stringify(entry));
  }

  readAll(): SharedMemorySnapshot {
    const registry = this.readRegistry();
    const now = Date.now();
    const activeRunIds = new Set<string>();

    // Prune stale runs
    for (const [id, run] of Object.entries(registry.runs)) {
      const lastHeartbeat = new Date(run.lastHeartbeat).getTime();
      if (now - lastHeartbeat > STALE_THRESHOLD_MS) {
        delete registry.runs[id];
      } else {
        activeRunIds.add(id);
      }
    }

    // Write back pruned registry
    this.writeRegistry(registry);

    // Read entries, filtering out those from stale/deregistered runs
    const entries = this.readEntries(activeRunIds);

    return { runs: registry.runs, entries };
  }

  /**
   * Read entries and other runs' state, excluding this run's own data.
   * This is what gets injected into the iteration prompt.
   */
  readOtherRuns(): SharedMemorySnapshot {
    const snapshot = this.readAll();
    delete snapshot.runs[this.runId];
    const entries = snapshot.entries.filter((e) => e.runId !== this.runId);
    return { runs: snapshot.runs, entries };
  }

  deregister(): void {
    const registry = this.readRegistry();
    delete registry.runs[this.runId];
    this.writeRegistry(registry);
    this.cleanupEntries(this.runId);
  }

  private readRegistry(): Registry {
    if (!existsSync(this.registryPath)) {
      return { runs: {} };
    }
    try {
      const content = readFileSync(this.registryPath, "utf-8");
      const parsed = JSON.parse(content) as Registry;
      if (!parsed.runs || typeof parsed.runs !== "object") {
        return { runs: {} };
      }
      return parsed;
    } catch {
      return { runs: {} };
    }
  }

  private writeRegistry(registry: Registry): void {
    atomicWriteFile(this.registryPath, JSON.stringify(registry, null, 2));
  }

  private readEntries(activeRunIds: Set<string>): MemoryEntry[] {
    if (!existsSync(this.entriesDir)) {
      return [];
    }

    const now = Date.now();
    const entriesByRun = new Map<
      string,
      { entry: MemoryEntry; file: string }[]
    >();
    const filesToDelete: string[] = [];
    const files = readdirSync(this.entriesDir).filter((f) =>
      f.endsWith(".json"),
    );

    for (const file of files) {
      try {
        const content = readFileSync(join(this.entriesDir, file), "utf-8");
        const entry = JSON.parse(content) as MemoryEntry;
        if (!activeRunIds.has(entry.runId)) {
          filesToDelete.push(file);
        } else if (
          now - new Date(entry.timestamp).getTime() >
          ENTRY_MAX_AGE_MS
        ) {
          filesToDelete.push(file);
        } else {
          const list = entriesByRun.get(entry.runId) ?? [];
          list.push({ entry, file });
          entriesByRun.set(entry.runId, list);
        }
      } catch {
        // Skip malformed entries
      }
    }

    // Enforce per-run entry cap: keep only the most recent entries
    const entries: MemoryEntry[] = [];
    for (const [, items] of entriesByRun) {
      items.sort(
        (a, b) =>
          new Date(a.entry.timestamp).getTime() -
          new Date(b.entry.timestamp).getTime(),
      );
      if (items.length > MAX_ENTRIES_PER_RUN) {
        const excess = items.splice(0, items.length - MAX_ENTRIES_PER_RUN);
        for (const item of excess) {
          filesToDelete.push(item.file);
        }
      }
      for (const item of items) {
        entries.push(item.entry);
      }
    }

    // Best-effort cleanup of expired / excess files
    for (const file of filesToDelete) {
      try {
        unlinkSync(join(this.entriesDir, file));
      } catch {
        // Best-effort cleanup
      }
    }

    return entries.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
  }

  private cleanupEntries(runId: string): void {
    if (!existsSync(this.entriesDir)) return;

    const files = readdirSync(this.entriesDir).filter((f) =>
      f.startsWith(`${runId}-`),
    );
    for (const file of files) {
      try {
        unlinkSync(join(this.entriesDir, file));
      } catch {
        // Best-effort cleanup
      }
    }
  }
}

/**
 * Format a shared memory snapshot as a human-readable string
 * for inclusion in the iteration prompt.
 */
export function formatSharedMemoryForPrompt(
  snapshot: SharedMemorySnapshot,
): string {
  const runEntries = Object.entries(snapshot.runs);
  if (runEntries.length === 0 && snapshot.entries.length === 0) {
    return "";
  }

  const lines: string[] = [
    "## Parallel Runs",
    "",
    "The following gnhf runs are currently active in this repository. Be aware of what they are working on to avoid conflicts:",
    "",
  ];

  if (runEntries.length === 0) {
    lines.push("No other active runs detected.", "");
  } else {
    for (const [id, run] of runEntries) {
      lines.push(`### Run: ${id}`);
      lines.push(`- **Objective:** ${run.objective}`);
      lines.push(`- **Branch:** ${run.branch}`);
      lines.push("");
    }
  }

  const recentEntries = snapshot.entries.slice(-20); // Last 20 entries

  // Separate file-lock entries for prominent display
  const fileLockEntries = recentEntries.filter((e) => e.type === "file-lock");
  const otherEntries = recentEntries.filter((e) => e.type !== "file-lock");

  if (fileLockEntries.length > 0) {
    lines.push(
      "### Files Being Modified by Other Runs",
      "",
      "**WARNING: The following files/directories are actively being modified by other parallel runs. Do NOT modify these files unless absolutely necessary to avoid merge conflicts.**",
      "",
    );
    for (const entry of fileLockEntries) {
      lines.push(`- \`${entry.content}\` (by ${entry.runId})`);
    }
    lines.push("");
  }

  if (otherEntries.length > 0) {
    lines.push("### Recent Activity from Other Runs", "");
    for (const entry of otherEntries) {
      const typeLabel = entry.type === "status" ? "[STATUS]" : "[INFO]";
      lines.push(`- ${typeLabel} (${entry.runId}): ${entry.content}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatTimeAgo(isoTimestamp: string): string {
  const diffMs = Date.now() - new Date(isoTimestamp).getTime();
  if (diffMs < 0) return "just now";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Format a shared memory snapshot as a human-readable string
 * for display in the terminal (gnhf status command).
 */
export function formatSharedMemoryForTerminal(
  snapshot: SharedMemorySnapshot,
): string {
  const runEntries = Object.entries(snapshot.runs);
  if (runEntries.length === 0 && snapshot.entries.length === 0) {
    return "  No active runs.\n";
  }

  const lines: string[] = [];

  if (runEntries.length > 0) {
    lines.push(`  Active Runs (${runEntries.length})`, "");
    for (const [id, run] of runEntries) {
      lines.push(`    ${id}`);
      lines.push(`      Objective: ${run.objective}`);
      lines.push(`      Branch:    ${run.branch}`);
      lines.push(`      Started:   ${formatTimeAgo(run.startedAt)}`);
      lines.push(`      Heartbeat: ${formatTimeAgo(run.lastHeartbeat)}`);
      lines.push("");
    }
  }

  const recentEntries = snapshot.entries.slice(-20);
  if (recentEntries.length > 0) {
    lines.push(`  Recent Entries (${recentEntries.length})`, "");
    for (const entry of recentEntries) {
      const typeLabel =
        entry.type === "file-lock"
          ? "FILE-LOCK"
          : entry.type === "status"
            ? "STATUS"
            : "INFO";
      const ago = formatTimeAgo(entry.timestamp);
      lines.push(
        `    [${typeLabel}] (${entry.runId}) ${entry.content}  (${ago})`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}
