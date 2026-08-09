import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
	defaultDefinitionDirectories,
	formatAgentDefinitionCatalog,
	listAgentDefinitions,
	type DefinitionDirectories,
} from "../subagents/definitions.ts";
import {
	createSubagentRuntime,
	DEFAULT_MAX_CONCURRENCY,
	type GraphDefinition,
	type LaunchOptions,
	type LaunchReceipt,
	type LaunchResult,
	type ParentNotification,
	type RecoveryPlan,
	type RunView,
	type StatusView,
	type SubagentRuntime,
} from "../subagents/runtime.ts";

const MAX_TOOL_RESPONSE_BYTES = 50 * 1024;
const MAX_PREVIEW_BYTES = 2_000;
const MAX_ERROR_BYTES = 2_000;
const MAX_NODES = 100;
const MAX_ARTIFACTS = 100;

const reasoningSchema = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);

const nodeSchema = Type.Object({
	agent: Type.String({ description: "Agent definition ID." }),
	logicalRole: Type.String({ description: "Parent-assigned responsibility for this node." }),
	task: Type.String({ description: "Plain-text task for the child." }),
	id: Type.Optional(Type.String({ description: "Static DAG node ID." })),
	dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Direct predecessor node IDs." })),
	cwd: Type.Optional(Type.String({ description: "Working directory for this node." })),
	provider: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	reasoning: Type.Optional(reasoningSchema),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Additional named tools for this node." })),
});

const graphSchema = Type.Object({
	kind: StringEnum(["single", "parallel", "chain", "dag"] as const),
	node: Type.Optional(nodeSchema),
	nodes: Type.Optional(Type.Array(nodeSchema)),
	maxConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: DEFAULT_MAX_CONCURRENCY })),
});

const launchSchema = Type.Object({
	graph: graphSchema,
	delivery: Type.Optional(StringEnum(["detached", "blocking"] as const)),
	idleLimitMs: Type.Optional(Type.Integer({ minimum: 1 })),
});

const recoveryReplacementSchema = Type.Object({
	logicalRole: Type.String(),
	correction: Type.Optional(Type.String()),
	artifacts: Type.Optional(Type.Array(Type.String())),
	acceptanceConditions: Type.Optional(Type.String()),
	agent: Type.Optional(Type.String()),
	cwd: Type.Optional(Type.String()),
	provider: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	reasoning: Type.Optional(reasoningSchema),
	tools: Type.Optional(Type.Array(Type.String())),
});

const recoveryPlanSchema = Type.Object({
	replacements: Type.Array(recoveryReplacementSchema),
});

const runIdSchema = Type.Object({ runId: Type.String({ description: "Stable run ID." }) });
const cancelSchema = Type.Object({
	runId: Type.String({ description: "Stable run ID." }),
	nodeId: Type.Optional(Type.String({ description: "Cancel this node and its descendants." })),
});
const recoverSchema = Type.Object({
	runId: Type.String({ description: "Failed source run ID." }),
	plan: recoveryPlanSchema,
	delivery: Type.Optional(StringEnum(["detached", "blocking"] as const)),
	idleLimitMs: Type.Optional(Type.Integer({ minimum: 1 })),
});

export type SubagentTool<TParams extends TSchema = TSchema> = ToolDefinition<TParams, SubagentToolDetails>;
export type SubagentToolRuntimeContext = Pick<ExtensionContext, "cwd" | "modelRegistry" | "sessionManager" | "isIdle">;
export type SubagentRuntimeFactory = (ctx: SubagentToolRuntimeContext) => SubagentRuntime;

export interface SubagentToolDetails {
	operation: "launch" | "status" | "join" | "cancel" | "resume" | "recover";
	run?: RunView;
	state?: string;
	usage?: LaunchResult["usage"];
	nodes?: CompactNode[];
	nodesOmitted?: number;
	artifacts?: CompactArtifact[];
	artifactsOmitted?: number;
	handoffs?: Array<{ nodeId: string; artifactPath: string; delivery: string }>;
	finalOutputPreview?: string;
	finalOutputPath?: string;
	bounded?: boolean;
	message?: string;
}

interface CompactNode {
	id: string;
	logicalRole: string;
	state: string;
	resultPath?: string;
	error?: { kind: string; message: string; stderr?: string; hasPartialOutput?: boolean };
	usage?: StatusView["nodes"][number]["usage"];
	blockedBy?: string[];
}

interface CompactArtifact {
	kind: string;
	path: string;
}

type LaunchInput = Static<typeof launchSchema>;
type RunIdInput = Static<typeof runIdSchema>;
type CancelInput = Static<typeof cancelSchema>;
type RecoverInput = Static<typeof recoverSchema>;

type ToolContext = SubagentToolRuntimeContext;

/** Registers the parent-facing adapter against a runtime provider. */
export function registerSubagentTools(pi: ExtensionAPI, runtimeFactory: SubagentRuntimeFactory): void {
	pi.registerTool(makeLaunchTool(runtimeFactory));
	pi.registerTool(makeStatusTool(runtimeFactory));
	pi.registerTool(makeJoinTool(runtimeFactory));
	pi.registerTool(makeCancelTool(runtimeFactory));
	pi.registerTool(makeResumeTool(runtimeFactory));
	pi.registerTool(makeRecoverTool(runtimeFactory));
}

function makeLaunchTool(runtimeFactory: SubagentRuntimeFactory): SubagentTool<typeof launchSchema> {
	return tool({
		name: "subagent_launch",
		label: "Subagent launch",
		description: "Parent-only: launch a bounded subagent graph. Returns a compact receipt by default; use subagent_join for the terminal result.",
		promptSnippet: "Launch a bounded subagent graph",
		parameters: launchSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const runtime = runtimeFactory(ctx);
			const options = launchOptions(params);
			const result = await launchWithParentCancellation(runtime, toGraph(params.graph), options, signal);
			if (options.delivery !== "blocking" && signal?.aborted && "run" in result) await runtime.cancel(result.run.id);
			return response("launch", params.delivery === "blocking" ? result as LaunchResult : result as LaunchReceipt);
		},
		renderCall: renderCall("launch"),
		renderResult: renderResult,
	});
}

function makeStatusTool(runtimeFactory: SubagentRuntimeFactory): SubagentTool<typeof runIdSchema> {
	return tool({
		name: "subagent_status",
		label: "Subagent status",
		description: "Parent-only: inspect compact lifecycle state, node state, usage, and durable artifact paths for a run.",
		promptSnippet: "Inspect compact subagent run status",
		parameters: runIdSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await runtimeFactory(ctx).status(params.runId);
			return response("status", result);
		},
		renderCall: renderCall("status"),
		renderResult,
	});
}

function makeJoinTool(runtimeFactory: SubagentRuntimeFactory): SubagentTool<typeof runIdSchema> {
	return tool({
		name: "subagent_join",
		label: "Subagent join",
		description: "Parent-only: wait for a detached run and return its compact terminal result.",
		promptSnippet: "Wait for a detached subagent run",
		parameters: runIdSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const runtime = runtimeFactory(ctx);
			const result = await withParentCancellation(signal, () => runtime.cancel(params.runId), () => runtime.join(params.runId));
			return response("join", result);
		},
		renderCall: renderCall("join"),
		renderResult,
	});
}

function makeCancelTool(runtimeFactory: SubagentRuntimeFactory): SubagentTool<typeof cancelSchema> {
	return tool({
		name: "subagent_cancel",
		label: "Subagent cancel",
		description: "Parent-only: cancel a whole run, or one node and its descendants.",
		promptSnippet: "Cancel a subagent run or node subtree",
		parameters: cancelSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await runtimeFactory(ctx).cancel(params.runId, params.nodeId);
			return response("cancel", result);
		},
		renderCall: renderCall("cancel"),
		renderResult,
	});
}

function makeResumeTool(runtimeFactory: SubagentRuntimeFactory): SubagentTool<typeof runIdSchema> {
	return tool({
		name: "subagent_resume",
		label: "Subagent resume",
		description: "Parent-only: resume a suspended run from its durable evidence.",
		promptSnippet: "Resume a suspended subagent run",
		parameters: runIdSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const runtime = runtimeFactory(ctx);
			const result = await withParentCancellation(signal, () => runtime.cancel(params.runId), () => runtime.resume(params.runId));
			return response("resume", result);
		},
		renderCall: renderCall("resume"),
		renderResult,
	});
}

function makeRecoverTool(runtimeFactory: SubagentRuntimeFactory): SubagentTool<typeof recoverSchema> {
	return tool({
		name: "subagent_recover",
		label: "Subagent recover",
		description: "Parent-only: create a new run that replaces failed logical roles and reuses unaffected durable work.",
		promptSnippet: "Recover failed logical roles in a subagent run",
		parameters: recoverSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const runtime = runtimeFactory(ctx);
			const options = launchOptions(params);
			const result = await recoverWithParentCancellation(runtime, params.runId, params.plan as RecoveryPlan, options, signal);
			if (options.delivery !== "blocking" && signal?.aborted && "run" in result) await runtime.cancel(result.run.id);
			return response("recover", params.delivery === "blocking" ? result as LaunchResult : result as LaunchReceipt);
		},
		renderCall: renderCall("recover"),
		renderResult,
	});
}

function tool<T extends SubagentTool>(definition: T): T {
	return definition;
}

function launchOptions(input: { delivery?: "detached" | "blocking"; idleLimitMs?: number }): LaunchOptions {
	return {
		delivery: input.delivery ?? "detached",
		...(input.idleLimitMs === undefined ? {} : { idleLimitMs: input.idleLimitMs }),
	};
}

function toGraph(input: LaunchInput["graph"]): GraphDefinition {
	if (input.kind === "single") {
		if (!input.node || input.nodes !== undefined) throw new Error("Single graph requires node and no nodes array");
		if (input.maxConcurrency !== undefined || input.node.id !== undefined || input.node.dependsOn !== undefined) {
			throw new Error("Single graph does not support maxConcurrency, id, or dependsOn");
		}
		return { kind: "single", node: toNodeDefinition(input.node) };
	}
	if (!input.nodes || input.node !== undefined) throw new Error(`${input.kind} graph requires nodes and no node`);
	if (input.kind === "dag") {
		return {
			kind: "dag",
			nodes: input.nodes.map((node) => {
				if (!node.id) throw new Error("DAG nodes require id");
				return { ...toNodeDefinition(node), id: node.id, ...(node.dependsOn === undefined ? {} : { dependsOn: node.dependsOn }) };
			}),
			...(input.maxConcurrency === undefined ? {} : { maxConcurrency: input.maxConcurrency }),
		};
	}
	if (input.nodes.some((node) => node.id !== undefined || node.dependsOn !== undefined)) {
		throw new Error(`${input.kind} graph nodes must not declare id or dependsOn`);
	}
	return {
		kind: input.kind,
		nodes: input.nodes.map(toNodeDefinition),
		...(input.maxConcurrency === undefined ? {} : { maxConcurrency: input.maxConcurrency }),
	} as GraphDefinition;
}

function toNodeDefinition(node: Static<typeof nodeSchema>) {
	const { id: _id, dependsOn: _dependsOn, ...definition } = node;
	return definition;
}

function response(operation: SubagentToolDetails["operation"], value: LaunchReceipt | LaunchResult | StatusView): { content: [{ type: "text"; text: string }]; details: SubagentToolDetails; isError?: boolean } {
	const details = compactDetails(operation, value);
	const text = JSON.stringify(details);
	return {
		content: [{ type: "text", text }],
		details,
		...(details.state === "failed" || details.state === "cancelled" ? { isError: true } : {}),
	};
}

function compactDetails(operation: SubagentToolDetails["operation"], value: LaunchReceipt | LaunchResult | StatusView): SubagentToolDetails {
	const run = value.run;
	const details: SubagentToolDetails = {
		operation,
		run: { ...run },
		state: run.state,
	};
	if ("nodes" in value) {
		if (value.usage) details.usage = value.usage;
		const compactNodes = value.nodes.map(compactNode);
		details.nodes = compactNodes.slice(0, MAX_NODES);
		if (compactNodes.length > MAX_NODES) details.nodesOmitted = compactNodes.length - MAX_NODES;
		const artifacts = "artifacts" in value
			? value.artifacts
			: value.nodes.flatMap((node) => node.artifacts);
		details.artifacts = compactArtifacts(artifacts).slice(0, MAX_ARTIFACTS);
		if (artifacts.length > MAX_ARTIFACTS) details.artifactsOmitted = artifacts.length - MAX_ARTIFACTS;
		if ("handoffs" in value && value.handoffs.length > 0) {
			details.handoffs = value.handoffs.slice(0, MAX_ARTIFACTS).map((handoff) => ({
				nodeId: handoff.nodeId,
				artifactPath: handoff.artifact.path,
				delivery: handoff.delivery,
			}));
		}
		const graphResult = artifacts.find((artifact) => artifact.kind === "graph-result");
		if ("finalOutput" in value && value.finalOutput !== undefined) {
			details.finalOutputPreview = boundedText(value.finalOutput, MAX_PREVIEW_BYTES);
			if (graphResult) details.finalOutputPath = graphResult.path;
		}
	}
	if (Buffer.byteLength(JSON.stringify(details), "utf8") > MAX_TOOL_RESPONSE_BYTES) {
		return {
			operation,
			run: { ...run },
			state: run.state,
			bounded: true,
			message: "Detailed result omitted from the bounded tool response; inspect the durable artifact paths.",
			artifacts: details.artifacts?.slice(0, 20),
			nodes: details.nodes?.slice(0, 20).map(({ id, logicalRole, state, resultPath }) => ({ id, logicalRole, state, ...(resultPath ? { resultPath } : {}) })),
		};
	}
	return details;
}

function compactNode(node: LaunchResult["nodes"][number] | StatusView["nodes"][number]): CompactNode {
	const resultPath = node.artifacts.find((artifact) => artifact.kind === "result" || artifact.kind === "failure" || artifact.kind === "checkpoint")?.path;
	const result = "result" in node ? node.result : undefined;
	const error = result?.error;
	return {
		id: node.id,
		logicalRole: node.logicalRole,
		state: node.state,
		...(resultPath ? { resultPath } : {}),
		...(node.usage ? { usage: node.usage } : {}),
		...(node.blockedBy ? { blockedBy: [...node.blockedBy] } : {}),
		...(error ? {
			error: {
				kind: error.kind,
				message: boundedText(error.message, MAX_ERROR_BYTES),
				...(error.stderr ? { stderr: boundedText(error.stderr, MAX_ERROR_BYTES) } : {}),
				...(error.partialOutput !== undefined ? { hasPartialOutput: true } : {}),
			},
		} : {}),
	};
}

function compactArtifacts(artifacts: LaunchResult["artifacts"]): CompactArtifact[] {
	return artifacts.map(({ kind, path }) => ({ kind, path }));
}

function boundedText(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	let result = value.slice(0, maxBytes);
	while (Buffer.byteLength(result, "utf8") > maxBytes - 40) result = result.slice(0, -1);
	return `${result}… [truncated]`;
}

function renderCall(operation: string): NonNullable<SubagentTool["renderCall"]> {
	return (args, theme) => {
		const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
		const runId = typeof input.runId === "string" ? input.runId : undefined;
		const action = theme.fg("toolTitle", theme.bold(`subagent_${operation}`));
		return new Text(`${action}${runId ? theme.fg("muted", ` ${runId}`) : ""}`, 0, 0);
	};
}

const renderResult: NonNullable<SubagentTool["renderResult"]> = (result, { isPartial }, theme) => {
	if (isPartial) return new Text(theme.fg("warning", "⏳ subagent active"), 0, 0);
	const details = result.details;
	if (!details) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "(no result)", 0, 0);
	const icon = details.state === "completed" ? "✓" : details.state === "failed" ? "✗" : details.state === "cancelled" ? "×" : "⟳";
	const color = details.state === "completed" ? "success" : details.state === "failed" ? "error" : details.state === "cancelled" ? "warning" : "accent";
	let text = theme.fg(color, `${icon} ${details.operation} ${details.state}`);
	if (details.run?.id) text += theme.fg("muted", ` ${details.run.id}`);
	if (details.bounded) text += theme.fg("warning", " (bounded; see artifacts)");
	return new Text(text, 0, 0);
};

async function launchWithParentCancellation(
	runtime: SubagentRuntime,
	graph: GraphDefinition,
	options: LaunchOptions,
	signal: AbortSignal | undefined,
): Promise<LaunchReceipt | LaunchResult> {
	if (options.delivery !== "blocking" || !signal) return runtime.launch(graph, options);
	const receipt = await runtime.launch(graph, { ...options, delivery: "detached" });
	const result = await withParentCancellation(signal, () => runtime.cancel(receipt.run.id), () => runtime.join(receipt.run.id));
	await acknowledgeRunNotifications(runtime, receipt.run.id);
	return result;
}

async function recoverWithParentCancellation(
	runtime: SubagentRuntime,
	runId: string,
	plan: RecoveryPlan,
	options: LaunchOptions,
	signal: AbortSignal | undefined,
): Promise<LaunchReceipt | LaunchResult> {
	if (options.delivery !== "blocking" || !signal) return runtime.recover(runId, plan, options);
	const receipt = await runtime.recover(runId, plan, { ...options, delivery: "detached" });
	const result = await withParentCancellation(signal, () => runtime.cancel(receipt.run.id), () => runtime.join(receipt.run.id));
	await acknowledgeRunNotifications(runtime, receipt.run.id);
	return result;
}

async function acknowledgeRunNotifications(runtime: SubagentRuntime, runId: string): Promise<void> {
	const notificationIds = (await runtime.notifications())
		.filter((notification) => notification.runId === runId)
		.map((notification) => notification.id);
	await runtime.acknowledgeNotifications(notificationIds);
}

async function withParentCancellation<T>(
	signal: AbortSignal | undefined,
	cancel: () => Promise<unknown>,
	operation: () => Promise<T>,
): Promise<T> {
	if (!signal) return operation();
	let cancelPromise: Promise<unknown> | undefined;
	let removeListener = () => {};
	const abort = new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			cancelPromise ??= Promise.resolve().then(cancel);
			cancelPromise.then((value) => resolve(value as T), reject);
		};
		if (signal.aborted) onAbort();
		else {
			signal.addEventListener("abort", onAbort, { once: true });
			removeListener = () => signal.removeEventListener("abort", onAbort);
		}
	});
	try {
		return await Promise.race([operation(), abort]);
	} finally {
		removeListener();
	}
}

export interface RuntimeOwner {
	factory: SubagentRuntimeFactory;
	bind: (ctx: ToolContext) => void;
	flush: () => Promise<void>;
	dispose: () => Promise<void>;
}

const SUBAGENT_NOTIFICATION_TYPE = "subagent-parent-notification";

export function defaultRuntimeOwner(
	pi: ExtensionAPI,
	runtimeCreator: typeof createSubagentRuntime = createSubagentRuntime,
): RuntimeOwner {
	let runtime: SubagentRuntime | undefined;
	let context: ToolContext | undefined;
	let flushing = false;
	let scheduled = false;

	const flush = async (): Promise<void> => {
		scheduled = false;
		if (flushing || !runtime || !context || !context.isIdle()) return;
		flushing = true;
		try {
			while (context.isIdle()) {
				const notifications = await runtime.notifications();
				if (notifications.length === 0) return;
				const content = formatParentNotifications(notifications);
				await Promise.resolve(pi.sendMessage({
					customType: SUBAGENT_NOTIFICATION_TYPE,
					content,
					display: true,
					details: { notifications },
				}, { triggerTurn: true, deliverAs: "followUp" }));
				await runtime.acknowledgeNotifications(notifications.map((notification) => notification.id));
			}
		} finally {
			flushing = false;
		}
	};
	const scheduleFlush = (): void => {
		if (scheduled) return;
		scheduled = true;
		queueMicrotask(() => { void flush(); });
	};
	const bind = (ctx: ToolContext): void => {
		context = ctx;
		if (runtime) {
			scheduleFlush();
			return;
		}
		const parentSessionId = ctx.sessionManager.getSessionFile() ?? `ephemeral:${ctx.cwd}`;
		runtime = runtimeCreator({
			cwd: ctx.cwd,
			parentSessionId,
			modelCatalog: { isAvailable: (provider, model) => ctx.modelRegistry.find(provider, model) !== undefined },
			onParentNotifications: () => scheduleFlush(),
		});
		scheduleFlush();
	};
	return {
		factory: (ctx) => {
			bind(ctx);
			return runtime!;
		},
		bind,
		flush,
		dispose: async () => {
			const activeRuntime = runtime;
			runtime = undefined;
			context = undefined;
			await activeRuntime?.dispose();
		},
	};
}

function formatParentNotifications(notifications: readonly ParentNotification[]): string {
	const lines = [`Subagent notifications (${notifications.length}):`];
	for (const notification of notifications) {
		const subject = notification.nodeId
			? `${notification.runId}/${notification.nodeId}${notification.logicalRole ? ` (${notification.logicalRole})` : ""}`
			: notification.runId;
		const artifacts = notification.artifactPaths.length > 0 ? ` Evidence: ${notification.artifactPaths.join(", ")}` : "";
		lines.push(`- [${notification.kind}] ${subject}: ${notification.message}.${artifacts}`);
	}
	return lines.join("\n");
}

export async function appendAgentDefinitionCatalog(
	systemPrompt: string,
	activeTools: readonly string[],
	cwd: string,
	directories: DefinitionDirectories = defaultDefinitionDirectories(cwd),
): Promise<string> {
	if (!activeTools.includes("subagent_launch")) return systemPrompt;
	const definitions = await listAgentDefinitions(directories);
	return `${systemPrompt}\n\n${formatAgentDefinitionCatalog(definitions)}`;
}

export default function subagentToolsExtension(pi: ExtensionAPI): void {
	const owner = defaultRuntimeOwner(pi);
	registerSubagentTools(pi, owner.factory);
	pi.on("before_agent_start", async (event, ctx) => ({
		systemPrompt: await appendAgentDefinitionCatalog(
			event.systemPrompt,
			event.systemPromptOptions.selectedTools ?? pi.getActiveTools(),
			ctx.cwd,
		),
	}));
	pi.on("session_start", (_event, ctx) => owner.bind(ctx));
	pi.on("agent_settled", (_event, ctx) => { owner.bind(ctx); void owner.flush(); });
	pi.on("session_shutdown", owner.dispose);
}
