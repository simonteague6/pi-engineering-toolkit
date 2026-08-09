import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAgentDefinitionCatalog } from "../extensions/subagent-tools.ts";
import type { DefinitionDirectories } from "../subagents/definitions.ts";

const definition = (id: string, description: string) => `---
id: ${id}
description: ${description}
tools: read, grep
provider: test-provider
model: test-model
reasoning: low
---

## Role
Inspect the assigned scope.

## Report contract
Return findings.

## Completion criteria
Stop when the scope is complete.
`;

async function withDefinitionDirectories<T>(fn: (directories: DefinitionDirectories) => Promise<T>): Promise<T> {
	const root = await mkdtemp(join(tmpdir(), "pi-subagent-prompt-"));
	const directories = { project: join(root, "project"), user: join(root, "user"), packaged: join(root, "packaged") };
	await Promise.all(Object.values(directories).map((directory) => mkdir(directory)));
	try {
		return await fn(directories);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("subagent parent prompt", () => {
	test("adds the effective definition catalog when subagent_launch is active", async () => {
		await withDefinitionDirectories(async (directories) => {
			await writeFile(join(directories.packaged, "recon.md"), definition("recon", "Read-only repository exploration."));
			await writeFile(join(directories.project, "worker.md"), definition("worker", "Bounded implementation work."));

			const prompt = await appendAgentDefinitionCatalog("base prompt", ["read", "subagent_launch"], "/workspace", directories);

			expect(prompt).toContain("## Subagent definitions");
			expect(prompt).toContain("`agent` to an exact definition ID");
			expect(prompt).toContain("`logicalRole` names the responsibility");
			expect(prompt).toContain("`recon` — Read-only repository exploration.");
			expect(prompt).toContain("`worker` — Bounded implementation work.");
			expect(prompt).toContain("including `general`, fails at launch");
		});
	});

	test("does not add catalog context when subagent_launch is inactive", async () => {
		await expect(appendAgentDefinitionCatalog("base prompt", ["read"], "/missing")).resolves.toBe("base prompt");
	});
});
