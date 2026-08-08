import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	defaultDefinitionDirectories,
	resolveAgentDefinition,
	type DefinitionDirectories,
	type ReasoningLevel,
} from "./definitions.ts";

export type LifecycleState = "queued" | "running" | "completed" | "failed" | "cancelled" | "suspended";

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
	agent: string;
	logicalRole: string;
	task: string;
	cwd?: string;
	provider?: string;
	model?: string;
	reasoning?: ReasoningLevel;
	/** Additional named tools for this node only. */
	tools?: readonly string[];
}

/** The only graph shape supported by this first runtime slice. */
export interface SingleNodeGraph {
	readonly nodes: readonly Readonly<NodeDefinition>[];
}

export interface ChildRunnerRequest {
	runId: string;
	nodeId: string;
	agent: string;
	logicalRole: string;
	task: string;
	cwd: string;
	provider: string;
	model: string;
	reasoning: ReasoningLevel;
	tools: readonly string[];
	systemPrompt: string;
	freshResources: true;
	recursiveDelegation: false;
	approvalPrompts: false;
}

export type ChildRunnerResult =
	| { state: "completed"; output: string; usage?: UsageRecord }
	| { state: "failed"; error: FailureEvidence; usage?: UsageRecord };

/** Executes one fresh child without exposing its process protocol to callers. */
export interface ChildRunner {
	run(request: ChildRunnerRequest): Promise<ChildRunnerResult>;
}

export interface ExecutionPolicy {
	agent: string;
	provider: string;
	model: string;
	reasoning: ReasoningLevel;
	tools: readonly string[];
	cwd: string;
	runnerMode: "subprocess-json";
	freshResources: true;
	recursiveDelegation: false;
	approvalPrompts: false;
}

export interface NodeResult {
	state: "completed" | "failed";
	output?: string;
	error?: FailureEvidence;
	usage?: UsageRecord;
	policy: ExecutionPolicy;
}

export interface NodeView {
	id: string;
	agent: string;
	logicalRole: string;
	state: LifecycleState;
	policy: ExecutionPolicy;
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

export interface ModelCatalog {
	isAvailable(provider: string, model: string): boolean | Promise<boolean>;
}

export interface SubagentRuntimeOptions {
	storeDirectory: string;
	runner?: ChildRunner;
	/** The parent working directory used when a graph node omits cwd. */
	cwd?: string;
	definitionDirectories?: Partial<DefinitionDirectories>;
	modelCatalog: ModelCatalog;
}

/** Stable public operations; storage files and process details remain private. */
export interface SubagentRuntime {
	launch(graph: SingleNodeGraph): Promise<LaunchResult>;
	status(runId: string): Promise<StatusView>;
	result(runId: string, nodeId: string): Promise<NodeResult>;
}

interface StoredNode {
	id: string;
	agent: string;
	logicalRole: string;
	state: LifecycleState;
	policy: ExecutionPolicy;
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
			if (!definition.agent.trim()) throw new Error("Node agent must not be empty");
			if (!definition.logicalRole.trim()) throw new Error("Node logicalRole must not be empty");
			if (!definition.task.trim()) throw new Error("Node task must not be empty");

			const agentDefinition = await resolveAgentDefinition(
				definition.agent,
				configuredDefinitionDirectories(options.cwd ?? process.cwd(), options.definitionDirectories),
			);
			if (agentDefinition.id !== definition.agent) {
				throw new Error(`Agent definition ID mismatch: requested ${definition.agent}, found ${agentDefinition.id}`);
			}
			const policy = resolveExecutionPolicy(definition, agentDefinition, options.cwd ?? process.cwd());
			if (!(await options.modelCatalog.isAvailable(policy.provider, policy.model))) {
				throw new Error(`Unavailable model: ${policy.provider}/${policy.model}`);
			}

			const runId = `run_${randomUUID()}`;
			const nodeId = `node_${randomUUID()}`;
			const runDirectory = join(options.storeDirectory, "runs", runId);
			const resultPath = join(runDirectory, "artifacts", `${nodeId}.json`);
			const manifestPath = join(runDirectory, "artifacts.json");
			const node: StoredNode = {
				id: nodeId,
				agent: definition.agent,
				logicalRole: definition.logicalRole,
				state: "queued",
				policy,
				artifacts: [],
			};
			const snapshot: StoredSnapshot = { run: { id: runId, state: "queued" }, nodes: [node] };

			await writeJsonAtomically(join(runDirectory, "graph.json"), { nodes: [definition] });
			await writeSnapshot(runDirectory, snapshot);
			snapshot.run.state = "running";
			node.state = "running";
			await writeSnapshot(runDirectory, snapshot);

			const startedAt = Date.now();
			let outcome: ChildRunnerResult;
			try {
				outcome = await runner.run({
					runId,
					nodeId,
					agent: policy.agent,
					logicalRole: definition.logicalRole,
					task: definition.task,
					cwd: policy.cwd,
					provider: policy.provider,
					model: policy.model,
					reasoning: policy.reasoning,
					tools: policy.tools,
					systemPrompt: childSystemPrompt(agentDefinition, policy),
					freshResources: true,
					recursiveDelegation: false,
					approvalPrompts: false,
				});
			} catch (error) {
				outcome = { state: "failed", error: { kind: "startup", message: errorMessage(error) } };
			}
			outcome = withDuration(outcome, Date.now() - startedAt);

			const artifact: Artifact = {
				kind: outcome.state === "completed" ? "result" : "failure",
				path: resultPath,
			};
			const result: NodeResult = outcome.state === "completed"
				? { state: "completed", output: outcome.output, usage: outcome.usage, policy }
				: { state: "failed", error: outcome.error, usage: outcome.usage, policy };

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

const forbiddenChildTools = new Set([
	"subagent_launch",
	"subagent_status",
	"subagent_join",
	"subagent_cancel",
	"subagent_resume",
	"subagent_recover",
]);

function configuredDefinitionDirectories(
	parentCwd: string,
	overrides: Partial<DefinitionDirectories> | undefined,
): DefinitionDirectories {
	const defaults = defaultDefinitionDirectories(parentCwd);
	return {
		packaged: overrides?.packaged ?? defaults.packaged,
		user: overrides?.user ?? defaults.user,
		project: overrides?.project ?? defaults.project,
	};
}

function resolveExecutionPolicy(
	node: Readonly<NodeDefinition>,
	definition: Awaited<ReturnType<typeof resolveAgentDefinition>>,
	parentCwd: string,
): ExecutionPolicy {
	const additionalTools = node.tools ?? [];
	for (const tool of additionalTools) {
		if (!tool.trim()) throw new Error("Tool names must not be empty");
		if (tool !== tool.trim()) throw new Error("Tool names must not include surrounding whitespace");
		if (tool.includes(",")) throw new Error("Tool names must not contain commas");
	}

	const tools = [...new Set([...definition.tools, ...additionalTools])];
	for (const tool of tools) {
		if (forbiddenChildTools.has(tool)) throw new Error(`Child tool is not allowed: ${tool}`);
	}

	return Object.freeze({
		agent: definition.id,
		provider: node.provider ?? definition.provider,
		model: node.model ?? definition.model,
		reasoning: node.reasoning ?? definition.reasoning,
		tools: Object.freeze(tools),
		cwd: node.cwd ?? parentCwd,
		runnerMode: "subprocess-json",
		freshResources: true,
		recursiveDelegation: false,
		approvalPrompts: false,
	});
}

function childSystemPrompt(
	definition: Awaited<ReturnType<typeof resolveAgentDefinition>>,
	policy: ExecutionPolicy,
): string {
	return [
		"You are a bounded child agent in a fresh Pi process.",
		"You receive only this task and the normal resources discovered from the declared working directory.",
		"Do not attempt recursive delegation or orchestration; those tools are unavailable.",
		"Tool allowlists are orchestration policy, not an OS security boundary.",
		`Resolved execution identity: ${policy.agent}; provider: ${policy.provider}; model: ${policy.model}; reasoning: ${policy.reasoning}.`,
		"",
		"## Role",
		definition.roleInstructions,
		"",
		"## Report contract",
		definition.reportContract,
		"",
		"## Completion criteria",
		definition.completionCriteria,
	].join("\n");
}

function toNodeView(node: StoredNode, result?: NodeResult): NodeView {
	return {
		id: node.id,
		agent: node.agent,
		logicalRole: node.logicalRole,
		state: node.state,
		policy: node.policy,
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

function withDuration(outcome: ChildRunnerResult, durationMs: number): ChildRunnerResult {
	return { ...outcome, usage: { ...outcome.usage, durationMs: Math.max(0, durationMs) } };
}

function freshChildEnvironment(): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (
			value !== undefined
			&& (
				name === "PATH"
				|| name === "HOME"
				|| name === "USER"
				|| name === "LOGNAME"
				|| name === "SHELL"
				|| name === "TMPDIR"
				|| name === "TERM"
				|| name === "COLORTERM"
				|| name === "LANG"
				|| name === "PI_CODING_AGENT_DIR"
				|| name === "XDG_CONFIG_HOME"
				|| name.startsWith("LC_")
			)
		) {
			environment[name] = value;
		}
	}
	return environment;
}

/** Default runner: a one-shot Pi JSON subprocess with a fresh, ephemeral session. */
export class SubprocessJsonRunner implements ChildRunner {
	constructor(private readonly executable = "pi") {}

	async run(request: ChildRunnerRequest): Promise<ChildRunnerResult> {
		const startedAt = Date.now();
		const args = ["--mode", "json", "-p", "--no-session"];
		args.push("--provider", request.provider);
		args.push("--model", request.model);
		args.push("--thinking", request.reasoning);
		args.push("--tools", request.tools.join(","));
		args.push("--append-system-prompt", request.systemPrompt);
		args.push(request.task);

		return new Promise<ChildRunnerResult>((resolve, reject) => {
			const child = spawn(this.executable, args, {
				cwd: request.cwd,
				env: freshChildEnvironment(),
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
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
				const usage: UsageRecord = {
					provider,
					model,
					inputTokens,
					outputTokens,
					durationMs: Math.max(0, Date.now() - startedAt),
				};
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
