import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGE_JSON = JSON.stringify(
	{
		name: "island-http-dispatcher",
		version: "1.0.0",
		type: "module",
		main: "index.js",
		types: "index.d.ts",
	},
	null,
	2,
);

const INDEX_JS = `import { EventEmitter } from "node:events";
import * as undici from "undici";

const ignoreUndiciDispatcherError = () => {};

export function withUndiciErrorListener(dispatcher) {
	if (dispatcher instanceof EventEmitter) EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
	return dispatcher;
}

export function createUndiciClient(origin, options) {
	return withUndiciErrorListener(new undici.Client(origin, options));
}

export function createUndiciOriginDispatcher(origin, options) {
	if (options.connections === 1) return createUndiciClient(origin, options);
	return withUndiciErrorListener(new undici.Pool(origin, { ...options, factory: createUndiciClient }));
}
`;

const INDEX_DTS = `import type { Dispatcher } from "undici";

export declare function withUndiciErrorListener(dispatcher: Dispatcher): Dispatcher;
export declare function createUndiciClient(origin: string | URL, options: object): Dispatcher;
export declare function createUndiciOriginDispatcher(origin: string | URL, options: object): Dispatcher;
`;

function replaceExpected(source, file, oldText, newText) {
	if (!source.includes(oldText)) {
		throw new Error(`scriptc-stage-http: expected marker missing in ${file}: ${oldText}`);
	}
	if (source.indexOf(oldText) !== source.lastIndexOf(oldText)) {
		throw new Error(`scriptc-stage-http: expected marker is not unique in ${file}: ${oldText}`);
	}
	return source.replace(oldText, newText);
}

export function stageHttp(OUT) {
	const packageDir = join(OUT, "node_modules/island-http-dispatcher");
	mkdirSync(packageDir, { recursive: true });
	writeFileSync(join(packageDir, "package.json"), `${PACKAGE_JSON}\n`);
	writeFileSync(join(packageDir, "index.js"), INDEX_JS);
	writeFileSync(join(packageDir, "index.d.ts"), INDEX_DTS);

	const httpDispatcherPath = join(OUT, "packages/coding-agent/src/core/http-dispatcher.ts");
	let source = readFileSync(httpDispatcherPath, "utf8");
	source = replaceExpected(source, httpDispatcherPath, 'import { EventEmitter } from "node:events";\n', "");
	source = replaceExpected(
		source,
		httpDispatcherPath,
		"const originalGlobalFetch = globalThis.fetch;\nlet installedGlobalFetch: typeof globalThis.fetch | undefined;\n",
		"",
	);

	const blockStart = "const ignoreUndiciDispatcherError";
	const blockEnd = "export function configureHttpDispatcher";
	const start = source.indexOf(blockStart);
	const end = source.indexOf(blockEnd, start);
	if (start === -1 || end === -1 || end <= start) {
		throw new Error(`scriptc-stage-http: expected dispatcher helper block missing in ${httpDispatcherPath}`);
	}
	if (source.indexOf(blockStart, start + blockStart.length) !== -1) {
		throw new Error(`scriptc-stage-http: dispatcher helper start is not unique in ${httpDispatcherPath}`);
	}
	const helperImport =
		'import { createUndiciClient, createUndiciOriginDispatcher, withUndiciErrorListener } from "island-http-dispatcher";\n\n';
	source = source.slice(0, start) + helperImport + source.slice(end);

	const fetchGuardStart = "\tconst shouldInstallGlobals =";
	const fetchGuardEnd = "\n\t}\n}";
	const guardStart = source.indexOf(fetchGuardStart);
	const guardEnd = source.indexOf(fetchGuardEnd, guardStart);
	if (guardStart === -1 || guardEnd === -1) {
		throw new Error(`scriptc-stage-http: expected fetch install guard missing in ${httpDispatcherPath}`);
	}
	if (source.indexOf(fetchGuardStart, guardStart + fetchGuardStart.length) !== -1) {
		throw new Error(`scriptc-stage-http: fetch install guard is not unique in ${httpDispatcherPath}`);
	}
	source = `${source.slice(0, guardStart)}\tundici.install?.();${source.slice(guardEnd + "\n\t}".length)}`;
	writeFileSync(httpDispatcherPath, source);
}
