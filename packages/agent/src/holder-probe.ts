import type { AgentOptions } from "./agent.ts";
import type { AgentMessage, StreamFn } from "./types.ts";

export class Holder {
	public onResponse?: (response: { headers: Record<string, string>; status: number }, model: any) => void | Promise<void>;
	public transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	public streamFunction: StreamFn;
	constructor(options: AgentOptions) {
		this.onResponse = options.onResponse;
		this.transformContext = options.transformContext;
		this.streamFunction = options.streamFn !== undefined ? options.streamFn : getDefault();
	}
}

function getDefault(): StreamFn {
	throw new Error("no default");
}
