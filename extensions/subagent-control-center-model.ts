import type { AgentDefinitionInfo } from "../subagents/definitions.ts";
import type { LifecycleState, StatusView } from "../subagents/runtime.ts";

export type ControlCenterTab = "runs" | "settings";
export type ControlCenterSelection = { kind: "run"; runId: string } | { kind: "node"; runId: string; nodeId: string } | { kind: "definition"; id: string };

export interface ControlCenterState {
	readonly tab: ControlCenterTab;
	readonly selected: ControlCenterSelection | undefined;
	readonly runs: readonly StatusView[];
	readonly definitions: readonly AgentDefinitionInfo[];
}

export type ControlCenterAction =
	| { type: "tab"; tab?: ControlCenterTab }
	| { type: "move"; delta: -1 | 1 }
	| { type: "select"; selection: ControlCenterSelection }
	| { type: "replace-runs"; runs: readonly StatusView[] }
	| { type: "replace-definitions"; definitions: readonly AgentDefinitionInfo[] };

export interface RunListRow {
	readonly key: string;
	readonly kind: "run" | "node";
	readonly runId: string;
	readonly nodeId?: string;
	readonly label: string;
	readonly definitionId?: string;
	readonly role?: string;
	readonly state: LifecycleState;
	readonly usage?: StatusView["nodes"][number]["usage"];
	readonly blockedBy?: readonly string[];
}

export interface GraphNodeView {
	readonly key: string;
	readonly id: string;
	readonly role: string;
	readonly definitionId: string;
	readonly state: LifecycleState;
	readonly dependencies: readonly string[];
	readonly selected: boolean;
}

export interface ControlCenterViewModel {
	readonly tab: ControlCenterTab;
	readonly selected: ControlCenterSelection | undefined;
	readonly rows: readonly RunListRow[];
	readonly selectedRun?: StatusView;
	readonly graphNodes: readonly GraphNodeView[];
	readonly graphEdges: readonly { from: string; to: string }[];
	readonly definitions: readonly AgentDefinitionInfo[];
}

export function createControlCenterState(
	runs: readonly StatusView[] = [],
	definitions: readonly AgentDefinitionInfo[] = [],
): ControlCenterState {
	const state: ControlCenterState = { tab: "runs", selected: undefined, runs: [...runs], definitions: [...definitions] };
	return selectFirst(state);
}

export function controlCenterReducer(state: ControlCenterState, action: ControlCenterAction): ControlCenterState {
	switch (action.type) {
		case "tab": {
			const tab = action.tab ?? (state.tab === "runs" ? "settings" : "runs");
			return selectFirst({ ...state, tab });
		}
		case "move": {
			const keys = selectableSelections(state);
			if (keys.length === 0) return state;
			const current = state.selected ? selectionKey(state.selected) : "";
			const index = Math.max(0, keys.findIndex((selection) => selectionKey(selection) === current));
			const next = (index + action.delta + keys.length) % keys.length;
			return { ...state, selected: keys[next] };
		}
		case "select":
			return isSelectionAvailable(state, action.selection) ? { ...state, selected: action.selection } : state;
		case "replace-runs":
			return selectFirst({ ...state, runs: [...action.runs] });
		case "replace-definitions":
			return selectFirst({ ...state, definitions: [...action.definitions] });
	}
}

export function controlCenterViewModel(state: ControlCenterState): ControlCenterViewModel {
	const rows: RunListRow[] = [];
	for (const run of state.runs) {
		rows.push({ key: runKey(run.run.id), kind: "run", runId: run.run.id, label: run.run.id, state: run.run.state, usage: run.usage });
		for (const node of run.nodes) {
			rows.push({
				key: nodeKey(run.run.id, node.id),
				kind: "node",
				runId: run.run.id,
				nodeId: node.id,
				label: node.logicalRole,
				definitionId: node.agent,
				role: node.logicalRole,
				state: node.state,
				usage: node.usage,
				blockedBy: node.blockedBy,
			});
		}
	}
	const selectedRunId = state.selected && "runId" in state.selected ? state.selected.runId : undefined;
	const selectedRun = state.runs.find((run) => run.run.id === selectedRunId);
	const selectedNodeId = state.selected?.kind === "node" ? state.selected.nodeId : undefined;
	const graphNodes = (selectedRun?.nodes ?? []).map((node) => ({
		key: nodeKey(selectedRun!.run.id, node.id),
		id: node.id,
		role: node.logicalRole,
		definitionId: node.agent,
		state: node.state,
		dependencies: node.dependencies ?? [],
		selected: selectedNodeId === node.id,
	}));
	const graphEdges = graphNodes.flatMap((node) => node.dependencies.map((from) => ({ from, to: node.id })));
	return { tab: state.tab, selected: state.selected, rows, selectedRun, graphNodes, graphEdges, definitions: state.definitions };
}

export function selectionKey(selection: ControlCenterSelection): string {
	if (selection.kind === "run") return runKey(selection.runId);
	if (selection.kind === "node") return nodeKey(selection.runId, selection.nodeId);
	return definitionKey(selection.id);
}

export function runKey(runId: string): string { return `run:${runId}`; }
export function nodeKey(runId: string, nodeId: string): string { return `node:${runId}/${nodeId}`; }
export function definitionKey(id: string): string { return `definition:${id}`; }

function selectableSelections(state: ControlCenterState): ControlCenterSelection[] {
	if (state.tab === "settings") return state.definitions.map((definition) => ({ kind: "definition", id: definition.id }));
	return state.runs.flatMap((run) => [
		{ kind: "run" as const, runId: run.run.id },
		...run.nodes.map((node) => ({ kind: "node" as const, runId: run.run.id, nodeId: node.id })),
	]);
}

function isSelectionAvailable(state: ControlCenterState, selection: ControlCenterSelection | undefined): boolean {
	if (!selection) return false;
	return selectableSelections(state).some((candidate) => selectionKey(candidate) === selectionKey(selection));
}

function selectFirst(state: ControlCenterState): ControlCenterState {
	if (isSelectionAvailable(state, state.selected)) return state;
	return { ...state, selected: selectableSelections(state)[0] };
}
