import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	registerSubagentTools,
	type SubagentTool,
} from "../extensions/subagent-tools.ts";
import type {
	LaunchReceipt,
	LaunchResult,
	StatusView,
	SubagentRuntime,
} from "../subagents/runtime.ts";

function runtimeFixture(): { runtime: SubagentRuntime; calls: Array<{ operation: string; args: unknown }> } {
	const calls: Array<{ operation: string; args: unknown }> = [];
	const result: LaunchResult = {
		run: { id: "run_123", state: "completed" },
		nodes: [{
			id: "node-1",
			agent: "worker",
			logicalRole: "Implement",
			state: "completed",
			policy: {
				agent: "worker",
				provider: "openai",
				model: "gpt-test",
				reasoning: "medium",
				tools: ["read"],
				cwd: "/repo",
				runnerMode: "subprocess-json",
				freshResources: true,
				recursiveDelegation: false,
				approvalPrompts: false,
			},
			artifacts: [{ kind: "result", path: "/store/result.json" }],
			result: {
				state: "completed",
				output: "x".repeat(100_000),
				policy: {
					agent: "worker",
					provider: "openai",
					model: "gpt-test",
					reasoning: "medium",
					tools: ["read"],
					cwd: "/repo",
					runnerMode: "subprocess-json",
					freshResources: true,
					recursiveDelegation: false,
					approvalPrompts: false,
				},
			},
		}],
		finalOutput: "y".repeat(100_000),
		trace: [{ nodeId: "node-1", logicalRole: "Implement", state: "completed", predecessorIds: [] }],
		artifacts: [{ kind: "graph-result", path: "/store/graph-result.json" }],
		handoffs: [],
	};
	const receipt: LaunchReceipt = { run: { id: "run_456", state: "running" } };
	const status: StatusView = {
		run: { id: "run_123", state: "running" },
		nodes: [],
	};
	const runtime = {
		launch: async (graph: unknown, options?: unknown) => {
			calls.push({ operation: "launch", args: { graph, options } });
			return options && (options as { delivery?: string }).delivery === "blocking" ? result : receipt;
		},
		status: async (runId: string) => { calls.push({ operation: "status", args: runId }); return status; },
		join: async (runId: string) => { calls.push({ operation: "join", args: runId }); return result; },
		cancel: async (runId: string, nodeId?: string) => { calls.push({ operation: "cancel", args: { runId, nodeId } }); return result; },
		resume: async (runId: string) => { calls.push({ operation: "resume", args: runId }); return result; },
		recover: async (runId: string, plan: unknown, options?: unknown) => {
			calls.push({ operation: "recover", args: { runId, plan, options } });
			return options && (options as { delivery?: string }).delivery === "blocking" ? result : receipt;
		},
		dispose: async () => {},
		cleanup: async () => ({ removedRunIds: [], preservedRunIds: [] }),
		events: async () => [],
		result: async () => result.nodes[0]!.result!,
	} as unknown as SubagentRuntime;
	return { runtime, calls };
}

function register(): { tools: Map<string, SubagentTool>; calls: Array<{ operation: string; args: unknown }> } {
	const { runtime, calls } = runtimeFixture();
	const tools = new Map<string, SubagentTool>();
	const pi = { registerTool: (tool: SubagentTool) => tools.set(tool.name, tool) } as unknown as ExtensionAPI;
	registerSubagentTools(pi, () => runtime);
	return { tools, calls };
}

const context = { cwd: "/repo", modelRegistry: {} } as any;

function execute(tool: SubagentTool, params: any, signal?: AbortSignal): Promise<any> {
	return tool.execute("tool-call", params, signal, undefined, context);
}

describe("subagent parent tools", () => {
	test("registers six separate parent operations", () => {
		const { tools } = register();
		expect([...tools.keys()]).toEqual([
			"subagent_launch",
			"subagent_status",
			"subagent_join",
			"subagent_cancel",
			"subagent_resume",
			"subagent_recover",
		]);
	});

	test("translates launch input and keeps detached output compact", async () => {
		const { tools, calls } = register();
		const response = await execute(tools.get("subagent_launch")!, {
			graph: {
				kind: "single",
				node: { agent: "worker", logicalRole: "Implement", task: "Do work" },
			},
		});

		expect(calls[0]).toEqual({
			operation: "launch",
			args: {
				graph: {
					kind: "single",
					node: { agent: "worker", logicalRole: "Implement", task: "Do work" },
				},
				options: { delivery: "detached" },
			},
		});
		expect(response.details).toMatchObject({ operation: "launch", run: { id: "run_456" } });
		expect(JSON.stringify(response.details)).not.toContain("x".repeat(100));
		expect(JSON.stringify(response.details)).not.toContain("y".repeat(100));
		expect(response.content[0]?.type).toBe("text");
		expect(response.content[0]?.text.length).toBeLessThan(50_000);
	});

	test("translates and executes status, join, cancel, resume, and recovery", async () => {
		const { tools, calls } = register();
		await execute(tools.get("subagent_status")!, { runId: "run_1" });
		await execute(tools.get("subagent_join")!, { runId: "run_1" });
		await execute(tools.get("subagent_cancel")!, { runId: "run_1", nodeId: "node-2" });
		await execute(tools.get("subagent_resume")!, { runId: "run_1" });
		await execute(tools.get("subagent_recover")!, {
			runId: "run_1",
			plan: { replacements: [{ logicalRole: "Implement", correction: "Retry" }] },
			delivery: "blocking",
		});

		expect(calls.map(({ operation }) => operation)).toEqual(["status", "join", "cancel", "resume", "recover"]);
		expect(calls[2]?.args).toEqual({ runId: "run_1", nodeId: "node-2" });
		expect(calls[4]?.args).toEqual({
			runId: "run_1",
			plan: { replacements: [{ logicalRole: "Implement", correction: "Retry" }] },
			options: { delivery: "blocking" },
		});
	});

	test("forwards a parent abort to runtime cancellation", async () => {
		const { tools, calls } = register();
		const controller = new AbortController();
		const pending = execute(tools.get("subagent_join")!, { runId: "run_1" }, controller.signal);
		controller.abort();
		await pending;
		expect(calls).toContainEqual({ operation: "cancel", args: { runId: "run_1", nodeId: undefined } });
	});

	test("cancels a blocking launch when its parent aborts", async () => {
		const { tools, calls } = register();
		const controller = new AbortController();
		const pending = execute(tools.get("subagent_launch")!, {
			graph: { kind: "single", node: { agent: "worker", logicalRole: "Implement", task: "Do work" } },
			delivery: "blocking",
		}, controller.signal);
		controller.abort();
		await pending;
		expect(calls).toContainEqual({ operation: "cancel", args: { runId: "run_456", nodeId: undefined } });
		expect(calls.filter(({ operation }) => operation === "cancel")).toHaveLength(1);
	});

	test("renders active and terminal lifecycle states", () => {
		const { tools } = register();
		const tool = tools.get("subagent_status")!;
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as any;
		const render = tool.renderResult!;
		const active = render({ content: [{ type: "text", text: "{}" }], details: { operation: "status", state: "running", run: { id: "run_1", state: "running" } } }, { expanded: false, isPartial: false }, theme, {} as any);
		const terminal = render({ content: [{ type: "text", text: "{}" }], details: { operation: "status", state: "completed", run: { id: "run_1", state: "completed" } } }, { expanded: false, isPartial: false }, theme, {} as any);
		expect(active).toBeDefined();
		expect(terminal).toBeDefined();
	});

	test("preserves thrown runtime errors", async () => {
		const error = new Error("runtime unavailable");
		const tools = new Map<string, SubagentTool>();
		const pi = { registerTool: (tool: SubagentTool) => tools.set(tool.name, tool) } as unknown as ExtensionAPI;
		registerSubagentTools(pi, () => ({
			...runtimeFixture().runtime,
			status: async () => { throw error; },
		} as SubagentRuntime));
		await expect(execute(tools.get("subagent_status")!, { runId: "run_1" })).rejects.toBe(error);
	});
});
