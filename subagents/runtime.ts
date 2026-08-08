import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type LifecycleState = "queued" | "running" | "completed" | "failed";

export interface UsageRecord {
	provider?: string;
	model?: string;
	reasoning?: string;
	inputTokens?: number;
	outputTokens?: number;
	durationMs?: number;
}

export interface Artifact {
	kind: "result" | "failure";
	path: string;
}

export interface FailureEvidence {
	kind: "startup" | "stream" | "execution";
	message: string;
	stderr?: string;
	partialOutput?: string;
}

export interface NodeDefinition {
	logicalRole: string;
	task: string;
	cwd?: string;
	model?: string;
	tools?: readonly string[];
}

/** The only graph shape supported by this first runtime slice. */
export interface SingleNodeGraph {
	readonly nodes: readonly Readonly<NodeDefinition>[];
}

export interface ChildRunnerRequest {
	runId: string;
	nodeId: string;
	logicalRole: string;
	task: string;
	cwd: string;
	model?: string;
	tools?: readonly string[];
}

export type ChildRunnerResult =
	| { state: "completed"; output: string; usage?: UsageRecord }
	| { state: "failed"; error: FailureEvidence; usage?: UsageRecord };

/** Executes one fresh child without exposing its process protocol to callers. */
export interface ChildRunner {
	run(request: ChildRunnerRequest): Promise<ChildRunnerResult>;
}

export interface NodeResult {
	state: "completed" | "failed";
	output?: string;
	error?: FailureEvidence;
	usage?: UsageRecord;
}

export interface NodeView {
	id: string;
	logicalRole: string;
	state: LifecycleState;
	artifacts: Artifact[];
	usage?: UsageRecord;
	result?: NodeResult;
}

export interface RunView {
	id: string;
	state: LifecycleState;
}

export interface LaunchResult {
	run: RunView;
	node: NodeView;
}

export interface StatusView {
	run: RunView;
	nodes: Array<Omit<NodeView, "result">>;
}

export interface SubagentRuntimeOptions {
	storeDirectory: string;
	runner?: ChildRunner;
}

/** Stable public operations; storage files and process details remain private. */
export interface SubagentRuntime {
	launch(graph: SingleNodeGraph): Promise<LaunchResult>;
	status(runId: string): Promise<StatusView>;
	result(runId: string, nodeId: string): Promise<NodeResult>;
}

interface StoredNode {
	id: string;
	logicalRole: string;
	state: LifecycleState;
	artifacts: Artifact[];
	usage?: UsageRecord;
	resultPath?: string;
}

interface StoredSnapshot {
	run: RunView;
	nodes: StoredNode[];
}

/**
 * Creates the public bounded-delegation runtime.
 *
 * The runner and store location are injected so callers can keep execution policy
 * and retention policy outside this small runtime boundary.
 */
export function createSubagentRuntime(options: SubagentRuntimeOptions): SubagentRuntime {
	const runner = options.runner ?? new SubprocessJsonRunner();

	return {
		launch: async (graph: SingleNodeGraph): Promise<LaunchResult> => {
			if (graph.nodes.length !== 1) {
				throw new Error("This runtime slice accepts exactly one node");
			}

			const definition = immutableNodeDefinition(graph.nodes[0]!);
			if (!definition.logicalRole.trim()) throw new Error("Node logicalRole must not be empty");
			if (!definition.task.trim()) throw new Error("Node task must not be empty");

			const runId = `run_${randomUUID()}`;
			const nodeId = `node_${randomUUID()}`;
			const runDirectory = join(options.storeDirectory, "runs", runId);
			const resultPath = join(runDirectory, "artifacts", `${nodeId}.json`);
			const manifestPath = join(runDirectory, "artifacts.json");
			const node: StoredNode = {
				id: nodeId,
				logicalRole: definition.logicalRole,
				state: "queued",
				artifacts: [],
			};
			const snapshot: StoredSnapshot = { run: { id: runId, state: "queued" }, nodes: [node] };

			await writeJsonAtomically(join(runDirectory, "graph.json"), { nodes: [definition] });
			await writeSnapshot(runDirectory, snapshot);
			snapshot.run.state = "running";
			node.state = "running";
			await writeSnapshot(runDirectory, snapshot);

			let outcome: ChildRunnerResult;
			try {
				outcome = await runner.run({
					runId,
					nodeId,
					logicalRole: definition.logicalRole,
					task: definition.task,
					cwd: definition.cwd ?? process.cwd(),
					model: definition.model,
					tools: definition.tools,
				});
			} catch (error) {
				outcome = { state: "failed", error: { kind: "startup", message: errorMessage(error) } };
			}

			const artifact: Artifact = {
				kind: outcome.state === "completed" ? "result" : "failure",
				path: resultPath,
			};
			const result: NodeResult = outcome.state === "completed"
				? { state: "completed", output: outcome.output, usage: outcome.usage }
				: { state: "failed", error: outcome.error, usage: outcome.usage };

			// Persist the complete terminal result and manifest before terminal state.
			await writeJsonAtomically(resultPath, result);
			await writeJsonAtomically(manifestPath, [artifact]);
			node.artifacts = [artifact];
			node.usage = outcome.usage;
			node.resultPath = resultPath;
			node.state = outcome.state;
			snapshot.run.state = outcome.state;
			await writeSnapshot(runDirectory, snapshot);

			return { run: { ...snapshot.run }, node: toNodeView(node, result) };
		},

		status: async (runId: string): Promise<StatusView> => {
			const snapshot = await readSnapshot(options.storeDirectory, runId);
			return {
				run: { ...snapshot.run },
				nodes: snapshot.nodes.map(({ resultPath: _resultPath, ...node }) => ({ ...node })),
			};
		},

		result: async (runId: string, nodeId: string): Promise<NodeResult> => {
			const snapshot = await readSnapshot(options.storeDirectory, runId);
			const node = snapshot.nodes.find((candidate) => candidate.id === nodeId);
			if (!node) throw new Error(`Unknown node: ${nodeId}`);
			if (!node.resultPath) throw new Error(`Node ${nodeId} has no durable result`);
			return JSON.parse(await readFile(node.resultPath, "utf8")) as NodeResult;
		},
	};
}

function immutableNodeDefinition(definition: Readonly<NodeDefinition>): Readonly<NodeDefinition> {
	const tools = definition.tools ? Object.freeze([...definition.tools]) : undefined;
	return Object.freeze({ ...definition, ...(tools ? { tools } : {}) });
}

function toNodeView(node: StoredNode, result?: NodeResult): NodeView {
	return {
		id: node.id,
		logicalRole: node.logicalRole,
		state: node.state,
		artifacts: [...node.artifacts],
		usage: node.usage,
		...(result ? { result } : {}),
	};
}

async function readSnapshot(storeDirectory: string, runId: string): Promise<StoredSnapshot> {
	try {
		return JSON.parse(await readFile(join(storeDirectory, "runs", runId, "snapshot.json"), "utf8")) as StoredSnapshot;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Unknown run: ${runId}`);
		throw error;
	}
}

async function writeSnapshot(runDirectory: string, snapshot: StoredSnapshot): Promise<void> {
	await writeJsonAtomically(join(runDirectory, "snapshot.json"), snapshot);
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporaryPath, JSON.stringify(value), "utf8");
	await rename(temporaryPath, path);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Default runner: a one-shot Pi JSON subprocess with a fresh, ephemeral session. */
export class SubprocessJsonRunner implements ChildRunner {
	constructor(private readonly executable = "pi") {}

	async run(request: ChildRunnerRequest): Promise<ChildRunnerResult> {
		const args = ["--mode", "json", "-p", "--no-session"];
		if (request.model) args.push("--model", request.model);
		if (request.tools && request.tools.length > 0) args.push("--tools", request.tools.join(","));
		args.push(request.task);

		return new Promise<ChildRunnerResult>((resolve, reject) => {
			const child = spawn(this.executable, args, { cwd: request.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			let settled = false;
			let malformedEvent = false;
			let finalOutput: string | undefined;
			let stopReason: string | undefined;
			let provider: string | undefined;
			let model: string | undefined;
			let inputTokens: number | undefined;
			let outputTokens: number | undefined;

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: unknown;
				try {
					event = JSON.parse(line);
				} catch {
					malformedEvent = true;
					return;
				}
				if (!isRecord(event)) return;
				if (event.type === "agent_settled") settled = true;
				if (event.type !== "message_end" || !isRecord(event.message) || event.message.role !== "assistant") return;

				finalOutput = textContent(event.message.content);
				stopReason = stringValue(event.message.stopReason);
				provider = stringValue(event.message.provider);
				model = stringValue(event.message.model);
				if (isRecord(event.message.usage)) {
					inputTokens = numberValue(event.message.usage.input);
					outputTokens = numberValue(event.message.usage.output);
				}
			};

			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
				const lines = stdout.split("\n");
				stdout = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});
			child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
			child.once("error", reject);
			child.once("close", (code) => {
				processLine(stdout);
				const usage = provider || model || inputTokens !== undefined || outputTokens !== undefined
					? { provider, model, inputTokens, outputTokens }
					: undefined;
				if (code !== 0 || stopReason === "error" || stopReason === "aborted") {
					resolve({
						state: "failed",
						error: { kind: "execution", message: stopReason ?? `Pi exited with code ${code ?? "unknown"}`, stderr, partialOutput: finalOutput },
						usage,
					});
					return;
				}
				if (malformedEvent || !settled || finalOutput === undefined) {
					resolve({
						state: "failed",
						error: {
							kind: "stream",
							message: malformedEvent ? "Pi emitted malformed JSON" : "Pi exited without settled final assistant output",
							stderr,
							partialOutput: finalOutput,
						},
						usage,
					});
					return;
				}
				resolve({ state: "completed", output: finalOutput, usage });
			});
		});
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function textContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter(isRecord)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}
