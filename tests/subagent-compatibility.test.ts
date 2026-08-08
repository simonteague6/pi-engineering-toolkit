import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SubprocessJsonRunner, type ChildRunnerRequest } from "../subagents/runtime.ts";

interface PackageManifest {
	engines: { node: string };
	exports: { "./subagents": string };
	pi: { extensions: string[] };
	piEngineeringKit: { supportedPiVersions: string[] };
	peerDependencies: Record<string, string>;
}

const repositoryRoot = resolve(import.meta.dir, "..");
const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as PackageManifest;

function piFixture(): { pi: ExtensionAPI; tools: string[] } {
	const tools: string[] = [];
	const pi = {
		on: () => {},
		registerCommand: () => {},
		registerEntryRenderer: () => {},
		registerMessageRenderer: () => {},
		registerShortcut: () => {},
		registerTool: (tool: { name: string }) => tools.push(tool.name),
	} as unknown as ExtensionAPI;
	return { pi, tools };
}

function request(): ChildRunnerRequest {
	return {
		runId: "run_compatibility",
		nodeId: "node_compatibility",
		agent: "worker",
		logicalRole: "Compatibility check",
		task: "Return the fixture result.",
		cwd: repositoryRoot,
		provider: "fixture",
		model: "fixture-model",
		reasoning: "low",
		tools: ["read"],
		systemPrompt: "Return only the fixture result.",
		freshResources: true,
		recursiveDelegation: false,
		approvalPrompts: false,
	};
}

async function withPiFixture<T>(run: (runner: SubprocessJsonRunner) => Promise<T>): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "pi-compatibility-fixture-"));
	const executable = join(directory, "pi");
	await writeFile(executable, `#!/usr/bin/env bun
console.log(JSON.stringify({ type: "message_end", message: {
  role: "assistant", content: [{ type: "text", text: "fixture result" }], stopReason: "stop"
} }));
console.log(JSON.stringify({ type: "agent_settled" }));
`, "utf8");
	await chmod(executable, 0o755);
	try {
		return await run(new SubprocessJsonRunner(executable));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

describe("declared Pi compatibility", () => {
	test("publishes a bounded Node and Pi support contract with a public subagent entry point", async () => {
		expect(manifest.engines.node).toBe(">=22.19.0");
		expect(manifest.peerDependencies["@earendil-works/pi-coding-agent"]).toBe(">=0.80.8 <0.83.0");
		expect(manifest.piEngineeringKit.supportedPiVersions).toContain("0.80.8");
		expect(manifest.exports["./subagents"]).toBe("./subagents/index.ts");
		const api = await import("../subagents/index.ts");
		expect(api.createSubagentRuntime).toBeFunction();
	});

	for (const version of manifest.piEngineeringKit.supportedPiVersions) {
		test(`loads package resources, registers parent tools, and parses JSON events for Pi ${version}`, async () => {
			const { pi, tools } = piFixture();
			for (const extension of manifest.pi.extensions) {
				await expect(readFile(join(repositoryRoot, extension), "utf8")).resolves.toContain("export default");
				const module = await import(join(repositoryRoot, extension));
				expect(module.default).toBeFunction();
				module.default(pi);
			}
			expect(tools).toEqual(expect.arrayContaining([
				"subagent_launch",
				"subagent_status",
				"subagent_join",
				"subagent_cancel",
				"subagent_resume",
				"subagent_recover",
			]));
			await expect(readFile(join(repositoryRoot, "agents", "worker.md"), "utf8")).resolves.toContain("## Role");
			await withPiFixture(async (runner) => {
				await expect(runner.run(request())).resolves.toMatchObject({
					state: "completed",
					output: "fixture result",
				});
			});
		});
	}
});
