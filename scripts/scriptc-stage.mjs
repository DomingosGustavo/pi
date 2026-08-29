#!/usr/bin/env node
/**
 * Stage pi's sources for a scriptc build.
 *
 * scriptc does not adopt tsconfig "paths", so `@earendil-works/pi-*` imports resolve
 * through node_modules to each package's built dist JS. That makes every workspace
 * package an opaque npm package served by the --dynamic island, and the island boundary
 * is contagious at the TYPE level: island-typed values lose static stdlib lowerings,
 * cannot be subclassed (SC1090), and cannot width-coerce (SC2002).
 *
 * Every workspace package compiles cleanly from source on its own:
 *   tui 95% · agent 93% · ai 90% · telemetry 88% · protocol 78% · client 100%  (0 errors each)
 *
 * So we copy the sources into a staging tree and rewrite workspace specifiers to
 * relative paths, making them ordinary program modules. Nothing is removed or stubbed —
 * this is purely a resolution change, so no runtime feature is lost.
 *
 * pi's own build is untouched: it still compiles the real packages/ tree.
 *
 *   node scripts/scriptc-stage.mjs [--out .scriptc-stage]
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { stageHttp } from "./scriptc-stage-http.mjs";
import { stageLazy } from "./scriptc-stage-lazy.mjs";
import { stageText } from "./scriptc-stage-text.mjs";

const ROOT = resolve(dirname(process.argv[1]), "..");
const outArg = process.argv.indexOf("--out");
const OUT = resolve(ROOT, outArg === -1 ? ".scriptc-stage" : process.argv[outArg + 1]);

// Packages to LEAVE as package imports (served by the --dynamic island) instead of
// staging them as program source. Islanding keeps a package's real JS running, so no
// feature is lost — it trades static compilation for the island's engine.
//   e.g. --island @earendil-works/pi-ai
// pi-ai is the natural candidate: compiled as source it contributes ~500 of 564
// diagnostics (provider SDKs are `any`-heavy streaming code), versus ~60 for the rest.
const islandArg = process.argv.indexOf("--island");
const ISLAND = new Set(islandArg === -1 ? [] : process.argv[islandArg + 1].split(",").map((s) => s.trim()));
const isIslanded = (spec) => [...ISLAND].some((p) => spec === p || spec.startsWith(`${p}/`));

/** package name -> directory holding its src (relative to repo root) */
const PKG_DIRS = {
	"@earendil-works/pi-tui": "packages/tui",
	"@earendil-works/pi-ai": "packages/ai",
	"@earendil-works/pi-agent-core": "packages/agent",
	"@earendil-works/pi-protocol": "packages/protocol",
	"@earendil-works/pi-client": "packages/client",
	"@earendil-works/pi-telemetry": "packages/telemetry",
	"@earendil-works/pi-coding-agent": "packages/coding-agent",
	"@earendil-works/pi-session-backend-sqlite-node": "packages/session-backends/sqlite-node",
};

/** explicit subpath overrides (from the repo's tsconfig "paths") */
const SUBPATH_OVERRIDES = {
	"@earendil-works/pi-agent-core/session/testing": "packages/agent/src/harness/session/testing/index.ts",
	"@earendil-works/pi-telemetry/testing": "packages/telemetry/src/testing/index.ts",
	"@earendil-works/pi-coding-agent/hooks": "packages/coding-agent/src/core/hooks/index.ts",
};

/** Resolve a workspace specifier to a repo-relative .ts file. */
function resolveSpecifier(spec) {
	if (SUBPATH_OVERRIDES[spec]) return SUBPATH_OVERRIDES[spec];
	if (PKG_DIRS[spec]) return `${PKG_DIRS[spec]}/src/index.ts`;
	for (const [pkg, dir] of Object.entries(PKG_DIRS)) {
		if (!spec.startsWith(`${pkg}/`)) continue;
		const sub = spec.slice(pkg.length + 1);
		// try <src>/<sub>.ts, <src>/<sub>/index.ts, and providers/<sub>.ts (pi-ai)
		for (const cand of [`${dir}/src/${sub}.ts`, `${dir}/src/${sub}/index.ts`, `${dir}/src/providers/${sub}.ts`]) {
			try {
				if (statSync(join(ROOT, cand)).isFile()) return cand;
			} catch {}
		}
		return null;
	}
	return null;
}

// ── stage the sources ───────────────────────────────────────────────────────
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const dirs = [...new Set(Object.values(PKG_DIRS))];
const islandDirs = new Set([...ISLAND].map((p) => PKG_DIRS[p]).filter(Boolean));
for (const d of dirs.filter((d) => !islandDirs.has(d))) {
	const from = join(ROOT, d, "src");
	try {
		if (!statSync(from).isDirectory()) continue;
	} catch {
		continue;
	}
	cpSync(from, join(OUT, d, "src"), { recursive: true });
}

// ── rewrite workspace specifiers to relative paths ──────────────────────────
// `from "pkg"`, `import("pkg")` and — critically — `declare module "pkg" { … }`.
// pi augments package types (e.g. `declare module "@earendil-works/pi-tui" {
// interface Keybindings extends AppKeybindings {} }`). Module augmentation is keyed by
// module identity, so if the imports become relative paths and the augmentation does not,
// the augmentation silently stops applying (114 SC0001 errors: '"app.exit"' not
// assignable to KeyId). Both must be rewritten together.
const SPEC_RE = /(\bfrom\s*|\bimport\s*\(\s*|\bdeclare\s+module\s+)("|')(@earendil-works\/[^"']+|typebox(?:\/[^"']+)?)\2/g;

// ── pi-ai-lite vendoring ─────────────────────────────────────────────────
// For the minimal scriptc build the whole pi-ai surface is served by a small
// static module (scriptc-minimal/vendor/pi-ai-lite) instead of the island.
// The agent loop's Model/Context/StreamFn types then originate in program
// source, which removes the static/island type contagion that made the Agent
// class uncompilable. Same import specifiers, so no call site changes.
const PI_AI_LITE = "packages/agent/src/vendor/pi-ai-lite/index.ts";
const TYPEBOX_LITE = "packages/agent/src/vendor/pi-ai-lite/typebox.ts";
const isPiAiSpec = (spec) => spec === "@earendil-works/pi-ai" || spec.startsWith("@earendil-works/pi-ai/");
const isTypeboxSpec = (spec) => spec === "typebox" || spec.startsWith("typebox/");
let files = 0;
let rewrites = 0;
let metaUrlRewrites = 0;
const unresolved = new Map();

function walk(dir) {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			walk(p);
		} else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) {
			let src = readFileSync(p, "utf8");
			const before = src;
			// `import.meta.url` has no scriptc lowering (SC2020). At staging time each
			// module's own URL is known, so substitute the per-module literal. This is
			// exact (unlike process.argv[1], which is the process entry, not the module),
			// so self-location keeps working in non-entry modules.
			if (p.includes(join("agent", "src"))) {
				// scriptc-port: `Model<any>` / `AgentTool<any, any>` instantiations
				// carry an `any` member into otherwise-static records, any-izing
				// the agent graph transitively. The type arguments are only
				// generic bookkeeping, so drop them in the staged tree.
				const patchedAny = src
					.replace(/\bModel<[^<>]*>/g, "Model")
					.replace(/\bEventStream<[^<>]*>/g, "EventStream")
					.replace(/\bAgentTool<any, any>/g, "AgentTool")
					.replace(/\bAgentTool<any>/g, "AgentTool")
					.replace(/\bTool<any>/g, "Tool");
				if (patchedAny !== src) src = patchedAny;
			}
			if (p.endsWith(join("agent", "src", "agent.ts"))) {
				// scriptc-port: drop onPayload/onResponse plumbing from the staged
				// tree. The minimal provider layer never observes them, and their
				// callback unions don't survive the compiled graph.
				const lines = src.split("\n");
				const drop = (startMark, endMark) => {
					const s0 = lines.indexOf(startMark);
					if (s0 === -1) return;
					const s1 = lines.indexOf(endMark, s0);
					if (s1 === -1) return;
					lines.splice(s0, s1 - s0 + 1);
				};
				drop("\t\tconst configuredOnPayload = options.onPayload;", "\t\t\t\t\t\tconfiguredOnPayload(payload, model);");
				drop("\t\tconst configuredOnResponse = options.onResponse;", "\t\t\t\t};");
				let filtered = lines.filter(
					(l) =>
						l !== "\t\tpublic onPayload?: (payload: unknown, model: Model) => any;" &&
						l !== "\t\tpublic onResponse?: (response: ProviderResponse, model: Model) => any;" &&
						l !== "\t\t\tonPayload: this.onPayload," &&
						l !== "\t\t\tonResponse: this.onResponse,",
				);
				const out = filtered.join("\n");
				if (out !== src) src = out;
			}
			if (p.endsWith(join("agent", "src", "types.ts"))) {
				// scriptc resolves `never` to `any`, which would collapse AgentMessage
				// through the index access; `Message` keeps the union a no-op there.
				src = src.replace("__reserved: never;", "__reserved: Message;");
				const patched = src.replace(
					"export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];",
					"// scriptc-port: staged tree drops the CustomAgentMessages index access\n// (scriptc resolves the empty-interface index to `any`/`undefined`); the\n// minimal build has no custom agent messages, so AgentMessage === Message.\nexport type AgentMessage = Message;",
				);
				if (patched !== src) {
					src = patched;
				}
			}
			if (src.includes("import.meta.url")) {
				const url = `file://${p}`;
				src = src.replace(/\bimport\.meta\.url\b/g, JSON.stringify(url));
				metaUrlRewrites++;
			}
			src = src.replace(SPEC_RE, (m, kw, q, spec) => {
				if (isPiAiSpec(spec) && !isIslanded("@earendil-works/pi-ai")) {
					let rel = relative(dirname(p), join(OUT, PI_AI_LITE)).split(sep).join("/");
					if (!rel.startsWith(".")) rel = `./${rel}`;
					rewrites++;
					return `${kw}${q}${rel}${q}`;
				}
				if (isTypeboxSpec(spec) && !isIslanded("@earendil-works/pi-agent-core")) {
					let rel = relative(dirname(p), join(OUT, TYPEBOX_LITE)).split(sep).join("/");
					if (!rel.startsWith(".")) rel = `./${rel}`;
					rewrites++;
					return `${kw}${q}${rel}${q}`;
				}
				if (isIslanded(spec)) return m;
				const target = resolveSpecifier(spec);
				if (!target) {
					unresolved.set(spec, (unresolved.get(spec) ?? 0) + 1);
					return m;
				}
				let rel = relative(dirname(p), join(OUT, target)).split(sep).join("/");
				if (!rel.startsWith(".")) rel = `./${rel}`;
				rewrites++;
				return `${kw}${q}${rel}${q}`;
			});
			if (src !== before) {
				writeFileSync(p, src);
				files++;
			}
		}
	}
}
walk(OUT);

// ── vendor packages that use package.json "imports" (#specifiers) ────────────
// scriptc cannot resolve `#ansi-styles` / `#supports-color` (SC2030/SC1010) in either
// tier — a hard error with no island fallback. Vendoring chalk's source into the stage
// tree and rewriting those specifiers to relative paths keeps chalk's behaviour exactly
// (same code), so colour output is not lost.
// Vendored as program source rather than served from the island.
// chalk: its package.json "imports" (#ansi-styles) are unresolvable in either tier.
// marked: pi-tui subclasses its Tokenizer, and `extends` requires the base class to
//         be declared in the program (SC1090); --npm-static refuses it ("inferred
//         export surface breaks 5 import sites").
// marked was tried here too (pi-tui subclasses its Tokenizer) but vendoring does not
// help: type resolution still goes through marked.d.ts, so scriptc sees an AMBIENT
// class declaration and `extends` stays SC1090. It needs either a compiler change or
// a pi-side refactor away from subclassing.
const VENDOR = { chalk: "vendor/chalk" };
for (const [pkg, dest] of Object.entries(VENDOR)) {
	const from = join(ROOT, "node_modules", pkg);
	try {
		if (!statSync(from).isDirectory()) continue;
	} catch {
		continue;
	}
	const to = join(OUT, dest);
	cpSync(from, to, { recursive: true });

	// rewrite the package's own "#x" imports to relative paths, using its imports map
	let importsMap = {};
	try {
		importsMap = JSON.parse(readFileSync(join(to, "package.json"), "utf8")).imports ?? {};
	} catch {}
	const rewriteHash = (dir) => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isDirectory()) {
				rewriteHash(p);
			} else if (p.endsWith(".js")) {
				let s = readFileSync(p, "utf8");
				const before = s;
				s = s.replace(/(\bfrom\s*)("|')(#[^"']+)\2/g, (m, kw, q, spec) => {
					const target = importsMap[spec];
					if (typeof target !== "string") return m;
					let rel = relative(dirname(p), join(to, target)).split(sep).join("/");
					if (!rel.startsWith(".")) rel = `./${rel}`;
					return `${kw}${q}${rel}${q}`;
				});
				if (s !== before) writeFileSync(p, s);
			}
		}
	};
	rewriteHash(to);

	// point staged pi sources at the vendored copy
	const pkgJson = JSON.parse(readFileSync(join(to, "package.json"), "utf8"));
	const entry = join(to, pkgJson.main ?? "index.js");

	// Importing the entry FILE (not the package name) means TypeScript looks for a
	// sibling declaration file: `marked.esm.js` -> `marked.esm.d.ts`. Packages whose
	// types live elsewhere (marked ships `lib/marked.d.ts`) need that bridge, or every
	// type-only import from the vendored copy fails.
	const typesRel = pkgJson.types ?? pkgJson.typings;
	if (typeof typesRel === "string") {
		const sibling = entry.replace(/\.[cm]?js$/, ".d.ts");
		const typesAbs = join(to, typesRel);
		if (sibling !== typesAbs) {
			let spec = relative(dirname(sibling), typesAbs).split(sep).join("/").replace(/\.d\.ts$/, "");
			if (!spec.startsWith(".")) spec = `./${spec}`;
			writeFileSync(sibling, `export * from "${spec}";\n`);
		}
	}
	const pointAt = (dir) => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isDirectory()) {
				if (p !== join(OUT, "vendor")) pointAt(p);
			} else if (p.endsWith(".ts")) {
				let s = readFileSync(p, "utf8");
				const re = new RegExp(`(\\bfrom\\s*)("|')(${pkg})\\2`, "g");
				const before = s;
				s = s.replace(re, (m, kw, q) => {
					let rel = relative(dirname(p), entry).split(sep).join("/");
					if (!rel.startsWith(".")) rel = `./${rel}`;
					return `${kw}${q}${rel}${q}`;
				});
				if (s !== before) writeFileSync(p, s);
			}
		}
	};
	pointAt(OUT);
	console.log(`vendored ${pkg} -> ${dest} (package.json "imports" specifiers rewritten)`);
}

// ── island shim for node:module ─────────────────────────────────────────────
// `module.createRequire` has no static lowering (SC2020), but "module" IS one of the
// island's shimmed builtins. Routing the import through a vendored CJS package moves the
// call into the island, so the code compiles and keeps its real behaviour there instead
// of being deleted. (Loading native .node addons still fails at runtime — as it does in
// pi's own Bun binary, pi#6250 — and pi already try/catches that path.)
const SHIM_DIR = join(OUT, "vendor/island-module");
mkdirSync(SHIM_DIR, { recursive: true });
writeFileSync(join(SHIM_DIR, "package.json"), JSON.stringify({ name: "island-module", version: "1.0.0", main: "index.js", types: "index.d.ts" }, null, 2));
writeFileSync(
	join(SHIM_DIR, "index.js"),
	'const mod = require("module");\n' +
		"module.exports = {\n" +
		"  createRequire: mod.createRequire,\n" +
		"  islandRequire: (id, from) => mod.createRequire(from)(id),\n" +
		"  islandResolve: (id, from) => mod.createRequire(from).resolve(id),\n" +
		"};\n",
);
writeFileSync(
	join(SHIM_DIR, "index.d.ts"),
	"export interface IslandRequire {\n\t(id: string): unknown;\n\tresolve(id: string): string;\n}\n" +
		"export declare function createRequire(path: string | URL): IslandRequire;\n" +
		"export declare function islandRequire(id: string, from: string): unknown;\n" +
		"export declare function islandResolve(id: string, from: string): string;\n",
);

let shimRewrites = 0;
const shimWalk = (dir) => {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			if (p !== join(OUT, "vendor")) shimWalk(p);
		} else if (p.endsWith(".ts")) {
			let s = readFileSync(p, "utf8");
			const before = s;
			s = s.replace(/import\s*\{[^}]*\bcreateRequire\b[^}]*\}\s*from\s*("|')(node:module|module)\1/g, (m, q) => {
				let rel = relative(dirname(p), join(SHIM_DIR, "index.js")).split(sep).join("/");
				if (!rel.startsWith(".")) rel = `./${rel}`;
				return `import { createRequire, islandRequire } from ${q}${rel}${q}`;
			});
			if (s !== before) {
				writeFileSync(p, s);
				shimRewrites++;
			}
		}
	}
};
shimWalk(OUT);

function patchKeybindingRecords(OUT) {
	const replaceExpected = (source, file, oldText, newText) => {
		if (!source.includes(oldText)) {
			throw new Error(`scriptc-stage: expected keybinding replacement missing in ${file}: ${oldText}`);
		}
		return source.replace(oldText, newText);
	};

	const tuiPath = join(OUT, "packages/tui/src/keybindings.ts");
	let tui = readFileSync(tuiPath, "utf8");
	tui = replaceExpected(
		tui,
		tuiPath,
		"export const TUI_KEYBINDINGS = {",
		"export const TUI_KEYBINDINGS: KeybindingDefinitions = {",
	);
	tui = replaceExpected(tui, tuiPath, "} as const satisfies KeybindingDefinitions;", "};");
	writeFileSync(tuiPath, tui);

	const codingAgentPath = join(OUT, "packages/coding-agent/src/core/keybindings.ts");
	let codingAgent = readFileSync(codingAgentPath, "utf8");
	codingAgent = replaceExpected(
		codingAgent,
		codingAgentPath,
		"export const KEYBINDINGS = {",
		"export const KEYBINDINGS: KeybindingDefinitions = {",
	);
	codingAgent = replaceExpected(codingAgent, codingAgentPath, "} as const satisfies KeybindingDefinitions;", "};");
	codingAgent = replaceExpected(
		codingAgent,
		codingAgentPath,
		"const KEYBINDING_NAME_MIGRATIONS = {",
		"const KEYBINDING_NAME_MIGRATIONS: Record<string, Keybinding> = {",
	);
	codingAgent = replaceExpected(
		codingAgent,
		codingAgentPath,
		"} as const satisfies Record<string, Keybinding>;",
		"};",
	);
	writeFileSync(codingAgentPath, codingAgent);
}

patchKeybindingRecords(OUT);

// scriptc port: the @anthropic-ai/sdk references the global `FormData` in its
// request-encoding chain (`body instanceof FormData`). The --dynamic island
// does not define FormData, so every provider request throws. Inject an inert
// polyfill into the SDK entry (idempotent; no behaviour change under Node).
	const sdkFiles = ["index.js", "index.mjs", "client.js", "client.mjs", "internal/uploads.js", "internal/uploads.mjs"];
	const SDK_INDEXS = sdkFiles.map((f) => join(ROOT, "node_modules", "@anthropic-ai", "sdk", f));
	for (const SDK_INDEX of SDK_INDEXS) {
try {
	if (statSync(SDK_INDEX).isFile()) {
		const sdk = readFileSync(SDK_INDEX, "utf8");
		const marker = "/* scriptc-port: island FormData polyfill */";
		if (!sdk.includes(marker)) {
			writeFileSync(
				SDK_INDEX,
				`${marker}\nif (typeof globalThis.FormData === "undefined") { globalThis.FormData = class FormData {}; }\n${sdk}`,
			);
		}
	}
} catch {}

function patchTelemetry(OUT) {
	const p = join(OUT, "packages/agent/src/harness/telemetry.ts");
	if (!existsSync(p)) return; // agent islanded
	let s = readFileSync(p, "utf8");
	const before = s;
	s = s.replace(/ as const satisfies TelemetrySchemaDefinition/g, " as const");
	s = s.replace(
		/(\t\t\t\t"pi\.operation\.outcome": \{\n[\s\S]*?\n\t\t\t\t\},\n)(\t\t\t\t\.\.\.operationErrorAttributes,\n)/g,
		"$2$1",
	);
	if (s !== before) writeFileSync(p, s);
}

patchTelemetry(OUT);

// scriptc port: the extension host surface is type-level only. scriptc must be able to
// compile ExtensionFactory as a *stored value type* (it lives in InlineExtension[],
// MainOptions and the loader cache), and it refuses any function type whose parameter
// type does not itself compile. The real ExtensionAPI does not compile because `on` has
// 34 overloads and `registerProvider` has 2, and overload sets have no lowering.
//
// Overloads are erased at runtime, so collapsing the *staged copy* changes no behaviour
// and costs no feature: pi's real sources keep the full overload set, so extension
// authors typechecking against the published SDK are unaffected. Only the throwaway
// tree handed to scriptc is weakened.
function patchExtensionHost(OUT) {
	const expect = (source, file, oldText, newText) => {
		if (!source.includes(oldText)) {
			throw new Error(`scriptc-stage: expected extension-host replacement missing in ${file}: ${oldText}`);
		}
		return source.replace(oldText, newText);
	};

	const typesPath = join(OUT, "packages/coding-agent/src/core/extensions/types.ts");
	let types = readFileSync(typesPath, "utf8");
	types = expect(
		types,
		typesPath,
		"export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;",
		"export type ExtensionFactory = (pi: any) => void | Promise<void>;",
	);
	writeFileSync(typesPath, types);

	// Map values may be class instances but never functions, and the rejection is
	// transitive (a *record* wrapping a function is rejected too). A one-field class
	// wrapper is the only shape that keeps Map get/set/clear semantics exactly.
	const loaderPath = join(OUT, "packages/coding-agent/src/core/extensions/loader.ts");
	let loader = readFileSync(loaderPath, "utf8");
	loader = expect(
		loader,
		loaderPath,
		"const extensionCache = new Map<string, ExtensionFactory>();",
		"class CachedExtensionFactory {\n\tconstructor(public readonly factory: ExtensionFactory) {}\n}\nconst extensionCache = new Map<string, CachedExtensionFactory>();",
	);
	loader = expect(
		loader,
		loaderPath,
		"\t\tconst cachedFactory = extensionCache.get(extensionPath);\n\t\tif (cachedFactory) {\n\t\t\treturn cachedFactory;\n\t\t}",
		"\t\tconst cachedFactory = extensionCache.get(extensionPath);\n\t\tif (cachedFactory) {\n\t\t\treturn cachedFactory.factory;\n\t\t}",
	);
	loader = expect(
		loader,
		loaderPath,
		"\t\textensionCache.set(extensionPath, factory);",
		"\t\textensionCache.set(extensionPath, new CachedExtensionFactory(factory));",
	);
	writeFileSync(loaderPath, loader);
}

patchExtensionHost(OUT);
stageText(OUT, ROOT);
stageLazy(OUT);
stageHttp(OUT);

console.log(`staged  -> ${relative(ROOT, OUT)}`);
console.log(`routed createRequire through the island in ${shimRewrites} modules`);
console.log(`rewrote ${rewrites} workspace specifiers across ${files} files`);
console.log(`rewrote import.meta.url in ${metaUrlRewrites} modules (per-module literal)`);
if (unresolved.size) {
	console.log("unresolved specifiers (left as package imports -> island):");
	for (const [s, n] of [...unresolved].sort((a, b) => b[1] - a[1])) console.log(`   ${n}x  ${s}`);
}
console.log(`\nbuild with:\n  SCRIPTC_CC=zigcc scriptc build ${relative(ROOT, OUT)}/packages/coding-agent/src/cli.ts --dynamic -o /tmp/pi-native`);
