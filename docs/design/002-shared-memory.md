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
  registry.json           # Active run registry (run metadata)
  entries/
    <runId>-<timestamp>.json  # Individual memory entries
```

### Run Registry

Each active run registers itself with metadata:

```json
{
  "runs": {
    "add-a-new-feature-fo-4eb55c": {
      "objective": "Add a new feature for ...",
      "branch": "gnhf/add-a-new-feature-fo-4eb55c",
      "startedAt": "2026-04-09T10:00:00Z",
      "lastHeartbeat": "2026-04-09T10:05:00Z",
      "cwd": "/path/to/worktree"
    }
  }
}
```

Runs are considered stale if their heartbeat is older than 10 minutes. Stale runs are cleaned up on read.

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

File operations use atomic write patterns (write to temp file, then rename) to avoid partial reads. The registry uses a simple last-writer-wins strategy with JSON merge, which is acceptable since concurrent updates to the same run are not expected. Entry files are append-only (each entry is a separate file), so no write conflicts occur.

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
