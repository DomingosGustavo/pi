import type { SpanOptions, TelemetryContext, TelemetrySpan } from "./index.ts";

function startNoopSpan<T>(_options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
	try {
		return Promise.resolve(callback(noopTelemetrySpan));
	} catch (error) {
		return Promise.reject(error);
	}
}

// scriptc: Object.freeze of a possibly-aliased value has no lowering (SC2020);
// freezing the literal in place is equivalent.
const noopTelemetrySpan: TelemetrySpan = Object.freeze({
	startSpan: startNoopSpan,
	addEvent: () => {},
	setAttributes: () => {},
	setStatus: () => {},
});

/** Shared telemetry context used when an application does not provide one. */
export const NOOP_TELEMETRY_CONTEXT: TelemetryContext = noopTelemetrySpan;
