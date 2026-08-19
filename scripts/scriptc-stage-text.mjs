/**
 * scriptc staging: Unicode text handling for pi-tui.
 *
 * Two blockers, one root file (packages/tui/src/utils.ts):
 *
 *  1. `Intl.Segmenter` has no scriptc lowering (SC2020) and the island engine
 *     (quickjs) ships no `Intl` at all. 14 diagnostics cascade from the two
 *     segmenter instances defined there.
 *  2. Six regexes use the `v` flag (SC1120). Two of them cannot be expressed with
 *     `u`: `\p{RGI_Emoji}` is a property OF STRINGS, and one uses set difference
 *     (`[\p{Spacing_Mark}--[…]]`).
 *
 * Both are solved by moving the work into the island, which was verified to support
 * the `v` flag natively (including `\p{RGI_Emoji}` and set subtraction) and to run
 * the @formatjs UAX#29 segmenter once a minimal `Intl` host object exists.
 *
 * Nothing is approximated: the same Unicode algorithms run, just in the engine.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

const ISLAND_PKG = "vendor/island-text";

const GLOBALS_JS = `// quickjs (the island engine) ships no Intl. The @formatjs polyfill expects the
// namespace to exist and calls Intl.getCanonicalLocales during construction.
if (typeof globalThis.Intl === "undefined") globalThis.Intl = {};
if (typeof globalThis.Intl.getCanonicalLocales !== "function") {
  globalThis.Intl.getCanonicalLocales = (locales) => {
    if (locales === undefined) return [];
    return (Array.isArray(locales) ? locales : [locales]).map(String);
  };
}
`;

const INDEX_JS = `import "./globals.js";
// Named re-exports do not resolve through the island (scriptc #19), so use the
// polyfill's global-install entry and read the constructor off Intl.
import "@formatjs/intl-segmenter/polyfill-force.js";

const Segmenter = globalThis.Intl.Segmenter;
const graphemeSegmenter = new Segmenter(undefined, { granularity: "grapheme" });
const wordSegmenter = new Segmenter(undefined, { granularity: "word" });

function toArray(segmenter, input) {
  const out = [];
  for (const part of segmenter.segment(input)) {
    out.push({ segment: part.segment, index: part.index, input, isWordLike: !!part.isWordLike });
  }
  return out;
}

export const segmentGraphemes = (s) => toArray(graphemeSegmenter, s);
export const segmentWords = (s) => toArray(wordSegmenter, s);

// The 'v' flag (unicode sets) is unsupported by the static regex engine but native here.
const zeroWidth = /^(?:\\p{Default_Ignorable_Code_Point}|\\p{Control}|\\p{Mark}|\\p{Surrogate})+$/v;
const leadingNonPrinting = /^[\\p{Default_Ignorable_Code_Point}\\p{Control}\\p{Format}\\p{Mark}\\p{Surrogate}]+/v;
const nonPrintingChar = /^(?:\\p{Default_Ignorable_Code_Point}|\\p{Control}|\\p{Format}|\\p{Mark}|\\p{Surrogate})$/v;
const markChar = /^\\p{Mark}$/v;
const terminalSpacingMark =
  /^(?:[\\p{Spacing_Mark}--[\\u1734\\u302E\\u302F]]|[\\u065F\\u0F7F\\u102B\\u102C\\u1031\\u1033-\\u1035\\u1038\\u103A-\\u103E])+$/v;
const rgiEmoji = /^\\p{RGI_Emoji}$/v;

export const isZeroWidth = (s) => zeroWidth.test(s);
export const isNonPrintingChar = (s) => nonPrintingChar.test(s);
export const isMarkChar = (s) => markChar.test(s);
export const isTerminalSpacingMark = (s) => terminalSpacingMark.test(s);
export const isRgiEmoji = (s) => rgiEmoji.test(s);
export const stripLeadingNonPrinting = (s) => s.replace(leadingNonPrinting, "");
`;

const INDEX_DTS = `export interface PiSegmentData {
	segment: string;
	index: number;
	input: string;
	/** optional, matching Intl.SegmentData (word granularity only) */
	isWordLike?: boolean;
}
export declare function segmentGraphemes(s: string): PiSegmentData[];
export declare function segmentWords(s: string): PiSegmentData[];
export declare function isZeroWidth(s: string): boolean;
export declare function isNonPrintingChar(s: string): boolean;
export declare function isMarkChar(s: string): boolean;
export declare function isTerminalSpacingMark(s: string): boolean;
export declare function isRgiEmoji(s: string): boolean;
export declare function stripLeadingNonPrinting(s: string): string;
`;

/** Write the island helper package into the staging tree. */
function writeIslandPackage(OUT) {
	const dir = join(OUT, ISLAND_PKG);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		`${JSON.stringify({ name: "island-text", version: "1.0.0", type: "module", main: "index.js", types: "index.d.ts" }, null, 2)}\n`,
	);
	writeFileSync(join(dir, "globals.js"), GLOBALS_JS);
	writeFileSync(join(dir, "index.js"), INDEX_JS);
	writeFileSync(join(dir, "index.d.ts"), INDEX_DTS);
	return dir;
}

const rel = (from, to) => {
	let r = relative(dirname(from), to).split(sep).join("/");
	if (!r.startsWith(".")) r = `./${r}`;
	return r;
};

/** Rewrite tui/src/utils.ts to delegate segmentation + v-flag regexes to the island. */
function patchUtils(OUT) {
	const p = join(OUT, "packages/tui/src/utils.ts");
	let s = readFileSync(p, "utf8");
	const helper = rel(p, join(OUT, ISLAND_PKG, "index.js"));

	s =
		`import {\n\tisMarkChar,\n\tisNonPrintingChar,\n\tisRgiEmoji,\n\tisTerminalSpacingMark,\n\tisZeroWidth,\n\ttype PiSegmentData,\n\tsegmentGraphemes,\n\tsegmentWords,\n\tstripLeadingNonPrinting,\n} from "${helper}";\n` +
		`\nexport type { PiSegmentData };\n` +
		`/** The subset of Intl.Segmenter pi uses. Segments are materialised as an array. */\n` +
		`export interface PiSegmenter {\n\tsegment(input: string): PiSegmentData[];\n}\n\n` +
		s;

	// segmenter instances -> island-backed objects
	s = s.replace(
		'const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });',
		"const graphemeSegmenter: PiSegmenter = { segment: (input: string): PiSegmentData[] => segmentGraphemes(input) };",
	);
	s = s.replace(
		'const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });',
		"const wordSegmenter: PiSegmenter = { segment: (input: string): PiSegmentData[] => segmentWords(input) };",
	);

	// drop the v-flag regex declarations (their logic now lives in the island)
	const dropRegex = [
		/^const zeroWidthRegex = .*$\n/m,
		/^const leadingNonPrintingRegex = .*$\n/m,
		/^const nonPrintingCharRegex = .*$\n/m,
		/^const markCharRegex = .*$\n/m,
		/^const terminalSpacingMarkRegex =\n\t.*$\n/m,
		/^const rgiEmojiRegex = .*$\n/m,
	];
	for (const re of dropRegex) s = s.replace(re, "");

	// call sites
	s = s
		.replace(/\bterminalSpacingMarkRegex\.test\(/g, "isTerminalSpacingMark(")
		.replace(/\bzeroWidthRegex\.test\(/g, "isZeroWidth(")
		.replace(/\brgiEmojiRegex\.test\(/g, "isRgiEmoji(")
		.replace(/\bmarkCharRegex\.test\(/g, "isMarkChar(")
		.replace(/\bnonPrintingCharRegex\.test\(/g, "isNonPrintingChar(")
		.replace(/(\w+)\.replace\(leadingNonPrintingRegex, ""\)/g, "stripLeadingNonPrinting($1)");

	// utils.ts declares its own accessors returning Intl.Segmenter
	s = s.replace(/Intl\.SegmentData/g, "PiSegmentData").replace(/Intl\.Segmenter/g, "PiSegmenter");

	writeFileSync(p, s);
}

/** Point every Intl.Segmenter / Intl.SegmentData type reference at the staged types. */
function rewriteTypes(OUT) {
	const utils = join(OUT, "packages/tui/src/utils.ts");
	let count = 0;
	const walk = (dir) => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isDirectory()) {
				if (p !== join(OUT, "vendor")) walk(p);
			} else if (p.endsWith(".ts") && p !== utils) {
				let s = readFileSync(p, "utf8");
				const before = s;
				const t = `import("${rel(p, utils).replace(/\.ts$/, ".ts")}")`;
				// Iterable<Intl.SegmentData> -> array (our segment() returns an array)
				s = s.replace(/Iterable<Intl\.SegmentData>/g, `${t}.PiSegmentData[]`);
				s = s.replace(/Intl\.SegmentData/g, `${t}.PiSegmentData`);
				s = s.replace(/Intl\.Segmenter/g, `${t}.PiSegmenter`);
				if (s !== before) {
					writeFileSync(p, s);
					count++;
				}
			}
		}
	};
	walk(OUT);
	return count;
}

export function stageText(OUT) {
	writeIslandPackage(OUT);
	patchUtils(OUT);
	const n = rewriteTypes(OUT);
	console.log(`text: island segmenter + v-flag regexes wired; Intl types rewritten in ${n} modules`);
}
