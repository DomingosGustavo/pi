#!/usr/bin/env node
/**
 * Prepare the staging tree for a scriptc build of pi-min.
 *
 * pi-min compiles its own sources statically and runs pi's packages
 * (@earendil-works/pi-ai, pi-agent-core, pi-tui) as real JavaScript inside
 * scriptc's --dynamic island. Those packages resolve through this workspace's
 * node_modules to their built dist, so nothing from packages/ is copied here.
 *
 * What this script does:
 *   1. recreate the staging directory (the caller overlays its entry sources
 *      and island bridge packages into it)
 *   2. prepend a FormData polyfill to @anthropic-ai/sdk: its request-encoding
 *      chain evaluates `body instanceof FormData`, and the island engine has no
 *      FormData global unless the scriptc runtime provides one
 *
 *   node scripts/scriptc-stage.mjs [--out .scriptc-stage]
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(dirname(process.argv[1]), "..");
const outArg = process.argv.indexOf("--out");
const OUT = resolve(ROOT, outArg === -1 ? ".scriptc-stage" : process.argv[outArg + 1]);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const MARKER = "/* scriptc-port: island FormData polyfill */";
const POLYFILL = `${MARKER}\nif (typeof globalThis.FormData === "undefined") { globalThis.FormData = class FormData {}; }\n`;
const sdkFiles = ["index.js", "index.mjs", "client.js", "client.mjs", "internal/uploads.js", "internal/uploads.mjs"];
let patched = 0;
for (const f of sdkFiles) {
	const p = join(ROOT, "node_modules", "@anthropic-ai", "sdk", f);
	try {
		if (!statSync(p).isFile()) continue;
	} catch {
		continue;
	}
	const sdk = readFileSync(p, "utf8");
	if (sdk.includes(MARKER)) continue;
	writeFileSync(p, POLYFILL + sdk);
	patched++;
}

console.log(`staged  -> ${relative(ROOT, OUT)}`);
console.log(`@anthropic-ai/sdk FormData polyfill: ${patched} file(s) newly patched`);
