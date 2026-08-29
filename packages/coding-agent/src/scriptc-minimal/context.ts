/**
 * Project context loading (AGENTS.md chain) — scriptc-port of the minimal
 * subset of packages/coding-agent/src/core/resource-loader.ts.
 *
 * Discovery matches pi's `loadProjectContextFiles`:
 *  - one global context file from the pi agent dir (~/.pi/agent)
 *  - one context file per directory from the filesystem root down to cwd
 *    (innermost files take precedence in later <project_instructions> blocks)
 * Candidates per dir: AGENTS.override.md > AGENTS.md > AGENTS.MD > CLAUDE.md > CLAUDE.MD.
 *
 * scriptc-port notes: no optional chaining, no spread args, no Set,
 * no regex — everything uses the lowered builtin surface
 * (existsSync/statSync/readFileSync, path.dirname/join/resolve, os.homedir).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface ContextFile {
	path: string;
	content: string;
}

const CONTEXT_CANDIDATES = [
	"AGENTS.override.md",
	"AGENTS.md",
	"AGENTS.MD",
	"CLAUDE.md",
	"CLAUDE.MD",
];

function loadContextFileFromDir(dir: string): ContextFile | null {
	for (const filename of CONTEXT_CANDIDATES) {
		const filePath = join(dir, filename);
		if (!existsSync(filePath)) continue;
		try {
			if (!statSync(filePath).isFile()) continue;
			return { path: filePath, content: readFileSync(filePath, "utf8") };
		} catch {
			continue;
		}
	}
	return null;
}

export function loadProjectContextFiles(cwd: string): ContextFile[] {
	const resolvedCwd = resolve(cwd);
	const agentDir = join(homedir(), ".pi", "agent");

	const contextFiles: ContextFile[] = [];
	const seenPaths: string[] = [];

	// global context (~/.pi/agent/AGENTS.md), like pi's agentDir context
	const globalContext = loadContextFileFromDir(agentDir);
	if (globalContext !== null) {
		contextFiles.push(globalContext);
		seenPaths.push(globalContext.path);
	}

	// ancestors, ordered outermost → cwd (pi unshifts while walking up)
	const ancestors: ContextFile[] = [];
	let currentDir = resolvedCwd;
	while (true) {
		const contextFile = loadContextFileFromDir(currentDir);
		if (contextFile !== null && seenPaths.indexOf(contextFile.path) === -1) {
			ancestors.unshift(contextFile);
			seenPaths.push(contextFile.path);
		}
		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	for (const file of ancestors) {
		contextFiles.push(file);
	}

	return contextFiles;
}
