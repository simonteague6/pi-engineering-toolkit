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
	kind: "result" | "failure" | "handoff" | "graph-result";
	path: string;
}

export interface FailureEvidence {
	kind: "startup" | "stream" | "execution" | "cancelled";
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

/** Public ergonomic form for exactly one child node. */
export interface SingleGraph {
	readonly kind: "single";
	readonly node: Readonly<NodeDefinition>;
}

/** Public ergonomic form for independent sibling nodes. */
export interface ParallelGraph {
	readonly kind: "parallel";
	readonly nodes: readonly Readonly<NodeDefinition>[];
	/** A per-run lower concurrency limit. */
	readonly maxConcurrency?: number;
}

/** Public ergonomic form for ordered dependent child nodes. */
export interface ChainGraph {
	readonly kind: "chain";
	readonly nodes: readonly Readonly<NodeDefinition>[];
	readonly maxConcurrency?: number;
}

/** A statically named DAG node with its direct required predecessors. */
export interface DagNodeDefinition extends NodeDefinition {
	readonly id: string;
	readonly dependsOn?: readonly string[];
}

/** Public form for a static acyclic dependency graph. */
export interface DagGraph {
	readonly kind: "dag";
	readonly nodes: readonly Readonly<DagNodeDefinition>[];
	readonly maxConcurrency?: number;
}

/** Public graph forms normalized to one private immutable graph before execution. */
export type GraphDefinition = SingleGraph | ParallelGraph | ChainGraph | DagGraph;

interface NormalizedNode {
	readonly id: string;
	readonly definition: Readonly<NodeDefinition>;
	readonly dependencies: readonly string[];
}

interface NormalizedGraph {
	readonly nodes: readonly NormalizedNode[];
	readonly maxConcurrency?: number;
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
	| { state: "failed"; error: FailureEvidence; usage?: UsageRecord }
	| { state: "cancelled"; error?: FailureEvidence; usage?: UsageRecord };

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
	state: "completed" | "failed" | "cancelled";
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
	blockedBy?: string[];
	usage?: UsageRecord;
	result?: NodeResult;
}

/** Durable evidence that a node received every direct predecessor result. */
export interface HandoffEvidence {
	nodeId: string;
	predecessorIds: string[];
	predecessorArtifacts: Artifact[];
	artifact: Artifact;
	delivery: "inline" | "artifact";
}

/** Compact terminal node history in graph declaration order. */
export interface NodeTrace {
	nodeId: string;
	logicalRole: string;
	state: LifecycleState;
	predecessorIds: string[];
	blockedBy?: string[];
}

export interface RunView {
	id: string;
	state: LifecycleState;
}

/** Terminal aggregate in declaration order with durable graph evidence. */
export interface LaunchResult {
	run: RunView;
	nodes: NodeView[];
	finalOutput?: string;
	trace: NodeTrace[];
	artifacts: Artifact[];
	handoffs: HandoffEvidence[];
}

export interface LaunchReceipt {
	run: RunView;
}

export interface LaunchOptions {
	/** Detached execution is the default; blocking returns the terminal node result. */
	delivery?: "detached" | "blocking";
}

export interface UsageTotals {
	inputTokens?: number;
	outputTokens?: number;
	durationMs?: number;
}

export interface StatusView {
	run: RunView;
	nodes: Array<Omit<NodeView, "result">>;
	usage?: UsageTotals;
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
	/** User-owned active-child ceiling; defaults to six. */
	maxConcurrency?: number;
}

/** Stable public operations; storage files and process details remain private. */
export interface SubagentRuntime {
	launch(graph: GraphDefinition): Promise<LaunchReceipt>;
	launch(graph: GraphDefinition, options: { delivery: "blocking" }): Promise<LaunchResult>;
	launch(graph: GraphDefinition, options: { delivery: "detached" }): Promise<LaunchReceipt>;
	launch(graph: GraphDefinition, options: LaunchOptions): Promise<LaunchReceipt | LaunchResult>;
	status(runId: string): Promise<StatusView>;
	join(runId: string): Promise<LaunchResult>;
	result(runId: string, nodeId: string): Promise<NodeResult>;
}

interface StoredNode {
	id: string;
	agent: string;
	logicalRole: string;
	state: LifecycleState;
	policy: ExecutionPolicy;
	artifacts: Artifact[];
	blockedBy?: string[];
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
	const ownedDetachedRuns = new Map<string, Promise<LaunchResult>>();

	const launch = (async (
		graph: GraphDefinition,
		launchOptions?: LaunchOptions,
	): Promise<LaunchReceipt | LaunchResult> => {
		const normalizedGraph = immutableGraphDefinition(graph);
		if (normalizedGraph.nodes.length === 0) throw new Error("Graph must contain at least one node");
		const concurrency = effectiveConcurrencyLimit(options.maxConcurrency, normalizedGraph.maxConcurrency);
		const parentCwd = options.cwd ?? process.cwd();
		const definitionDirectories = configuredDefinitionDirectories(parentCwd, options.definitionDirectories);
		const preparedNodes: Array<{
			node: NormalizedNode;
			agentDefinition: Awaited<ReturnType<typeof resolveAgentDefinition>>;
			policy: ExecutionPolicy;
		}> = [];
		for (const node of normalizedGraph.nodes) {
			const definition = node.definition;
			validateNodeDefinition(definition);
			const agentDefinition = await resolveAgentDefinition(definition.agent, definitionDirectories);
			if (agentDefinition.id !== definition.agent) {
				throw new Error(`Agent definition ID mismatch: requested ${definition.agent}, found ${agentDefinition.id}`);
			}
			const policy = resolveExecutionPolicy(definition, agentDefinition, parentCwd);
			if (!(await options.modelCatalog.isAvailable(policy.provider, policy.model))) {
				throw new Error(`Unavailable model: ${policy.provider}/${policy.model}`);
			}
			preparedNodes.push({ node, agentDefinition, policy });
		}

		const runId = `run_${randomUUID()}`;
		const runDirectory = join(options.storeDirectory, "runs", runId);
		const manifestPath = join(runDirectory, "artifacts.json");
		const nodes: StoredNode[] = preparedNodes.map(({ node, policy }) => ({
			id: node.id,
			agent: node.definition.agent,
			logicalRole: node.definition.logicalRole,
			state: "queued",
			policy,
			artifacts: [],
		}));
		const resultPaths = nodes.map((node) => join(runDirectory, "artifacts", "nodes", `${node.id}.json`));
		const snapshot: StoredSnapshot = { run: { id: runId, state: "queued" }, nodes };
		let snapshotWrite = Promise.resolve();
		const persistSnapshot = (): Promise<void> => {
			const write = snapshotWrite.then(() => writeSnapshot(runDirectory, snapshot));
			snapshotWrite = write;
			return write;
		};

		await writeJsonAtomically(join(runDirectory, "graph.json"), normalizedGraph);
		await persistSnapshot();
		snapshot.run.state = "running";
		await persistSnapshot();

		const handoffs: HandoffEvidence[] = [];
		const indexById = new Map(nodes.map((node, index) => [node.id, index]));

		const executeNode = (index: number): Promise<NodeView> => {
			const prepared = preparedNodes[index]!;
			const node = nodes[index]!;
			const predecessorIndexes = prepared.node.dependencies
				.map((id) => indexById.get(id)!)
				.sort((left, right) => left - right);
			node.state = "running";
			void persistSnapshot();

			return (async (): Promise<NodeView> => {
				let task = prepared.node.definition.task;
				if (predecessorIndexes.length > 0) {
					const predecessorArtifacts: Artifact[] = [];
					const sections: string[] = [];
					for (const predecessorIndex of predecessorIndexes) {
						const predecessor = nodes[predecessorIndex]!;
						const artifact = predecessor.artifacts.find((candidate) => candidate.kind === "result");
						if (!artifact || !predecessor.resultPath) throw new Error(`Missing durable result for predecessor ${predecessor.id}`);
						const result = JSON.parse(await readFile(predecessor.resultPath, "utf8")) as NodeResult;
						if (result.state !== "completed" || result.output === undefined) {
							throw new Error(`Unusable result for predecessor ${predecessor.id}`);
						}
						predecessorArtifacts.push(artifact);
						sections.push(`## Output from ${predecessor.id}\n${result.output}`);
					}
					const memo = sections.join("\n\n");
					const handoffArtifact: Artifact = {
						kind: "handoff",
						path: join(runDirectory, "artifacts", "handoffs", `${node.id}.txt`),
					};
					await writeTextAtomically(handoffArtifact.path, memo);
					node.artifacts = [...node.artifacts, handoffArtifact];
					const delivery = Buffer.byteLength(memo, "utf8") > MAX_INLINE_HANDOFF_BYTES ? "artifact" : "inline";
					handoffs.push({
						nodeId: node.id,
						predecessorIds: predecessorIndexes.map((predecessorIndex) => nodes[predecessorIndex]!.id),
						predecessorArtifacts,
						artifact: handoffArtifact,
						delivery,
					});
					task = delivery === "inline"
						? `${task}\n\n${memo}`
						: `${task}\n\n## Required predecessor handoff\nThe complete predecessor handoff is stored at: ${handoffArtifact.path}\nRead this artifact before starting.`;
				}

				const resultPath = resultPaths[index]!;
				const startedAt = Date.now();
				let outcome: ChildRunnerResult;
				try {
					outcome = await runner.run({
						runId,
						nodeId: node.id,
						agent: prepared.policy.agent,
						logicalRole: prepared.node.definition.logicalRole,
						task,
						cwd: prepared.policy.cwd,
						provider: prepared.policy.provider,
						model: prepared.policy.model,
						reasoning: prepared.policy.reasoning,
						tools: prepared.policy.tools,
						systemPrompt: childSystemPrompt(prepared.agentDefinition, prepared.policy),
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
					? { state: "completed", output: outcome.output, usage: outcome.usage, policy: prepared.policy }
					: {
						state: outcome.state,
						...(outcome.error === undefined ? {} : { error: outcome.error }),
						usage: outcome.usage,
						policy: prepared.policy,
					};

				// Persist the complete terminal result before exposing the terminal node state.
				await writeJsonAtomically(resultPath, result);
				node.artifacts = [...node.artifacts, artifact];
				node.usage = outcome.usage;
				node.resultPath = resultPath;
				node.state = outcome.state;
				await persistSnapshot();

				return toNodeView(node, result);
			})();
		};

		const execution = (async (): Promise<LaunchResult> => {
			const results: Array<NodeView | undefined> = new Array(nodes.length);
			let active: Array<{ index: number; execution: Promise<NodeView> }> = [];
			while (true) {
				let blocked = false;
				for (let index = 0; index < nodes.length; index += 1) {
					const node = nodes[index]!;
					if (node.state !== "queued") continue;
					const blockers = preparedNodes[index]!.node.dependencies.filter((id) => {
						const predecessor = nodes[indexById.get(id)!]!;
						return predecessor.state === "failed" || predecessor.state === "cancelled" || predecessor.blockedBy !== undefined;
					});
					if (blockers.length > 0) {
						node.blockedBy = blockers;
						blocked = true;
					}
				}
				if (blocked) await persistSnapshot();

				while (active.length < concurrency) {
					const index = nodes.findIndex((node, candidate) => node.state === "queued"
						&& node.blockedBy === undefined
						&& preparedNodes[candidate]!.node.dependencies.every((id) => nodes[indexById.get(id)!]!.state === "completed"));
					if (index < 0) break;
					active.push({ index, execution: executeNode(index) });
				}

				if (active.length === 0) break;
				const settled = await Promise.race(active.map(async ({ index, execution }) => ({ index, view: await execution })));
				results[settled.index] = settled.view;
				active = active.filter((candidate) => candidate.index !== settled.index);
			}

			const finalNodes = nodes.map((node, index) => results[index] ?? toNodeView(node));
			snapshot.run.state = finalNodes.some((node) => node.state === "cancelled")
				? "cancelled"
				: finalNodes.every((node) => node.state === "completed") ? "completed" : "failed";
			const graphArtifact: Artifact = { kind: "graph-result", path: join(runDirectory, "artifacts", "graph-result.json") };
			const artifacts = [...nodes.flatMap((node) => node.artifacts), graphArtifact];
			const finalNode = finalNodes.at(-1)!;
			const aggregate: LaunchResult = {
				run: { ...snapshot.run },
				nodes: finalNodes,
				...(finalNode.result?.state === "completed" ? { finalOutput: finalNode.result.output } : {}),
				trace: finalNodes.map((node, index) => ({
					nodeId: node.id,
					logicalRole: node.logicalRole,
					state: node.state,
					predecessorIds: [...preparedNodes[index]!.node.dependencies],
					...(node.blockedBy ? { blockedBy: [...node.blockedBy] } : {}),
				})),
				artifacts,
				handoffs: [...handoffs].sort((left, right) => indexById.get(left.nodeId)! - indexById.get(right.nodeId)!),
			};
			await writeJsonAtomically(graphArtifact.path, aggregate);
			await writeJsonAtomically(manifestPath, artifacts);
			await persistSnapshot();
			return aggregate;
		})();

		if (launchOptions?.delivery === "blocking") return execution;

		ownedDetachedRuns.set(runId, execution);
		// A detached receipt must observe the queued nodes as running before it returns.
		await snapshotWrite;
		// Detached callers may never join; retain rejection handling for storage failures.
		void execution.catch(() => undefined);
		return { run: { ...snapshot.run } };
	}) as SubagentRuntime["launch"];

	return {
		launch,

		status: async (runId: string): Promise<StatusView> => {
			const snapshot = await readSnapshot(options.storeDirectory, runId);
			const usage = usageTotals(snapshot.nodes);
			return {
				run: { ...snapshot.run },
				nodes: snapshot.nodes.map(({ resultPath: _resultPath, ...node }) => ({ ...node })),
				...(usage ? { usage } : {}),
			};
		},

		join: async (runId: string): Promise<LaunchResult> => {
			await readSnapshot(options.storeDirectory, runId);
			const execution = ownedDetachedRuns.get(runId);
			if (!execution) throw new Error(`Run is not owned by this runtime: ${runId}`);
			return execution;
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

export const DEFAULT_MAX_CONCURRENCY = 6;
/** Large handoffs remain complete on disk and enter child context by explicit path. */
export const MAX_INLINE_HANDOFF_BYTES = 50 * 1024;

function immutableGraphDefinition(graph: GraphDefinition): NormalizedGraph {
	const definitions = graph.kind === "single" ? [graph.node] : graph.nodes;
	if (!Array.isArray(definitions)) throw new Error("Graph nodes must be an array");

	const nodes = graph.kind === "dag"
		? definitions.map((node) => {
				const dagNode = node as Readonly<DagNodeDefinition>;
				const { id, dependsOn = [], ...definition } = dagNode;
				return immutableNormalizedNode(id, definition, dependsOn);
			})
		: definitions.map((definition, index) => immutableNormalizedNode(
			`node-${index + 1}`,
			definition,
			graph.kind === "chain" && index > 0 ? [`node-${index}`] : [],
		));
	validateGraph(nodes);
	return Object.freeze({
		nodes: Object.freeze(nodes),
		...(graph.kind !== "single" && graph.maxConcurrency !== undefined
			? { maxConcurrency: graph.maxConcurrency }
			: {}),
	});
}

function immutableNormalizedNode(
	id: string,
	definition: Readonly<NodeDefinition>,
	dependencies: readonly string[],
): NormalizedNode {
	return Object.freeze({
		id,
		definition: immutableNodeDefinition(definition),
		dependencies: Object.freeze([...dependencies]),
	});
}

function validateGraph(nodes: readonly NormalizedNode[]): void {
	const ids = new Set<string>();
	for (const node of nodes) {
		if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(node.id)) {
			throw new Error(`Invalid node ID: ${node.id}`);
		}
		if (ids.has(node.id)) throw new Error(`Duplicate node ID: ${node.id}`);
		ids.add(node.id);
	}
	for (const node of nodes) {
		const dependencies = new Set<string>();
		for (const dependency of node.dependencies) {
			if (!ids.has(dependency)) throw new Error(`Unknown predecessor ${dependency} for node ${node.id}`);
			if (!dependencies.add(dependency)) throw new Error(`Duplicate predecessor ${dependency} for node ${node.id}`);
		}
	}

	const remainingDependencies = new Map(nodes.map((node) => [node.id, node.dependencies.length]));
	const dependents = new Map(nodes.map((node) => [node.id, [] as string[]]));
	for (const node of nodes) {
		for (const dependency of node.dependencies) dependents.get(dependency)!.push(node.id);
	}
	const ready = nodes.filter((node) => node.dependencies.length === 0).map((node) => node.id);
	let visited = 0;
	while (ready.length > 0) {
		const id = ready.shift()!;
		visited += 1;
		for (const dependent of dependents.get(id)!) {
			const remaining = remainingDependencies.get(dependent)! - 1;
			remainingDependencies.set(dependent, remaining);
			if (remaining === 0) ready.push(dependent);
		}
	}
	if (visited !== nodes.length) throw new Error("Graph must be acyclic");
}

function validateNodeDefinition(definition: Readonly<NodeDefinition>): void {
	if (!definition.agent.trim()) throw new Error("Node agent must not be empty");
	if (!definition.logicalRole.trim()) throw new Error("Node logicalRole must not be empty");
	if (!definition.task.trim()) throw new Error("Node task must not be empty");
}

function effectiveConcurrencyLimit(userLimit: number | undefined, runLimit: number | undefined): number {
	const ceiling = userLimit ?? DEFAULT_MAX_CONCURRENCY;
	validateConcurrencyLimit("Runtime maxConcurrency", ceiling);
	if (runLimit !== undefined) validateConcurrencyLimit("Graph maxConcurrency", runLimit);
	return Math.min(ceiling, runLimit ?? ceiling);
}

function validateConcurrencyLimit(label: string, limit: number): void {
	if (!Number.isSafeInteger(limit) || limit < 1) {
		throw new Error(`${label} must be a positive safe integer`);
	}
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
		...(node.blockedBy ? { blockedBy: [...node.blockedBy] } : {}),
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
	await writeTextAtomically(path, JSON.stringify(value));
}

async function writeTextAtomically(path: string, value: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporaryPath, value, "utf8");
	await rename(temporaryPath, path);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function withDuration(outcome: ChildRunnerResult, durationMs: number): ChildRunnerResult {
	return { ...outcome, usage: { ...outcome.usage, durationMs: Math.max(0, durationMs) } };
}

function usageTotals(nodes: readonly StoredNode[]): UsageTotals | undefined {
	const totals: UsageTotals = {};
	const fields = ["inputTokens", "outputTokens", "durationMs"] as const;
	for (const node of nodes) {
		for (const field of fields) {
			const value = node.usage?.[field];
			if (value !== undefined) totals[field] = (totals[field] ?? 0) + value;
		}
	}
	return Object.keys(totals).length > 0 ? totals : undefined;
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
				if (stopReason === "aborted") {
					resolve({
						state: "cancelled",
						error: { kind: "cancelled", message: "Pi stopped before settlement", stderr, partialOutput: finalOutput },
						usage,
					});
					return;
				}
				if (code !== 0 || stopReason === "error") {
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
