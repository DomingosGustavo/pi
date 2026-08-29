/**
 * pi-ai-lite: static type surface for the scriptc port's minimal graph.
 *
 * These are the pi-ai types the agent loop / tools consume, declared locally so
 * that no type in the compiled program originates from an island-served
 * package. Shapes mirror packages/ai/src/types.ts (subset).
 */
import type { TSchema } from "./typebox.ts";

export type KnownApi = "anthropic-messages" | "openai-completions" | "openai-responses" | "google-generative-ai";
export type Api = string;
export type ProviderId = string;
export type ToolChoice = "auto" | "none";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";
export type ProviderEnv = Record<string, string | undefined>;

export interface ThinkingBudgets {
	off?: number;
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
	xhigh?: number;
	max?: number;
}

export interface TelemetryContext {
	readonly [attribute: string]: unknown;
}

export interface AssistantMessageDiagnostic {
	severity: "info" | "warning" | "error";
	message: string;
}

export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	redacted?: boolean;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, any>;
	thoughtSignature?: string;
	namespace?: string;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
	reasoning?: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface DeferredHandle {
	provider: string;
	modelId: string;
	api: string;
	id: string;
	expiresAt?: number;
	pollAfterMs?: number;
	data?: JsonValue;
}

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: Api;
	provider: ProviderId;
	model: string;
	responseModel?: string;
	responseId?: string;
	diagnostics?: AssistantMessageDiagnostic[];
	usage: Usage;
	stopReason: StopReason;
	deferred?: DeferredHandle;
	errorMessage?: string;
	rawStopReason?: string;
	endTurn?: boolean;
	timestamp: number;
}

export interface ToolResultMessage<TDetails = unknown> {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	details?: TDetails;
	usage?: Usage;
	addedToolNames?: string[];
	isError: boolean;
	timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| {
			type: "done";
			reason: Extract<StopReason, "stop" | "length" | "toolUse" | "deferred">;
			message: AssistantMessage;
	  }
	| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

export interface Tool<TParameters extends TSchema = TSchema> {
	name: string;
	description: string;
	// scriptc-port note: declared as TSchema (not TParameters) — a generic
	// member instantiated with `any` (AgentTool<any>) any-izes the whole record
	// transitively in the compiled graph.
	parameters: TSchema;
}

export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}

export interface ModelCostRates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface ModelCost extends ModelCostRates {}

export interface Model<TApi extends Api = Api> {
	id: string;
	name: string;
	// scriptc-port note: Api, not TApi — same any-instantiation concern.
	api: Api;
	provider: ProviderId;
	baseUrl: string;
	reasoning: boolean;
	thinkingLevelMap?: Partial<Record<string, string | null>>;
	input: ("text" | "image")[];
	cost: ModelCost;
	contextWindow: number;
	maxTokens: number;
	samplingParams?: Record<string, unknown>;
	headers?: Record<string, string>;
}

export interface ProviderResponse {
	status: number;
	headers: Record<string, string>;
}

// scriptc-port note: non-generic — generic interface chains made the derived
// config types dynamic in the compiled graph.
export interface ProviderRequestOptions {
	signal?: AbortSignal;
	telemetryContext?: TelemetryContext;
	apiKey?: string;
	fetch?: unknown;
	env?: ProviderEnv;
	onPayload?: (payload: unknown, model: Model) => unknown | undefined | Promise<unknown | undefined>;
	onResponse?: (response: ProviderResponse, model: Model) => void | Promise<void>;
	headers?: Record<string, string | null>;
	timeoutMs?: number;
	maxRetries?: number;
	maxRetryDelayMs?: number;
}

export interface StreamOptions extends ProviderRequestOptions {
	temperature?: number;
	samplingParams?: Record<string, unknown>;
	maxTokens?: number;
	transport?: Transport;
}

export interface SimpleStreamOptions extends StreamOptions {
	toolChoice?: ToolChoice;
	reasoning?: ThinkingLevel;
	thinkingBudgets?: ThinkingBudgets;
	/** Session identifier forwarded to providers for cache-aware backends. */
	sessionId?: string;
}

export interface ModelsSimpleStreamOptions extends SimpleStreamOptions {}
