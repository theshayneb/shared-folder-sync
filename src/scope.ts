/** Extensions synced from a shared folder. Binary attachments are skipped. */
const FOLDER_EXTENSIONS = ["md", "base", "canvas", "txt"];

export interface ShareScope {
	folders: string[];
	files: string[];
}

/** Turns user-typed paths (backslashes, stray slashes) into vault paths. */
export function cleanPath(input: string): string {
	return input
		.trim()
		.replace(/\\/g, "/")
		.split("/")
		.filter((part) => part !== "" && part !== ".")
		.join("/");
}

/** Splits a newline-separated settings field into clean, unique paths. */
export function parsePathList(text: string): string[] {
	const paths = text.split(/\r?\n/).map(cleanPath).filter((p) => p !== "");
	return [...new Set(paths)];
}

/**
 * Rejects paths that could escape the vault or reach a hidden top-level
 * folder, which is where Obsidian keeps its config folder.
 */
export function isSafePath(path: string): boolean {
	if (path === "" || path.length > 400 || path.startsWith("/") || path.includes("\\")) {
		return false;
	}
	const parts = path.split("/");
	if (parts.some((p) => p === "" || p === "." || p === "..")) {
		return false;
	}
	return !parts[0]?.startsWith(".");
}

export function inScope(scope: ShareScope, path: string): boolean {
	if (!isSafePath(path)) {
		return false;
	}
	if (scope.files.includes(path)) {
		return true;
	}
	const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	if (!FOLDER_EXTENSIONS.includes(ext)) {
		return false;
	}
	return scope.folders.some((folder) => path.startsWith(folder + "/"));
}

/** A stable string for comparing two scopes. */
export function scopeKey(scope: ShareScope): string {
	return JSON.stringify({ folders: scope.folders, files: scope.files });
}
