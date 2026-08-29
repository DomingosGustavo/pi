/**
 * pi-ai-lite: micro typebox shim.
 *
 * The minimal build only needs the schema *builder* (Type.*) and the TSchema /
 * Static types for tool parameter declarations. A full vendored typebox is
 * overkill, so this produces plain JSON-Schema objects (plus a `~optional`
 * marker consumed by Type.Object's `required` computation).
 *
 * The stager rewrites `import ... from "typebox"` to this module for the
 * staged tree, which makes the whole compiled graph island-free.
 */
import type { Tool, ToolCall } from "./types.ts";

export type TSchema = Record<string, unknown>;

// The real typebox computes Static<T> from the schema generics; the minimal
// build reads tool arguments as `any` at the boundary, so the static type is
// unconstrained here.
export type Static<T extends TSchema = TSchema> = Record<string, unknown>;

export type TLocalizedValidationError = { path?: string; message?: string };

interface SchemaOptions {
	description?: string;
	default?: unknown;
	[k: string]: unknown;
}

function withOptions(schema: Record<string, unknown>, options?: SchemaOptions): Record<string, unknown> {
	if (options === undefined) return schema;
	const out: Record<string, unknown> = { ...schema };
	for (const key of Object.keys(options)) {
		out[key] = options[key];
	}
	return out;
}

export const Type = {
	// Optional params mirror the real typebox builder signatures so the same
	// call sites typecheck against both.
	Object: (properties: Record<string, unknown>, options?: SchemaOptions): Record<string, unknown> => {
		const required: string[] = [];
		for (const key of Object.keys(properties)) {
			const prop = properties[key] as Record<string, unknown>;
			if (prop === null || prop["~optional"] !== true) required.push(key);
		}
		return withOptions({ type: "object", properties, required }, options);
	},
	String: (options?: SchemaOptions): Record<string, unknown> => withOptions({ type: "string" }, options),
	Number: (options?: SchemaOptions): Record<string, unknown> => withOptions({ type: "number" }, options),
	Boolean: (options?: SchemaOptions): Record<string, unknown> => withOptions({ type: "boolean" }, options),
	Optional: (schema: Record<string, unknown>): Record<string, unknown> => ({ ...schema, "~optional": true }),
};

/**
 * Minimal argument validation replacing typebox/compile + typebox/value:
 * pass-through. The tools in the minimal build coerce their own inputs
 * (Number/String conversions at the use sites), so schema validation is not
 * load-bearing here. Re-introduce real schema validation when the compiler
 * lowers the typebox surface (or vendored equivalents).
 */
export function validateToolArguments(tool: Tool, toolCall: ToolCall): Record<string, any> {
	const args: any = toolCall.arguments;
	if (args === null || typeof args !== "object") {
		throw new Error(`Validation failed for tool "${toolCall.name}": arguments must be an object`);
	}
	return args;
}
