/**
 * System prompt construction — scriptc-port of the minimal subset of
 * packages/coding-agent/src/core/system-prompt.ts.
 *
 * Same structure as pi's `buildSystemPrompt`: tools list, guidelines,
 * <project_context> block with <project_instructions path="..."> entries,
 * then "Current working directory: ...". Skills and pi-docs sections are
 * omitted (no skills loader, no bundled docs in the minimal binary).
 *
 * scriptc-port notes: string concat/join only, no regex, no optional
 * chaining, indexed for-loops instead of destructuring for-of.
 */

import type { ContextFile } from "./context.ts";

interface ToolSnippet {
	name: string;
	snippet: string;
}

const TOOL_SNIPPETS: ToolSnippet[] = [
	{ name: "read", snippet: "Read a text file (optionally a line range) from disk." },
	{ name: "write", snippet: "Write text to a file, creating parent directories as needed." },
	{ name: "edit", snippet: "Replace an exact string occurrence in a file." },
	{ name: "bash", snippet: "Run a bash command and return its output." },
	{ name: "ls", snippet: "List a directory's entries." },
	{ name: "grep", snippet: "Search file contents for a pattern (substring or regex)." },
];

export interface BuildSystemPromptOptions {
	cwd: string;
	contextFiles: ContextFile[];
}

export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	// pi normalizes windows separators; split/join instead of regex
	const promptCwd = options.cwd.split("\\").join("/");

	const toolLines: string[] = [];
	for (const tool of TOOL_SNIPPETS) {
		toolLines.push(`- ${tool.name}: ${tool.snippet}`);
	}

	const prompt =
		`You are pi, a coding agent running as a compiled native binary. You help users by reading files, executing commands, editing code, and writing new files.\n\n` +
		`Available tools:\n${toolLines.join("\n")}\n\n` +
		`Guidelines:\n` +
		`- Use read/grep/ls to explore, edit/write to change files, bash for commands\n` +
		`- Be concise in your responses\n` +
		`- Show file paths clearly when working with files\n` +
		`- Prefer relative paths`;

	let full = prompt;

	const contextFiles = options.contextFiles;
	if (contextFiles.length > 0) {
		full += "\n\n<project_context>\n\n";
		full += "Project-specific instructions and guidelines:\n\n";
		for (let i = 0; i < contextFiles.length; i++) {
			const file = contextFiles[i];
			full += `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n\n`;
		}
		full += "</project_context>\n";
	}

	full += `\nCurrent working directory: ${promptCwd}`;

	return full;
}
