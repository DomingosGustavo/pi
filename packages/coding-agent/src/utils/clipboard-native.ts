import { createRequire } from "module";
import { dirname, join } from "path";
import { pathToFileURL } from "url";

export type ClipboardModule = {
	getText: () => Promise<string>;
	setText: (text: string) => Promise<void>;
	hasImage: () => boolean;
	getImageBinary: () => Promise<Array<number>>;
};

type ClipboardRequire = (id: string) => unknown;

// scriptc port: 'module.createRequire' has no lowering (SC2020), and a compiled
// binary cannot load native .node addons anyway. Clipboard degrades to unavailable.
const moduleRequire: ClipboardRequire = () => {
	throw new Error("native clipboard unavailable in a scriptc-compiled binary");
};
const executableDirRequire: ClipboardRequire = moduleRequire;
const hasDisplay = process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

export function loadClipboardNative(
	requires: readonly ClipboardRequire[] = [moduleRequire, executableDirRequire],
): ClipboardModule | null {
	// scriptc port: native .node addons cannot be loaded from a compiled binary.
	void requires;
	return null;
}

const clipboard = !process.env.TERMUX_VERSION && hasDisplay ? loadClipboardNative() : null;

export { clipboard };
