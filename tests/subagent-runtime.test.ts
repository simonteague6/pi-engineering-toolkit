import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createSubagentRuntime,
	SubprocessJsonRunner,
	type ChildRunner,
	type ChildRunnerRequest,
	type SubagentRuntimeOptions,
} from "../subagents/runtime.ts";
function singleNode(task = "Inspect the repository") {
	return {
		nodes: [{ agent: "worker", logicalRole: "Recon", task }],
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
			const launch = await runtime.launch(singleNode());

			expect(typeof launch.run.id).toBe("string");
			expect(launch.run.state).toBe("completed");
			expect(typeof launch.node.id).toBe("string");
			expect(launch.node.logicalRole).toBe("Recon");
			expect(launch.node.state).toBe("completed");
			expect(launch.node.result).toMatchObject({
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
			expect(launch.node.usage).toMatchObject({ provider: "test", model: "deterministic", inputTokens: 12, outputTokens: 5 });
			expect(launch.node.artifacts).toHaveLength(1);
			expect(launch.node.artifacts[0]!.kind).toBe("result");
			expect(typeof launch.node.artifacts[0]!.path).toBe("string");
			expect(requests).toHaveLength(1);
			expect(requests[0]).toMatchObject({ runId: launch.run.id, nodeId: launch.node.id, task: "Inspect the repository" });

			const status = await runtime.status(launch.run.id);
			expect(status.run).toEqual({ id: launch.run.id, state: "completed" });
			expect(status.nodes).toEqual([expect.objectContaining({
				id: launch.node.id,
				agent: "worker",
				logicalRole: "Recon",
				state: "completed",
				artifacts: launch.node.artifacts,
				usage: launch.node.usage,
				policy: launch.node.policy,
			})]);
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
				await runtime.launch({ nodes: [{ agent: "worker", logicalRole: "Inspect", task: "Inspect the repository", cwd: childDirectory }] });
				await runtime.launch({
					nodes: [{
						agent: "worker",
						logicalRole: "Inspect",
						task: "Inspect the repository",
						cwd: childDirectory,
						provider: "override",
						model: "override-model",
						reasoning: "medium",
						tools: ["bash"],
					}],
				});
				await rm(join(project, "worker.md"));
				await runtime.launch({ nodes: [{ agent: "worker", logicalRole: "Inspect", task: "Inspect the repository", cwd: childDirectory }] });
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
			await expect(runtime.launch({ nodes: [{ agent: "missing", logicalRole: "Missing", task: "Inspect" }] })).rejects.toThrow("Agent definition not found: missing");
			await expect(runtime.launch({
				nodes: [{ agent: "worker", logicalRole: "Recursive", task: "Inspect", tools: ["subagent_launch"] }],
			})).rejects.toThrow("Child tool is not allowed: subagent_launch");
			await expect(runtime.launch({
				nodes: [{ agent: "worker", logicalRole: "Bypass", task: "Inspect", tools: ["subagent_launch,read"] }],
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
					await runtime.launch({ nodes: [{ agent, logicalRole, task: "Perform the bounded task" }] });
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
		const graph = { nodes: [{ agent: "worker", logicalRole: "Recon", task: "Inspect", tools: ["isolated-tool"] }] };

		await withRuntime(runner, async (runtime) => {
			const launch = runtime.launch(graph);
			await started;
			graph.nodes[0]!.tools.push("leaked-tool");
			releaseRunner!();
			await launch;

			expect(capturedRequest!.tools).toContain("isolated-tool");
			expect(capturedRequest!.tools).not.toContain("leaked-tool");
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
