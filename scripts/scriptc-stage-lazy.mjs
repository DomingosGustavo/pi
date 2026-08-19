/**
 * scriptc staging: defer island-derived module-level bindings.
 *
 * A value that comes from the island cannot be *referenced* at module top level
 * (SC1090: "the reference to 'x' (a binding form with no lowering)"). The same call
 * inside a function body is fine — which is why `extensions/loader.ts` compiles but
 * `const cjsRequire = createRequire(...)` at top level does not.
 *
 * So top-level `createRequire` bindings become memoised lazy wrappers with identical
 * call semantics, and photon's `require("fs")` becomes a plain static import (it was
 * only using `createRequire` to reach a builtin that scriptc supports directly).
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `const NAME = createRequire(EXPR);` -> named program function.
 *
 * An island function may be CALLED from a named program function, but the require
 * function it returns cannot be held as a value (SC1090), so each call resolves
 * through the island helper instead of storing the intermediate.
 */
const LAZY_REQUIRE = (name, expr) => `function ${name}(id: string): unknown {
\treturn islandRequire(id, ${expr});
}`;

export function stageLazy(OUT) {
	let lazified = 0;
	let photonFixed = 0;

	const walk = (dir) => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isDirectory()) {
				if (p !== join(OUT, "vendor")) walk(p);
				continue;
			}
			if (!p.endsWith(".ts")) continue;
			let s = readFileSync(p, "utf8");
			const before = s;

			// photon reaches node:fs through createRequire purely to dodge bundler
			// interop; `typeof import("fs")` has no lowering, and a static import of a
			// supported builtin is exactly equivalent here.
			if (p.endsWith("utils/photon.ts")) {
				const m = s.match(/^const require = createRequire\([^\n]*\);\nconst fs = require\("fs"\) as typeof import\("fs"\);$/m);
				if (m) {
					s = s.replace(m[0], "");
					s = s.replace(/^(import \* as path from "path";)$/m, 'import * as fs from "fs";\n$1');
					photonFixed++;
				}
			}

			// generic: top-level `const X = createRequire(EXPR);`
			s = s.replace(/^const (\w+) = createRequire\(([^\n]*?)\);$/gm, (_m, name, expr) => {
				lazified++;
				return LAZY_REQUIRE(name, expr);
			});

			if (s !== before) writeFileSync(p, s);
		}
	};
	walk(OUT);
	console.log(`lazy: ${lazified} top-level createRequire bindings deferred${photonFixed ? ", photon fs import made static" : ""}`);
}
