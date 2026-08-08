import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createSubagentRuntime,
	SubprocessJsonRunner,
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

async function withSubprocessRunner<T>(
	script: string,
	test: (runner: SubprocessJsonRunner) => Promise<T>,
): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "pi-subprocess-runner-"));
	const executable = join(directory, "fake-pi");
	await writeFile(executable, `#!/usr/bin/env bun\n${script}`, "utf8");
	await chmod(executable, 0o755);
	try {
		return await test(new SubprocessJsonRunner(executable));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function childRequest(): ChildRunnerRequest {
	return {
		runId: "run_test",
		nodeId: "node_test",
		logicalRole: "Recon",
		task: "Inspect the repository",
		cwd: process.cwd(),
	};
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
				usage: expect.objectContaining({
					provider: "test",
					model: "deterministic",
					inputTokens: 12,
					outputTokens: 5,
					durationMs: expect.any(Number),
				}),
			});
			expect(launch.node.usage).toMatchObject({ provider: "test", model: "deterministic", inputTokens: 12, outputTokens: 5 });
			expect(launch.node.usage?.durationMs).toBeGreaterThanOrEqual(0);
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
		let request: ChildRunnerRequest | undefined;
		let releaseRunner: (() => void) | undefined;
		let runnerStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => { runnerStarted = resolve; });
		const runner: ChildRunner = {
			run: async (runnerRequest) => {
				request = runnerRequest;
				runnerStarted!();
				await new Promise<void>((resolve) => { releaseRunner = resolve; });
				return { state: "completed", output: "saved first" };
			},
		};

		await withRuntime(runner, async (runtime) => {
			const launch = runtime.launch(singleNode());
			await started;
			expect((await runtime.status(request!.runId)).run.state).toBe("running");

			releaseRunner!();
			let terminalStatus = await runtime.status(request!.runId);
			while (terminalStatus.run.state !== "completed") {
				await Promise.resolve();
				terminalStatus = await runtime.status(request!.runId);
			}

			expect(terminalStatus.nodes[0]!.state).toBe("completed");
			expect(await runtime.result(request!.runId, request!.nodeId)).toMatchObject({ output: "saved first" });
			expect((await launch).node.state).toBe("completed");
		});
	});
});

describe("subprocess JSON runner", () => {
	test("parses settled JSONL output, usage, and duration", async () => {
		await withSubprocessRunner(`
			console.log(JSON.stringify({ type: "message_end", message: {
				role: "assistant", content: [{ type: "text", text: "first" }, { type: "text", text: "second" }],
				stopReason: "stop", provider: "test-provider", model: "test-model", usage: { input: 12, output: 5 },
			} }));
			console.log(JSON.stringify({ type: "agent_settled" }));
		`, async (runner) => {
			const result = await runner.run(childRequest());

			expect(result).toEqual({
				state: "completed",
				output: "first\nsecond",
				usage: expect.objectContaining({
					provider: "test-provider",
					model: "test-model",
					inputTokens: 12,
					outputTokens: 5,
					durationMs: expect.any(Number),
				}),
			});
		});
	});

	test("fails when a JSONL event is malformed and preserves stderr", async () => {
		await withSubprocessRunner(`
			console.error("protocol failed");
			console.log("{not valid JSON");
		`, async (runner) => {
			const result = await runner.run(childRequest());

			expect(result).toMatchObject({
				state: "failed",
				error: { kind: "stream", message: "Pi emitted malformed JSON", stderr: "protocol failed\n" },
			});
		});
	});

	test("requires agent_settled after a final assistant message", async () => {
		await withSubprocessRunner(`
			console.log(JSON.stringify({ type: "message_end", message: {
				role: "assistant", content: [{ type: "text", text: "unsettled" }], stopReason: "stop",
			} }));
		`, async (runner) => {
			const result = await runner.run(childRequest());

			expect(result).toMatchObject({
				state: "failed",
				error: { kind: "stream", message: "Pi exited without settled final assistant output", partialOutput: "unsettled" },
			});
		});
	});

	test("returns execution evidence when the child exits unsuccessfully", async () => {
		await withSubprocessRunner(`
			console.error("provider failed");
			console.log(JSON.stringify({ type: "message_end", message: {
				role: "assistant", content: [{ type: "text", text: "partial" }],
			} }));
			process.exit(7);
		`, async (runner) => {
			const result = await runner.run(childRequest());

			expect(result).toMatchObject({
				state: "failed",
				error: { kind: "execution", message: "Pi exited with code 7", stderr: "provider failed\n", partialOutput: "partial" },
			});
		});
	});
});
