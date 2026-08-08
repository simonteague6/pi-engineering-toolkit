import { describe, expect, test } from "bun:test";
import {
	controlCenterReducer,
	controlCenterViewModel,
	createControlCenterState,
	nodeKey,
	runKey,
	type ControlCenterState,
} from "../extensions/subagent-control-center-model.ts";
import type { StatusView } from "../subagents/runtime.ts";

function runs(): StatusView[] {
	return [{
		run: { id: "run_1", state: "failed" },
		usage: { inputTokens: 10, outputTokens: 20, contextTokens: 30, cost: 0.25, unavailable: [] },
		nodes: [
		{ id: "research", agent: "researcher", logicalRole: "Research", state: "completed", dependencies: [], policy: {} as never, artifacts: [] },
		{ id: "implement", agent: "worker", logicalRole: "Implement", state: "failed", dependencies: ["research"], policy: {} as never, artifacts: [], blockedBy: [] },
		{ id: "review", agent: "spec-reviewer", logicalRole: "Review", state: "queued", dependencies: ["implement"], policy: {} as never, artifacts: [] },
		],
	}];
}

describe("subagent control-center view model", () => {
	test("derives a split-view list and dependency edges from runtime status", () => {
		const state = createControlCenterState(runs());
		const view = controlCenterViewModel(state);

		expect(view.rows.map((row) => row.key)).toEqual([
			runKey("run_1"),
			nodeKey("run_1", "research"),
			nodeKey("run_1", "implement"),
			nodeKey("run_1", "review"),
		]);
		expect(view.graphEdges).toEqual([
			{ from: "research", to: "implement" },
			{ from: "implement", to: "review" },
		]);
	});

	test("keeps list and graph selection synchronized while navigating", () => {
		let state = createControlCenterState(runs());
		state = controlCenterReducer(state, { type: "move", delta: 1 });
		state = controlCenterReducer(state, { type: "move", delta: 1 });
		const view = controlCenterViewModel(state);

		expect(state.selected).toEqual({ kind: "node", runId: "run_1", nodeId: "implement" });
		expect(view.graphNodes.find((node) => node.id === "implement")?.selected).toBe(true);
	});

	test("switches to settings and preserves selection bounds after refresh", () => {
		let state: ControlCenterState = createControlCenterState(runs());
		state = controlCenterReducer(state, { type: "tab", tab: "settings" });
		expect(state.tab).toBe("settings");
		expect(state.selected).toBeUndefined();
		state = controlCenterReducer(state, { type: "replace-runs", runs: [] });
		expect(state.selected).toBeUndefined();
	});
});
