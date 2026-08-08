import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAgentDefinitions, updateAgentDefinition, type DefinitionDirectories } from "../subagents/definitions.ts";

const source = (id: string, provider = "openai", model = "model-a", reasoning = "low") => `---
id: ${id}
description: Test definition
tools: read
provider: ${provider}
model: ${model}
reasoning: ${reasoning}
---

## Role
Inspect the task.

## Report contract
Return findings.

## Completion criteria
Stop when complete.
`;

async function withDirectories<T>(fn: (directories: DefinitionDirectories) => Promise<T>): Promise<T> {
	const root = await mkdtemp(join(tmpdir(), "pi-definitions-"));
	const directories = { project: join(root, "project"), user: join(root, "user"), packaged: join(root, "packaged") };
	await Promise.all(Object.values(directories).map((directory) => mkdir(directory)));
	try { return await fn(directories); } finally { await rm(root, { recursive: true, force: true }); }
}

describe("agent definition settings", () => {
	test("lists definitions with resolver precedence", async () => {
		await withDirectories(async (directories) => {
			await writeFile(join(directories.packaged, "worker.md"), source("worker", "packaged"));
			await writeFile(join(directories.user, "worker.md"), source("worker", "user"));
			const definitions = await listAgentDefinitions(directories);
			expect(definitions).toHaveLength(1);
			expect(definitions[0]).toMatchObject({ id: "worker", provider: "user", source: "user" });
		});
	});

	test("updates the selected project source of truth", async () => {
		await withDirectories(async (directories) => {
			await writeFile(join(directories.project, "worker.md"), source("worker"));
			const updated = await updateAgentDefinition("worker", directories, { provider: "anthropic", model: "claude", reasoning: "high" });
			expect(updated).toMatchObject({ source: "project", provider: "anthropic", model: "claude", reasoning: "high" });
			const file = await readFile(join(directories.project, "worker.md"), "utf8");
			expect(file).toContain("provider: anthropic");
			expect(file).toContain("model: claude");
			expect(file).toContain("reasoning: high");
		});
	});

	test("creates a user override instead of mutating packaged definitions", async () => {
		await withDirectories(async (directories) => {
			await writeFile(join(directories.packaged, "worker.md"), source("worker"));
			const updated = await updateAgentDefinition("worker", directories, { model: "user-model" });
			expect(updated.source).toBe("user");
			expect(updated.path).toBe(join(directories.user, "worker.md"));
			expect(await readFile(join(directories.packaged, "worker.md"), "utf8")).toContain("model: model-a");
		});
	});
});
