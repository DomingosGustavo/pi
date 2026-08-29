/**
 * pi-ai-lite: minimal provider registry + non-streaming HTTP adapters.
 *
 * Replaces the island-served pi-ai provider layer for the scriptc port's
 * minimal build. Everything here is program source: the agent loop's
 * Model/Context/StreamFn types become statically compiled, which removes the
 * static/island boundary that made the Agent class uncompilable.
 *
 * MVP scope: anthropic-messages and openai-completions, non-streaming (the
 * provider response is delivered as a burst of synthetic stream events).
 * Streaming SSE, OAuth providers, Bedrock/Vertex, and the dynamic model
 * catalog come later — the Agent/StreamFn contract is unchanged, so they slot
 * in without touching the loop.
 */
import { AssistantMessageEventStream } from "./event-stream.ts";
import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	Tool,
	ToolCall,
	ToolResultMessage,
	Usage,
} from "./types.ts";

export interface LiteProvider {
	id: string;
	name: string;
	getModels(): Model<any>[];
}

export interface LiteModels {
	getProvider(id: string): LiteProvider | undefined;
	getProviders(): readonly LiteProvider[];
	getModel(provider: string, id: string): Model<any> | undefined;
	streamSimple(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function modelCost(
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number },
	usage: Usage,
): Usage["cost"] {
	const input = (usage.input / 1_000_000) * cost.input;
	const output = (usage.output / 1_000_000) * cost.output;
	const cacheRead = (usage.cacheRead / 1_000_000) * cost.cacheRead;
	const cacheWrite = (usage.cacheWrite / 1_000_000) * cost.cacheWrite;
	return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

function catalogModel(
	provider: string,
	api: string,
	baseUrl: string,
	id: string,
	name: string,
	contextWindow: number,
	maxTokens: number,
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number },
): Model<any> {
	return { id, name, api, provider, baseUrl, reasoning: false, input: ["text"], cost, contextWindow, maxTokens };
}

const ANTHROPIC_BASE = "https://api.anthropic.com";
const OPENAI_BASE = "https://api.openai.com/v1";

const ANTHROPIC_MODELS: Model<any>[] = [
	catalogModel(
		"anthropic",
		"anthropic-messages",
		ANTHROPIC_BASE,
		"claude-sonnet-4-5",
		"Claude Sonnet 4.5",
		200_000,
		64_000,
		{ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	),
	catalogModel(
		"anthropic",
		"anthropic-messages",
		ANTHROPIC_BASE,
		"claude-opus-4-5",
		"Claude Opus 4.5",
		200_000,
		64_000,
		{ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	),
	catalogModel(
		"anthropic",
		"anthropic-messages",
		ANTHROPIC_BASE,
		"claude-haiku-4-5",
		"Claude Haiku 4.5",
		200_000,
		64_000,
		{ input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	),
];

const OPENAI_MODELS: Model<any>[] = [
	catalogModel("openai", "openai-completions", OPENAI_BASE, "gpt-5.2", "GPT-5.2", 400_000, 128_000, {
		input: 1.25,
		output: 10,
		cacheRead: 0.125,
		cacheWrite: 0,
	}),
	catalogModel("openai", "openai-completions", OPENAI_BASE, "gpt-5.2-codex", "GPT-5.2 Codex", 400_000, 128_000, {
		input: 1.25,
		output: 10,
		cacheRead: 0.125,
		cacheWrite: 0,
	}),
	catalogModel("openai", "openai-completions", OPENAI_BASE, "gpt-5-mini", "GPT-5 Mini", 400_000, 128_000, {
		input: 0.25,
		output: 2,
		cacheRead: 0.025,
		cacheWrite: 0,
	}),
];

function makeProvider(id: string, name: string, models: Model<any>[]): LiteProvider {
	return { id, name, getModels: () => models.slice() };
}

export function createModels(): LiteModels {
	const providers: LiteProvider[] = [
		makeProvider("anthropic", "Anthropic", ANTHROPIC_MODELS),
		makeProvider("openai", "OpenAI", OPENAI_MODELS),
	];
	// scriptc: find() callbacks have no lowering — loops instead.
	const findProvider = (id: string): LiteProvider | undefined => {
		for (const p of providers) {
			if (p.id === id) return p;
		}
		return undefined;
	};
	const findModel = (providerId: string, modelId: string): Model<any> | undefined => {
		const provider = findProvider(providerId);
		if (provider === undefined) return undefined;
		for (const m of provider.getModels()) {
			if (m.id === modelId) return m;
		}
		return undefined;
	};
	return {
		getProvider: findProvider,
		getProviders: () => providers.slice(),
		getModel: findModel,
		streamSimple: (model, context, options) => streamRequest(model, context, options ?? {}),
	};
}

// ── request serialization ───────────────────────────────────────────────────

function textOf(content: string | (TextContent | { type: "image"; data: string; mimeType: string })[]): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") parts.push(block.text);
	}
	return parts.join("\n");
}

function toAnthropicMessages(messages: Message[]): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	for (const message of messages) {
		if (message.role === "user") {
			out.push({ role: "user", content: textOf(message.content) });
		} else if (message.role === "assistant") {
			const content: Array<Record<string, unknown>> = [];
			for (const block of message.content) {
				if (block.type === "text" && block.text.length > 0) {
					content.push({ type: "text", text: block.text });
				} else if (block.type === "toolCall") {
					content.push({ type: "tool_use", id: block.id, name: block.name, input: block.arguments });
				}
			}
			if (content.length > 0) out.push({ role: "assistant", content });
		} else {
			const toolResult: ToolResultMessage = message;
			out.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: toolResult.toolCallId,
						content: textOf(toolResult.content),
						is_error: toolResult.isError,
					},
				],
			});
		}
	}
	return out;
}

function toOpenAiMessages(systemPrompt: string, messages: Message[]): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	if (systemPrompt) out.push({ role: "system", content: systemPrompt });
	for (const message of messages) {
		if (message.role === "user") {
			out.push({ role: "user", content: textOf(message.content) });
		} else if (message.role === "assistant") {
			const toolCalls: Array<Record<string, unknown>> = [];
			let text = "";
			for (const block of message.content) {
				if (block.type === "text") text += (text ? "\n" : "") + block.text;
				if (block.type === "toolCall") {
					toolCalls.push({
						id: block.id,
						type: "function",
						function: { name: block.name, arguments: JSON.stringify(block.arguments) },
					});
				}
			}
			const entry: Record<string, unknown> = { role: "assistant", content: text || null };
			if (toolCalls.length > 0) entry.tool_calls = toolCalls;
			out.push(entry);
		} else {
			for (const block of message.content) {
				if (block.type === "text") {
					out.push({ role: "tool", tool_call_id: message.toolCallId, content: block.text });
				}
			}
		}
	}
	return out;
}

function toOpenAiTools(tools: Tool[]): any[] {
	return tools.map((tool) => ({
		type: "function",
		function: { name: tool.name, description: tool.description, parameters: tool.parameters },
	}));
}

function toAnthropicTools(tools: Tool[]): any[] {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		input_schema: tool.parameters,
	}));
}

// ── response parsing ────────────────────────────────────────────────────────

function parseAnthropicResponse(model: Model<any>, body: any): AssistantMessage {
	const content: (TextContent | ToolCall)[] = [];
	let stopReason: AssistantMessage["stopReason"] = "stop";
	for (const block of body.content ?? []) {
		if (block.type === "text") {
			content.push({ type: "text", text: block.text });
		} else if (block.type === "tool_use") {
			content.push({ type: "toolCall", id: block.id, name: block.name, arguments: block.input ?? {} });
			stopReason = "toolUse";
		}
	}
	const usage: Usage = {
		input: body.usage?.input_tokens ?? 0,
		output: body.usage?.output_tokens ?? 0,
		cacheRead: body.usage?.cache_read_input_tokens ?? 0,
		cacheWrite: body.usage?.cache_creation_input_tokens ?? 0,
		totalTokens: (body.usage?.input_tokens ?? 0) + (body.usage?.output_tokens ?? 0),
		cost: zeroUsage().cost,
	};
	usage.cost = modelCost(model.cost, usage);
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		responseModel: body.model,
		responseId: body.id,
		usage,
		stopReason,
		timestamp: Date.now(),
	};
}

function parseOpenAiResponse(model: Model<any>, body: any): AssistantMessage {
	const content: (TextContent | ToolCall)[] = [];
	let stopReason: AssistantMessage["stopReason"] = "stop";
	const choice = body.choices?.[0] ?? {};
	const message = choice.message ?? {};
	if (typeof message.content === "string" && message.content.length > 0) {
		content.push({ type: "text", text: message.content });
	}
	for (const call of message.tool_calls ?? []) {
		let args: Record<string, any> = {};
		try {
			args = JSON.parse(call.function?.arguments ?? "{}");
		} catch {
			args = {};
		}
		content.push({ type: "toolCall", id: call.id ?? "", name: call.function?.name ?? "", arguments: args });
		stopReason = "toolUse";
	}
	if (choice.finish_reason === "tool_calls") stopReason = "toolUse";
	const usageBody = body.usage ?? {};
	const usage: Usage = {
		input: usageBody.prompt_tokens ?? 0,
		output: usageBody.completion_tokens ?? 0,
		cacheRead: usageBody.prompt_tokens_details?.cached_tokens ?? 0,
		cacheWrite: 0,
		totalTokens: usageBody.total_tokens ?? 0,
		cost: zeroUsage().cost,
	};
	usage.cost = modelCost(model.cost, usage);
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		responseModel: body.model,
		responseId: body.id,
		usage,
		stopReason,
		timestamp: Date.now(),
	};
}

// ── the stream function ─────────────────────────────────────────────────────

function streamRequest(model: Model<any>, context: Context, options: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const apiKey = options.apiKey;
	if (!apiKey) {
		stream.push({
			type: "error",
			reason: "error",
			error: errorAssistantMessage(model, `No API key for provider '${model.provider}'`),
		});
		stream.end();
		return stream;
	}
	void runRequest(model, context, options, stream).catch((error: unknown) => {
		stream.push({ type: "error", reason: "error", error: errorAssistantMessage(model, String(error)) });
		stream.end();
	});
	return stream;
}

function errorAssistantMessage(model: Model<any>, message: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage(),
		stopReason: "error",
		errorMessage: message,
		timestamp: Date.now(),
	};
}

async function runRequest(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions,
	stream: AssistantMessageEventStream,
): Promise<void> {
	const empty: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage(),
		stopReason: "pending",
		timestamp: Date.now(),
	};
	stream.push({ type: "start", partial: empty });

	let response: any;
	let body: any;
	if (model.api === "anthropic-messages") {
		const requestBody: any = {
			model: model.id,
			max_tokens: options.maxTokens ?? Math.min(8_000, model.maxTokens),
			messages: toAnthropicMessages(context.messages),
		};
		if (context.systemPrompt) requestBody.system = context.systemPrompt;
		if (context.tools && context.tools.length > 0) requestBody.tools = toAnthropicTools(context.tools);
		const headers: Record<string, string> = {
			"content-type": "application/json",
			"x-api-key": options.apiKey ?? "",
			"anthropic-version": "2023-06-01",
		};
		const fetchResponse = await fetch(`${model.baseUrl}/v1/messages`, {
			method: "POST",
			headers,
			body: JSON.stringify(requestBody),
			signal: options.signal,
		});
		response = fetchResponse;
		body = await fetchResponse.json();
	} else {
		const requestBody: any = {
			model: model.id,
			messages: toOpenAiMessages(context.systemPrompt ?? "", context.messages),
		};
		if (context.tools && context.tools.length > 0) {
			requestBody.tools = toOpenAiTools(context.tools);
			requestBody.tool_choice = "auto";
		}
		const headers: Record<string, string> = {
			"content-type": "application/json",
			authorization: `Bearer ${options.apiKey ?? ""}`,
		};
		const fetchResponse = await fetch(`${model.baseUrl}/chat/completions`, {
			method: "POST",
			headers,
			body: JSON.stringify(requestBody),
			signal: options.signal,
		});
		response = fetchResponse;
		body = await fetchResponse.json();
	}

	if (!response.ok) {
		const detail = typeof body?.error?.message === "string" ? body.error.message : JSON.stringify(body).slice(0, 400);
		stream.push({
			type: "error",
			reason: "error",
			error: errorAssistantMessage(model, `HTTP ${response.status}: ${detail}`),
		});
		stream.end();
		return;
	}

	const finalMessage =
		model.api === "anthropic-messages" ? parseAnthropicResponse(model, body) : parseOpenAiResponse(model, body);
	for (const block of finalMessage.content) {
		if (block.type === "text") {
			stream.push({ type: "text_delta", contentIndex: 0, delta: block.text, partial: finalMessage });
		} else if (block.type === "toolCall") {
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial: finalMessage });
		}
	}
	stream.push({
		type: "done",
		reason: finalMessage.stopReason === "toolUse" ? "toolUse" : "stop",
		message: finalMessage,
	});
	stream.end(finalMessage);
}
