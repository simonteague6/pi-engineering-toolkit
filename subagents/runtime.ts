import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	defaultDefinitionDirectories,
	resolveAgentDefinition,
	type DefinitionDirectories,
	type ReasoningLevel,
} from "./definitions.ts";

export type LifecycleState = "queued" | "running" | "completed" | "failed" | "cancelled" | "suspended";

export type TokenUsage = number | "unavailable";
export type TokenUsageField = "inputTokens" | "outputTokens";

/** Resolved node identity plus provider-supplied usage; never an estimate. */
export interface UsageRecord {
	provider?: string;
	model?: string;
	reasoning?: ReasoningLevel;
	inputTokens?: TokenUsage;
	outputTokens?: TokenUsage;
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

/** Parent-selected changes for one failed logical role in a recovery run. */
export interface RecoveryReplacement {
	readonly logicalRole: string;
	readonly correction?: string;
	readonly artifacts?: readonly string[];
	readonly acceptanceConditions?: string;
	readonly agent?: string;
	readonly cwd?: string;
	readonly provider?: string;
	readonly model?: string;
	readonly reasoning?: ReasoningLevel;
	readonly tools?: readonly string[];
}

export interface RecoveryPlan {
	readonly replacements: readonly RecoveryReplacement[];
}

/** Immutable ancestry and replacement evidence for a recovery run. */
export interface RecoveryLineage {
	readonly sourceRunId: string;
	readonly originalRunId: string;
	readonly graphDefinitionRunId: string;
	readonly replacedLogicalRoles: readonly string[];
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
	lineage?: RecoveryLineage;
}

/** Terminal aggregate in declaration order with durable graph evidence. */
export interface LaunchResult {
	run: RunView;
	nodes: NodeView[];
	/** Sums only provider-supplied token values; unavailable values are explicit. */
	usage?: UsageTotals;
	finalOutput?: string;
	trace: NodeTrace[];
	artifacts: Artifact[];
	handoffs: HandoffEvidence[];
}

export interface LaunchReceipt {
	run: RunView;
}

export type ParentNotificationKind = "node-failure" | "node-cancellation" | "graph-suspension" | "graph-result";

/** Compact durable evidence queued for the parent session. */
export interface ParentNotification {
	id: string;
	parentSessionId: string;
	runId: string;
	kind: ParentNotificationKind;
	state: Extract<LifecycleState, "failed" | "cancelled" | "suspended" | "completed">;
	nodeId?: string;
	logicalRole?: string;
	message: string;
	artifactPaths: readonly string[];
	createdAt: number;
	deliveredAt?: number;
}

export type ParentNotificationListener = (notifications: readonly ParentNotification[]) => void | Promise<void>;

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
	/** Fields unavailable for one or more nodes; totals never estimate them. */
	unavailable: readonly TokenUsageField[];
}

export interface CleanupResult {
	removedRunIds: string[];
	preservedRunIds: string[];
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
	/** Isolated-store override for tests; normal callers use the package-owned Pi store. */
	storeDirectory?: string;
	/** Stable parent-session key used to scope queued notifications. */
	parentSessionId?: string;
	/** Called after a notification is durably queued. It must not interrupt an active parent turn. */
	onParentNotifications?: ParentNotificationListener;
	/** Terminal run-data retention; defaults to 30 days. */
	retentionPeriodMs?: number;
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
	/** Creates a new run that replaces failed roles and reuses unaffected durable work. */
	recover(runId: string, plan: RecoveryPlan): Promise<LaunchReceipt>;
	recover(runId: string, plan: RecoveryPlan, options: { delivery: "blocking" }): Promise<LaunchResult>;
	recover(runId: string, plan: RecoveryPlan, options: { delivery: "detached" }): Promise<LaunchReceipt>;
	recover(runId: string, plan: RecoveryPlan, options: LaunchOptions): Promise<LaunchReceipt | LaunchResult>;
	/** Gracefully suspends runtime-owned active runs. */
	dispose(): Promise<void>;
	/** Removes expired terminal run data while preserving non-terminal runs. */
	cleanup(): Promise<CleanupResult>;
	events(runId: string): Promise<LifecycleEvent[]>;
	result(runId: string, nodeId: string): Promise<NodeResult>;
	/** Returns undelivered notifications for this runtime's parent session. */
	notifications(): Promise<ParentNotification[]>;
	/** Marks individual notification records delivered without deleting their evidence. */
	acknowledgeNotifications(notificationIds: readonly string[]): Promise<void>;
	/** Subscribes to newly queued notifications. The returned function removes the listener. */
	subscribeNotifications(listener: ParentNotificationListener): () => void;
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
	parentSessionId: string;
	delivery: "detached" | "blocking";
	nodes: StoredNode[];
	idleLimitMs: number;
	terminalAt?: number;
}

interface StoredNotificationFile {
	notifications: ParentNotification[];
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
 * The runner is injected for controlled execution; runtime data stays in the
 * package-owned Pi store unless an isolated test store is supplied.
 */
export function createSubagentRuntime(options: SubagentRuntimeOptions): SubagentRuntime {
	const storeDirectory = options.storeDirectory ?? defaultRunStoreDirectory();
	const parentSessionId = options.parentSessionId ?? "default";
	if (!parentSessionId.trim()) throw new Error("Parent session ID must not be empty");
	const runner = options.runner ?? new SubprocessJsonRunner();
	const executions = new Map<string, Promise<LaunchResult>>();
	const notificationListeners = new Set<ParentNotificationListener>(options.onParentNotifications ? [options.onParentNotifications] : []);
	const notificationWrites = new Map<string, Promise<void>>();
	const controls = new Map<string, RunControl>();
	const clock = options.clock ?? systemClock;
	const defaultIdleLimitMs = options.idleLimitMs ?? DEFAULT_IDLE_LIMIT_MS;
	const retentionPeriodMs = options.retentionPeriodMs ?? DEFAULT_RETENTION_PERIOD_MS;
	const terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
	validatePositiveDuration("Runtime idleLimitMs", defaultIdleLimitMs);
	validatePositiveDuration("Runtime retentionPeriodMs", retentionPeriodMs);
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
		const runDirectory = join(storeDirectory, "runs", runId);
		const manifestPath = join(runDirectory, "artifacts.json");
		const resultPaths = snapshot.nodes.map((node) => join(runDirectory, "artifacts", "nodes", `${node.id}.json`));
		const indexById = new Map(snapshot.nodes.map((node, index) => [node.id, index]));
		const handoffs: HandoffEvidence[] = [];
		const nodeViews = new Map<number, NodeView>();
		let snapshotWrite = Promise.resolve();
		let eventWrite = Promise.resolve();
		let pendingNotifications: ParentNotification[] = [];
		const queueNotification = async (notification: Omit<ParentNotification, "id" | "parentSessionId" | "createdAt" | "runId">): Promise<void> => {
			if (snapshot.delivery !== "detached") return;
			const record: ParentNotification = {
				...notification,
				runId,
				id: `notification_${randomUUID()}`,
				parentSessionId: snapshot.parentSessionId,
				createdAt: clock.now(),
				artifactPaths: [...notification.artifactPaths],
			};
			pendingNotifications = [...pendingNotifications, record];
			const write = (notificationWrites.get(runId) ?? Promise.resolve()).then(async () => {
				await writeJsonAtomically(join(runDirectory, "notifications.json"), { notifications: pendingNotifications });
			});
			notificationWrites.set(runId, write);
			await write;
			const queued = await listNotificationsForSession(storeDirectory, snapshot.parentSessionId);
			for (const listener of notificationListeners) void Promise.resolve(listener(queued)).catch(() => undefined);
		};
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
			await record(state, node.id, state === "failed" ? (error.kind === "timeout" ? "timeout" : undefined) : state);
			if (state === "failed" || state === "cancelled") {
				await queueNotification({
					kind: state === "failed" ? "node-failure" : "node-cancellation",
					state,
					nodeId: node.id,
					logicalRole: node.logicalRole,
					message: boundedNotificationText(error.message),
					artifactPaths: [resultPath],
				});
			}
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
			const usage = resolvedUsage(outcome.usage, prepared.policy, clock.now() - startedAt);
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
				? { state, output: (outcome as Extract<ChildRunnerResult, { state: "completed" }>).output, usage, policy: prepared.policy }
				: { state, ...(error ? { error } : {}), usage, policy: prepared.policy };
			await writeJsonAtomically(resultPath, result);
			node.resultPath = resultPath;
			node.artifacts = [...node.artifacts, { kind: state === "completed" ? "result" : state === "suspended" ? "checkpoint" : "failure", path: resultPath }];
			node.usage = usage;
			node.state = state;
			const view = toNodeView(node, result);
			nodeViews.set(index, view);
			await record(state, node.id, state === "failed" && error?.kind === "timeout" ? "timeout" : state === "suspended" ? "suspended" : state === "cancelled" ? "cancelled" : undefined);
			if (state === "failed" || state === "cancelled") {
				await queueNotification({
					kind: state === "failed" ? "node-failure" : "node-cancellation",
					state,
					nodeId: node.id,
					logicalRole: node.logicalRole,
					message: boundedNotificationText(error?.message ?? `Node ${node.id} ${state}`),
					artifactPaths: [resultPath],
				});
			}
			await persistSnapshot();
			return view;
		};

		for (let index = 0; index < snapshot.nodes.length; index += 1) {
			const node = snapshot.nodes[index]!;
			if (node.state !== "completed" || !node.resultPath) continue;
			const result = JSON.parse(await readFile(node.resultPath, "utf8")) as NodeResult;
			if (result.state !== "completed") throw new Error(`Unusable durable result for completed node ${node.id}`);
			nodeViews.set(index, toNodeView(node, result));
		}
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
		if (isTerminal(snapshot.run.state)) snapshot.terminalAt ??= clock.now();
		const graphArtifact: Artifact = { kind: "graph-result", path: join(runDirectory, "artifacts", "graph-result.json") };
		const artifacts = [...snapshot.nodes.flatMap((node) => node.artifacts), graphArtifact];
		const finalNode = finalNodes.at(-1)!;
		const usage = usageTotals(snapshot.nodes);
		const aggregate: LaunchResult = {
			run: { ...snapshot.run }, nodes: finalNodes,
			...(usage ? { usage } : {}),
			...(finalNode.result?.state === "completed" ? { finalOutput: finalNode.result.output } : {}),
			trace: finalNodes.map((node, index) => ({ nodeId: node.id, logicalRole: node.logicalRole, state: node.state, predecessorIds: [...preparedNodes[index]!.node.dependencies], ...(node.blockedBy ? { blockedBy: [...node.blockedBy] } : {}) })),
			artifacts, handoffs: [...handoffs].sort((left, right) => indexById.get(left.nodeId)! - indexById.get(right.nodeId)!),
		};
		await writeJsonAtomically(graphArtifact.path, aggregate);
		await writeJsonAtomically(manifestPath, artifacts);
		if (snapshot.run.state === "completed") {
			await queueNotification({
				kind: "graph-result",
				state: "completed",
				message: `Run ${runId} completed`,
				artifactPaths: [graphArtifact.path],
			});
		} else if (snapshot.run.state === "suspended") {
			await queueNotification({
				kind: "graph-suspension",
				state: "suspended",
				message: `Run ${runId} suspended`,
				artifactPaths: [graphArtifact.path],
			});
		}
		await record(snapshot.run.state);
		await persistSnapshot();
		await eventWrite;
		notificationWrites.delete(runId);
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
		const runDirectory = join(storeDirectory, "runs", runId);
		const snapshot: StoredSnapshot = {
			run: { id: runId, state: "running" },
			parentSessionId,
			delivery: launchOptions?.delivery === "blocking" ? "blocking" : "detached",
			idleLimitMs,
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

	const recover = (async (sourceRunId: string, plan: RecoveryPlan, launchOptions?: LaunchOptions): Promise<LaunchReceipt | LaunchResult> => {
		const sourceSnapshot = await readSnapshot(storeDirectory, sourceRunId);
		if (sourceSnapshot.run.state !== "failed") throw new Error(`Recovery requires a failed run: ${sourceRunId}`);
		const graph = await readGraph(storeDirectory, sourceRunId);
		const replacementByRole = recoveryReplacements(plan, sourceSnapshot, graph);
		const affectedNodeIds = new Set<string>();
		for (const node of graph.nodes) {
			if (replacementByRole.has(node.definition.logicalRole)) {
				for (const nodeId of descendantNodeIds(graph, node.id)) affectedNodeIds.add(nodeId);
			}
		}
		const recoveryGraph = graphWithRecoveryReplacements(graph, replacementByRole);
		const idleLimitMs = launchOptions?.idleLimitMs ?? defaultIdleLimitMs;
		validatePositiveDuration("Run idleLimitMs", idleLimitMs);
		effectiveConcurrencyLimit(options.maxConcurrency, graph.maxConcurrency);
		const prepared = await prepareNodes(recoveryGraph, options.cwd ?? process.cwd());
		const runId = `run_${randomUUID()}`;
		const lineage: RecoveryLineage = {
			sourceRunId,
			originalRunId: sourceSnapshot.run.lineage?.originalRunId ?? sourceRunId,
			graphDefinitionRunId: sourceSnapshot.run.lineage?.graphDefinitionRunId ?? sourceRunId,
			replacedLogicalRoles: [...replacementByRole.keys()],
		};
		const sourceById = new Map(sourceSnapshot.nodes.map((node) => [node.id, node]));
		const snapshot: StoredSnapshot = {
			run: { id: runId, state: "running", lineage },
			parentSessionId,
			delivery: launchOptions?.delivery === "blocking" ? "blocking" : "detached",
			idleLimitMs,
			nodes: prepared.map(({ node, policy }) => {
				const sourceNode = sourceById.get(node.id)!;
				if (!affectedNodeIds.has(node.id) && sourceNode.state === "completed") {
					return {
						...sourceNode,
						artifacts: [...sourceNode.artifacts],
						...(sourceNode.blockedBy ? { blockedBy: [...sourceNode.blockedBy] } : {}),
					};
				}
				return { id: node.id, agent: node.definition.agent, logicalRole: node.definition.logicalRole, state: "queued", policy, artifacts: [] };
			}),
		};
		const runDirectory = join(storeDirectory, "runs", runId);
		await writeJsonAtomically(join(runDirectory, "graph.json"), graph);
		await writeJsonAtomically(join(runDirectory, "recovery.json"), { lineage, plan });
		await writeSnapshot(runDirectory, snapshot);
		const execution = startRun(runId, recoveryGraph, prepared, snapshot);
		if (launchOptions?.delivery === "blocking") return execution;
		await writeSnapshot(runDirectory, snapshot);
		return { run: { ...snapshot.run } };
	}) as SubagentRuntime["recover"];

	return {
		launch,
		status: async (runId) => {
			const snapshot = await readSnapshot(storeDirectory, runId);
			const usage = usageTotals(snapshot.nodes);
			return { run: { ...snapshot.run }, nodes: snapshot.nodes.map(({ resultPath: _resultPath, ...node }) => ({ ...node })), ...(usage ? { usage } : {}) };
		},
		join: async (runId) => {
			await readSnapshot(storeDirectory, runId);
			const execution = executions.get(runId);
			if (!execution) throw new Error(`Run is not owned by this runtime: ${runId}`);
			return execution;
		},
		cancel: (runId, nodeId) => {
			const control = controls.get(runId);
			const execution = executions.get(runId);
			if (!control || !execution) return Promise.reject(new Error(`Run is not owned by this runtime: ${runId}`));
			if (nodeId === undefined) return control.apply!("cancelling", control.nodeIds).then(() => execution);
			return readGraph(storeDirectory, runId).then((graph) => {
				const nodeIds = descendantNodeIds(graph, nodeId);
				if (nodeIds.length === 0) throw new Error(`Unknown node: ${nodeId}`);
				return control.apply!("cancelling", nodeIds).then(() => execution);
			});
		},
		resume: async (runId) => {
			const snapshot = await readSnapshot(storeDirectory, runId);
			if (snapshot.run.state !== "suspended") throw new Error(`Run is not suspended: ${runId}`);
			const graph = await readGraph(storeDirectory, runId);
			const prepared = await prepareNodes(graph, options.cwd ?? process.cwd());
			for (const node of snapshot.nodes) {
				if (node.state !== "completed") {
					node.state = "queued";
					node.blockedBy = undefined;
					node.resultPath = undefined;
				}
			}
			snapshot.run.state = "running";
			await writeSnapshot(join(storeDirectory, "runs", runId), snapshot);
			return startRun(runId, graph, prepared, snapshot);
		},
		recover,
		dispose: async () => {
			await Promise.all([...controls.values()].map((control) => control.apply!("suspending", control.nodeIds)));
			await Promise.all([...executions.values()].map(async (execution) => { await execution; }));
		},
		cleanup: async () => {
			const runsDirectory = join(storeDirectory, "runs");
			let runIds: string[];
			try {
				runIds = (await readdir(runsDirectory)).sort();
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return { removedRunIds: [], preservedRunIds: [] };
				throw error;
			}

			const removedRunIds: string[] = [];
			const preservedRunIds: string[] = [];
			for (const runId of runIds) {
				if (executions.has(runId) || controls.has(runId)) {
					preservedRunIds.push(runId);
					continue;
				}
				try {
					const snapshot = await readSnapshot(storeDirectory, runId);
					if (!isTerminal(snapshot.run.state) || snapshot.terminalAt === undefined || clock.now() < snapshot.terminalAt + retentionPeriodMs || await hasUndeliveredNotifications(join(runsDirectory, runId))) {
						preservedRunIds.push(runId);
						continue;
					}
					await rm(join(runsDirectory, runId), { recursive: true, force: true });
					removedRunIds.push(runId);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
					throw error;
				}
			}
			return { removedRunIds, preservedRunIds };
		},
		events: async (runId) => readEvents(storeDirectory, runId),
		result: async (runId, nodeId) => {
			const snapshot = await readSnapshot(storeDirectory, runId);
			const node = snapshot.nodes.find((candidate) => candidate.id === nodeId);
			if (!node) throw new Error(`Unknown node: ${nodeId}`);
			if (!node.resultPath) throw new Error(`Node ${nodeId} has no durable result`);
			return JSON.parse(await readFile(node.resultPath, "utf8")) as NodeResult;
		},
		notifications: () => listNotificationsForSession(storeDirectory, parentSessionId),
		acknowledgeNotifications: async (notificationIds) => {
			await Promise.all([...notificationWrites.values()]);
			await acknowledgeNotifications(storeDirectory, parentSessionId, notificationIds, clock.now());
		},
		subscribeNotifications: (listener) => {
			notificationListeners.add(listener);
			return () => notificationListeners.delete(listener);
		},
	};
}

function recoveryReplacements(
	plan: RecoveryPlan,
	sourceSnapshot: StoredSnapshot,
	graph: NormalizedGraph,
): Map<string, RecoveryReplacement> {
	if (!Array.isArray(plan.replacements) || plan.replacements.length === 0) {
		throw new Error("Recovery requires at least one replacement");
	}
	const graphNodesByRole = new Map<string, NormalizedNode[]>();
	for (const node of graph.nodes) {
		const nodes = graphNodesByRole.get(node.definition.logicalRole) ?? [];
		nodes.push(node);
		graphNodesByRole.set(node.definition.logicalRole, nodes);
	}
	const replacements = new Map<string, RecoveryReplacement>();
	for (const replacement of plan.replacements) {
		if (!replacement.logicalRole?.trim()) throw new Error("Recovery replacement logicalRole must not be empty");
		if (replacements.has(replacement.logicalRole)) throw new Error(`Duplicate recovery replacement: ${replacement.logicalRole}`);
		if (graphNodesByRole.get(replacement.logicalRole)?.length !== 1) {
			throw new Error(`Recovery logical role must identify exactly one node: ${replacement.logicalRole}`);
		}
		validateRecoveryText(replacement.correction, "Recovery correction");
		validateRecoveryText(replacement.acceptanceConditions, "Recovery acceptance conditions");
		for (const artifact of replacement.artifacts ?? []) validateRecoveryText(artifact, "Recovery artifact path");
		replacements.set(replacement.logicalRole, replacement);
	}
	const sourceById = new Map(sourceSnapshot.nodes.map((node) => [node.id, node]));
	const failedRoles: string[] = [];
	for (const node of graph.nodes) {
		const sourceNode = sourceById.get(node.id);
		if (!sourceNode) throw new Error(`Recovery source is missing node evidence: ${node.id}`);
		if (sourceNode.state === "failed") failedRoles.push(node.definition.logicalRole);
	}
	for (const role of failedRoles) {
		if (!replacements.has(role)) throw new Error(`Recovery must replace every failed logical role: ${role}`);
	}
	for (const role of replacements.keys()) {
		const node = graphNodesByRole.get(role)![0]!;
		if (sourceById.get(node.id)!.state !== "failed") {
			throw new Error(`Recovery replacement is not failed: ${role}`);
		}
	}
	return replacements;
}

function validateRecoveryText(value: string | undefined, label: string): void {
	if (value !== undefined && !value.trim()) throw new Error(`${label} must not be empty`);
}

function graphWithRecoveryReplacements(
	graph: NormalizedGraph,
	replacements: ReadonlyMap<string, RecoveryReplacement>,
): NormalizedGraph {
	const nodes = graph.nodes.map((node) => {
		const replacement = replacements.get(node.definition.logicalRole);
		if (!replacement) return node;
		const definition: NodeDefinition = {
			agent: replacement.agent ?? node.definition.agent,
			logicalRole: node.definition.logicalRole,
			task: recoveryTask(node.definition.task, replacement),
			cwd: replacement.cwd ?? node.definition.cwd,
			provider: replacement.provider ?? node.definition.provider,
			model: replacement.model ?? node.definition.model,
			reasoning: replacement.reasoning ?? node.definition.reasoning,
			tools: replacement.tools ?? node.definition.tools,
		};
		return Object.freeze({ ...node, definition: immutableNodeDefinition(definition) });
	});
	return Object.freeze({ nodes: Object.freeze(nodes), ...(graph.maxConcurrency === undefined ? {} : { maxConcurrency: graph.maxConcurrency }) });
}

function recoveryTask(task: string, replacement: RecoveryReplacement): string {
	const sections = [task];
	if (replacement.correction !== undefined) sections.push(`## Recovery correction\n${replacement.correction}`);
	if (replacement.artifacts?.length) sections.push(`## Additional recovery artifacts\n${replacement.artifacts.map((artifact) => `- ${artifact}`).join("\n")}`);
	if (replacement.acceptanceConditions !== undefined) sections.push(`## Recovery acceptance conditions\n${replacement.acceptanceConditions}`);
	return sections.join("\n\n");
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
export const DEFAULT_RETENTION_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
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
		const snapshot = JSON.parse(await readFile(join(storeDirectory, "runs", runId, "snapshot.json"), "utf8")) as Partial<StoredSnapshot> & Pick<StoredSnapshot, "run" | "nodes" | "idleLimitMs">;
		return {
			...snapshot,
			parentSessionId: snapshot.parentSessionId ?? "default",
			delivery: snapshot.delivery ?? "detached",
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Unknown run: ${runId}`);
		throw error;
	}
}

async function hasUndeliveredNotifications(runDirectory: string): Promise<boolean> {
	try {
		const stored = JSON.parse(await readFile(join(runDirectory, "notifications.json"), "utf8")) as StoredNotificationFile;
		return stored.notifications.some((notification) => notification.deliveredAt === undefined);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function listNotificationsForSession(storeDirectory: string, parentSessionId: string): Promise<ParentNotification[]> {
	let runIds: string[];
	try {
		runIds = await readdir(join(storeDirectory, "runs"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const notifications: ParentNotification[] = [];
	for (const runId of runIds) {
		try {
			const stored = JSON.parse(await readFile(join(storeDirectory, "runs", runId, "notifications.json"), "utf8")) as StoredNotificationFile;
			for (const notification of stored.notifications) {
				if (notification.parentSessionId === parentSessionId && notification.deliveredAt === undefined) notifications.push(notification);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
	}
	return notifications.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

async function acknowledgeNotifications(
	storeDirectory: string,
	parentSessionId: string,
	notificationIds: readonly string[],
	deliveredAt: number,
): Promise<void> {
	const ids = new Set(notificationIds);
	if (ids.size === 0) return;
	let runIds: string[];
	try {
		runIds = await readdir(join(storeDirectory, "runs"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	for (const runId of runIds) {
		const path = join(storeDirectory, "runs", runId, "notifications.json");
		try {
			const stored = JSON.parse(await readFile(path, "utf8")) as StoredNotificationFile;
			let changed = false;
			const notifications = stored.notifications.map((notification) => {
				if (ids.has(notification.id) && notification.parentSessionId === parentSessionId && notification.deliveredAt === undefined) {
					changed = true;
					return { ...notification, deliveredAt };
				}
				return notification;
			});
			if (changed) await writeJsonAtomically(path, { notifications });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
	}
}

function boundedNotificationText(value: string): string {
	const maxBytes = 500;
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	let result = value.slice(0, maxBytes);
	while (Buffer.byteLength(result, "utf8") > maxBytes - 16) result = result.slice(0, -1);
	return `${result}…`;
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

function resolvedUsage(
	providerUsage: UsageRecord | undefined,
	policy: ExecutionPolicy,
	durationMs: number,
): UsageRecord {
	return {
		provider: policy.provider,
		model: policy.model,
		reasoning: policy.reasoning,
		inputTokens: suppliedTokenCount(providerUsage?.inputTokens),
		outputTokens: suppliedTokenCount(providerUsage?.outputTokens),
		durationMs: Math.max(0, durationMs),
	};
}

function suppliedTokenCount(value: TokenUsage | undefined): TokenUsage {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : "unavailable";
}

function usageTotals(nodes: readonly StoredNode[]): UsageTotals | undefined {
	const totals: Omit<UsageTotals, "unavailable"> = {};
	const unavailable = new Set<TokenUsageField>();
	for (const node of nodes) {
		const usage = node.usage;
		if (!usage) continue;
		for (const field of ["inputTokens", "outputTokens"] as const) {
			const value = usage[field];
			if (typeof value === "number") totals[field] = (totals[field] ?? 0) + value;
			else unavailable.add(field);
		}
		if (usage.durationMs !== undefined) totals.durationMs = (totals.durationMs ?? 0) + usage.durationMs;
	}
	return Object.keys(totals).length > 0 || unavailable.size > 0
		? { ...totals, unavailable: [...unavailable].sort() as TokenUsageField[] }
		: undefined;
}

function defaultRunStoreDirectory(): string {
	const piAgentDirectory = process.env.PI_CODING_AGENT_DIR;
	return join(piAgentDirectory && piAgentDirectory.trim() ? piAgentDirectory : join(homedir(), ".pi", "agent"), "pi-engineering-toolkit");
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
