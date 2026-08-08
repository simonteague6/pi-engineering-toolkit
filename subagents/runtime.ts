import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
	kind: "result" | "failure" | "checkpoint" | "handoff" | "graph-result";
	path: string;
}

export interface FailureEvidence {
	kind: "startup" | "stream" | "execution" | "cancelled" | "timeout";
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
export interface ChildRunnerOptions {
	/** Requests graceful child termination. */
	readonly signal?: AbortSignal;
	/** The runner must escalate after this grace period when it owns a process. */
	readonly terminationGraceMs?: number;
	/** Reports whether the child currently has active provider or tool work. */
	readonly onActivityChange?: (active: boolean) => void;
}

export interface ChildRunner {
	run(request: ChildRunnerRequest, options?: ChildRunnerOptions): Promise<ChildRunnerResult>;
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
	state: "completed" | "failed" | "cancelled" | "suspended";
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
	/** Time with no active provider or tool work. Defaults to ten minutes. */
	idleLimitMs?: number;
}

export interface LifecycleEvent {
	runId: string;
	state: LifecycleState;
	nodeId?: string;
	reason?: "cancelled" | "suspended" | "timeout";
	at: number;
}

export interface RuntimeClock {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(timer: unknown): void;
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
	/** Default time with no active provider or tool work; defaults to ten minutes. */
	idleLimitMs?: number;
	/** Grace period before a subprocess runner force-terminates a child. */
	terminationGraceMs?: number;
	/** Injectable clock for deterministic lifecycle tests. */
	clock?: RuntimeClock;
}

/** Stable public operations; storage files and process details remain private. */
export interface SubagentRuntime {
	launch(graph: GraphDefinition): Promise<LaunchReceipt>;
	launch(graph: GraphDefinition, options: { delivery: "blocking" }): Promise<LaunchResult>;
	launch(graph: GraphDefinition, options: { delivery: "detached" }): Promise<LaunchReceipt>;
	launch(graph: GraphDefinition, options: LaunchOptions): Promise<LaunchReceipt | LaunchResult>;
	status(runId: string): Promise<StatusView>;
	join(runId: string): Promise<LaunchResult>;
	/** Cancels a whole run, or one node and its descendants. */
	cancel(runId: string, nodeId?: string): Promise<LaunchResult>;
	/** Restarts a suspended run from its durable graph and evidence only. */
	resume(runId: string): Promise<LaunchResult>;
	/** Gracefully suspends runtime-owned active runs. */
	dispose(): Promise<void>;
	events(runId: string): Promise<LifecycleEvent[]>;
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
	idleLimitMs: number;
}

interface RunControl {
	readonly nodeIds: readonly string[];
	readonly controllers: Map<string, AbortController>;
	readonly active: Set<string>;
	mode: "running" | "cancelling" | "suspending" | "timing-out";
	haltScheduling: boolean;
	readonly affected: Set<string>;
	apply?: (mode: RunControl["mode"], nodeIds: readonly string[]) => Promise<void>;
}

/**
 * Creates the public bounded-delegation runtime.
 *
 * The runner and store location are injected so callers can keep execution policy
 * and retention policy outside this small runtime boundary.
 */
export function createSubagentRuntime(options: SubagentRuntimeOptions): SubagentRuntime {
	const runner = options.runner ?? new SubprocessJsonRunner();
	const executions = new Map<string, Promise<LaunchResult>>();
	const controls = new Map<string, RunControl>();
	const clock = options.clock ?? systemClock;
	const defaultIdleLimitMs = options.idleLimitMs ?? DEFAULT_IDLE_LIMIT_MS;
	const terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
	validatePositiveDuration("Runtime idleLimitMs", defaultIdleLimitMs);
	validatePositiveDuration("Runtime terminationGraceMs", terminationGraceMs);

	const prepareNodes = async (graph: NormalizedGraph, parentCwd: string) => {
		const directories = configuredDefinitionDirectories(parentCwd, options.definitionDirectories);
		const prepared: Array<{ node: NormalizedNode; agentDefinition: Awaited<ReturnType<typeof resolveAgentDefinition>>; policy: ExecutionPolicy }> = [];
		for (const node of graph.nodes) {
			validateNodeDefinition(node.definition);
			const agentDefinition = await resolveAgentDefinition(node.definition.agent, directories);
			if (agentDefinition.id !== node.definition.agent) {
				throw new Error(`Agent definition ID mismatch: requested ${node.definition.agent}, found ${agentDefinition.id}`);
			}
			const policy = resolveExecutionPolicy(node.definition, agentDefinition, parentCwd);
			if (!(await options.modelCatalog.isAvailable(policy.provider, policy.model))) {
				throw new Error(`Unavailable model: ${policy.provider}/${policy.model}`);
			}
			prepared.push({ node, agentDefinition, policy });
		}
		return prepared;
	};

	const executeRun = async (
		runId: string,
		graph: NormalizedGraph,
		preparedNodes: Awaited<ReturnType<typeof prepareNodes>>,
		snapshot: StoredSnapshot,
	): Promise<LaunchResult> => {
		const runDirectory = join(options.storeDirectory, "runs", runId);
		const manifestPath = join(runDirectory, "artifacts.json");
		const resultPaths = snapshot.nodes.map((node) => join(runDirectory, "artifacts", "nodes", `${node.id}.json`));
		const indexById = new Map(snapshot.nodes.map((node, index) => [node.id, index]));
		const handoffs: HandoffEvidence[] = [];
		const nodeViews = new Map<number, NodeView>();
		let snapshotWrite = Promise.resolve();
		let eventWrite = Promise.resolve();
		const persistSnapshot = (): Promise<void> => {
			const write = snapshotWrite.then(() => writeSnapshot(runDirectory, snapshot));
			snapshotWrite = write;
			return write;
		};
		const record = (state: LifecycleState, nodeId?: string, reason?: LifecycleEvent["reason"]): Promise<void> => {
			const event: LifecycleEvent = { runId, state, ...(nodeId ? { nodeId } : {}), ...(reason ? { reason } : {}), at: clock.now() };
			const write = eventWrite.then(() => appendFile(join(runDirectory, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8"));
			eventWrite = write;
			return write;
		};
		const control: RunControl = {
			nodeIds: snapshot.nodes.map((node) => node.id),
			controllers: new Map(),
			active: new Set(),
			mode: "running",
			haltScheduling: false,
			affected: new Set(),
		};
		controls.set(runId, control);
		const activeWork = new Set<string>();
		let idleTimer: unknown;
		const clearIdleTimer = () => {
			if (idleTimer !== undefined) clock.clearTimeout(idleTimer);
			idleTimer = undefined;
		};
		const armIdleTimer = () => {
			clearIdleTimer();
			if ((control.mode !== "running" && control.haltScheduling) || activeWork.size !== 0) return;
			idleTimer = clock.setTimeout(() => {
				if (!control.haltScheduling && activeWork.size === 0) {
					void control.apply?.("timing-out", snapshot.nodes.filter((node) => !isTerminal(node.state)).map((node) => node.id));
				}
			}, snapshot.idleLimitMs);
		};
		const setStoredResult = async (
			index: number,
			state: Extract<LifecycleState, "failed" | "cancelled" | "suspended">,
			error: FailureEvidence,
		): Promise<void> => {
			const node = snapshot.nodes[index]!;
			if (isTerminal(node.state)) return;
			const resultPath = state === "suspended"
				? join(runDirectory, "artifacts", "checkpoints", `${node.id}-${randomUUID()}.json`)
				: resultPaths[index]!;
			const result: NodeResult = { state, error, policy: node.policy };
			await writeJsonAtomically(resultPath, result);
			node.resultPath = resultPath;
			node.artifacts = [...node.artifacts, { kind: state === "suspended" ? "checkpoint" : "failure", path: resultPath }];
			node.state = state;
			nodeViews.set(index, toNodeView(node, result));
			await record(state, node.id, state === "failed" && error.kind === "timeout" ? "timeout" : state);
		};
		control.apply = async (mode, nodeIds) => {
			if (control.mode !== "running" && mode !== "suspending" && !(mode === "timing-out" && !control.haltScheduling)) return;
			control.mode = mode;
			control.haltScheduling = mode !== "cancelling" || nodeIds.length === control.nodeIds.length;
			clearIdleTimer();
			for (const nodeId of nodeIds) {
				control.affected.add(nodeId);
				const index = indexById.get(nodeId);
				if (index === undefined) continue;
				const node = snapshot.nodes[index]!;
				if (node.state === "queued") {
					const error: FailureEvidence = mode === "timing-out"
						? { kind: "timeout", message: `Idle limit of ${snapshot.idleLimitMs}ms exceeded` }
						: { kind: "cancelled", message: mode === "suspending" ? "Run suspended" : "Run cancelled" };
					await setStoredResult(index, mode === "timing-out" ? "failed" : mode === "suspending" ? "suspended" : "cancelled", error);
				}
				control.controllers.get(nodeId)?.abort();
			}
			await persistSnapshot();
		};

		const executeNode = async (index: number): Promise<NodeView> => {
			const prepared = preparedNodes[index]!;
			const node = snapshot.nodes[index]!;
			const predecessorIndexes = prepared.node.dependencies.map((id) => indexById.get(id)!).sort((left, right) => left - right);
			node.state = "running";
			void record("running", node.id);
			void persistSnapshot();
			let task = prepared.node.definition.task;
			if (predecessorIndexes.length > 0) {
				const predecessorArtifacts: Artifact[] = [];
				const sections: string[] = [];
				for (const predecessorIndex of predecessorIndexes) {
					const predecessor = snapshot.nodes[predecessorIndex]!;
					const artifact = predecessor.artifacts.find((candidate) => candidate.kind === "result");
					if (!artifact || !predecessor.resultPath) throw new Error(`Missing durable result for predecessor ${predecessor.id}`);
					const result = JSON.parse(await readFile(predecessor.resultPath, "utf8")) as NodeResult;
					if (result.state !== "completed" || result.output === undefined) throw new Error(`Unusable result for predecessor ${predecessor.id}`);
					predecessorArtifacts.push(artifact);
					sections.push(`## Output from ${predecessor.id}\n${result.output}`);
				}
				const memo = sections.join("\n\n");
				const handoffArtifact: Artifact = { kind: "handoff", path: join(runDirectory, "artifacts", "handoffs", `${node.id}.txt`) };
				await writeTextAtomically(handoffArtifact.path, memo);
				node.artifacts = [...node.artifacts, handoffArtifact];
				const delivery = Buffer.byteLength(memo, "utf8") > MAX_INLINE_HANDOFF_BYTES ? "artifact" : "inline";
				handoffs.push({ nodeId: node.id, predecessorIds: predecessorIndexes.map((predecessorIndex) => snapshot.nodes[predecessorIndex]!.id), predecessorArtifacts, artifact: handoffArtifact, delivery });
				task = delivery === "inline" ? `${task}\n\n${memo}` : `${task}\n\n## Required predecessor handoff\nThe complete predecessor handoff is stored at: ${handoffArtifact.path}\nRead this artifact before starting.`;
			}
			const controller = new AbortController();
			control.controllers.set(node.id, controller);
			control.active.add(node.id);
			activeWork.add(node.id);
			clearIdleTimer();
			const startedAt = clock.now();
			let outcome: ChildRunnerResult;
			try {
				outcome = await runner.run({
					runId, nodeId: node.id, agent: prepared.policy.agent, logicalRole: prepared.node.definition.logicalRole, task,
					cwd: prepared.policy.cwd, provider: prepared.policy.provider, model: prepared.policy.model, reasoning: prepared.policy.reasoning,
					tools: prepared.policy.tools, systemPrompt: childSystemPrompt(prepared.agentDefinition, prepared.policy),
					freshResources: true, recursiveDelegation: false, approvalPrompts: false,
				}, {
					signal: controller.signal,
					terminationGraceMs,
					onActivityChange: (active) => {
						if (active) activeWork.add(node.id);
						else activeWork.delete(node.id);
						armIdleTimer();
					},
				});
			} catch (error) {
				outcome = { state: "failed", error: { kind: "startup", message: errorMessage(error) } };
			}
			control.controllers.delete(node.id);
			control.active.delete(node.id);
			activeWork.delete(node.id);
			armIdleTimer();
			outcome = withDuration(outcome, clock.now() - startedAt);
			let state: NodeResult["state"] = outcome.state;
			let error = outcome.state === "completed" ? undefined : outcome.error;
			if (control.affected.has(node.id)) {
				if (control.mode === "suspending") {
					state = "suspended";
					error = { kind: "cancelled", message: "Run suspended", ...(outcome.state === "completed" ? { partialOutput: outcome.output } : {}) };
				} else if (control.mode === "timing-out") {
					state = "failed";
					error = { kind: "timeout", message: `Idle limit of ${snapshot.idleLimitMs}ms exceeded`, ...(outcome.state === "completed" ? { partialOutput: outcome.output } : {}) };
				} else {
					state = "cancelled";
					error = { kind: "cancelled", message: "Run cancelled", ...(outcome.state === "completed" ? { partialOutput: outcome.output } : {}) };
				}
			}
			const resultPath = state === "suspended"
				? join(runDirectory, "artifacts", "checkpoints", `${node.id}-${randomUUID()}.json`)
				: resultPaths[index]!;
			const result: NodeResult = state === "completed"
				? { state, output: (outcome as Extract<ChildRunnerResult, { state: "completed" }>).output, usage: outcome.usage, policy: prepared.policy }
				: { state, ...(error ? { error } : {}), usage: outcome.usage, policy: prepared.policy };
			await writeJsonAtomically(resultPath, result);
			node.resultPath = resultPath;
			node.artifacts = [...node.artifacts, { kind: state === "completed" ? "result" : state === "suspended" ? "checkpoint" : "failure", path: resultPath }];
			node.usage = outcome.usage;
			node.state = state;
			const view = toNodeView(node, result);
			nodeViews.set(index, view);
			await record(state, node.id, state === "failed" && error?.kind === "timeout" ? "timeout" : state === "suspended" ? "suspended" : state === "cancelled" ? "cancelled" : undefined);
			await persistSnapshot();
			return view;
		};

		for (const node of snapshot.nodes) {
			if (node.state === "queued") void record("queued", node.id);
		}
		void record("running");
		const results: Array<NodeView | undefined> = new Array(snapshot.nodes.length);
		let active: Array<{ index: number; execution: Promise<NodeView> }> = [];
		while (true) {
			let blocked = false;
			for (let index = 0; index < snapshot.nodes.length; index += 1) {
				const node = snapshot.nodes[index]!;
				if (node.state !== "queued") continue;
				const blockers = preparedNodes[index]!.node.dependencies.filter((id) => {
					const predecessor = snapshot.nodes[indexById.get(id)!]!;
					return predecessor.state === "failed" || predecessor.state === "cancelled" || predecessor.blockedBy !== undefined;
				});
				if (blockers.length > 0) { node.blockedBy = blockers; blocked = true; }
			}
			if (blocked) await persistSnapshot();
			while ((!control.haltScheduling) && active.length < effectiveConcurrencyLimit(options.maxConcurrency, graph.maxConcurrency)) {
				const index = snapshot.nodes.findIndex((node, candidate) => node.state === "queued" && node.blockedBy === undefined && preparedNodes[candidate]!.node.dependencies.every((id) => snapshot.nodes[indexById.get(id)!]!.state === "completed"));
				if (index < 0) break;
				active.push({ index, execution: executeNode(index) });
			}
			if (active.length === 0) break;
			const settled = await Promise.race(active.map(async ({ index, execution }) => ({ index, view: await execution })));
			results[settled.index] = settled.view;
			active = active.filter((candidate) => candidate.index !== settled.index);
		}
		clearIdleTimer();
		const finalNodes = snapshot.nodes.map((node, index) => results[index] ?? nodeViews.get(index) ?? toNodeView(node));
		snapshot.run.state = finalNodes.every((node) => node.state === "completed")
			? "completed"
			: finalNodes.some((node) => node.state === "suspended") ? "suspended"
			: finalNodes.some((node) => node.state === "cancelled") ? "cancelled" : "failed";
		const graphArtifact: Artifact = { kind: "graph-result", path: join(runDirectory, "artifacts", "graph-result.json") };
		const artifacts = [...snapshot.nodes.flatMap((node) => node.artifacts), graphArtifact];
		const finalNode = finalNodes.at(-1)!;
		const aggregate: LaunchResult = {
			run: { ...snapshot.run }, nodes: finalNodes,
			...(finalNode.result?.state === "completed" ? { finalOutput: finalNode.result.output } : {}),
			trace: finalNodes.map((node, index) => ({ nodeId: node.id, logicalRole: node.logicalRole, state: node.state, predecessorIds: [...preparedNodes[index]!.node.dependencies], ...(node.blockedBy ? { blockedBy: [...node.blockedBy] } : {}) })),
			artifacts, handoffs: [...handoffs].sort((left, right) => indexById.get(left.nodeId)! - indexById.get(right.nodeId)!),
		};
		await writeJsonAtomically(graphArtifact.path, aggregate);
		await writeJsonAtomically(manifestPath, artifacts);
		await record(snapshot.run.state);
		await persistSnapshot();
		await eventWrite;
		controls.delete(runId);
		return aggregate;
	};

	const startRun = (runId: string, graph: NormalizedGraph, prepared: Awaited<ReturnType<typeof prepareNodes>>, snapshot: StoredSnapshot) => {
		const execution = executeRun(runId, graph, prepared, snapshot);
		executions.set(runId, execution);
		void execution.finally(() => {
			executions.delete(runId);
			controls.delete(runId);
		}).catch(() => undefined);
		return execution;
	};

	const launch = (async (graphDefinition: GraphDefinition, launchOptions?: LaunchOptions): Promise<LaunchReceipt | LaunchResult> => {
		const graph = immutableGraphDefinition(graphDefinition);
		if (graph.nodes.length === 0) throw new Error("Graph must contain at least one node");
		const idleLimitMs = launchOptions?.idleLimitMs ?? defaultIdleLimitMs;
		validatePositiveDuration("Run idleLimitMs", idleLimitMs);
		effectiveConcurrencyLimit(options.maxConcurrency, graph.maxConcurrency);
		const parentCwd = options.cwd ?? process.cwd();
		const prepared = await prepareNodes(graph, parentCwd);
		const runId = `run_${randomUUID()}`;
		const runDirectory = join(options.storeDirectory, "runs", runId);
		const snapshot: StoredSnapshot = {
			run: { id: runId, state: "running" }, idleLimitMs,
			nodes: prepared.map(({ node, policy }) => ({ id: node.id, agent: node.definition.agent, logicalRole: node.definition.logicalRole, state: "queued", policy, artifacts: [] })),
		};
		await writeJsonAtomically(join(runDirectory, "graph.json"), graph);
		await writeSnapshot(runDirectory, snapshot);
		const execution = startRun(runId, graph, prepared, snapshot);
		if (launchOptions?.delivery === "blocking") return execution;
		// The receipt guarantees that every initially ready node is durably visible as running.
		await writeSnapshot(runDirectory, snapshot);
		return { run: { ...snapshot.run } };
	}) as SubagentRuntime["launch"];

	return {
		launch,
		status: async (runId) => {
			const snapshot = await readSnapshot(options.storeDirectory, runId);
			const usage = usageTotals(snapshot.nodes);
			return { run: { ...snapshot.run }, nodes: snapshot.nodes.map(({ resultPath: _resultPath, ...node }) => ({ ...node })), ...(usage ? { usage } : {}) };
		},
		join: async (runId) => {
			await readSnapshot(options.storeDirectory, runId);
			const execution = executions.get(runId);
			if (!execution) throw new Error(`Run is not owned by this runtime: ${runId}`);
			return execution;
		},
		cancel: (runId, nodeId) => {
			const control = controls.get(runId);
			const execution = executions.get(runId);
			if (!control || !execution) return Promise.reject(new Error(`Run is not owned by this runtime: ${runId}`));
			if (nodeId === undefined) return control.apply!("cancelling", control.nodeIds).then(() => execution);
			return readGraph(options.storeDirectory, runId).then((graph) => {
				const nodeIds = descendantNodeIds(graph, nodeId);
				if (nodeIds.length === 0) throw new Error(`Unknown node: ${nodeId}`);
				return control.apply!("cancelling", nodeIds).then(() => execution);
			});
		},
		resume: async (runId) => {
			const snapshot = await readSnapshot(options.storeDirectory, runId);
			if (snapshot.run.state !== "suspended") throw new Error(`Run is not suspended: ${runId}`);
			const graph = await readGraph(options.storeDirectory, runId);
			const prepared = await prepareNodes(graph, options.cwd ?? process.cwd());
			for (const node of snapshot.nodes) {
				if (node.state !== "completed") {
					node.state = "queued";
					node.blockedBy = undefined;
					node.resultPath = undefined;
				}
			}
			snapshot.run.state = "running";
			await writeSnapshot(join(options.storeDirectory, "runs", runId), snapshot);
			return startRun(runId, graph, prepared, snapshot);
		},
		dispose: async () => {
			await Promise.all([...controls.values()].map((control) => control.apply!("suspending", control.nodeIds)));
			await Promise.all([...executions.values()].map(async (execution) => { await execution; }));
		},
		events: async (runId) => readEvents(options.storeDirectory, runId),
		result: async (runId, nodeId) => {
			const snapshot = await readSnapshot(options.storeDirectory, runId);
			const node = snapshot.nodes.find((candidate) => candidate.id === nodeId);
			if (!node) throw new Error(`Unknown node: ${nodeId}`);
			if (!node.resultPath) throw new Error(`Node ${nodeId} has no durable result`);
			return JSON.parse(await readFile(node.resultPath, "utf8")) as NodeResult;
		},
	};
}
const systemClock: RuntimeClock = {
	now: () => Date.now(),
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

function validatePositiveDuration(label: string, value: number): void {
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
}

function isTerminal(state: LifecycleState): boolean {
	return state === "completed" || state === "failed" || state === "cancelled";
}

function immutableNodeDefinition(definition: Readonly<NodeDefinition>): Readonly<NodeDefinition> {
	const tools = definition.tools ? Object.freeze([...definition.tools]) : undefined;
	return Object.freeze({ ...definition, ...(tools ? { tools } : {}) });
}

export const DEFAULT_MAX_CONCURRENCY = 6;
export const DEFAULT_IDLE_LIMIT_MS = 10 * 60 * 1000;
export const DEFAULT_TERMINATION_GRACE_MS = 5_000;
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

async function readGraph(storeDirectory: string, runId: string): Promise<NormalizedGraph> {
	try {
		return JSON.parse(await readFile(join(storeDirectory, "runs", runId, "graph.json"), "utf8")) as NormalizedGraph;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Unknown run: ${runId}`);
		throw error;
	}
}

function descendantNodeIds(graph: NormalizedGraph, nodeId: string): string[] {
	if (!graph.nodes.some((node) => node.id === nodeId)) return [];
	const selected = new Set([nodeId]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const node of graph.nodes) {
			if (node.dependencies.some((dependency) => selected.has(dependency)) && !selected.has(node.id)) {
				selected.add(node.id);
				changed = true;
			}
		}
	}
	return graph.nodes.filter((node) => selected.has(node.id)).map((node) => node.id);
}

async function readEvents(storeDirectory: string, runId: string): Promise<LifecycleEvent[]> {
	try {
		const source = await readFile(join(storeDirectory, "runs", runId, "events.jsonl"), "utf8");
		return source.split("\n").filter(Boolean).map((line) => JSON.parse(line) as LifecycleEvent);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			await readSnapshot(storeDirectory, runId);
			return [];
		}
		throw error;
	}
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

	async run(request: ChildRunnerRequest, options: ChildRunnerOptions = {}): Promise<ChildRunnerResult> {
		const startedAt = Date.now();
		const args = ["--mode", "json", "-p", "--no-session"];
		args.push("--provider", request.provider);
		args.push("--model", request.model);
		args.push("--thinking", request.reasoning);
		args.push("--tools", request.tools.join(","));
		args.push("--append-system-prompt", request.systemPrompt);
		args.push(request.task);

		return new Promise<ChildRunnerResult>((resolve, reject) => {
			let child: ReturnType<typeof spawn>;
			try {
				child = spawn(this.executable, args, {
				cwd: request.cwd,
				env: freshChildEnvironment(),
				shell: false,
					stdio: ["ignore", "pipe", "pipe"],
				});
			} catch (error) {
				reject(error);
				return;
			}
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
			let abortRequested = options.signal?.aborted ?? false;
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			const abort = () => {
				abortRequested = true;
				child.kill("SIGTERM");
				killTimer = setTimeout(() => child.kill("SIGKILL"), options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS);
			};
			if (options.signal) options.signal.addEventListener("abort", abort, { once: true });
			if (abortRequested) abort();
			// Until Pi reports agent or tool activity, a stalled child is idle.
			options.onActivityChange?.(false);

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
				if (event.type === "agent_start" || event.type === "tool_execution_start") options.onActivityChange?.(true);
				if (event.type === "agent_end" || event.type === "tool_execution_end" || event.type === "agent_settled") options.onActivityChange?.(false);
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
				if (killTimer !== undefined) clearTimeout(killTimer);
				if (options.signal) options.signal.removeEventListener("abort", abort);
				options.onActivityChange?.(false);
				processLine(stdout);
				const usage: UsageRecord = {
					provider,
					model,
					inputTokens,
					outputTokens,
					durationMs: Math.max(0, Date.now() - startedAt),
				};
				if (abortRequested || stopReason === "aborted") {
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
