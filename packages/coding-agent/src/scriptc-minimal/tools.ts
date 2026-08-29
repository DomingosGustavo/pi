/**
 * Minimal tool set for the scriptc port.
 *
 * Same basic pi tools (read / write / edit / bash / ls / grep) with pi's core
 * semantics: read uses 1-indexed offsets + truncation limits, edit does
 * exact-string replacement, bash spawns a shell with an optional timeout, and
 * every result is (TextContent | ImageContent)[] in an AgentToolResult.
 *
 * Deliberately free of pi-tui / theme / extension dependencies — those are the
 * blockers for static compilation. The interactive renderers live behind
 * ToolDefinition in the full agent; this file carries only the execution core.
 *
 * scriptc constraints honoured here (see ~/src/scriptc lower-builtins.ts):
 * - bash uses spawnSync with a literal {encoding, timeout} options object
 *   (async ChildProcess stdio streams have no lowering);
 * - fs work uses readFileSync/statSync/readdirSync + fs/promises readFile/
 *   writeFile, all of which lower.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, type Stats, statSync } from "node:fs";
import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { isAbsolute, join as joinPath, resolve as resolvePath } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core/types";

/*
 * Boundary notes (scriptc): the tool objects cross into the agent loop, whose
 * AgentTool type references the typebox schema types served by the --dynamic
 * island. Values crossing that boundary must be JSON-safe, so the schema
 * values are laundered with `as any` (typebox schemas ARE plain JSON), and
 * execute() takes unannotated params so contextual typing keeps them `any`.
 */
import { truncateHead } from "../core/tools/truncate.ts";

type TextResult = AgentToolResult<undefined>;

function text(out: string): any {
	return { content: [{ type: "text", text: out }], details: undefined };
}

function toCwd(p: string): string {
	return isAbsolute(p) ? p : resolvePath(joinPath(process.cwd(), p));
}

// ── read ────────────────────────────────────────────────────────────────────

const readSchema: Record<string, unknown> = {
	type: "object",
	properties: {
		path: { type: "string", description: "Path to the file to read (relative or absolute)" },
		offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
		limit: { type: "number", description: "Maximum number of lines to read" },
	},
	required: ["path"],
};

export const readTool: AgentTool<any> = {
	name: "read",
	label: "Read",
	description:
		"Read file contents. Returns the file with line numbers; use offset/limit for large files. " +
		"Reading a directory lists its children.",
	parameters: readSchema as any,
	async execute(_id, params: any): Promise<any> {
		const abs = toCwd(params.path);
		const st = statSync(abs);
		if (st.isDirectory()) {
			return text(readdirSync(abs).join("\n"));
		}
		const raw = await fsReadFile(abs, "utf8");
		const lines = raw.split("\n");
		const start = Math.max(1, Math.floor(params.offset ?? 1));
		const end = Math.min(lines.length, start + Math.floor(params.limit ?? 2000) - 1);
		const numbered: string[] = [];
		for (let i = start; i <= end; i++) {
			numbered.push(`${String(i).padStart(6)}\t${lines[i - 1] ?? ""}`);
		}
		const body = numbered.join("\n");
		const truncated = truncateHead(body, { maxBytes: 50 * 1024 });
		return text(truncated.content + (truncated.truncated ? "\n... (truncated)" : ""));
	},
};

// ── write ───────────────────────────────────────────────────────────────────

const writeSchema: Record<string, unknown> = {
	type: "object",
	properties: {
		path: { type: "string", description: "Path to the file to write (relative or absolute)" },
		content: { type: "string", description: "Content to write to the file" },
	},
	required: ["path", "content"],
};

export const writeTool: AgentTool<any> = {
	name: "write",
	label: "Write",
	description: "Write content to a file, replacing it entirely.",
	parameters: writeSchema as any,
	async execute(_id, params: any): Promise<any> {
		const abs = toCwd(params.path);
		await fsWriteFile(abs, params.content);
		return text(`Wrote ${params.content.length} bytes to ${abs}`);
	},
};

// ── edit ────────────────────────────────────────────────────────────────────

const editSchema: Record<string, unknown> = {
	type: "object",
	properties: {
		path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
		oldText: { type: "string", description: "Exact text to replace (must appear exactly once unless replaceAll)" },
		newText: { type: "string", description: "Replacement text" },
		replaceAll: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match" },
	},
	required: ["path", "oldText", "newText"],
};

export const editTool: AgentTool<any> = {
	name: "edit",
	label: "Edit",
	description:
		"Replace an exact string in a file. oldText must match exactly once unless replaceAll is true. " +
		"Include surrounding context in oldText to disambiguate.",
	parameters: editSchema as any,
	async execute(_id, params: any): Promise<any> {
		const abs = toCwd(params.path);
		const content = await fsReadFile(abs, "utf8");
		const oldText: string = params.oldText;
		const count = content.split(oldText).length - 1;
		if (count === 0) throw new Error(`oldText not found in ${params.path}`);
		if (count > 1 && !params.replaceAll) {
			throw new Error(`oldText matches ${count} times in ${params.path} — add context or set replaceAll`);
		}
		const newText: string = params.newText;
		const replaceAll: boolean = params.replaceAll === true;
		const updated = replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText);
		await fsWriteFile(abs, updated);
		return text(`Edited ${abs} (${count} replacement${count === 1 ? "" : "s"})`);
	},
};

// ── bash ────────────────────────────────────────────────────────────────────

const bashSchema: Record<string, unknown> = {
	type: "object",
	properties: {
		command: { type: "string", description: "Bash command to execute" },
		timeout: { type: "number", description: "Timeout in seconds (optional, no default timeout)" },
	},
	required: ["command"],
};

const BASH_MAX_BYTES = 30_000;

function bashWithTimeout(command: string, timeoutMs: number): TextResult {
	const r = spawnSync("bash", ["-c", command], { encoding: "utf8", timeout: timeoutMs });
	let out = r.stdout || "";
	if (r.stderr) out += (out ? "\n" : "") + r.stderr;
	if (r.error) out += (out ? "\n" : "") + `spawn error: ${r.error.message}`;
	if (r.signal) out += (out ? "\n" : "") + `[killed by signal: ${r.signal}]`;
	if (!out) out = "(no output)";
	if (out.length > BASH_MAX_BYTES) {
		out = truncateHead(out, { maxBytes: BASH_MAX_BYTES }).content + "\n... (truncated)";
	}
	return text(r.status !== 0 ? `${out}\n[exit code: ${r.status}]` : out);
}

export const bashTool: AgentTool<any> = {
	name: "bash",
	label: "Bash",
	description: "Execute a bash command and return stdout/stderr. Pass timeout (seconds) to bound long commands.",
	parameters: bashSchema as any,
	async execute(_id, params: any): Promise<any> {
		if (params.timeout !== undefined) {
			return bashWithTimeout(params.command, params.timeout * 1000);
		}
		const r = spawnSync("bash", ["-c", params.command], { encoding: "utf8" });
		let out = r.stdout || "";
		if (r.stderr) out += (out ? "\n" : "") + r.stderr;
		if (r.error) out += (out ? "\n" : "") + `spawn error: ${r.error.message}`;
		if (!out) out = "(no output)";
		if (out.length > BASH_MAX_BYTES) {
			out = truncateHead(out, { maxBytes: BASH_MAX_BYTES }).content + "\n... (truncated)";
		}
		return text(r.status !== 0 ? `${out}\n[exit code: ${r.status}]` : out);
	},
};

// ── ls / grep (light) ───────────────────────────────────────────────────────

const lsSchema: Record<string, unknown> = {
	type: "object",
	properties: {
		path: { type: "string", description: "Directory to list (default: cwd)" },
	},
};

export const lsTool: AgentTool<any> = {
	name: "ls",
	label: "LS",
	description: "List the immediate children of a directory with sizes.",
	parameters: lsSchema as any,
	async execute(_id, params: any): Promise<any> {
		const dir = toCwd(params.path ?? ".");
		const names = readdirSync(dir);
		const rows: string[] = [];
		for (const name of names) {
			try {
				const st: Stats = statSync(joinPath(dir, name));
				rows.push(st.isDirectory() ? `${name}/` : `  ${name} (${st.size} bytes)`);
			} catch {
				rows.push(name);
			}
		}
		return text(rows.join("\n") || "(empty)");
	},
};

const grepSchema: Record<string, unknown> = {
	type: "object",
	properties: {
		pattern: { type: "string", description: "Regular expression to search for" },
		path: { type: "string", description: "File or directory to search (default: cwd)" },
	},
	required: ["pattern"],
};

const GREP_MAX_MATCHES = 100;

export const grepTool: AgentTool<any> = {
	name: "grep",
	label: "Grep",
	description: "Search file contents with a regular expression under a path.",
	parameters: grepSchema as any,
	async execute(_id, params: any): Promise<any> {
		const root = toCwd(params.path ?? ".");
		const pattern: string = params.pattern;
		const regex = new RegExp(pattern);
		const results: string[] = [];
		const walk = (p: string, depth: number): void => {
			if (results.length >= GREP_MAX_MATCHES || depth > 6) return;
			let st: Stats;
			try {
				st = statSync(p);
			} catch {
				return;
			}
			if (st.isDirectory()) {
				for (const name of readdirSync(p)) {
					if (name.startsWith(".") || name === "node_modules") continue;
					walk(joinPath(p, name), depth + 1);
				}
				return;
			}
			if (st.size > 1024 * 1024) return;
			let content: string;
			try {
				content = readFileSync(p, "utf8");
			} catch {
				return;
			}
			const lines = content.split("\n");
			for (let i = 0; i < lines.length; i++) {
				if (regex.test(lines[i]!)) {
					results.push(`${p}:${i + 1}: ${lines[i]!.slice(0, 300)}`);
					if (results.length >= GREP_MAX_MATCHES) return;
				}
			}
		};
		walk(root, 0);
		return text(results.length ? results.join("\n") : "(no matches)");
	},
};

export const minimalTools: AgentTool<any>[] = [readTool, writeTool, editTool, bashTool, lsTool, grepTool];
