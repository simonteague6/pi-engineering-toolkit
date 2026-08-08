import { createSubagentRuntime as createRuntime } from "./runtime.ts";
import type { ModelCatalog, ParentNotificationListener, SubagentRuntime } from "./runtime.ts";

export type {
	Artifact,
	ChainGraph,
	CleanupResult,
	DagGraph,
	DagNodeDefinition,
	ExecutionPolicy,
	FailureEvidence,
	GraphDefinition,
	HandoffEvidence,
	LaunchOptions,
	LaunchReceipt,
	LaunchResult,
	LifecycleEvent,
	LifecycleState,
	ModelCatalog,
	NodeDefinition,
	NodeResult,
	NodeTrace,
	NodeView,
	ParallelGraph,
	ParentNotification,
	ParentNotificationKind,
	ParentNotificationListener,
	RecoveryLineage,
	RecoveryPlan,
	RecoveryReplacement,
	RunView,
	SingleGraph,
	StatusView,
	SubagentRuntime,
	TokenUsage,
	TokenUsageField,
	UsageRecord,
	UsageTotals,
} from "./runtime.ts";

export type { ReasoningLevel } from "./definitions.ts";

/** Configuration supported by the package's stable subagent TypeScript seam. */
export interface SubagentRuntimeOptions {
	readonly parentSessionId?: string;
	readonly onParentNotifications?: ParentNotificationListener;
	readonly retentionPeriodMs?: number;
	readonly cwd?: string;
	readonly modelCatalog: ModelCatalog;
	readonly maxConcurrency?: number;
	readonly idleLimitMs?: number;
}

/** Creates the supported durable subagent runtime with the package-owned runner and store. */
export function createSubagentRuntime(options: SubagentRuntimeOptions): SubagentRuntime {
	return createRuntime(options);
}
