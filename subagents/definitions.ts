import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export type ReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type DefinitionSource = "project" | "user" | "packaged";

export interface AgentDefinition {
	readonly id: string;
	readonly description: string;
	readonly tools: readonly string[];
	readonly provider: string;
	readonly model: string;
	readonly reasoning: ReasoningLevel;
	readonly roleInstructions: string;
	readonly reportContract: string;
	readonly completionCriteria: string;
}

export interface DefinitionDirectories {
	readonly packaged: string;
	readonly user: string;
	readonly project: string;
}

export interface AgentDefinitionInfo extends AgentDefinition {
	readonly source: DefinitionSource;
	readonly path: string;
}

const reasoningLevels = new Set<ReasoningLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function defaultDefinitionDirectories(parentCwd: string): DefinitionDirectories {
	return {
		packaged: fileURLToPath(new URL("../agents", import.meta.url)),
		user: join(homedir(), ".pi", "agent", "agents"),
		project: join(parentCwd, ".pi", "agents"),
	};
}

/** Resolves exactly one definition using project > user > packaged precedence. */
export async function resolveAgentDefinition(id: string, directories: DefinitionDirectories): Promise<AgentDefinition> {
	const info = await resolveAgentDefinitionInfo(id, directories);
	return info;
}

/** Lists effective definitions using the same project > user > packaged precedence as launch. */
export async function listAgentDefinitions(directories: DefinitionDirectories): Promise<AgentDefinitionInfo[]> {
	const result = new Map<string, AgentDefinitionInfo>();
	for (const [source, directory] of definitionSources(directories)) {
		let entries: string[];
		try {
			entries = await readdir(directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		for (const entry of entries.filter((name) => name.endsWith(".md")).sort()) {
			const id = entry.slice(0, -3);
			if (result.has(id)) continue;
			const path = join(directory, entry);
			result.set(id, { ...parseAgentDefinition(await readFile(path, "utf8"), path), source, path });
		}
	}
	return [...result.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** Writes model defaults into the definition file selected by the normal precedence rules. */
export async function updateAgentDefinition(
	id: string,
	directories: DefinitionDirectories,
	patch: Partial<Pick<AgentDefinition, "provider" | "model" | "reasoning">>,
): Promise<AgentDefinitionInfo> {
	const current = await resolveAgentDefinitionInfo(id, directories);
	const target = current.source === "packaged" ? join(directories.user, `${id}.md`) : current.path;
	const source = await readFile(current.path, "utf8");
	const updated = updateFrontmatter(source, patch);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, updated, "utf8");
	const definition = parseAgentDefinition(updated, target);
	return { ...definition, source: current.source === "packaged" ? "user" : current.source, path: target };
}

async function resolveAgentDefinitionInfo(id: string, directories: DefinitionDirectories): Promise<AgentDefinitionInfo> {
	if (!id.trim() || id.includes("/") || id.includes("\\")) {
		throw new Error(`Invalid agent definition ID: ${id}`);
	}
	for (const [source, directory] of definitionSources(directories)) {
		const path = join(directory, `${id}.md`);
		try {
			return { ...parseAgentDefinition(await readFile(path, "utf8"), path), source, path };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
	}
	throw new Error(`Agent definition not found: ${id}`);
}

function definitionSources(directories: DefinitionDirectories): Array<[DefinitionSource, string]> {
	return [["project", directories.project], ["user", directories.user], ["packaged", directories.packaged]];
}

function updateFrontmatter(
	source: string,
	patch: Partial<Pick<AgentDefinition, "provider" | "model" | "reasoning">>,
): string {
	const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (!match) throw new Error("Cannot update definition without YAML frontmatter");
	const fields = new Map<string, string>();
	for (const line of match[1]!.split(/\r?\n/)) {
		const separator = line.indexOf(":");
		if (separator > 0) fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
	}
	for (const key of ["provider", "model", "reasoning"] as const) {
		const value = patch[key];
		if (value !== undefined) fields.set(key, value);
	}
	const frontmatter = [...fields.entries()].map(([key, value]) => `${key}: ${value}`).join("\n");
	return `---\n${frontmatter}\n---${source.slice(match[0].length - (match[0].endsWith("\n") ? 1 : 0))}`;
}

function parseAgentDefinition(source: string, path: string): AgentDefinition {
	const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (!match) throw invalidDefinition(path, "missing YAML frontmatter");

	const fields = new Map<string, string>();
	for (const line of match[1]!.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const separator = line.indexOf(":");
		if (separator <= 0) throw invalidDefinition(path, `invalid frontmatter line: ${line}`);
		const key = line.slice(0, separator).trim();
		const value = line.slice(separator + 1).trim();
		if (!value) throw invalidDefinition(path, `missing value for ${key}`);
		if (fields.has(key)) throw invalidDefinition(path, `duplicate ${key}`);
		fields.set(key, value);
	}

	const required = ["id", "description", "tools", "provider", "model", "reasoning"] as const;
	for (const field of required) {
		if (!fields.has(field)) throw invalidDefinition(path, `missing ${field}`);
	}

	const id = fields.get("id")!;
	const tools = fields.get("tools")!.split(",").map((tool) => tool.trim()).filter(Boolean);
	const reasoning = fields.get("reasoning")!;
	if (!tools.length) throw invalidDefinition(path, "tools must name at least one tool");
	if (!reasoningLevels.has(reasoning as ReasoningLevel)) throw invalidDefinition(path, `unsupported reasoning level: ${reasoning}`);

	const body = source.slice(match[0].length);
	return Object.freeze({
		id,
		description: fields.get("description")!,
		tools: Object.freeze(tools),
		provider: fields.get("provider")!,
		model: fields.get("model")!,
		reasoning: reasoning as ReasoningLevel,
		roleInstructions: requiredSection(body, "Role", path),
		reportContract: requiredSection(body, "Report contract", path),
		completionCriteria: requiredSection(body, "Completion criteria", path),
	});
}

function requiredSection(body: string, heading: string, path: string): string {
	const lines = body.split(/\r?\n/);
	const start = lines.findIndex((line) => line === `## ${heading}`);
	if (start < 0) throw invalidDefinition(path, `missing ${heading} section`);
	const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
	const content = lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
	if (!content) throw invalidDefinition(path, `missing ${heading} section`);
	return content;
}

function invalidDefinition(path: string, reason: string): Error {
	return new Error(`Invalid agent definition at ${path}: ${reason}`);
}
