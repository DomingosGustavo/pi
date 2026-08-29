import type { AssistantMessage, AssistantMessageEvent } from "./types.ts";

// Generic event stream class.
//
// scriptc-port notes:
// - internal storage is untyped (`any`): the compiler rejects arrays of
//   functions whose parameter types instantiate library generics
//   (IteratorResult<T, any>), while plain `(value: any) => void` function
//   arrays lower fine (same shape as Agent.listeners);
// - no `[Symbol.asyncIterator]` / generator methods: computed method names
//   and generator methods have no lowering yet. The compiled loop consumes
//   `result()`. The generic type parameters are kept for typechecking hosts.
export class EventStream<T = any, R = any> {
	private queue: any[] = [];
	private waiting: Array<(value: any) => void> = [];
	private done = false;
	private finalResultPromise: Promise<any>;
	// scriptc: calling a function stored directly in a `this` field is not
	// lowered, but records containing functions are a supported shape.
	private deferred: { resolve: (value: any) => void } | undefined;
	private readonly isComplete: (event: any) => boolean;
	private readonly extractResult: (event: any) => any;

	constructor(isComplete: (event: any) => boolean, extractResult: (event: any) => any) {
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		this.finalResultPromise = new Promise((resolve) => {
			this.deferred = { resolve };
		});
	}

	private settle(value: any): void {
		const d = this.deferred;
		if (d !== undefined) d.resolve(value);
	}

	push(event: any): void {
		if (this.done) return;

		if (this.isComplete(event)) {
			this.done = true;
			this.settle(this.extractResult(event));
		}

		// Deliver to waiting consumer or queue it
		const waiter = this.waiting.shift();
		if (waiter !== undefined) {
			waiter({ value: event, done: false });
		} else {
			this.queue.push(event);
		}
	}

	end(result?: any): void {
		this.done = true;
		if (result !== undefined) {
			this.settle(result);
		}
		// Notify all waiting consumers that we're done
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift();
			if (waiter !== undefined) waiter({ value: undefined, done: true });
		}
	}

	result(): Promise<any> {
		return this.finalResultPromise;
	}
}

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event: AssistantMessageEvent) => event.type === "done" || event.type === "error",
			(event: AssistantMessageEvent) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}
