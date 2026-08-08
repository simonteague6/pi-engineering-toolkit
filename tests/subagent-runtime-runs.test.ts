import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSubagentRuntime, type ChildRunner } from "../subagents/runtime.ts";

const graph = { kind: "single" as const, node: { agent: "worker", logicalRole: "Inspect", task: "Inspect" } };

const runner: ChildRunner = { run: async () => ({ state: "completed", output: "done" }) };

describe("runtime run listing", () => {
	test("lists only runs owned by the current parent session", async () => {
		const storeDirectory = await mkdtemp(join(tmpdir(), "pi-runtime-list-"));
		try {
			const first = createSubagentRuntime({ storeDirectory, parentSessionId: "parent-a", runner, modelCatalog: { isAvailable: () => true } });
			const second = createSubagentRuntime({ storeDirectory, parentSessionId: "parent-b", runner, modelCatalog: { isAvailable: () => true } });
			await first.launch(graph, { delivery: "blocking" });
			await second.launch(graph, { delivery: "blocking" });

			expect(await first.runs()).toHaveLength(1);
			expect((await first.runs())[0]?.run.state).toBe("completed");
			expect(await second.runs()).toHaveLength(1);
		} finally {
			await rm(storeDirectory, { recursive: true, force: true });
		}
	});
});
