# Native Handoff

This context defines the language for transferring work between Pi sessions without losing the user’s place or requiring manual context copying.

## Session Transfer

**Handoff**:
A deliberate transfer of working context from a source session into a replacement session so work can continue in the same Pi window.
_Avoid_: Fork, new window, reset

**Source session**:
The session from which the user initiates a handoff and whose conversation remains available for later review.
_Avoid_: Old session

**Replacement session**:
The fresh session that receives the handoff context and waits for the user’s next instruction.
_Avoid_: New conversation, new window

## Subagent execution language

**Run**:
One execution of a single node, parallel group, or chain.
_Avoid_: Job, task (when referring to the whole execution)

**Node**:
One agent invocation inside a run.
_Avoid_: Step (when the position is not the main concern)

**Lifecycle state**:
The status of a run or node: `queued`, `running`, `completed`, `failed`, `cancelled`, or `suspended`. `Cancelled` is terminal and cannot resume; `suspended` is non-terminal and can resume.
_Avoid_: Treating blocking or detached delivery as lifecycle states.

**Lifecycle event**:
A durable record of a meaningful run or node state change, such as queued, started, completed, failed, cancelled, or suspended.
_Avoid_: Parent notification

**Run snapshot**:
The latest durable summary of a run and its nodes, used for fast status inspection after restart.
_Avoid_: Reconstructing normal status solely from the event history.

**Artifact manifest**:
The durable index of result, handoff, partial-output, checkpoint, and explicitly retained work files belonging to a run.
_Avoid_: Treating a path in a notification as the artifact itself.

**Durable result**:
A node's complete output written to the run store before the node is recorded as completed. V1 does not stream model output to disk; output still available only in an in-flight node is not guaranteed after a crash.
_Avoid_: Treating completion metadata as proof that the output was persisted.

**Idle limit**:
A configurable limit for time with no active model or tool work. An active tool call does not count as idle. V1 uses a 10-minute default with a per-run override; normal overrides must be at least 30 seconds. A shorter limit requires the explicit `allowShortIdleLimit` escape hatch and is reserved for controlled tests. When the limit is reached, the run is stopped through the configured timeout policy.
_Avoid_: Wall-clock limit

**Usage record**:
Basic accounting saved for a node and aggregated for its run: provider, model, reasoning setting, input/output tokens when available, and duration. Missing provider usage is recorded as unavailable rather than guessed.
_Avoid_: Estimated token or cost values presented as facts.

**Result retention**:
Run files remain in the global store for a configurable period. V1 defaults to 30 days and provides explicit cleanup; retention must not remove files still needed by an active or suspended run.
_Avoid_: Assuming run artifacts are permanent.

**Run data store**:
The package-owned global store at `$PI_CODING_AGENT_DIR/pi-engineering-toolkit/`, defaulting to `~/.pi/agent/pi-engineering-toolkit/`. Each run has its own folder under `runs/<runId>/` for lifecycle records, snapshots, artifacts, and logs.
_Avoid_: Mixing runtime records with Pi's native session JSONL files.

**Completion evidence**:
A run is completed only when every required node succeeds, every required handoff is available, and the final result is saved. A failure record preserves IDs, role, error, result paths, and available usage data.
_Avoid_: Calling a run complete because every node merely stopped.

**Blocking execution**:
A run whose active parent turn stays open until the run returns a terminal result.
_Avoid_: Foreground

**Detached execution**:
A run that continues after the parent turn ends. The parent remains available and receives completion notifications.
_Avoid_: Background (as the runtime term)

**Join**:
An explicit parent operation that waits for a detached run's terminal result instead of requiring status polling or automatically injecting the full result into parent context.
_Avoid_: Treating a parent notification as the complete result.

**Status view**:
A compact inspection result showing run and node states, artifact paths, and usage totals. It does not include full output text or duplicate Pi's native JSONL transcripts.
_Avoid_: Using status inspection as a transcript viewer.

**Suspension**:
A non-terminal frozen run that can resume from its latest durable checkpoint. A graceful Pi shutdown suspends active runs; they resume only after explicit user or parent action.
_Avoid_: Cancellation, stop, automatic restart

**Cancellation**:
A terminal decision to end a run. A cancelled run cannot resume. V1 does not steer a running node; a direction change uses cancellation plus an explicit recovery or new run.
_Avoid_: Suspension, pause, live steering

**Internal completion event**:
A runtime record for every child state change, including successful node completion. It is available for status and inspection but does not automatically enter parent context.
_Avoid_: Parent notification

**Parent notification**:
A queued, compact record surfaced to the parent for a child failure, cancellation, suspension, or final graph result. It does not interrupt an active parent turn.
_Avoid_: Completion event, interrupt, tool call

**Auto-resume**:
A runtime-started parent turn that processes a parent notification when the parent is idle. If the parent is busy, the notification waits without interrupting the turn.
_Avoid_: Interrupt, forced turn

**Handoff memo**:
The complete plain-text output passed from one node to the next. It is separate from compact parent notifications and is not truncated.
_Avoid_: Parent summary, transcript

**Logical role**:
The parent-assigned responsibility for a node, such as `Backend Researcher`. It identifies the work for the parent and runtime, but it is not an execution identity and need not be shown to the child.
_Avoid_: Node ID, agent ID

**Recovery run**:
A new run that replaces failed logical roles and continues the remaining graph using artifacts from the original run.
_Avoid_: Continuation graph, mutated run

**Handoff marker**:
A compact, durable TUI record in the source session showing that a handoff occurred and identifying its artifact.
_Avoid_: Notification, custom LLM message

## Context Boundaries

**Conversation context**:
The active branch of a session, including relevant user and assistant messages, tool results, and compaction summaries.
_Avoid_: Chat history, native context

**Resource context**:
The project and global instructions and resources that Pi loads independently for each session.
_Avoid_: Native context, background context

## Handoff Content

**Handoff artifact**:
The human-readable document produced during a handoff and stored outside the project workspace for inspection or recovery.
_Avoid_: Handoff file, summary file

**Handoff context**:
The artifact’s content made available inside the replacement session before the user sends a new instruction.
_Avoid_: Initial prompt, automatic message

**Pending handoff**:
A replacement session that contains handoff context but has not yet sent a request to the model because the user has not submitted a new instruction.
_Avoid_: Auto-started session, queued prompt
