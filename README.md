<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="96">
  </a>
</p>

<h1 align="center">pi-engineering-kit</h1>

<p align="center">Engineering-focused extensions for the <a href="https://pi.dev">pi</a> terminal coding agent.</p>

<p align="center">
  <a href="https://www.typescriptlang.org/"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white"></a>
  <a href="https://pi.dev/docs/packages"><img alt="pi package" src="https://img.shields.io/badge/pi-package-7C3AED?style=flat-square"></a>
</p>

[Features](#features) • [Install](#install) • [Usage](#usage) • [Configuration](#configuration) • [Development](#development)

`pi-engineering-kit` is a pi package for an SDLC-oriented workflow. It adds model-and-reasoning profiles, context visibility, native session handoffs, and a searchable code-block clipboard picker without modifying pi itself.

> [!WARNING]
> Pi packages run with full system access. Review the extensions in `extensions/` before installing this package, especially if you are installing from an unpinned Git ref.

## Features

- **Model profiles** — Switch between built-in or custom combinations of provider, model, and reasoning effort. Profiles do not change prompts, tools, permissions, skills, or other behavior.
- **Native handoff** — Generate a durable handoff artifact and move into an idle replacement session with the context already available.
- **Context visibility** — Show current context usage in the footer and warn when a session approaches context limits.
- **Code-block clipboard picker** — Search fenced code blocks from completed assistant replies and copy the selected block to the system clipboard.
- **Subagent control center** — Open `/subagents` to inspect current-session runs and edit definition-backed model defaults.

## Install

Install directly from GitHub:

```bash
pi install git:github.com/simonteague6/pi-engineering-kit
```

For a reproducible install, pin a tag or commit:

```bash
pi install git:github.com/simonteague6/pi-engineering-kit@<tag-or-commit>
```

To try the package for one run without adding it to your settings:

```bash
pi -e git:github.com/simonteague6/pi-engineering-kit
```

Restart pi, or run `/reload`, after installing. Use `pi list` to confirm that the package is installed.

### Requirements

- Node.js `>=22.19.0`
- [pi](https://pi.dev/) `>=0.80.8 <0.83.0` (smoke-tested with 0.80.8 and 0.82.1)
- An authenticated pi model for profiles, `/handoff`, and subagents
- A system clipboard backend for `/copy-code`:
  - macOS: `pbcopy`
  - Windows: `clip`
  - Linux: one of `wl-copy`, `xclip`, or `xsel`

## Usage

### Subagents

Subagent System v1 delegates bounded work to fresh Pi subprocesses. It supports one child, independent parallel children, ordered chains, and static dependency graphs. The parent agent launches and controls runs through six tools:

| Tool | Use |
| --- | --- |
| `subagent_launch` | Start a single, parallel, chain, or DAG run. |
| `subagent_status` | Read compact state, usage, and durable artifact paths. |
| `subagent_join` | Wait for a detached run's terminal result. |
| `subagent_cancel` | End an entire run, or one node and its descendants. |
| `subagent_resume` | Explicitly continue a suspended run. |
| `subagent_recover` | Start a new run that replaces failed logical roles. |

Extensions that need the supported TypeScript seam import it from the explicit package subpath:

```ts
import { createSubagentRuntime, type GraphDefinition } from "pi-engineering-kit/subagents";
```

The supported seam is the graph and lifecycle API. The Pi command arguments, JSON stream protocol, process runner, locks, and on-disk layout are package internals.

`subagent_launch` accepts these graph forms:

```text
single:   { kind: "single", node: { agent, logicalRole, task } }
parallel: { kind: "parallel", nodes: [{ agent, logicalRole, task }, ...] }
chain:    { kind: "chain", nodes: [{ agent, logicalRole, task }, ...] }
dag:      { kind: "dag", nodes: [{ id, agent, logicalRole, task, dependsOn }, ...] }
```

`maxConcurrency` and `delivery` (`detached` or `blocking`) are optional model-facing launch controls. A DAG must use unique IDs and be acyclic. Agents should rely on the runtime's ten-minute idle-watchdog default rather than setting an idle limit; use `subagent_cancel` for deliberate cancellation.

#### Launch and delivery

`subagent_launch` defaults to **detached** delivery: it returns a small receipt while the child continues. Use `subagent_join` when the final result is needed. Choose **blocking** delivery only when the parent turn must wait for the terminal result. Each run has a user-owned concurrency ceiling (six by default) and a runtime idle watchdog (ten minutes by default); a graph can lower, but never raise, that ceiling. Runtime/API callers may configure the watchdog and per-run overrides, but model-facing tools do not expose those controls. Use `subagent_cancel` when cancellation is deliberate.

A child receives its declared working directory, task text, selected definition, and fresh Pi resource discovery. It starts with no parent transcript or in-memory extension state. A completed node writes its full durable result before the runtime marks it complete. Chain and graph successors receive complete predecessor handoffs, inline when small and through an artifact path when large.

#### Lifecycle, recovery, and retention

Runs and nodes are `queued`, `running`, `completed`, `failed`, `cancelled`, or `suspended`. Cancellation is terminal. Shutdown and reload suspend active work; call `subagent_resume` to continue from durable evidence. For a failed graph, `subagent_recover` creates a new run with an immutable lineage, replaces each failed logical role, and reuses unaffected successful artifacts.

The package stores run snapshots, lifecycle events, results, handoffs, and notifications under:

```text
$PI_CODING_AGENT_DIR/pi-engineering-toolkit/runs/<runId>/
```

The default base directory is `~/.pi/agent/pi-engineering-toolkit/`. Terminal run data is retained for 30 days. Cleanup never removes active or suspended runs, or evidence for undelivered parent notifications. Parent notifications are compact and wait until the parent is idle; they do not interrupt a turn.

#### Safety limits and interface modes

Definitions resolve in project, user, then packaged precedence. A child uses only its definition allowlist plus explicit node additions. Recursive subagent tools and interactive approval prompts are unavailable. These controls are **not** an operating-system sandbox: children retain the local user's OS permissions. Use a container or VM for OS isolation.

Run `/subagents` in TUI mode to open the full-screen control center. The Runs view shows current-session runs, node lifecycle states, dependency edges, available usage, and durable result details. Settings edits definition-backed provider, model, and reasoning defaults; project definitions take precedence over user and packaged definitions.

In print, JSON, or RPC mode, `/subagents` does not open a TUI. The six parent tools remain available, and their compact JSON results include run state and durable artifact paths for scripts and non-TUI clients.

### Profiles

The package provides four built-in profiles, named around the modes encouraged by [Matt Pocock's skills](https://github.com/mattpocock/skills):

| Profile | Default reasoning effort | Color |
| --- | --- | --- |
| `interrogate` | `high` | Blue |
| `implement` | `medium` | Green |
| `review` | `high` | Violet |
| `diagnose` | `xhigh` | Red |

The values above are defaults, not locked settings. You can change a built-in profile's model, reasoning effort, and color later. The built-in names are fixed and cannot be deleted, but each profile can be enabled or disabled. They inherit the provider and model active when the configuration is initialized.

The `interrogate` profile is selected by default when it is enabled. In the TUI:

| Action | Shortcut or command |
| --- | --- |
| Open the profile picker | `Ctrl+Space` |
| Cycle enabled profiles | `Ctrl+Q` |
| Open the picker | `/profile` |
| Disable the active profile | `/profile none` |

The picker supports enabling/disabling profiles, reordering them, changing their color, and managing custom profiles. Useful command forms include:

```text
/profile add <name> <provider/model> <effort> [color]
/profile remove <name>
/profile enable <name>
/profile disable <name>
/profile <name>
```

Interactive `/profile add` uses the models allowed by `/scoped-models`. In non-TUI mode, provide all required arguments explicitly.

### Context usage

After each completed turn, the footer shows usage in the form `ctx 117k`. A widget appears when usage reaches:

- **100,000 tokens** — reasoning quality may be declining; `/handoff` is recommended.
- **130,000 tokens** — reasoning quality may be degraded; `/handoff` is urgent.

The widget is cleared when a session starts or context usage is unavailable.

### Subagent policy

Each child resolves one agent definition before launch. Definitions are selected in project, user, then packaged precedence and declare the provider, model, reasoning level, role instructions, report contract, completion criteria, and least-privilege tools. A node can temporarily add named tools or override its provider, model, or reasoning level without changing that definition or a sibling node.

The child receives its declared working directory, task text, and fresh Pi resource discovery. It does not inherit the parent transcript, private reasoning, tool history, in-memory extension state, or secret values. Recursive orchestration and tools outside the effective allowlist are unavailable, and children do not receive interactive approval prompts.

These restrictions are runtime orchestration controls, not an OS sandbox. A child still runs with the local user's operating-system permissions; graph authors remain responsible for coordinating concurrent writes in a shared worktree.

### Native handoff

Run `/handoff` when the current session is becoming too large:

```text
/handoff
/handoff Focus on finishing the failing tests
```

The command:

1. Asks the active model to write a concise handoff document, including suggested skills and the optional next-session focus.
2. Redacts sensitive information and avoids duplicating existing artifacts such as plans, issues, ADRs, commits, and diffs.
3. Atomically writes and verifies the handoff artifact in an OS temporary directory outside the workspace.
4. Creates a pending replacement session containing the handoff context, without sending an automatic provider message.
5. Records a handoff marker in the source session when possible.

The replacement session waits for your next instruction, so you remain in control of when work resumes.

### Copy assistant code

Run `/copy-code` in interactive TUI mode to open a picker containing fenced code blocks from completed assistant replies.

- Type to filter by language, preview text, or turn number.
- Use `↑`/`↓` to select a block.
- Press `Enter` to copy only the block body, without its Markdown fences.
- Press `Esc` to cancel.

## Configuration

By default, profiles are stored at:

```text
~/.pi/agent/profiles.json
```

The path follows pi's configured agent directory, so `PI_CODING_AGENT_DIR` can change its location.

The picker is the recommended way to manage this file. A custom profile has this shape:

```json
{
  "id": "fast",
  "name": "Fast",
  "provider": "openai",
  "model": "gpt-5.4-mini",
  "thinkingLevel": "low",
  "color": "cyan",
  "enabled": true,
  "builtin": false
}
```

Supported reasoning levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Supported profile colors are `red`, `orange`, `yellow`, `green`, `blue`, `indigo`, `violet`, `cyan`, `pink`, `gray`, and `white`.

## Development

Clone the repository and install its development dependencies with Bun:

```bash
git clone https://github.com/simonteague6/pi-engineering-kit.git
cd pi-engineering-kit
bun install
```

Run the test suite and type checker:

```bash
bun test
bunx tsc --noEmit
```

The package does not require a build step. Pi loads the TypeScript extensions declared by the `pi` manifest in `package.json`.

### Project layout

```text
extensions/
├── context-usage-meter.ts   # Threshold warnings above the editor
├── copy-code.ts              # Searchable code-block clipboard picker
├── current-context-size.ts  # Footer context usage status
├── handoff.ts               # Native session transfer
└── profile.ts                # Model and reasoning profiles

tests/                       # Bun tests for extension behavior
docs/agents/                 # Repository workflow documentation
```

## Related documentation

- [Pi packages](https://pi.dev/docs/packages)
- [Pi extensions](https://pi.dev/docs/extensions)
- [Matt Pocock's skills repository](https://github.com/mattpocock/skills)
- [`CONTEXT.md`](./CONTEXT.md) — terminology for native session handoffs
