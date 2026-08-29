/**
 * Minimal scriptc-native pi: TUI + provider plug + basic tools.
 *
 * Provider layer runs through @earendil-works/pi-ai (the --dynamic island),
 * which gives every pi provider (anthropic, openai, google, ... with env-key
 * auth) from one registry. The agent loop is pi's own
 * @earendil-works/pi-agent-core Agent. The TUI is hand-rolled on the stdin/
 * stdout surface scriptc lowers: raw mode, stdin.on("data"), stdout.write.
 *
 * Build:
 *   node scripts/scriptc-stage.mjs --island @earendil-works/pi-ai
 *   SCRIPTC_CC=zigcc scriptc build \
 *     .scriptc-stage/packages/coding-agent/src/scriptc-minimal/main.ts \
 *     --dynamic -o /tmp/pi-min
 *
 * Usage:
 *   pi-min                      # interactive TUI
 *   pi-min -p "prompt"          # one-shot, prints the response
 *   PI_PROVIDER=anthropic PI_MODEL=... pi-min ...
 */
import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentEvent, StreamFn } from "@earendil-works/pi-agent-core";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { minimalTools } from "./tools.ts";
import { loadProjectContextFiles } from "./context.ts";
import { buildSystemPrompt } from "./system-prompt.ts";

// ── ANSI helpers ────────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

function out(s: string): void {
	process.stdout.write(s);
}

function outLine(s: string): void {
	process.stdout.write(`${s}\n`);
}

// ── provider plug ───────────────────────────────────────────────────────────

interface ProviderSelection {
	model: any;
	providerId: string;
}

function selectModel(): ProviderSelection {
	const models = builtinModels();
	const providerId = process.env.PI_PROVIDER ?? "anthropic";
	const modelId = process.env.PI_MODEL;
	let model: any | undefined;
	if (modelId) {
		model = models.getModel(providerId, modelId);
	} else {
		const provider = models.getProvider(providerId);
		if (provider !== undefined) {
			const providerModels = provider.getModels();
			model = providerModels.length > 0 ? providerModels[0] : undefined;
		}
	}
	if (!model) {
		throw new Error(
			`No model found for provider '${providerId}'${modelId ? ` / model '${modelId}'` : ""}. ` +
				`Set PI_PROVIDER and PI_MODEL.`,
		);
	}
	return { model, providerId };
}

function makeStreamFn() {
	const models = builtinModels();
	// NOTE: params stay unannotated on purpose — this callback crosses into
	// dynamically-served (island) code, and scriptc only admits it when the
	// checker keeps the parameters 'any' via contextual typing. The inferred
	// return is the island's event-stream value, which the boundary treats as
	// an opaque dynamic value.
	const streamFn: StreamFn = async (model, context, options) => {
		const apiKey = getEnvApiKey(model.provider);
		const signal = options !== undefined ? options.signal : undefined;
		const maxTokens = process.env.PI_MAX_TOKENS !== undefined ? Number(process.env.PI_MAX_TOKENS) : undefined;
		return models.streamSimple(model, context, { apiKey, signal, maxTokens });
	};
	return streamFn;
}

/**
 * Env-var API-key lookup (subset of pi-ai's getEnvApiKey table — the pi-ai
 * module stays islanded, so a source file cannot import from it). Covers the
 * common providers; unknown providers fall back to the UPPER_SNAKE convention.
 */
// undefined-valued: a missing key must read as undefined, not trap
// (scriptc traps keyed reads whose result type has no undefined arm).
const ENV_API_KEYS: Record<string, string | undefined> = {
	anthropic: "ANTHROPIC_API_KEY",
	openai: "OPENAI_API_KEY",
	"azure-openai-responses": "AZURE_OPENAI_API_KEY",
	deepseek: "DEEPSEEK_API_KEY",
	google: "GEMINI_API_KEY",
	groq: "GROQ_API_KEY",
	cerebras: "CEREBRAS_API_KEY",
	xai: "XAI_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	mistral: "MISTRAL_API_KEY",
	moonshotai: "MOONSHOT_API_KEY",
	fireworks: "FIREWORKS_API_KEY",
	together: "TOGETHER_API_KEY",
	huggingface: "HF_TOKEN",
};

function getEnvApiKey(provider: string): string | undefined {
	const named = ENV_API_KEYS[provider];
	if (named && process.env[named]) return process.env[named];
	const conventional = `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
	return process.env[conventional];
}

// ── TUI ─────────────────────────────────────────────────────────────────────

/** Line editor state for the raw-mode input line. */
class InputLine {
	prompt: string;
	private buffer = "";
	private cursor = 0;
	/** The text captured at the last submit. */
	submitted = "";

	constructor(prompt: string) {
		this.prompt = prompt;
		this.render();
	}

	private col(): number {
		return this.prompt.length + this.cursor;
	}

	render(): void {
		// carriage return, prompt + buffer, then position the cursor
		out(`\r\x1b[K${this.prompt}${this.buffer}\r\x1b[${this.col() + 1}G`);
	}

	handle(bytes: Uint8Array): "submitted" | "exit" | "none" {
		const s = Buffer.from(bytes).toString("utf8");
		if (s === "\r" || s === "\n") {
			this.submitted = this.buffer;
			out("\r\n");
			this.buffer = "";
			this.cursor = 0;
			if (this.submitted.trim().length === 0) return "none";
			return "submitted";
		}
		if (s === "\x03" || s === "\x04") {
			out("\r\n");
			return "exit";
		}
		if (s === "\x7f" || s === "\b") {
			if (this.cursor > 0) {
				this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
				this.cursor--;
				this.render();
			}
			return "none";
		}
		if (s === "\x1b[D") {
			if (this.cursor > 0) {
				this.cursor--;
				this.render();
			}
			return "none";
		}
		if (s === "\x1b[C") {
			if (this.cursor < this.buffer.length) {
				this.cursor++;
				this.render();
			}
			return "none";
		}
		if (s.startsWith("\x1b")) {
			return "none"; // ignore other escape sequences for now
		}
		if (s >= " " || s === "\t") {
			this.buffer = this.buffer.slice(0, this.cursor) + s + this.buffer.slice(this.cursor);
			this.cursor += s.length;
			this.render();
		}
		return "none";
	}
}

class Tui {
	private inputLine: InputLine | null = null;
	private busy = true;
	private pendingChunks: Uint8Array[] = [];
	private readonly onData = (chunk: Uint8Array): void => {
		this.handleChunk(chunk);
	};

	start(): void {
		if (process.stdin.isTTY) {
			process.stdin.setRawMode(true);
		}
		process.stdin.on("data", this.onData);
	}

	stop(): void {
		if (process.stdin.isTTY) {
			process.stdin.setRawMode(false);
		}
	}

	private handleChunk(chunk: Uint8Array): void {
		if (this.busy) {
			// buffer keystrokes typed while the agent runs; replay when idle
			this.pendingChunks.push(chunk);
			return;
		}
		if (!this.inputLine) return;
		const result = this.inputLine.handle(chunk);
		if (result === "submitted") {
			const text = this.inputLine.submitted;
			this.inputLine = null;
			void this.onSubmit(text);
		} else if (result === "exit") {
			this.stop();
			outLine("");
			process.exit(0);
		}
	}

	setBusy(busy: boolean): void {
		this.busy = busy;
		if (!busy) {
			this.inputLine = new InputLine(`${CYAN}>${RESET} `);
			// replay buffered keystrokes from while the agent was streaming
			const buffered = this.pendingChunks;
			this.pendingChunks = [];
			for (const chunk of buffered) {
				this.handleChunk(chunk);
			}
		}
	}

	private async onSubmit(text: string): Promise<void> {
		this.setBusy(true);
		await runAgentTurn(text);
		this.setBusy(false);
	}
}

// ── agent wiring ────────────────────────────────────────────────────────────

// scriptc-port: dynamic system prompt — AGENTS.md/CLAUDE.md chain (cwd → root,
// plus ~/.pi/agent) is loaded and appended as <project_instructions>, matching
// pi's loadProjectContextFiles + buildSystemPrompt shape.
const CWD = process.cwd();
const contextFiles = loadProjectContextFiles(CWD);
const SYSTEM_PROMPT = buildSystemPrompt({ cwd: CWD, contextFiles });

function renderEvent(event: any): void {
	const type = event.type as string;
	if (type === "message_update") {
		const ev = event.assistantMessageEvent;
		if (ev.type === "text_delta") {
			streamedText = true;
			out(ev.delta);
		} else if (ev.type === "thinking_delta") {
			out(`${DIM}${ev.delta}${RESET}`);
		}
	} else if (type === "message_end") {
		if (event.message.role === "assistant") {
			// fallback: providers that emit no text deltas would otherwise
			// leave the final answer invisible
			if (!streamedText) {
				const blocks = event.message.content;
				if (typeof blocks === "object" && blocks !== null && typeof blocks.length === "number") {
					let text = "";
					for (let i = 0; i < blocks.length; i++) {
						const block = blocks[i];
						if (block.type === "text") text += block.text;
					}
					if (text.length > 0) outLine(text);
				}
			}
			streamedText = false;
			outLine("");
		}
	} else if (type === "tool_execution_start") {
		outLine(`${YELLOW}\u00b7 ${event.toolName} ${JSON.stringify(event.args).slice(0, 120)}${RESET}`);
	} else if (type === "tool_execution_end") {
		if (event.isError) outLine(`${RED}tool error${RESET}`);
		outLine(`${DIM}${truncate(toolResultText(event.result), 400)}${RESET}`);
	} else if (type === "turn_end") {
		outLine("");
	} else if (type === "agent_end") {
		const msg = event.messages[event.messages.length - 1];
		if (msg !== undefined && msg.role === "assistant") {
			const m = msg as { errorMessage?: string };
			if (m.errorMessage !== undefined) outLine(`${RED}error: ${m.errorMessage}${RESET}`);
		}
	}
}

function toolResultText(result: any): string {
	if (!result) return "";
	if (typeof result === "string") return result;
	const content = result.content;
	if (typeof content === "object" && content !== null && typeof content.length === "number") {
		let texts = "";
		for (const c of content) {
			texts += (texts ? "\n" : "") + (c.type === "text" ? (c.text ?? "") : `[${c.type}]`);
		}
		return texts;
	}
	return JSON.stringify(result).slice(0, 200);
}

function truncate(s: string, max: number): string {
	const flat = s.replace(/\n/g, "\n  ");
	if (flat.length <= max) return flat;
	return `${flat.slice(0, max)}…`;
}

let agent: Agent | null = null;
let streamedText = false;

async function runAgentTurn(userText: string): Promise<void> {
	if (!agent) return;
	try {
		await agent.prompt(userText);
	} catch (err) {
		outLine(`${RED}agent error: ${String(err)}${RESET}`);
	}
}

async function main(): Promise<number> {
	const args = process.argv.slice(2);
	const oneShotIndex = args.indexOf("-p");
	const oneShot = oneShotIndex !== -1 ? args[oneShotIndex + 1] : undefined;

	const selection = selectModel();
	outLine(`${BOLD}pi-min${RESET} ${DIM}— ${selection.providerId}/${selection.model.id}${RESET}`);
	if (contextFiles.length > 0) {
		for (let i = 0; i < contextFiles.length; i++) {
			outLine(`${DIM}context: ${contextFiles[i].path}${RESET}`);
		}
	}

	// Island boundary: AgentOptions/callbacks are dynamic values; only
	// primitives, JSON-safe records, and any-typed callbacks cross.
	agent = new Agent({
		streamFn: makeStreamFn(),
		initialState: {
			systemPrompt: SYSTEM_PROMPT,
			model: selection.model,
			tools: minimalTools,
		},
	});
	agent.subscribe((event) => {
		renderEvent(event);
	});

	if (oneShot !== undefined) {
		outLine(`${DIM}prompt: ${oneShot}${RESET}`);
		await runAgentTurn(oneShot);
		return 0;
	}

	outLine(`${DIM}ctrl+c to exit${RESET}`);
	const tui = new Tui();
	tui.start();
	tui.setBusy(false);
	await new Promise<void>(() => {
		// the TUI owns the process from here; ctrl+c exits via raw-mode handling
	});
	return 0;
}

main()
	.then((code) => {
		process.exit(code);
	})
	.catch((err) => {
		outLine(`${RED}fatal: ${String(err)}${RESET}`);
		process.exit(1);
	});
