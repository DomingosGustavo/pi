import type {
	Context,
	ImageContent,
	ProviderResponse,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	ThinkingBudgets,
	Transport,
} from "@earendil-works/pi-ai";
import {
	buildProviderContext as buildProviderContextFromAgentContext,
	runAgentLoop,
	runAgentLoopContinue,
} from "./agent-loop.ts";
import { getDefaultStreamFn } from "./stream-fn.ts";
import type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentLoopTurnUpdate,
	AgentMessage,
	AgentState,
	AgentTool,
	BeforeToolCallContext,
	BeforeToolCallResult,
	PrepareNextTurnContext,
	QueueMode,
	ShouldStopAfterTurnContext,
	StreamFn,
	ThinkingLevel,
	ToolExecutionMode,
} from "./types.ts";

export type { QueueMode } from "./types.ts";

/** scriptc: `error instanceof Error` is unsupported (builtin right-hand side);
 * duck-type the message instead — behaviour is identical for Error values. */
function errorMessageOf(error: unknown): string {
	if (typeof error === "object" && error !== null) {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string") return message;
	}
	return String(error);
}

function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	);
}

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const DEFAULT_MODEL: Model<any> = {
	id: "unknown",
	name: "unknown",
	api: "unknown",
	provider: "unknown",
	baseUrl: "",
	reasoning: false,
	input: [],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 0,
	maxTokens: 0,
};

/** scriptc-port note: explicit interface — the old
 * `Omit<AgentState, ...> & {...}` mapped-type form resolved loosely in the
 * compiled graph (members gained `| undefined` arms and any-ized the state). */
interface MutableAgentState {
	systemPrompt: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	tools: AgentTool[];
	messages: AgentMessage[];
	isStreaming: boolean;
	streamingMessage?: AgentMessage;
	// Array, not Set: scriptc has no lowering for the Set copy-constructor, and
	// Sets of strings do not survive the static/island record boundary.
	pendingToolCalls: string[];
	errorMessage?: string;
}

/** Writable initial-state subset of {@link AgentState}. */
export interface AgentStateInit {
	systemPrompt?: string;
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	tools?: AgentTool[];
	messages?: AgentMessage[];
}


/**
 * Read/write view over the mutable state exposed through {@link Agent.state}.
 *
 * A class (not accessor properties in the state literal): scriptc rejects set
 * accessors in object literals, while class accessors lower fine. Assigning
 * `state.tools` / `state.messages` copies the provided top-level array, as the
 * AgentState contract documents.
 */
class AgentStateView implements AgentState {
	private readonly mutable: MutableAgentState;
	constructor(mutable: MutableAgentState) {
		this.mutable = mutable;
	}
	get systemPrompt(): string {
		return this.mutable.systemPrompt;
	}
	set systemPrompt(value: string) {
		this.mutable.systemPrompt = value;
	}
	get model(): Model<any> {
		return this.mutable.model;
	}
	set model(value: Model<any>) {
		this.mutable.model = value;
	}
	get thinkingLevel(): import("./types.ts").ThinkingLevel {
		return this.mutable.thinkingLevel;
	}
	set thinkingLevel(value: import("./types.ts").ThinkingLevel) {
		this.mutable.thinkingLevel = value;
	}
	set tools(tools: AgentTool<any>[]) {
		this.mutable.tools = tools.slice();
	}
	get tools(): AgentTool<any>[] {
		return this.mutable.tools;
	}
	set messages(messages: AgentMessage[]) {
		this.mutable.messages = messages.slice();
	}
	get messages(): AgentMessage[] {
		return this.mutable.messages;
	}
	get isStreaming(): boolean {
		return this.mutable.isStreaming;
	}
	get streamingMessage(): AgentMessage | undefined {
		return this.mutable.streamingMessage;
	}
	get pendingToolCalls(): readonly string[] {
		return this.mutable.pendingToolCalls;
	}
	get errorMessage(): string | undefined {
		return this.mutable.errorMessage;
	}
}

function createMutableAgentState(initialState: AgentStateInit | undefined): MutableAgentState {
	// scriptc: chained optional calls resolve to `any` — narrow with ifs.
	let tools: AgentTool<any>[] = [];
	if (initialState !== undefined && initialState.tools !== undefined) {
		tools = initialState.tools.slice();
	}
	let messages: AgentMessage[] = [];
	if (initialState !== undefined && initialState.messages !== undefined) {
		messages = initialState.messages.slice();
	}
	return {
		systemPrompt: initialState === undefined ? "" : initialState.systemPrompt === undefined ? "" : initialState.systemPrompt,
		model: initialState === undefined || initialState.model === undefined ? DEFAULT_MODEL : initialState.model,
		thinkingLevel: initialState === undefined || initialState.thinkingLevel === undefined ? "off" : initialState.thinkingLevel,
		tools,
		messages,
		isStreaming: false,
		streamingMessage: undefined,
		pendingToolCalls: [],
		errorMessage: undefined,
	};
}

/** Options for constructing an {@link Agent}. */
export interface AgentOptions {
	initialState?: AgentStateInit;
	// scriptc-port note: always-promise (sync-or-async union not compilable).
	convertToLlm?: (messages: AgentMessage[]) => Promise<Message[]>;
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	streamFn: StreamFn;
	getApiKey?: (provider: string) => Promise<string | undefined>;
	// scriptc-port note: spelled out (indexed-access types on imported
	// interfaces resolve loosely in the compiled graph).
	onPayload?: (payload: unknown, model: Model<any>) => unknown | undefined | Promise<unknown | undefined>;
	onResponse?: (response: ProviderResponse, model: Model<any>) => void | Promise<void>;
	// Callback option types are Promise-returning to match the stored fields
	// (scriptc-port normalization; every consumer awaits these).
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
	shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext, signal?: AbortSignal) => Promise<boolean>;
	prepareNextTurn?: (signal?: AbortSignal) => Promise<AgentLoopTurnUpdate | undefined>;
	prepareNextTurnWithContext?: (
		context: PrepareNextTurnContext,
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined>;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	sessionId?: string;
	thinkingBudgets?: ThinkingBudgets;
	transport?: Transport;
	maxRetryDelayMs?: number;
	toolExecution?: ToolExecutionMode;
}

class PendingMessageQueue {
	private messages: AgentMessage[] = [];
	public mode: QueueMode;

	constructor(mode: QueueMode) {
		this.mode = mode;
	}

	enqueue(message: AgentMessage): void {
		this.messages.push(message);
	}

	hasItems(): boolean {
		return this.messages.length > 0;
	}

	drain(): AgentMessage[] {
		if (this.mode === "all") {
			const drained = this.messages.slice();
			this.messages = [];
			return drained;
		}

		const first = this.messages[0];
		if (!first) {
			return [];
		}
		this.messages = this.messages.slice(1);
		return [first];
	}

	clear(): void {
		this.messages = [];
	}
}

type ActiveRun = {
	promise: Promise<void>;
	resolve: () => void;
	abortController: AbortController;
};

/**
 * Stateful wrapper around the low-level agent loop.
 *
 * `Agent` owns the current transcript, emits lifecycle events, executes tools,
 * and exposes queueing APIs for steering and follow-up messages.
 */
export class Agent {
	private _state: MutableAgentState;
	// Array, not Set: scriptc (the compiler for the native scriptc-port binary)
	// limits Set elements to numbers and strings, but arrays of functions are a
	// supported shape. Semantics are preserved — subscribe/unsubscribe and
	// listener order behave identically; only duplicate registration of the same
	// function object is no longer deduplicated, which pi never relied on.
	private readonly listeners: Array<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void> = [];
	private readonly steeringQueue: PendingMessageQueue;
	private readonly followUpQueue: PendingMessageQueue;

	// Fields below store Promise-returning callbacks: the scriptc port
	// constructs Agent from code that also touches island (dynamically-served)
	// modules, and sync-or-async union returns are not representable across that
	// boundary. Every consumer awaits these callbacks, so behaviour is
	// unchanged; sync callbacks are wrapped into async ones in the constructor.
	public convertToLlm: (messages: AgentMessage[]) => Promise<Message[]>;
	public transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	public streamFunction: StreamFn;
	// Stored Promise-returning: the scriptc port constructs Agent from code that
	// also touches island (dynamically-served) modules, and a sync-or-async union
	// return is not representable across that boundary. The only consumer
	// (agent-loop.ts) awaits the result, so behaviour is unchanged; sync
	// callbacks are wrapped into async ones here.
	public getApiKey?: (provider: string) => Promise<string | undefined>;
	public onPayload?: SimpleStreamOptions["onPayload"];
	public onResponse?: SimpleStreamOptions["onResponse"];
	public beforeToolCall?: (
		context: BeforeToolCallContext,
		signal?: AbortSignal,
	) => Promise<BeforeToolCallResult | undefined>;
	public afterToolCall?: (
		context: AfterToolCallContext,
		signal?: AbortSignal,
	) => Promise<AfterToolCallResult | undefined>;
	public shouldStopAfterTurn?: (
		context: ShouldStopAfterTurnContext,
		signal?: AbortSignal,
	) => Promise<boolean>;
	public prepareNextTurn?: (
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined>;
	public prepareNextTurnWithContext?: (
		context: PrepareNextTurnContext,
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined>;
	private activeRun?: ActiveRun;
	private stateView?: AgentStateView;
	/** Session identifier forwarded to providers for cache-aware backends. */
	public sessionId?: string;
	/** Optional per-level thinking token budgets forwarded to the stream function. */
	public thinkingBudgets?: ThinkingBudgets;
	/** Preferred transport forwarded to the stream function. */
	public transport: Transport;
	/** Optional cap for provider-requested retry delays. */
	public maxRetryDelayMs?: number;
	/** Tool execution strategy for assistant messages that contain multiple tool calls. */
	public toolExecution: ToolExecutionMode;

	constructor(options: AgentOptions) {
		// scriptc-port note: fields are read without optional chaining — `?.`
		// results resolve to `any` in the compiled graph, which then rejects the
		// static field assignments below. `options` is a required parameter.
		this._state = createMutableAgentState(options.initialState);
		this.convertToLlm = async (messages: AgentMessage[]): Promise<Message[]> => {
			if (options.convertToLlm !== undefined) return options.convertToLlm(messages);
			return defaultConvertToLlm(messages);
		};
		this.transformContext = options.transformContext;
		this.streamFunction = options.streamFn !== undefined ? options.streamFn : getDefaultStreamFn();
		this.getApiKey = options.getApiKey;
		this.onPayload = options.onPayload;
		this.onResponse = options.onResponse;
		this.beforeToolCall = options.beforeToolCall;
		this.afterToolCall = options.afterToolCall;
		this.shouldStopAfterTurn = options.shouldStopAfterTurn;
		this.prepareNextTurn = options.prepareNextTurn;
		this.prepareNextTurnWithContext = options.prepareNextTurnWithContext;
		this.steeringQueue = new PendingMessageQueue(options.steeringMode ?? "one-at-a-time");
		this.followUpQueue = new PendingMessageQueue(options.followUpMode ?? "one-at-a-time");
		this.sessionId = options.sessionId;
		this.thinkingBudgets = options.thinkingBudgets;
		this.transport = options.transport ?? "auto";
		this.maxRetryDelayMs = options.maxRetryDelayMs;
		this.toolExecution = options.toolExecution ?? "parallel";
	}

	/**
	 * Subscribe to agent lifecycle events.
	 *
	 * Listener promises are awaited in subscription order and are included in
	 * the current run's settlement. Listeners also receive the active abort
	 * signal for the current run.
	 *
	 * `agent_end` is the final emitted event for a run, but the agent does not
	 * become idle until all awaited listeners for that event have settled.
	 */
	subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
		this.listeners.push(listener);
		return () => {
			const index = this.listeners.indexOf(listener);
			if (index !== -1) this.listeners.splice(index, 1);
		};
	}

	/**
	 * Current agent state.
	 *
	 * Assigning `state.tools` or `state.messages` copies the provided top-level array.
	 */
	get state(): AgentState {
		if (this.stateView === undefined) this.stateView = new AgentStateView(this._state);
		return this.stateView;
	}

	/** Build a provider context through the same transform and conversion pipeline used by agent requests. */
	async buildProviderContext(context: AgentContext, signal?: AbortSignal): Promise<Context> {
		return buildProviderContextFromAgentContext(
			context,
			{
				convertToLlm: this.convertToLlm,
				transformContext: this.transformContext ?? (async (messages: AgentMessage[]) => messages),
			},
			signal,
		);
	}

	/** Controls how queued steering messages are drained. */
	set steeringMode(mode: QueueMode) {
		this.steeringQueue.mode = mode;
	}

	get steeringMode(): QueueMode {
		return this.steeringQueue.mode;
	}

	/** Controls how queued follow-up messages are drained. */
	set followUpMode(mode: QueueMode) {
		this.followUpQueue.mode = mode;
	}

	get followUpMode(): QueueMode {
		return this.followUpQueue.mode;
	}

	/** Queue a message to be injected after the current assistant turn finishes. */
	steer(message: AgentMessage): void {
		this.steeringQueue.enqueue(message);
	}

	/** Queue a message to run only after the agent would otherwise stop. */
	followUp(message: AgentMessage): void {
		this.followUpQueue.enqueue(message);
	}

	/** Remove all queued steering messages. */
	clearSteeringQueue(): void {
		this.steeringQueue.clear();
	}

	/** Remove all queued follow-up messages. */
	clearFollowUpQueue(): void {
		this.followUpQueue.clear();
	}

	/** Remove all queued steering and follow-up messages. */
	clearAllQueues(): void {
		this.clearSteeringQueue();
		this.clearFollowUpQueue();
	}

	/** Returns true when either queue still contains pending messages. */
	hasQueuedMessages(): boolean {
		return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
	}

	/** Active abort signal for the current run, if any. */
	get signal(): AbortSignal | undefined {
		return this.activeRun?.abortController.signal;
	}

	/** Abort the current run, if one is active. */
	abort(): void {
		this.activeRun?.abortController.abort();
	}

	/**
	 * Resolve when the current run and all awaited event listeners have finished.
	 *
	 * This resolves after `agent_end` listeners settle.
	 */
	waitForIdle(): Promise<void> {
		return this.activeRun?.promise ?? Promise.resolve();
	}

	/** Clear transcript state, runtime state, and queued messages. */
	reset(): void {
		if (this.activeRun) {
			throw new Error("Agent is already processing. Wait for completion before resetting.");
		}

		this._state.messages = [];
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = [];
		this._state.errorMessage = undefined;
		this.clearFollowUpQueue();
		this.clearSteeringQueue();
	}

	/** Start a new prompt from text, a single message, or a batch of messages. */
	async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
	async prompt(input: string, images?: ImageContent[]): Promise<void>;
	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
		if (this.activeRun) {
			throw new Error(
				"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
			);
		}
		const messages = this.normalizePromptInput(input, images);
		await this.runPromptMessages(messages);
	}

	/** Continue from the current transcript. The last message must be a user or tool-result message. */
	async continue(): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing. Wait for completion before continuing.");
		}

		const lastMessage = this._state.messages[this._state.messages.length - 1];
		if (!lastMessage) {
			throw new Error("No messages to continue from");
		}

		if (lastMessage.role === "assistant") {
			const queuedSteering = this.steeringQueue.drain();
			if (queuedSteering.length > 0) {
				await this.runPromptMessages(queuedSteering, { skipInitialSteeringPoll: true });
				return;
			}

			const queuedFollowUps = this.followUpQueue.drain();
			if (queuedFollowUps.length > 0) {
				await this.runPromptMessages(queuedFollowUps);
				return;
			}

			throw new Error("Cannot continue from message role: assistant");
		}

		await this.runContinuation();
	}

	private normalizePromptInput(
		input: string | AgentMessage | AgentMessage[],
		images?: ImageContent[],
	): AgentMessage[] {
		// scriptc: neither Array.isArray nor `instanceof Array` (builtin
		// right-hand side) is supported, and `in` needs record-typed receivers —
		// duck-type arrays via an optional `length` property.
		if (typeof input === "object" && input !== null) {
			const asLength = input as { length?: number };
			if (typeof asLength.length === "number") {
				return input as AgentMessage[];
			}
			return [input as AgentMessage];
		}

		if (typeof input !== "string") {
			return [input];
		}

		const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
		if (images !== undefined && images.length > 0) {
			for (const image of images) content.push(image);
		}
		return [{ role: "user", content, timestamp: Date.now() }];
	}

	private async runPromptMessages(
		messages: AgentMessage[],
		options: { skipInitialSteeringPoll?: boolean } = {},
	): Promise<void> {
		await this.runWithLifecycle(async (signal) => {
			await runAgentLoop(
				messages,
				this.createContextSnapshot(),
				this.createLoopConfig(options),
				(event) => this.processEvents(event),
				signal,
				this.streamFunction,
			);
		});
	}

	private async runContinuation(): Promise<void> {
		await this.runWithLifecycle(async (signal) => {
			await runAgentLoopContinue(
				this.createContextSnapshot(),
				this.createLoopConfig(),
				(event) => this.processEvents(event),
				signal,
				this.streamFunction,
			);
		});
	}

	private createContextSnapshot(): AgentContext {
		return {
			systemPrompt: this._state.systemPrompt,
			messages: this._state.messages.slice(),
			tools: this._state.tools.slice(),
		};
	}

	private createLoopConfig(options: { skipInitialSteeringPoll?: boolean } = {}): AgentLoopConfig {
		let skipInitialSteeringPoll = options.skipInitialSteeringPoll === true;
		const shouldStopAfterTurn = this.shouldStopAfterTurn;
		return {
			model: this._state.model,
			reasoning: this._state.thinkingLevel === "off" ? undefined : this._state.thinkingLevel,
			transformContext: this.transformContext ?? (async (messages: AgentMessage[]) => messages),
			sessionId: this.sessionId,
			onPayload: this.onPayload,
			onResponse: this.onResponse,
			transport: this.transport,
			thinkingBudgets: this.thinkingBudgets,
			maxRetryDelayMs: this.maxRetryDelayMs,
			toolExecution: this.toolExecution,
			beforeToolCall: this.beforeToolCall,
			afterToolCall: this.afterToolCall,
			shouldStopAfterTurn: shouldStopAfterTurn
				? async (context: ShouldStopAfterTurnContext): Promise<boolean> =>
						shouldStopAfterTurn(context, this.signal)
				: undefined,
			prepareNextTurn:
				this.prepareNextTurnWithContext !== undefined || this.prepareNextTurn !== undefined
					? async (context: PrepareNextTurnContext): Promise<AgentLoopTurnUpdate | undefined> => {
							if (this.prepareNextTurnWithContext !== undefined) {
								return this.prepareNextTurnWithContext(context, this.signal);
							}
							const next = this.prepareNextTurn;
							return next !== undefined ? next(this.signal) : undefined;
						}
					: undefined,
			convertToLlm: this.convertToLlm,
			getApiKey: this.getApiKey,
			getSteeringMessages: async () => {
				if (skipInitialSteeringPoll) {
					skipInitialSteeringPoll = false;
					return [];
				}
				return this.steeringQueue.drain();
			},
			getFollowUpMessages: async () => this.followUpQueue.drain(),
		};
	}

	private async runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing.");
		}

		const abortController = new AbortController();
		let resolvePromise = () => {};
		const promise = new Promise<void>((resolve) => {
			resolvePromise = resolve;
		});
		this.activeRun = { promise, resolve: resolvePromise, abortController };

		this._state.isStreaming = true;
		this._state.streamingMessage = undefined;
		this._state.errorMessage = undefined;

		try {
			await executor(abortController.signal);
		} catch (error) {
			await this.handleRunFailure(error, abortController.signal.aborted);
		} finally {
			this.finishRun();
		}
	}

	private async handleRunFailure(error: unknown, aborted: boolean): Promise<void> {
		const failureMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: this._state.model.api,
			provider: this._state.model.provider,
			model: this._state.model.id,
			usage: EMPTY_USAGE,
			stopReason: aborted ? "aborted" : "error",
			errorMessage: errorMessageOf(error),
			timestamp: Date.now(),
		} satisfies AgentMessage;
		await this.processEvents({ type: "message_start", message: failureMessage });
		await this.processEvents({ type: "message_end", message: failureMessage });
		await this.processEvents({ type: "turn_end", message: failureMessage, toolResults: [] });
		await this.processEvents({ type: "agent_end", messages: [failureMessage] });
	}

	private finishRun(): void {
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = [];
		this.activeRun?.resolve();
		this.activeRun = undefined;
	}

	/**
	 * Reduce internal state for a loop event, then await listeners.
	 *
	 * `agent_end` only means no further loop events will be emitted. The run is
	 * considered idle later, after all awaited listeners for `agent_end` finish
	 * and `finishRun()` clears runtime-owned state.
	 */
	private async processEvents(event: AgentEvent): Promise<void> {
		switch (event.type) {
			case "message_start":
				this._state.streamingMessage = event.message;
				break;

			case "message_update":
				this._state.streamingMessage = event.message;
				break;

			case "message_end":
				this._state.streamingMessage = undefined;
				this._state.messages.push(event.message);
				break;

			case "tool_execution_start": {
				const pendingToolCalls = this._state.pendingToolCalls;
				if (!pendingToolCalls.includes(event.toolCallId)) pendingToolCalls.push(event.toolCallId);
				break;
			}

			case "tool_execution_end": {
				const pendingToolCalls = this._state.pendingToolCalls;
				const doneIndex = pendingToolCalls.indexOf(event.toolCallId);
				if (doneIndex !== -1) pendingToolCalls.splice(doneIndex, 1);
				break;
			}

			case "turn_end":
				if (event.message.role === "assistant" && event.message.errorMessage) {
					this._state.errorMessage = event.message.errorMessage;
				}
				break;

			case "agent_end":
				this._state.streamingMessage = undefined;
				break;
		}

		const signal = this.activeRun?.abortController.signal;
		if (!signal) {
			throw new Error("Agent listener invoked outside active run");
		}
		for (const listener of this.listeners) {
			await listener(event, signal);
		}
	}
}
