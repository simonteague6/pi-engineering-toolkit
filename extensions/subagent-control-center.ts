import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	defaultDefinitionDirectories,
	listAgentDefinitions,
	updateAgentDefinition,
	type AgentDefinitionInfo,
	type DefinitionDirectories,
} from "../subagents/definitions.ts";
import {
	createSubagentRuntime,
	type NodeResult,
	type StatusView,
	type SubagentRuntime,
} from "../subagents/runtime.ts";
import {
	controlCenterReducer,
	controlCenterViewModel,
	createControlCenterState,
	type ControlCenterAction,
	type ControlCenterState,
	type ControlCenterSelection,
} from "./subagent-control-center-model.ts";

const REFRESH_MS = 750;
const CONTROL_CENTER_COMMAND = "subagents";

type ViewAction = ControlCenterAction | { type: "close" } | { type: "open" };

class ControlCenterComponent {
	private state: ControlCenterState;
	private refreshTimer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly theme: Theme,
		state: ControlCenterState,
		private readonly done: (action: ViewAction) => void,
		private readonly onRefresh: (apply: (runs: readonly StatusView[]) => void) => void,
	) {
		this.state = state;
	}

	startRefresh(tui: { requestRender(): void }): void {
		this.refreshTimer = setInterval(() => {
			this.onRefresh((runs) => {
				this.state = controlCenterReducer(this.state, { type: "replace-runs", runs });
				tui.requestRender();
			});
		}, REFRESH_MS);
	}

	setState(state: ControlCenterState): void { this.state = state; }
	getState(): ControlCenterState { return this.state; }

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) return this.done({ type: "close" });
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.left) || matchesKey(data, Key.right) || data === "h" || data === "l") {
			return this.done({ type: "tab" });
		}
		if (matchesKey(data, Key.up) || data === "k") return this.done({ type: "move", delta: -1 });
		if (matchesKey(data, Key.down) || data === "j") return this.done({ type: "move", delta: 1 });
		if (matchesKey(data, Key.enter)) return this.done({ type: "open" });
	}

	render(width: number): string[] {
		const inner = Math.max(1, width - 2);
		const title = ` ${this.theme.fg("accent", this.theme.bold("SUBAGENTS"))}   ${this.tabLabel("runs", "Runs")}   ${this.tabLabel("settings", "Settings")}`;
		const lines = [
			this.theme.fg("borderAccent", `╭${"─".repeat(inner)}╮`),
			this.frame(title, inner),
			this.frame("", inner),
			...(this.state.tab === "runs" ? this.renderRuns(inner) : this.renderSettings(inner)),
			this.frame("", inner),
			this.frame(this.state.tab === "runs"
				? " ↑↓/jk select · enter detail · tab/←→ settings · esc close"
				: " ↑↓/jk select · enter edit defaults · tab/←→ runs · esc close", inner),
			this.theme.fg("borderAccent", `╰${"─".repeat(inner)}╯`),
		];
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	invalidate(): void {}

	dispose(): void {
		if (this.refreshTimer !== undefined) clearInterval(this.refreshTimer);
		this.refreshTimer = undefined;
	}

	private renderRuns(width: number): string[] {
		const split = Math.max(28, Math.min(44, Math.floor((width - 3) * 0.42)));
		const graphWidth = Math.max(1, width - split - 3);
		const view = controlCenterViewModel(this.state);
		const listLines = [
			this.theme.fg("muted", `${view.rows.filter((row) => row.kind === "run").length} runs · current session`),
			...(view.rows.length === 0 ? [this.theme.fg("dim", "No subagent runs yet.")] : view.rows.map((row) => this.renderRow(row))),
		];
		const graphLines = this.renderGraph(view, graphWidth);
		const rows = Math.max(listLines.length, graphLines.length);
		return Array.from({ length: rows }, (_, index) => {
			const left = this.pad(listLines[index] ?? "", split);
			const right = truncateToWidth(graphLines[index] ?? "", graphWidth, "");
			return this.frame(` ${left} ${this.theme.fg("border", "│")} ${this.pad(right, graphWidth)}`, width);
		});
	}

	private renderSettings(width: number): string[] {
		const view = controlCenterViewModel(this.state);
		const lines = [
			this.theme.fg("muted", "DEFINITION DEFAULTS · changes are written to the selected definition source"),
			...(view.definitions.length === 0 ? [this.theme.fg("dim", "No agent definitions found.")] : view.definitions.map((definition) => this.renderDefinition(definition))),
		];
		const selectedId = this.state.selected?.kind === "definition" ? this.state.selected.id : undefined;
		const selected = selectedId === undefined ? undefined : view.definitions.find((definition) => definition.id === selectedId);
		if (selected) {
			lines.push("", this.theme.fg("dim", `Source: ${selected.path}`));
			lines.push(this.theme.fg("dim", "Enter chooses a scoped model, then a reasoning level."));
		} else {
			lines.push("", this.theme.fg("dim", "Select a definition to edit its provider/model/reasoning defaults."));
		}
		return lines.map((line) => this.frame(` ${line}`, width));
	}

	private renderGraph(view: ReturnType<typeof controlCenterViewModel>, width: number): string[] {
		if (!view.selectedRun) return [this.theme.fg("dim", "RUN GRAPH"), this.theme.fg("dim", "Select a run to inspect its graph.")];
		const run = view.selectedRun;
		const lines = [this.theme.fg("muted", `RUN GRAPH · ${run.run.id} · ${stateLabel(run.run.state)}`)];
		if (view.graphNodes.length === 0) return lines;
		for (const node of view.graphNodes) {
			const selected = node.selected || (view.selected?.kind === "run" && view.selected.runId === run.run.id && view.graphNodes.length === 1);
			const label = `${statusIcon(node.state, this.theme)} ${node.role} · ${node.definitionId} (${node.id})`;
			const boxWidth = Math.max(16, Math.min(width, visibleWidth(label) + 2));
			const color = selected ? "borderAccent" : "border";
			lines.push(this.theme.fg(color, `╭${"─".repeat(Math.max(1, boxWidth - 2))}╮`));
			lines.push(this.theme.fg(color, "│") + ` ${truncateToWidth(label, Math.max(1, boxWidth - 2), "…")} ` + this.theme.fg(color, "│"));
			lines.push(this.theme.fg(color, `╰${"─".repeat(Math.max(1, boxWidth - 2))}╯`));
			if (node.dependencies.length > 0) lines.push(this.theme.fg("dim", `  └─ requires: ${node.dependencies.join(", ")}`));
		}
		if (view.graphEdges.length > 0) lines.push(this.theme.fg("dim", `  ${view.graphEdges.length} dependency edge${view.graphEdges.length === 1 ? "" : "s"}`));
		return lines;
	}

	private renderRow(row: ReturnType<typeof controlCenterViewModel>["rows"][number]): string {
		const selected = this.state.selected && selectionKey(this.state.selected) === row.key;
		const prefix = selected ? this.theme.fg("accent", "›") : " ";
		const indent = row.kind === "node" ? "  " : "";
		const label = row.kind === "run" ? row.label : `${row.label} · ${row.definitionId}`;
		const usage = formatUsage(row.usage);
		return `${prefix} ${indent}${statusIcon(row.state, this.theme)} ${this.theme.fg(selected ? "text" : "muted", selected ? this.theme.bold(label) : label)} ${this.theme.fg("dim", usage)}`;
	}

	private renderDefinition(definition: AgentDefinitionInfo): string {
		const selected = this.state.selected?.kind === "definition" && this.state.selected.id === definition.id;
		const prefix = selected ? this.theme.fg("accent", "›") : " ";
		const value = `${definition.provider}/${definition.model} · ${definition.reasoning}`;
		return `${prefix} ${this.theme.fg(selected ? "text" : "muted", selected ? this.theme.bold(definition.id) : definition.id)} ${this.theme.fg("accent", value)} ${this.theme.fg("dim", `[${definition.source}]`)}`;
	}

	private tabLabel(tab: "runs" | "settings", label: string): string {
		return tab === this.state.tab ? this.theme.fg("text", this.theme.bold(`[ ${label} ]`)) : this.theme.fg("dim", label);
	}

	private frame(value: string, width: number): string {
		const content = truncateToWidth(value, Math.max(1, width), "");
		return this.theme.fg("border", "│") + content + " ".repeat(Math.max(0, width - visibleWidth(content))) + this.theme.fg("border", "│");
	}

	private pad(value: string, width: number): string {
		const content = truncateToWidth(value, width, "");
		return content + " ".repeat(Math.max(0, width - visibleWidth(content)));
	}
}

class DetailComponent {
	constructor(private readonly theme: Theme, private readonly title: string, private readonly result: NodeResult | undefined, private readonly message: string) {}
	render(width: number): string[] {
		const inner = Math.max(1, width - 2);
		const output = this.result?.output;
		const body = output === undefined ? [this.theme.fg("warning", this.message)] : output.split("\n").slice(0, 80).map((line) => this.theme.fg("toolOutput", line));
		const lines = [
			this.theme.fg("borderAccent", `╭${"─".repeat(inner)}╮`),
			this.frame(` ${this.theme.fg("accent", this.theme.bold(this.title))}`, inner),
			this.frame(` state: ${this.result?.state ?? "running"}`, inner),
			this.frame("", inner),
			...body.map((line) => this.frame(` ${line}`, inner)),
			this.frame("", inner),
			this.frame(" Esc/Enter close · output is durable result data, not a persisted transcript", inner),
			this.theme.fg("borderAccent", `╰${"─".repeat(inner)}╯`),
		];
		return lines.map((line) => truncateToWidth(line, width, ""));
	}
	handleInput(data: string, done: () => void): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) done();
	}
	invalidate(): void {}
	private frame(value: string, width: number): string {
		const content = truncateToWidth(value, width, "");
		return this.theme.fg("border", "│") + content + " ".repeat(Math.max(0, width - visibleWidth(content))) + this.theme.fg("border", "│");
	}
}

function selectionKey(selection: ControlCenterSelection): string {
	if (selection.kind === "run") return `run:${selection.runId}`;
	if (selection.kind === "node") return `node:${selection.runId}/${selection.nodeId}`;
	return `definition:${selection.id}`;
}

function stateLabel(state: string): string { return state.toUpperCase(); }

function statusIcon(state: string, theme: Theme): string {
	const color = state === "completed" ? "success" : state === "failed" || state === "cancelled" ? "error" : state === "running" ? "accent" : "warning";
	const icon = state === "completed" ? "●" : state === "failed" ? "✗" : state === "cancelled" ? "×" : state === "running" ? "◉" : "○";
	return theme.fg(color, icon);
}

function formatUsage(usage: StatusView["nodes"][number]["usage"] | undefined): string {
	if (!usage) return "—";
	const parts = [
		tokenLabel(usage.inputTokens, "in"),
		tokenLabel(usage.outputTokens, "out"),
		tokenLabel(usage.contextTokens, "ctx"),
		usage.cost === undefined ? undefined : `$${usage.cost.toFixed(2)}`,
		usage.durationMs === undefined ? undefined : `${Math.round(usage.durationMs / 1000)}s`,
	].filter((part): part is string => part !== undefined);
	return parts.length > 0 ? parts.join(" ") : "—";
}

function tokenLabel(value: number | "unavailable" | undefined, label: string): string | undefined {
	if (value === undefined) return undefined;
	if (value === "unavailable") return `${label}:?`;
	return `${label}:${value >= 1000 ? `${Math.floor(value / 1000)}k` : value}`;
}

interface ScopedModelChoice {
	readonly model: { readonly provider: string; readonly id: string };
	readonly thinkingLevel?: string;
}

function modelChoices(ctx: ExtensionContext): Array<{ label: string; provider: string; model: string; reasoning?: string }> {
	const scopedModels = (ctx as ExtensionContext & { scopedModels?: readonly ScopedModelChoice[] }).scopedModels ?? [];
	const scoped: readonly ScopedModelChoice[] = scopedModels.length > 0 ? scopedModels : ctx.modelRegistry.getAvailable().map((model) => ({ model }));
	return scoped.map(({ model, thinkingLevel }) => ({
		label: `${model.provider}/${model.id}${thinkingLevel ? ` · ${thinkingLevel}` : ""}`,
		provider: model.provider,
		model: model.id,
		reasoning: thinkingLevel,
	}));
}

async function editDefinition(ctx: ExtensionContext, directories: DefinitionDirectories, definition: AgentDefinitionInfo): Promise<AgentDefinitionInfo | undefined> {
	const choices = modelChoices(ctx);
	if (choices.length === 0) {
		ctx.ui.notify("No scoped models are available.", "warning");
		return undefined;
	}
	const selectedLabel = await ctx.ui.select("Definition model", choices.map((choice) => choice.label));
	const selected = choices.find((choice) => choice.label === selectedLabel);
	if (!selected) return undefined;
	const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	const reasoning = await ctx.ui.select("Definition reasoning", levels);
	if (!reasoning || !levels.includes(reasoning)) return undefined;
	return updateAgentDefinition(definition.id, directories, { provider: selected.provider, model: selected.model, reasoning: reasoning as AgentDefinitionInfo["reasoning"] });
}

async function showDetail(ctx: ExtensionContext, title: string, result: NodeResult | undefined, message: string): Promise<void> {
	if (ctx.mode !== "tui") return;
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const component = new DetailComponent(theme, title, result, message);
		return {
			render: (width) => component.render(width),
			handleInput: (data) => { component.handleInput(data, done); tui.requestRender(); },
			invalidate: () => component.invalidate(),
		};
	}, { overlay: true, overlayOptions: { width: "100%", minWidth: 72, maxHeight: "100%", anchor: "center", margin: 0 } });
}

async function openControlCenter(ctx: ExtensionContext, runtime: SubagentRuntime, directories: DefinitionDirectories): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/subagents requires TUI mode.", "error");
		return;
	}
	let state = createControlCenterState(await runtime.runs(), await listAgentDefinitions(directories));
	while (true) {
		let component: ControlCenterComponent | undefined;
		const action = await ctx.ui.custom<ViewAction>((tui, theme, _keybindings, done) => {
			component = new ControlCenterComponent(theme, state, done, (apply) => {
				void runtime.runs().then(apply).catch(() => undefined);
			});
			component.startRefresh(tui);
			return {
				render: (width) => component!.render(width),
				handleInput: (data) => component!.handleInput(data),
				invalidate: () => component!.invalidate(),
				dispose: () => component!.dispose(),
			};
		}, { overlay: true, overlayOptions: { width: "100%", minWidth: 72, maxHeight: "100%", anchor: "center", margin: 0 } });
		if (!action || action.type === "close") return;
		state = component?.getState() ?? state;
		if (action.type === "open") {
			const selected = state.selected;
			if (selected?.kind === "node") {
				let result: NodeResult | undefined;
				let message = "Child is live, but no durable result is available yet.";
				try {
					result = await runtime.result(selected.runId, selected.nodeId);
					message = "";
				} catch (error) {
					message = error instanceof Error ? error.message : String(error);
				}
				await showDetail(ctx, `${selected.runId}/${selected.nodeId}`, result, message);
			} else if (selected?.kind === "run") {
				await showDetail(ctx, selected.runId, undefined, "Select a child node to inspect its available result data.");
			} else if (selected?.kind === "definition") {
				const definition = state.definitions.find((candidate) => candidate.id === selected.id);
				if (definition) {
					const updated = await editDefinition(ctx, directories, definition);
					if (updated) {
						state = controlCenterReducer(state, { type: "replace-definitions", definitions: await listAgentDefinitions(directories) });
						ctx.ui.notify(`Updated ${updated.id} defaults in ${updated.path}.`, "info");
					}
				}
			}
			continue;
		}
		state = controlCenterReducer(state, action);
	}
}

export default function subagentControlCenter(pi: ExtensionAPI): void {
	let runtime: SubagentRuntime | undefined;
	let runtimeSession: string | undefined;
	const getRuntime = (ctx: ExtensionContext): SubagentRuntime => {
		const parentSessionId = ctx.sessionManager.getSessionFile() ?? `ephemeral:${ctx.cwd}`;
		if (!runtime || runtimeSession !== parentSessionId) {
			runtime = createSubagentRuntime({
				cwd: ctx.cwd,
				parentSessionId,
				modelCatalog: { isAvailable: (provider, model) => ctx.modelRegistry.find(provider, model) !== undefined },
			});
			runtimeSession = parentSessionId;
		}
		return runtime;
	};

	const open = async (ctx: ExtensionContext): Promise<void> => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/subagents requires TUI mode.", "error");
			return;
		}
		const directories = defaultDefinitionDirectories(ctx.cwd);
		await openControlCenter(ctx, getRuntime(ctx), directories);
	};
	pi.registerCommand(CONTROL_CENTER_COMMAND, {
		description: "Open the current-session subagent control center",
		handler: async (_args, ctx) => open(ctx),
	});
	pi.registerShortcut(Key.ctrlAlt("s"), {
		description: "Open the subagent control center",
		handler: async (ctx) => open(ctx),
	});
	pi.on("session_shutdown", async () => {
		await runtime?.dispose();
		runtime = undefined;
		runtimeSession = undefined;
	});
}
