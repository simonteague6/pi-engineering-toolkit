import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createSubagentRuntime,
	type ChildRunner,
	type ChildRunnerRequest,
} from "../subagents/runtime.ts";

function singleNode(task = "Inspect the repository") {
	return {
		nodes: [{ logicalRole: "Recon", task }],
	};
}

async function withRuntime<T>(
	runner: ChildRunner,
	test: (runtime: ReturnType<typeof createSubagentRuntime>) => Promise<T>,
): Promise<T> {
	const storeDirectory = await mkdtemp(join(tmpdir(), "pi-subagent-runtime-"));
	try {
		return await test(createSubagentRuntime({ storeDirectory, runner }));
	} finally {
		await rm(storeDirectory, { recursive: true, force: true });
	}
}

describe("subagent runtime", () => {
	test("launches one child and returns stable IDs, plain-text output, artifacts, and usage", async () => {
		const requests: ChildRunnerRequest[] = [];
		const runner: ChildRunner = {
			run: async (request) => {
				requests.push(request);
				return {
					state: "completed",
					output: "Found the runtime boundary.",
					usage: { provider: "test", model: "deterministic", inputTokens: 12, outputTokens: 5 },
				};
			},
		};

		await withRuntime(runner, async (runtime) => {
			const launch = await runtime.launch(singleNode());

			expect(typeof launch.run.id).toBe("string");
			expect(launch.run.state).toBe("completed");
			expect(typeof launch.node.id).toBe("string");
			expect(launch.node.logicalRole).toBe("Recon");
			expect(launch.node.state).toBe("completed");
			expect(launch.node.result).toEqual({
				state: "completed",
				output: "Found the runtime boundary.",
				usage: { provider: "test", model: "deterministic", inputTokens: 12, outputTokens: 5 },
			});
			expect(launch.node.usage).toEqual({ provider: "test", model: "deterministic", inputTokens: 12, outputTokens: 5 });
			expect(launch.node.artifacts).toHaveLength(1);
			expect(launch.node.artifacts[0]!.kind).toBe("result");
			expect(typeof launch.node.artifacts[0]!.path).toBe("string");
			expect(requests).toHaveLength(1);
			expect(requests[0]).toMatchObject({ runId: launch.run.id, nodeId: launch.node.id, task: "Inspect the repository" });

			const status = await runtime.status(launch.run.id);
			expect(status).toEqual({
				run: { id: launch.run.id, state: "completed" },
				nodes: [{
					id: launch.node.id,
					logicalRole: "Recon",
					state: "completed",
					artifacts: launch.node.artifacts,
					usage: launch.node.usage,
				}],
			});
		});
	});

	test("snapshots the single-node graph before the child starts", async () => {
		let capturedRequest: ChildRunnerRequest | undefined;
		let releaseRunner: (() => void) | undefined;
		let runnerStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => { runnerStarted = resolve; });
		const runner: ChildRunner = {
			run: async (request) => {
				capturedRequest = request;
				runnerStarted!();
				await new Promise<void>((resolve) => { releaseRunner = resolve; });
				return { state: "completed", output: "done" };
			},
		};
		const graph = { nodes: [{ logicalRole: "Recon", task: "Inspect", tools: ["read"] }] };

		await withRuntime(runner, async (runtime) => {
			const launch = runtime.launch(graph);
			await started;
			graph.nodes[0]!.tools.push("bash");
			releaseRunner!();
			await launch;

			expect(capturedRequest!.tools).toEqual(["read"]);
		});
	});

	test("treats an empty terminal output as a successful durable result", async () => {
		const runner: ChildRunner = { run: async () => ({ state: "completed", output: "" }) };

		await withRuntime(runner, async (runtime) => {
			const launch = await runtime.launch(singleNode());
			const result = await runtime.result(launch.run.id, launch.node.id);

			expect(launch.node.state).toBe("completed");
			expect(result).toMatchObject({ state: "completed", output: "" });
		});
	});

	test("returns failed status with durable error evidence", async () => {
		const runner: ChildRunner = {
			run: async () => ({
				state: "failed",
				error: { kind: "execution", message: "provider rejected the request", stderr: "401 unauthorized" },
			}),
		};

		await withRuntime(runner, async (runtime) => {
			const launch = await runtime.launch(singleNode());
			const result = await runtime.result(launch.run.id, launch.node.id);

			expect(launch.run.state).toBe("failed");
			expect(launch.node).toMatchObject({
				state: "failed",
				result: { state: "failed", error: { kind: "execution", message: "provider rejected the request" } },
			});
			expect(result).toMatchObject({ state: "failed", error: { stderr: "401 unauthorized" } });
		});
	});

	test("does not expose completed status until the durable result can be read", async () => {
		const runner: ChildRunner = { run: async () => ({ state: "completed", output: "saved first" }) };

		await withRuntime(runner, async (runtime) => {
			const launch = await runtime.launch(singleNode());
			const resultArtifact = launch.node.artifacts.find((artifact) => artifact.kind === "result");

			expect(launch.node.state).toBe("completed");
			expect(await readFile(resultArtifact!.path, "utf8")).toContain("saved first");
			expect(await runtime.result(launch.run.id, launch.node.id)).toMatchObject({ output: "saved first" });
		});
	});
});
