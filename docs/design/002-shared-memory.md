# Shared Memory for Parallel Agent Runs

## Problem

When multiple gnhf runs execute concurrently (especially via `--worktree`), each agent operates in complete isolation. Agents have no awareness of what other agents are working on, leading to potential issues:

- **Duplicate work**: Two agents may attempt the same refactoring or fix independently.
- **Conflicts**: Agents may make incompatible changes to shared interfaces or APIs.
- **Missed coordination**: An agent changing a utility function has no way to inform another agent that depends on it.

## Solution

Introduce a file-based shared memory system that allows concurrent gnhf runs to exchange information. Each run can post entries to a shared store and read entries posted by other runs. The shared memory is stored in `.gnhf/shared-memory/` within the repository root, using the git common directory to ensure worktrees share the same location.

## Design

### Storage Layout

```
.gnhf/shared-memory/
  runs/
    <runId>.json              # Per-run registration (one file per active run)
  entries/
    <runId>-<timestamp>.json  # Individual memory entries
```

### Run Registry

Each active run registers itself by writing its own file to `runs/<runId>.json`:

```json
{
  "objective": "Add a new feature for ...",
  "branch": "gnhf/add-a-new-feature-fo-4eb55c",
  "startedAt": "2026-04-09T10:00:00Z",
  "lastHeartbeat": "2026-04-09T10:05:00Z",
  "cwd": "/path/to/worktree"
}
```

Each run writes only its own file, so concurrent registrations and heartbeats never conflict — there is no shared registry file that could suffer from lost-update race conditions. Reading the registry means scanning all files in the `runs/` directory.

Runs are considered stale if their heartbeat is older than 10 minutes. Stale run files are deleted on the next read.

### Memory Entries

Entries are atomic JSON files written by each run:

```json
{
  "runId": "add-a-new-feature-fo-4eb55c",
  "type": "status",
  "content": "Refactoring the auth module — touching src/auth/*.ts",
  "timestamp": "2026-04-09T10:05:00Z"
}
```

Entry types:
- `status` — Current activity description (what the agent is working on)
- `file-lock` — Advisory note that certain files are being modified
- `info` — General information for other agents

### API

```typescript
class SharedMemory {
  constructor(repoRoot: string, runId: string)
  register(objective: string, branch: string, cwd: string): void
  heartbeat(): void
  post(type: EntryType, content: string): void
  readAll(): SharedMemorySnapshot
  deregister(): void
}
```

### Integration Points

1. **Orchestrator**: Creates a `SharedMemory` instance at startup, registers the run, sends heartbeats between iterations, and deregisters on shutdown.
2. **Iteration prompt**: The `buildIterationPrompt` function includes a snapshot of shared memory state so agents can see what other runs are doing.
3. **Git ignore**: Shared memory files are excluded from commits via `info/exclude`.

### Concurrency Safety

File operations use atomic write patterns (write to temp file, then rename) to avoid partial reads. Both run registrations and entries use per-file isolation — each run writes only its own registration file (`runs/<runId>.json`) and each entry is a separate file, so no write conflicts occur between concurrent runs. This eliminates the lost-update race condition that would exist with a shared registry file.

### Staleness & Cleanup

- Runs that haven't sent a heartbeat in 10 minutes are considered stale and removed from the registry on the next read.
- Entry files from deregistered or stale runs are cleaned up.

### Entry Retention

Entries are subject to two retention limits to prevent unbounded growth during long-running multi-agent sessions:

- **Max age (30 minutes)**: Entries older than 30 minutes are deleted on read, even from active runs. This keeps the shared memory focused on recent activity.
- **Per-run cap (10 entries)**: Each run retains at most 10 entries. When a run exceeds this limit, the oldest entries are deleted on the next read. This bounds filesystem usage proportional to the number of active runs.

Both limits are enforced lazily during `readEntries()` — expired and excess entries are deleted as a best-effort side effect of reading.

## Scope

### Phase 1 (this implementation)
- Core `SharedMemory` class with registry, entries, read/write
- Integration into `Orchestrator` (register, heartbeat, deregister)
- Integration into `buildIterationPrompt` (include snapshot in agent prompt)
- Git exclude for shared memory directory
- Automatic status posting after each iteration (success/failure summaries broadcast to sibling runs)
- Agent-driven entry posting via structured output (`shared_memory_entries` field in agent output) — agents can post `file-lock` and `info` entries to signal file modifications and share context with sibling runs

### Phase 2 (this implementation)
- Renderer display of sibling run activity — the terminal UI shows a "sibling runs" section between the agent message and moon strip, listing up to 3 active sibling runs with their latest status. The section is optional and drops when the terminal is too short.
- `OrchestratorState` extended with `siblingRuns: SiblingRunInfo[]` populated from the shared memory snapshot read before each iteration

### Phase 3 (this implementation)
- CLI subcommand `gnhf status` to inspect shared memory state — shows active runs (objective, branch, started/heartbeat times) and recent entries (type, run, content, time ago) in a terminal-friendly format
- `formatSharedMemoryForTerminal()` function for human-readable terminal output with relative timestamps

### Phase 4 (this implementation)
- File-lock entries are separated into a dedicated "Files Being Modified by Other Runs" section in the agent prompt, with an explicit avoidance warning telling the agent not to modify those files unless absolutely necessary
- Status and info entries remain in the general "Recent Activity from Other Runs" section
- This makes file-lock entries actionable rather than purely informational — agents can make conflict-avoidance decisions based on the prominent warning

### Phase 5 (this implementation)
- Replaced single `registry.json` with per-run files in `runs/` directory to eliminate race conditions
- Each run writes only its own `runs/<runId>.json` file, so concurrent registrations and heartbeats never cause lost updates
- The `Registry` interface was removed — reading the registry now scans all files in the `runs/` directory
- Stale run pruning deletes individual run files rather than modifying a shared registry

### Phase 6 (this implementation)
- Automatic file-lock posting from git diff: after each successful iteration commits changes, the orchestrator extracts changed files via `git diff --name-only HEAD~1..HEAD` and posts file-lock entries automatically
- Files are grouped by directory — when 3+ files in the same directory are changed, they collapse to a `dir/*` wildcard entry to keep entries concise
- `.gnhf/` paths (run metadata) are filtered out since they aren't meaningful to sibling runs
- This makes file-lock data reliable without requiring agent cooperation — every committed change is automatically broadcast to sibling runs
- Agent-driven file-lock entries (from `shared_memory_entries` output) are still posted in addition to automatic ones, allowing agents to declare intent for files they plan to modify in future iterations

### Phase 7 (this implementation)
- Active conflict detection: before each iteration, the orchestrator compares the current run's file-lock entries against other runs' file-lock entries to find overlapping paths
- Conflicts are rendered as a prominent "CONFLICT DETECTED" section at the top of the shared memory prompt, above the regular file-lock warnings
- Path overlap detection supports exact matches and directory wildcards (e.g., `src/auth/*` matches `src/auth/login.ts`)
- The orchestrator now reads the full snapshot once per iteration (via `readAll()`) and uses `filterToOtherRuns()` for prompt display + `detectConflicts()` for conflict detection, avoiding duplicate filesystem reads
- Conflicts are deduplicated by file+runId+otherFile to avoid reporting the same overlap multiple times

### Phase 8 (this implementation)
- File-lock entry deduplication: the orchestrator tracks which file-lock paths have been posted during the run's lifetime and skips re-posting the same path in subsequent iterations
- Prevents duplicate file-lock entries from consuming per-run entry cap slots (10 max) when the same files are modified across multiple iterations
- Deduplication applies to both auto-posted file-lock entries (from git diff) and agent-driven file-lock entries (from `shared_memory_entries` output), and cross-deduplicates between the two sources
- New file-lock paths (files changed for the first time in a later iteration) are still posted normally

### Phase 9 (this implementation)
- `gnhf status --json` outputs the shared memory snapshot as machine-readable JSON for scripting and programmatic consumption
- `gnhf status --clear` removes all shared memory state (run registrations and entry files), useful for cleaning up stale state after crashes or debugging
- Added `clearAll()` method to SharedMemory class that deletes all files in both `runs/` and `entries/` directories and returns the count of deleted files

### Phase 10 (this implementation)
- Worktree integration tests: added 4 tests that create real git worktrees and verify that SharedMemory instances from the main repo and a worktree resolve to the same shared directory, can see each other's registrations and entries, and support cross-worktree conflict detection
- These tests validate the core contract of the shared memory system — `getRepoRoot()` uses `git rev-parse --git-common-dir` to resolve worktrees to the main repo's `.gnhf/shared-memory/` directory, ensuring worktree runs never create isolated shared memory silos
- Tests cover: cross-worktree state sharing, readOtherRuns from worktree, deregister cleanup from worktree, and cross-worktree conflict detection

### Phase 11 (this implementation)
- `gnhf status` now detects and displays pairwise conflicts between all active runs — users can see at a glance which runs are modifying overlapping files
- Added `detectAllPairwiseConflicts()` function that finds file-lock overlaps between all pairs of runs (not just one run vs others), with deduplication so each conflict pair is reported once
- `formatSharedMemoryForTerminal()` now accepts optional conflicts and renders a "Conflicts (N)" section between active runs and recent entries
- `gnhf status --json` output now includes a `conflicts` array alongside runs and entries
- Terminal conflict display uses `← conflict between runs` for exact matches and `↔` with run attribution for wildcard overlaps
