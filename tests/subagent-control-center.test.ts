import { describe, expect, test } from "bun:test";
import { ControlCenterComponent } from "../extensions/subagent-control-center.ts";
import {
	controlCenterReducer,
	controlCenterViewModel,
	createControlCenterState,
	nodeKey,
	runKey,
	type ControlCenterState,
} from "../extensions/subagent-control-center-model.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
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

const testTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

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

describe("subagent control-center component", () => {
	test("handles navigation in place instead of closing and reopening the overlay", () => {
		const actions: string[] = [];
		const component = new ControlCenterComponent(
			testTheme,
			createControlCenterState(runs()),
			(action) => actions.push(action.type),
			() => undefined,
		);

		component.handleInput("j");

		expect(actions).toEqual([]);
		expect(component.getState().selected).toEqual({ kind: "node", runId: "run_1", nodeId: "research" });

		component.handleInput("\r");
		expect(actions).toEqual(["open"]);
	});

	test("fills the overlay to the terminal height", () => {
		const component = new ControlCenterComponent(
			testTheme,
			createControlCenterState(),
			() => undefined,
			() => undefined,
			() => 12,
		);

		const lines = component.render(40);

		expect(lines).toHaveLength(12);
		expect(lines[0]).toStartWith("╭");
		expect(lines.at(-1)).toStartWith("╰");
	});
});
