import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createSubagentRuntime,
	MAX_INLINE_HANDOFF_BYTES,
	SubprocessJsonRunner,
	type ChildRunner,
	type ChildRunnerRequest,
	type NodeDefinition,
	type SubagentRuntimeOptions,
} from "../subagents/runtime.ts";
function singleNode(task = "Inspect the repository") {
	return {
		kind: "single" as const,
		node: { agent: "worker", logicalRole: "Recon", task },
	};
}

async function withRuntime<T>(
	runner: ChildRunner,
	test: (runtime: ReturnType<typeof createSubagentRuntime>) => Promise<T>,
	options: Partial<Omit<SubagentRuntimeOptions, "runner" | "storeDirectory">> = {},
): Promise<T> {
	const storeDirectory = await mkdtemp(join(tmpdir(), "pi-subagent-runtime-"));
	const { modelCatalog = { isAvailable: () => true }, ...runtimeOptions } = options;
	try {
		return await test(createSubagentRuntime({ storeDirectory, runner, modelCatalog, ...runtimeOptions }));
	} finally {
		await rm(storeDirectory, { recursive: true, force: true });
	}
}

async function withStore<T>(test: (storeDirectory: string) => Promise<T>): Promise<T> {
	const storeDirectory = await mkdtemp(join(tmpdir(), "pi-subagent-runtime-"));
	try {
		return await test(storeDirectory);
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
		agent: "worker",
		logicalRole: "Recon",
		task: "Inspect the repository",
		cwd: process.cwd(),
		provider: "test-provider",
		model: "test-model",
		reasoning: "low",
		tools: ["read"],
		systemPrompt: "bounded child",
		freshResources: true,
		recursiveDelegation: false,
		approvalPrompts: false,
	};
}

async function writeDefinition(
	directory: string,
	id: string,
	overrides: { provider?: string; model?: string; reasoning?: string; tools?: string } = {},
): Promise<void> {
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, `${id}.md`),
		`---
id: ${id}
description: Test ${id} definition
tools: ${overrides.tools ?? "read"}
provider: ${overrides.provider ?? "test-provider"}
model: ${overrides.model ?? "test-model"}
reasoning: ${overrides.reasoning ?? "low"}
---

## Role
Inspect only the supplied task.

## Report contract
Return the observed result.

## Completion criteria
Stop after inspecting the requested scope.
`,
		"utf8",
	);
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
			const launch = await runtime.launch(singleNode(), { delivery: "blocking" });
			const node = launch.nodes[0]!;

			expect(typeof launch.run.id).toBe("string");
			expect(launch.run.state).toBe("completed");
			expect(typeof node.id).toBe("string");
			expect(node.logicalRole).toBe("Recon");
			expect(node.state).toBe("completed");
			expect(node.result).toMatchObject({
				state: "completed",
				output: "Found the runtime boundary.",
				usage: {
					provider: "test",
					model: "deterministic",
					inputTokens: 12,
					outputTokens: 5,
					durationMs: expect.any(Number),
				},
				policy: {
					agent: "worker",
					freshResources: true,
					recursiveDelegation: false,
					approvalPrompts: false,
				},
			});
			expect(node.usage).toMatchObject({ provider: "test", model: "deterministic", inputTokens: 12, outputTokens: 5 });
			expect(node.artifacts).toHaveLength(1);
			expect(node.artifacts[0]!.kind).toBe("result");
			expect(typeof node.artifacts[0]!.path).toBe("string");
			expect(requests).toHaveLength(1);
			expect(requests[0]).toMatchObject({ runId: launch.run.id, nodeId: node.id, task: "Inspect the repository" });

			const status = await runtime.status(launch.run.id);
			expect(status.run).toEqual({ id: launch.run.id, state: "completed" });
			expect(status.nodes).toEqual([expect.objectContaining({
				id: node.id,
				agent: "worker",
				logicalRole: "Recon",
				state: "completed",
				artifacts: node.artifacts,
				usage: node.usage,
				policy: node.policy,
			})]);
		});
	});

	test("runs a public parallel graph under its lower concurrency limit and aggregates declaration order", async () => {
		const started: string[] = [];
		const completed: string[] = [];
		const releases = new Map<string, () => void>();
		let signalInitialBatch: (() => void) | undefined;
		let signalThirdStart: (() => void) | undefined;
		const initialBatchStarted = new Promise<void>((resolve) => { signalInitialBatch = resolve; });
		const thirdStarted = new Promise<void>((resolve) => { signalThirdStart = resolve; });
		let active = 0;
		let maximumActive = 0;
		const runner: ChildRunner = {
			run: async (request) => {
				started.push(request.logicalRole);
				active += 1;
				maximumActive = Math.max(maximumActive, active);
				if (started.length === 2) signalInitialBatch!();
				if (started.length === 3) signalThirdStart!();
				await new Promise<void>((resolve) => { releases.set(request.logicalRole, resolve); });
				active -= 1;
				completed.push(request.logicalRole);
				return { state: "completed", output: `${request.logicalRole} complete` };
			},
		};

		await withRuntime(runner, async (runtime) => {
			const execution = runtime.launch({
				kind: "parallel",
				maxConcurrency: 2,
				nodes: [
					{ agent: "worker", logicalRole: "First", task: "First task" },
					{ agent: "worker", logicalRole: "Second", task: "Second task" },
					{ agent: "worker", logicalRole: "Third", task: "Third task" },
				],
			}, { delivery: "blocking" });
			await initialBatchStarted;
			releases.get("Second")!();
			await thirdStarted;
			await Promise.resolve();
			releases.get("Third")!();
			releases.get("First")!();
			const launch = await execution;

			expect(started).toEqual(["First", "Second", "Third"]);
			expect(completed).toEqual(["Second", "Third", "First"]);
			expect(maximumActive).toBe(2);
			expect(launch.run.state).toBe("completed");
			expect(launch.nodes.map((node) => node.result?.output)).toEqual([
				"First complete",
				"Second complete",
				"Third complete",
			]);
		}, { maxConcurrency: 4 });
	});

	test("caps a parallel graph at the default ceiling of six children", async () => {
		let active = 0;
		let maximumActive = 0;
		const nodes: NodeDefinition[] = Array.from({ length: 7 }, (_, index) => ({
			agent: "worker",
			logicalRole: `Node ${index + 1}`,
			task: `Task ${index + 1}`,
		}));
		const runner: ChildRunner = {
			run: async () => {
				active += 1;
				maximumActive = Math.max(maximumActive, active);
				await Promise.resolve();
				active -= 1;
				return { state: "completed", output: "done" };
			},
		};

		await withRuntime(runner, async (runtime) => {
			await runtime.launch({ kind: "parallel", nodes }, { delivery: "blocking" });

			expect(maximumActive).toBe(6);
		});
	});

	test("does not let a run raise the user concurrency ceiling", async () => {
		let active = 0;
		let maximumActive = 0;
		const runner: ChildRunner = {
			run: async () => {
				active += 1;
				maximumActive = Math.max(maximumActive, active);
				await Promise.resolve();
				active -= 1;
				return { state: "completed", output: "done" };
			},
		};

		await withRuntime(runner, async (runtime) => {
			await runtime.launch({
				kind: "parallel",
				maxConcurrency: 3,
				nodes: [
					{ agent: "worker", logicalRole: "First", task: "First" },
					{ agent: "worker", logicalRole: "Second", task: "Second" },
					{ agent: "worker", logicalRole: "Third", task: "Third" },
				],
			}, { delivery: "blocking" });

			expect(maximumActive).toBe(2);
		}, { maxConcurrency: 2 });
	});

	test("rejects invalid runtime and graph concurrency limits before child launch", async () => {
		let calls = 0;
		const runner: ChildRunner = {
			run: async () => {
				calls += 1;
				return { state: "completed", output: "unexpected" };
			},
		};

		await withRuntime(runner, async (runtime) => {
			await expect(runtime.launch(singleNode())).rejects.toThrow("Runtime maxConcurrency must be a positive safe integer");
		}, { maxConcurrency: 0 });
		await withRuntime(runner, async (runtime) => {
			await expect(runtime.launch({
				kind: "parallel",
				maxConcurrency: 1.5,
				nodes: [{ agent: "worker", logicalRole: "Only", task: "Only task" }],
			})).rejects.toThrow("Graph maxConcurrency must be a positive safe integer");
		});
		expect(calls).toBe(0);
	});

	test("waits for unrelated siblings after a parallel node fails", async () => {
		const started: string[] = [];
		const runner: ChildRunner = {
			run: async (request) => {
				started.push(request.logicalRole);
				await Promise.resolve();
				if (request.logicalRole === "Fails") {
					return { state: "failed", error: { kind: "execution", message: "expected failure" } };
				}
				await Promise.resolve();
				return { state: "completed", output: `${request.logicalRole} complete` };
			},
		};

		await withRuntime(runner, async (runtime) => {
			const launch = await runtime.launch({
				kind: "parallel",
				maxConcurrency: 2,
				nodes: [
					{ agent: "worker", logicalRole: "Fails", task: "Fail" },
					{ agent: "worker", logicalRole: "Continues", task: "Continue" },
					{ agent: "worker", logicalRole: "Queued", task: "Start after a slot opens" },
				],
			}, { delivery: "blocking" });

			expect(started).toEqual(["Fails", "Continues", "Queued"]);
			expect(launch.run.state).toBe("failed");
			expect(launch.nodes.map((node) => node.state)).toEqual(["failed", "completed", "completed"]);
			expect(launch.nodes[0]!.result?.error).toMatchObject({ message: "expected failure" });
			expect(launch.nodes[1]!.result?.output).toBe("Continues complete");
			expect(launch.nodes[2]!.result?.output).toBe("Queued complete");
			const status = await runtime.status(launch.run.id);
			expect(status.nodes.map((node) => node.state)).toEqual(["failed", "completed", "completed"]);
			expect(status.usage).toMatchObject({ durationMs: expect.any(Number) });
			await expect(runtime.result(launch.run.id, launch.nodes[0]!.id)).resolves.toMatchObject({
				state: "failed",
				error: { message: "expected failure" },
			});
		});
	});

	test("waits for unrelated siblings after a parallel node is cancelled", async () => {
		const started: string[] = [];
		const runner: ChildRunner = {
			run: async (request) => {
				started.push(request.logicalRole);
				await Promise.resolve();
				if (request.logicalRole === "Cancelled") {
					return {
						state: "cancelled",
						error: { kind: "cancelled", message: "expected cancellation" },
					};
				}
				await Promise.resolve();
				return { state: "completed", output: `${request.logicalRole} complete` };
			},
		};

		await withRuntime(runner, async (runtime) => {
			const launch = await runtime.launch({
				kind: "parallel",
				maxConcurrency: 2,
				nodes: [
					{ agent: "worker", logicalRole: "Cancelled", task: "Cancel" },
					{ agent: "worker", logicalRole: "Continues", task: "Continue" },
					{ agent: "worker", logicalRole: "Queued", task: "Start after a slot opens" },
				],
			}, { delivery: "blocking" });

			expect(started).toEqual(["Cancelled", "Continues", "Queued"]);
			expect(launch.run.state).toBe("cancelled");
			expect(launch.nodes.map((node) => node.state)).toEqual(["cancelled", "completed", "completed"]);
			await expect(runtime.result(launch.run.id, launch.nodes[0]!.id)).resolves.toMatchObject({
				state: "cancelled",
				error: { kind: "cancelled", message: "expected cancellation" },
			});
		});
	});

	test("snapshots the public parallel graph before sibling children start", async () => {
		const requests: ChildRunnerRequest[] = [];
		const releaseRunners: Array<() => void> = [];
		let signalStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => { signalStarted = resolve; });
		const runner: ChildRunner = {
			run: async (request) => {
				requests.push(request);
				if (requests.length === 2) signalStarted!();
				await new Promise<void>((resolve) => { releaseRunners.push(resolve); });
				return { state: "completed", output: request.logicalRole };
			},
		};
		const graph = {
			kind: "parallel" as const,
			nodes: [
				{ agent: "worker", logicalRole: "First", task: "First", tools: ["stable-tool"] },
				{ agent: "worker", logicalRole: "Second", task: "Second", tools: ["second-tool"] },
			],
		};

		await withRuntime(runner, async (runtime) => {
			const launch = runtime.launch(graph, { delivery: "blocking" });
			await started;
			graph.nodes[0]!.tools.push("leaked-tool");
			for (const releaseRunner of releaseRunners) releaseRunner();
			await launch;

			expect(requests[0]!.tools).toContain("stable-tool");
			expect(requests[0]!.tools).not.toContain("leaked-tool");
			expect(requests[1]!.tools).toContain("second-tool");
		});
	});

	test("detaches by default, exposes compact progress, joins the durable result, and survives recreation", async () => {
		let request: ChildRunnerRequest | undefined;
		let releaseRunner: (() => void) | undefined;
		const runner: ChildRunner = {
			run: async (runnerRequest) => {
				request = runnerRequest;
				await new Promise<void>((resolve) => { releaseRunner = resolve; });
				return {
					state: "completed",
					output: "Durably finished.",
					usage: { provider: "test", model: "deterministic", inputTokens: 8, outputTokens: 3 },
				};
			},
		};

		await withStore(async (storeDirectory) => {
			const runtime = createSubagentRuntime({
				storeDirectory,
				runner,
				modelCatalog: { isAvailable: () => true },
			});
			const receipt = await runtime.launch(singleNode());

			expect(receipt).toEqual({ run: { id: expect.stringMatching(/^run_/), state: "running" } });
			const runningStatus = await runtime.status(receipt.run.id);
			expect(runningStatus).toMatchObject({
				run: { id: receipt.run.id, state: "running" },
				nodes: [{
					id: request!.nodeId,
					state: "running",
					policy: { agent: "worker", provider: "openai", model: "gpt-5.6-luna" },
					artifacts: [],
				}],
			});
			expect(runningStatus.nodes[0]).not.toHaveProperty("result");

			const joined = runtime.join(receipt.run.id);
			releaseRunner!();
			expect(await joined).toMatchObject({
				run: { id: receipt.run.id, state: "completed" },
				nodes: [{ id: request!.nodeId, result: { state: "completed", output: "Durably finished." } }],
			});

			const settledStatus = await runtime.status(receipt.run.id);
			expect(settledStatus).toMatchObject({
				run: { id: receipt.run.id, state: "completed" },
				usage: { inputTokens: 8, outputTokens: 3, durationMs: expect.any(Number) },
			});
			expect(JSON.stringify(settledStatus)).not.toContain("Durably finished.");

			const recreatedRuntime = createSubagentRuntime({
				storeDirectory,
				runner,
				modelCatalog: { isAvailable: () => true },
			});
			expect(await recreatedRuntime.status(receipt.run.id)).toEqual(settledStatus);
		});
	});

	test("joins detached failures and rejects unknown or inaccessible runs", async () => {
		const runner: ChildRunner = {
			run: async () => ({
				state: "failed",
				error: { kind: "execution", message: "provider rejected the request" },
			}),
		};

		await withStore(async (storeDirectory) => {
			const runtime = createSubagentRuntime({
				storeDirectory,
				runner,
				modelCatalog: { isAvailable: () => true },
			});
			const receipt = await runtime.launch(singleNode());

			await expect(runtime.join(receipt.run.id)).resolves.toMatchObject({
				run: { id: receipt.run.id, state: "failed" },
				nodes: [{ result: { state: "failed", error: { message: "provider rejected the request" } } }],
			});
			await expect(runtime.status("run_unknown")).rejects.toThrow("Unknown run: run_unknown");
			await expect(runtime.join("run_unknown")).rejects.toThrow("Unknown run: run_unknown");

			const recreatedRuntime = createSubagentRuntime({
				storeDirectory,
				runner,
				modelCatalog: { isAvailable: () => true },
			});
			await expect(recreatedRuntime.join(receipt.run.id)).rejects.toThrow(`Run is not owned by this runtime: ${receipt.run.id}`);
		});
	});

	test("resolves the project definition and isolates per-node policy overrides", async () => {
		const definitionsDirectory = await mkdtemp(join(tmpdir(), "pi-agent-definitions-"));
		const childDirectory = join(definitionsDirectory, "child-worktree");
		const packaged = join(definitionsDirectory, "packaged");
		const user = join(definitionsDirectory, "user");
		const project = join(definitionsDirectory, "project");
		const requests: ChildRunnerRequest[] = [];
		const runner: ChildRunner = {
			run: async (request) => {
				requests.push(request);
				return { state: "completed", output: "done" };
			},
		};

		try {
			await writeDefinition(packaged, "worker", { provider: "packaged", model: "packaged-model", reasoning: "low", tools: "read" });
			await writeDefinition(user, "worker", { provider: "user", model: "user-model", reasoning: "medium", tools: "grep" });
			await writeDefinition(project, "worker", { provider: "project", model: "project-model", reasoning: "high", tools: "read" });

			await withRuntime(runner, async (runtime) => {
				await runtime.launch({ kind: "single", node: { agent: "worker", logicalRole: "Inspect", task: "Inspect the repository", cwd: childDirectory } }, { delivery: "blocking" });
				await runtime.launch({
					kind: "single",
					node: {
						agent: "worker",
						logicalRole: "Inspect",
						task: "Inspect the repository",
						cwd: childDirectory,
						provider: "override",
						model: "override-model",
						reasoning: "medium",
						tools: ["bash"],
					},
				}, { delivery: "blocking" });
				await rm(join(project, "worker.md"));
				await runtime.launch({ kind: "single", node: { agent: "worker", logicalRole: "Inspect", task: "Inspect the repository", cwd: childDirectory } }, { delivery: "blocking" });
			}, {
				definitionDirectories: { packaged, user, project },
				modelCatalog: { isAvailable: async () => true },
			});

			expect(requests).toHaveLength(3);
			expect(requests[0]).toMatchObject({
				cwd: childDirectory,
				provider: "project",
				model: "project-model",
				reasoning: "high",
				tools: ["read"],
			});
			expect(requests[1]).toMatchObject({
				cwd: childDirectory,
				provider: "override",
				model: "override-model",
				reasoning: "medium",
				tools: ["read", "bash"],
			});
			expect(requests[2]).toMatchObject({
				cwd: childDirectory,
				provider: "user",
				model: "user-model",
				reasoning: "medium",
				tools: ["grep"],
			});
		} finally {
			await rm(definitionsDirectory, { recursive: true, force: true });
		}
	});

	test("rejects unavailable models, missing definitions, and recursive tools before child launch", async () => {
		let calls = 0;
		const runner: ChildRunner = {
			run: async () => {
				calls += 1;
				return { state: "completed", output: "unexpected" };
			},
		};

		await withRuntime(runner, async (runtime) => {
			await expect(runtime.launch(singleNode())).rejects.toThrow("Unavailable model: openai/gpt-5.6-luna");
			await expect(runtime.launch({ kind: "single", node: { agent: "missing", logicalRole: "Missing", task: "Inspect" } })).rejects.toThrow("Agent definition not found: missing");
			await expect(runtime.launch({
				kind: "single",
				node: { agent: "worker", logicalRole: "Recursive", task: "Inspect", tools: ["subagent_launch"] },
			})).rejects.toThrow("Child tool is not allowed: subagent_launch");
			await expect(runtime.launch({
				kind: "single",
				node: { agent: "worker", logicalRole: "Bypass", task: "Inspect", tools: ["subagent_launch,read"] },
			})).rejects.toThrow("Tool names must not contain commas");
			expect(calls).toBe(0);
		}, { modelCatalog: { isAvailable: () => false } });
	});

	test("rejects a malformed selected definition before child launch", async () => {
		const definitionsDirectory = await mkdtemp(join(tmpdir(), "pi-invalid-agent-definition-"));
		let calls = 0;
		const runner: ChildRunner = {
			run: async () => {
				calls += 1;
				return { state: "completed", output: "unexpected" };
			},
		};

		try {
			await writeFile(join(definitionsDirectory, "worker.md"), "---\nid: worker\n---\n", "utf8");
			await withRuntime(runner, async (runtime) => {
				await expect(runtime.launch(singleNode())).rejects.toThrow("Invalid agent definition");
				expect(calls).toBe(0);
			}, {
				definitionDirectories: {
					packaged: definitionsDirectory,
					user: definitionsDirectory,
					project: definitionsDirectory,
				},
			});
		} finally {
			await rm(definitionsDirectory, { recursive: true, force: true });
		}
	});

	test("ships the five bounded packaged definitions", async () => {
		const isolatedDirectories = await mkdtemp(join(tmpdir(), "pi-empty-agent-definitions-"));
		const requests: ChildRunnerRequest[] = [];
		const runner: ChildRunner = {
			run: async (request) => {
				requests.push(request);
				return { state: "completed", output: "" };
			},
		};
		const definitions = [
			["recon", "Recon"],
			["researcher", "Research"],
			["worker", "Work"],
			["standards-reviewer", "Standards review"],
			["spec-reviewer", "Spec review"],
		] as const;

		try {
			await withRuntime(runner, async (runtime) => {
				for (const [agent, logicalRole] of definitions) {
					await runtime.launch({ kind: "single", node: { agent, logicalRole, task: "Perform the bounded task" } }, { delivery: "blocking" });
				}
			}, { definitionDirectories: { user: isolatedDirectories, project: isolatedDirectories } });
		} finally {
			await rm(isolatedDirectories, { recursive: true, force: true });
		}

		expect(requests.map((request) => request.agent)).toEqual(definitions.map(([agent]) => agent));
		expect(requests.map((request) => request.reasoning)).toEqual(["low", "medium", "medium", "high", "high"]);
		for (const request of requests) {
			expect(request).toMatchObject({
				provider: "openai",
				model: "gpt-5.6-luna",
				freshResources: true,
				recursiveDelegation: false,
				approvalPrompts: false,
			});
			expect(request.systemPrompt).toContain("## Role");
			expect(request.systemPrompt).toContain("## Report contract");
			expect(request.systemPrompt).toContain("## Completion criteria");
		}
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
		const graph = { kind: "single" as const, node: { agent: "worker", logicalRole: "Recon", task: "Inspect", tools: ["isolated-tool"] } };

		await withRuntime(runner, async (runtime) => {
			const launch = runtime.launch(graph, { delivery: "blocking" });
			await started;
			graph.node.tools.push("leaked-tool");
			releaseRunner!();
			await launch;

			expect(capturedRequest!.tools).toContain("isolated-tool");
			expect(capturedRequest!.tools).not.toContain("leaked-tool");
		});
	});

	test("treats an empty terminal output as a successful durable result", async () => {
		const runner: ChildRunner = { run: async () => ({ state: "completed", output: "" }) };

		await withRuntime(runner, async (runtime) => {
			const launch = await runtime.launch(singleNode(), { delivery: "blocking" });
			const node = launch.nodes[0]!;
			const result = await runtime.result(launch.run.id, node.id);

			expect(node.state).toBe("completed");
			expect(result).toMatchObject({ state: "completed", output: "" });
		});
	});
	test("routes a complete durable predecessor handoff through an ordered chain", async () => {
		const requests: ChildRunnerRequest[] = [];
		const runner: ChildRunner = {
			run: async (request) => {
				requests.push(request);
				return { state: "completed", output: request.logicalRole === "Research" ? "Repository facts." : "Implemented." };
			},
		};

		await withRuntime(runner, async (runtime) => {
			const launch = await runtime.launch({
				kind: "chain",
				nodes: [
					{ agent: "worker", logicalRole: "Research", task: "Inspect the repository." },
					{ agent: "worker", logicalRole: "Implement", task: "Use the report to implement the change." },
				],
			}, { delivery: "blocking" });

			expect(requests.map((request) => request.task)).toEqual([
				"Inspect the repository.",
				"Use the report to implement the change.\n\n## Output from node-1\nRepository facts.",
			]);
			expect(launch.finalOutput).toBe("Implemented.");
			expect(launch.handoffs).toEqual([expect.objectContaining({
				nodeId: "node-2",
				predecessorIds: ["node-1"],
			})]);
		});
	});

	test("normalizes single and one-node parallel forms to the same stable public graph", async () => {
		const requests: ChildRunnerRequest[] = [];
		const runner: ChildRunner = {
			run: async (request) => {
				requests.push(request);
				return { state: "completed", output: "done" };
			},
		};

		await withRuntime(runner, async (runtime) => {
			const single = await runtime.launch(singleNode("Inspect once."), { delivery: "blocking" });
			const parallel = await runtime.launch({
				kind: "parallel",
				nodes: [{ agent: "worker", logicalRole: "Recon", task: "Inspect once." }],
			}, { delivery: "blocking" });
			const chain = await runtime.launch({
				kind: "chain",
				nodes: [{ agent: "worker", logicalRole: "Recon", task: "Inspect once." }],
			}, { delivery: "blocking" });
			const dag = await runtime.launch({
				kind: "dag",
				nodes: [{ id: "node-1", agent: "worker", logicalRole: "Recon", task: "Inspect once." }],
			}, { delivery: "blocking" });

			expect(single.trace).toEqual(parallel.trace);
			expect(single.trace).toEqual(chain.trace);
			expect(single.trace).toEqual(dag.trace);
			expect(single.nodes.map((node) => node.id)).toEqual(["node-1"]);
			expect(requests.map((request) => request.nodeId)).toEqual(["node-1", "node-1", "node-1", "node-1"]);
		});
	});

	test("routes DAG fan-in in declaration order and exposes complete graph evidence", async () => {
		const requests: ChildRunnerRequest[] = [];
		const runner: ChildRunner = {
			run: async (request) => {
				requests.push(request);
				return { state: "completed", output: `${request.logicalRole} result` };
			},
		};

		await withRuntime(runner, async (runtime) => {
			const launch = await runtime.launch({
				kind: "dag",
				nodes: [
					{ id: "research", agent: "worker", logicalRole: "Research", task: "Research." },
					{ id: "review", agent: "worker", logicalRole: "Review", task: "Review." },
					{ id: "merge", agent: "worker", logicalRole: "Merge", task: "Merge.", dependsOn: ["review", "research"] },
				],
			}, { delivery: "blocking" });

			expect(requests[2]!.task).toBe("Merge.\n\n## Output from research\nResearch result\n\n## Output from review\nReview result");
			expect(launch.finalOutput).toBe("Merge result");
			expect(launch.trace).toEqual([
				{ nodeId: "research", logicalRole: "Research", state: "completed", predecessorIds: [] },
				{ nodeId: "review", logicalRole: "Review", state: "completed", predecessorIds: [] },
				{ nodeId: "merge", logicalRole: "Merge", state: "completed", predecessorIds: ["review", "research"] },
			]);
			expect(launch.handoffs).toEqual([expect.objectContaining({
				nodeId: "merge",
				predecessorIds: ["research", "review"],
				predecessorArtifacts: [{ kind: "result", path: expect.any(String) }, { kind: "result", path: expect.any(String) }],
				artifact: { kind: "handoff", path: expect.any(String) },
				delivery: "inline",
			})]);
			expect(launch.artifacts).toContainEqual({ kind: "graph-result", path: expect.any(String) });
		});
	});

	test("keeps node artifacts separate from the graph aggregate artifact", async () => {
		const runner: ChildRunner = { run: async () => ({ state: "completed", output: "node result" }) };

		await withRuntime(runner, async (runtime) => {
			const launch = await runtime.launch({
				kind: "dag",
				nodes: [{ id: "graph-result", agent: "worker", logicalRole: "Named node", task: "Run." }],
			}, { delivery: "blocking" });

			expect(await runtime.result(launch.run.id, "graph-result")).toMatchObject({ state: "completed", output: "node result" });
		});
	});

	test("keeps empty predecessor output and routes oversized handoffs by artifact path", async () => {
		const requests: ChildRunnerRequest[] = [];
		const runner: ChildRunner = {
			run: async (request) => {
				requests.push(request);
				const output = request.logicalRole === "Empty"
					? ""
					: request.logicalRole === "Large" ? "x".repeat(MAX_INLINE_HANDOFF_BYTES + 1) : "done";
				return { state: "completed", output };
			},
		};

		await withRuntime(runner, async (runtime) => {
			const empty = await runtime.launch({
				kind: "chain",
				nodes: [
					{ agent: "worker", logicalRole: "Empty", task: "Return no text." },
					{ agent: "worker", logicalRole: "Consumes empty", task: "Use empty." },
				],
			}, { delivery: "blocking" });
			const oversized = await runtime.launch({
				kind: "chain",
				nodes: [
					{ agent: "worker", logicalRole: "Large", task: "Return much text." },
					{ agent: "worker", logicalRole: "Consumes large", task: "Use large." },
				],
			}, { delivery: "blocking" });

			expect(requests[1]!.task).toBe("Use empty.\n\n## Output from node-1\n");
			expect(oversized.handoffs[0]).toMatchObject({ delivery: "artifact", artifact: { path: expect.any(String) } });
			expect(requests[3]!.task).toMatch(/## Required predecessor handoff\nThe complete predecessor handoff is stored at: .+\/handoffs\/.+\.txt/);
			expect(requests[3]!.task).not.toContain("x".repeat(MAX_INLINE_HANDOFF_BYTES + 1));
			expect(empty.nodes[1]!.state).toBe("completed");
		});
	});

	test("rejects invalid DAG edges and cycles before any child starts", async () => {
		let calls = 0;
		const runner: ChildRunner = { run: async () => { calls += 1; return { state: "completed", output: "unexpected" }; } };

		await withRuntime(runner, async (runtime) => {
			await expect(runtime.launch({
				kind: "dag",
				nodes: [{ id: "one", agent: "worker", logicalRole: "One", task: "One", dependsOn: ["missing"] }],
			})).rejects.toThrow("Unknown predecessor missing for node one");
			await expect(runtime.launch({
				kind: "dag",
				nodes: [
					{ id: "same", agent: "worker", logicalRole: "One", task: "One" },
					{ id: "same", agent: "worker", logicalRole: "Two", task: "Two" },
				],
			})).rejects.toThrow("Duplicate node ID: same");
			await expect(runtime.launch({
				kind: "dag",
				nodes: [
					{ id: "one", agent: "worker", logicalRole: "One", task: "One", dependsOn: ["two"] },
					{ id: "two", agent: "worker", logicalRole: "Two", task: "Two", dependsOn: ["one"] },
				],
			})).rejects.toThrow("Graph must be acyclic");
		});

		expect(calls).toBe(0);
	});

	test("blocks failed DAG descendants while unrelated branches continue", async () => {
		const started: string[] = [];
		const runner: ChildRunner = {
			run: async (request) => {
				started.push(request.logicalRole);
				if (request.logicalRole === "Fails") return { state: "failed", error: { kind: "execution", message: "expected" } };
				return { state: "completed", output: `${request.logicalRole} result` };
			},
		};

		await withRuntime(runner, async (runtime) => {
			const launch = await runtime.launch({
				kind: "dag",
				nodes: [
					{ id: "fails", agent: "worker", logicalRole: "Fails", task: "Fail." },
					{ id: "blocked", agent: "worker", logicalRole: "Blocked", task: "Never run.", dependsOn: ["fails"] },
					{ id: "continues", agent: "worker", logicalRole: "Continues", task: "Continue." },
				],
			}, { delivery: "blocking" });

			expect(started).toEqual(["Fails", "Continues"]);
			expect(launch.nodes.map((node) => node.state)).toEqual(["failed", "queued", "completed"]);
			expect(launch.nodes[1]!.blockedBy).toEqual(["fails"]);
			expect(launch.trace[1]).toEqual({ nodeId: "blocked", logicalRole: "Blocked", state: "queued", predecessorIds: ["fails"], blockedBy: ["fails"] });
		});
	});

	test("blocks descendants of a cancelled predecessor", async () => {
		const started: string[] = [];
		const runner: ChildRunner = {
			run: async (request) => {
				started.push(request.logicalRole);
				return request.logicalRole === "Cancelled"
					? { state: "cancelled", error: { kind: "cancelled", message: "stopped" } }
					: { state: "completed", output: "unexpected" };
			},
		};

		await withRuntime(runner, async (runtime) => {
			const launch = await runtime.launch({
				kind: "dag",
				nodes: [
					{ id: "cancelled", agent: "worker", logicalRole: "Cancelled", task: "Stop." },
					{ id: "blocked", agent: "worker", logicalRole: "Blocked", task: "Never run.", dependsOn: ["cancelled"] },
				],
			}, { delivery: "blocking" });

			expect(started).toEqual(["Cancelled"]);
			expect(launch.run.state).toBe("cancelled");
			expect(launch.nodes[1]).toMatchObject({ state: "queued", blockedBy: ["cancelled"] });
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
			const launch = await runtime.launch(singleNode(), { delivery: "blocking" });
			const node = launch.nodes[0]!;
			const result = await runtime.result(launch.run.id, node.id);

			expect(launch.run.state).toBe("failed");
			expect(node).toMatchObject({
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
			const launch = runtime.launch(singleNode(), { delivery: "blocking" });
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
			expect((await launch).nodes[0]!.state).toBe("completed");
		});
	});
});

class FakeClock {
	private nowMs = 0;
	private nextId = 0;
	private readonly timers = new Map<number, { at: number; callback: () => void }>();

	now(): number { return this.nowMs; }

	setTimeout(callback: () => void, delayMs: number): number {
		const id = this.nextId++;
		this.timers.set(id, { at: this.nowMs + delayMs, callback });
		return id;
	}

	clearTimeout(id: unknown): void { this.timers.delete(id as number); }

	advance(ms: number): void {
		this.nowMs += ms;
		for (const [id, timer] of [...this.timers]) {
			if (timer.at <= this.nowMs) {
				this.timers.delete(id);
				timer.callback();
			}
		}
	}
}

describe("run control", () => {
	test("cancels active and queued nodes durably", async () => {
		let release: (() => void) | undefined;
		let started: (() => void) | undefined;
		const running = new Promise<void>((resolve) => { started = resolve; });
		const runner: ChildRunner = {
			run: async (_request, options) => {
				started!();
				await new Promise<void>((resolve) => { release = resolve; });
				return options?.signal?.aborted
					? { state: "cancelled", error: { kind: "cancelled", message: "stopped" } }
					: { state: "completed", output: "unexpected" };
			},
		};

		await withRuntime(runner, async (runtime) => {
			const launch = runtime.launch({
				kind: "chain",
				nodes: [
					{ agent: "worker", logicalRole: "Active", task: "Work." },
					{ agent: "worker", logicalRole: "Queued descendant", task: "Never start." },
				],
			});
			await running;
			const cancellation = runtime.cancel((await launch).run.id);
			release!();
			const result = await cancellation;

			expect(result.run.state).toBe("cancelled");
			expect(result.nodes.map((node) => node.state)).toEqual(["cancelled", "cancelled"]);
			expect(await runtime.result(result.run.id, "node-2")).toMatchObject({
				state: "cancelled",
				error: { kind: "cancelled" },
			});
			expect((await runtime.events(result.run.id)).some((event) => event.state === "cancelled")).toBe(true);
		});
	});

	test("cancels one node and its descendants while unrelated siblings continue", async () => {
		const runner: ChildRunner = {
			run: async (request, options) => {
				if (request.logicalRole === "Cancel") {
					await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
					return { state: "cancelled", error: { kind: "cancelled", message: "stopped" } };
				}
				return { state: "completed", output: "unrelated evidence" };
			},
		};

		await withRuntime(runner, async (runtime) => {
			const receipt = await runtime.launch({
				kind: "dag",
				nodes: [
					{ id: "cancel", agent: "worker", logicalRole: "Cancel", task: "Stop." },
					{ id: "descendant", agent: "worker", logicalRole: "Descendant", task: "Never run.", dependsOn: ["cancel"] },
					{ id: "sibling", agent: "worker", logicalRole: "Sibling", task: "Continue." },
				],
			});
			const result = await runtime.cancel(receipt.run.id, "cancel");

			expect(result.nodes.map((node) => node.state)).toEqual(["cancelled", "cancelled", "completed"]);
			expect(result.nodes[2]!.result).toMatchObject({ output: "unrelated evidence" });
		});
	});

	test("disposal suspends a run and recreation requires explicit resume", async () => {
		let releaseFirst: (() => void) | undefined;
		let firstStarted: (() => void) | undefined;
		const firstRunStarted = new Promise<void>((resolve) => { firstStarted = resolve; });
		let calls = 0;
		const runner: ChildRunner = {
			run: async (_request, options) => {
				calls += 1;
				if (calls === 1) {
					firstStarted!();
					await new Promise<void>((resolve) => { releaseFirst = resolve; });
					if (options?.signal?.aborted) return { state: "cancelled", error: { kind: "cancelled", message: "suspended" } };
				}
				return { state: "completed", output: "durable after resume" };
			},
		};

		await withStore(async (storeDirectory) => {
			const runtime = createSubagentRuntime({ storeDirectory, runner, modelCatalog: { isAvailable: () => true } });
			const receipt = await runtime.launch(singleNode());
			await firstRunStarted;
			const dispose = runtime.dispose();
			releaseFirst!();
			await dispose;
			expect((await runtime.status(receipt.run.id)).run.state).toBe("suspended");

			const recreated = createSubagentRuntime({ storeDirectory, runner, modelCatalog: { isAvailable: () => true } });
			expect((await recreated.status(receipt.run.id)).run.state).toBe("suspended");
			const resumed = await recreated.resume(receipt.run.id);
			expect(resumed.run).toMatchObject({ id: receipt.run.id, state: "completed" });
			expect(resumed.nodes[0]!.result).toMatchObject({ output: "durable after resume" });
			expect(resumed.nodes[0]!.artifacts.map((artifact) => artifact.kind)).toEqual(["checkpoint", "result"]);
		});
	});

	test("fails stalled work at its per-run idle limit without timing active work out", async () => {
		const clock = new FakeClock();
		let release: (() => void) | undefined;
		let started: (() => void) | undefined;
		const runnerStarted = new Promise<void>((resolve) => { started = resolve; });
		const runner: ChildRunner = {
			run: async (_request, options) => {
				started!();
				options?.onActivityChange?.(false);
				await new Promise<void>((resolve) => { release = resolve; });
				return options?.signal?.aborted
					? { state: "cancelled", error: { kind: "cancelled", message: "idle stop" } }
					: { state: "completed", output: "unexpected" };
			},
		};

		await withRuntime(runner, async (runtime) => {
			const execution = runtime.launch(singleNode(), { delivery: "blocking", idleLimitMs: 20 });
			await runnerStarted;
			clock.advance(19);
			await Promise.resolve();
			clock.advance(1);
			release!();
			const result = await execution;

			expect(result.run.state).toBe("failed");
			expect(result.nodes[0]!.result).toMatchObject({
				state: "failed",
				error: { kind: "timeout" },
			});
		}, { clock });
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

	test("records an aborted child as cancelled with partial output", async () => {
		await withSubprocessRunner(`
			console.log(JSON.stringify({ type: "message_end", message: {
				role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "aborted",
			} }));
		`, async (runner) => {
			await expect(runner.run(childRequest())).resolves.toMatchObject({
				state: "cancelled",
				error: { kind: "cancelled", message: "Pi stopped before settlement", partialOutput: "partial" },
			});
		});
	});

	test("requests graceful termination then force-terminates an unresponsive child", async () => {
		await withSubprocessRunner(`
			console.log(JSON.stringify({ type: "agent_start" }));
			process.on("SIGTERM", () => {});
			setInterval(() => {}, 1_000);
		`, async (runner) => {
			const controller = new AbortController();
			const result = await Promise.race([
				runner.run(childRequest(), {
					signal: controller.signal,
					terminationGraceMs: 20,
					onActivityChange: (active) => { if (active) controller.abort(); },
				}),
				new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("child did not terminate")), 1_000)),
			]);

			expect(result).toMatchObject({ state: "cancelled", error: { kind: "cancelled" } });
		});
	});

	test("starts a fresh subprocess with the effective policy and no inherited secret environment", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-child-worktree-"));
		const resolvedCwd = await realpath(cwd);
		const originalSecret = process.env.PI_SUBAGENT_TEST_SECRET;
		process.env.PI_SUBAGENT_TEST_SECRET = "parent-only-secret";
		const request: ChildRunnerRequest = {
			...childRequest(),
			cwd,
			provider: "policy-provider",
			model: "policy-model",
			reasoning: "high",
			tools: ["read", "grep"],
			systemPrompt: "bounded policy prompt",
		};
		const expectedArguments = [
			"--mode", "json", "-p", "--no-session",
			"--provider", "policy-provider",
			"--model", "policy-model",
			"--thinking", "high",
			"--tools", "read,grep",
			"--append-system-prompt", "bounded policy prompt",
			"Inspect the repository",
		];

		try {
			await withSubprocessRunner(`
				const expected = ${JSON.stringify(expectedArguments)};
				const supplied = process.argv.slice(2);
				const checks = {
					cwd: process.cwd() === ${JSON.stringify(resolvedCwd)},
					args: expected.every((value, index) => supplied[index] === value),
					secret: process.env.PI_SUBAGENT_TEST_SECRET === undefined,
				};
				if (!checks.cwd || !checks.args || !checks.secret) {
					console.error(JSON.stringify({ checks, supplied }));
					process.exit(9);
				}
				console.log(JSON.stringify({ type: "message_end", message: {
					role: "assistant", content: [{ type: "text", text: "fresh" }], stopReason: "stop",
				} }));
				console.log(JSON.stringify({ type: "agent_settled" }));
			`, async (runner) => {
				await expect(runner.run(request)).resolves.toMatchObject({ state: "completed", output: "fresh" });
			});
		} finally {
			if (originalSecret === undefined) delete process.env.PI_SUBAGENT_TEST_SECRET;
			else process.env.PI_SUBAGENT_TEST_SECRET = originalSecret;
			await rm(cwd, { recursive: true, force: true });
		}
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
