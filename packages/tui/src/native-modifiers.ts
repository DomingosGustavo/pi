import * as path from "node:path";
import { fileURLToPath } from "node:url";

// scriptc port: 'module.createRequire' has no lowering (SC2020) and a compiled binary
// cannot load native .node addons. These helpers are Windows-only niceties.
const cjsRequire = (_id: string): unknown => {
	throw new Error("native module unavailable in a compiled binary");
};

export type ModifierKey = "shift" | "command" | "control" | "option";

type NativeModifiersHelper = {
	isModifierPressed: (name: ModifierKey) => boolean;
};

let nativeModifiersHelper: NativeModifiersHelper | null | undefined;

function isNativeModifiersHelper(value: unknown): value is NativeModifiersHelper {
	if (typeof value !== "object" || value === null) return false;
	const candidate = (value as { isModifierPressed?: unknown }).isModifierPressed;
	return typeof candidate === "function";
}

function loadNativeModifiersHelper(): NativeModifiersHelper | undefined {
	if (nativeModifiersHelper !== undefined) return nativeModifiersHelper ?? undefined;
	nativeModifiersHelper = null;
	const arch = process.arch;
	if (arch !== "x64" && arch !== "arm64") return undefined;

	let nativePath: string;
	if (process.platform === "darwin") {
		nativePath = path.join("native", "darwin", "prebuilds", `darwin-${arch}`, "darwin-modifiers.node");
	} else if (process.platform === "win32") {
		nativePath = path.join("native", "win32", "prebuilds", `win32-${arch}`, "win32-console-mode.node");
	} else {
		return undefined;
	}

	const moduleDir = path.dirname(process.argv[1]);
	const candidates = [
		path.join(moduleDir, "..", nativePath),
		path.join(moduleDir, nativePath),
		path.join(path.dirname(process.execPath), nativePath),
	];

	for (const modulePath of candidates) {
		try {
			const helper = cjsRequire(modulePath) as unknown;
			if (isNativeModifiersHelper(helper)) {
				nativeModifiersHelper = helper;
				return helper;
			}
		} catch {
			// Try the next possible packaging location.
		}
	}

	return undefined;
}

export function isNativeModifierPressed(key: ModifierKey): boolean {
	const helper = loadNativeModifiersHelper();
	if (!helper) return false;
	try {
		return helper.isModifierPressed(key) === true;
	} catch {
		return false;
	}
}
