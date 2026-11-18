import { mergeVersions } from "./merge";
import { inScope, ShareScope, scopeKey } from "./scope";

export interface LocalFile {
	path: string;
	mtime: number;
}

/** The slice of the vault being shared. */
export interface LocalStore {
	/** Shared files that exist on this device. */
	list(): Promise<LocalFile[]>;
	/** Returns null when the file doesn't exist. */
	read(path: string): Promise<string | null>;
	/** Creates or overwrites the file, creating parent folders. */
	write(path: string, content: string): Promise<void>;
	remove(path: string): Promise<void>;
}

export interface RemoteEntry {
	path: string;
	rev: number;
	content: string | null;
	deleted: boolean;
	mtime: number;
}

export interface PushChange {
	path: string;
	/** null means the file was deleted. */
	content: string | null;
	baseRev: number;
	mtime: number;
}

export interface SyncRequest {
	action: "sync";
	/** Protocol 3: the mailbox rejects every concurrent change, and we merge. */
	v: 3;
	cursor: number;
	device: string;
	changes: PushChange[];
	/** Sent by the share's owner so other members adopt these paths. */
	scope?: ShareScope;
	ownerKey?: string;
}

export interface PushResult {
	path: string;
	status: "accepted" | "rejected";
	rev: number;
	current?: RemoteEntry;
}

export interface SyncResponse {
	rev: number;
	results: PushResult[];
	changes: RemoteEntry[];
	/** The share's paths as last set by its owner, or null if never set. */
	scope: ShareScope | null;
}

export type Transport = (request: SyncRequest) => Promise<SyncResponse>;

export interface FileRecord {
	/** Hash of the content both sides agreed on; "" for a deleted file. */
	hash: string;
	rev: number;
	/** Local mtime when the hash was taken, to skip rereading unchanged files. */
	mtime?: number;
	/**
	 * The agreed content itself, the starting point for merging two edits.
	 * Left out for large files, which then merge by newest file time.
	 */
	base?: string;
}

export interface SyncState {
	cursor: number;
	files: Record<string, FileRecord>;
	/** The shared paths at the last pass. */
	scopeKey?: string;
}

export interface SyncSummary {
	pushed: number;
	pulled: number;
	/** Files where both sides had changed and were merged. */
	merged: number;
	/** The share's paths according to the mailbox, from the last response. */
	remoteScope: ShareScope | null;
}

const DELETED = "";
const BATCH_SIZE = 50;
/** Files larger than this keep no base copy (see FileRecord.base). */
export const MAX_BASE_LENGTH = 100_000;
/** How many times one pass merges and re-sends the same file. */
const MAX_MERGE_ATTEMPTS = 3;

export function emptyState(): SyncState {
	return { cursor: 0, files: {} };
}

/** cyrb53: a fast 53-bit string hash. Collisions only cost a skipped sync. */
export function hashContent(text: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return "h" + (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export interface SyncEngineOptions {
	store: LocalStore;
	transport: Transport;
	scope: ShareScope;
	device: string;
	state: SyncState;
	/** The owner code, when this device owns the share and sets its paths. */
	ownerKey?: string;
	/**
	 * Called after every round trip so progress survives a crash. The caller
	 * stores it only when it actually changed.
	 */
	saveState: (state: SyncState) => Promise<void>;
	now?: () => number;
}

function record(content: string | null, rev: number, mtime?: number): FileRecord {
	if (content === null) {
		return { hash: DELETED, rev };
	}
	const rec: FileRecord = { hash: hashContent(content), rev };
	if (mtime !== undefined) {
		rec.mtime = mtime;
	}
	if (content.length <= MAX_BASE_LENGTH) {
		rec.base = content;
	}
	return rec;
}

function isNote(path: string): boolean {
	return path.toLowerCase().endsWith(".md");
}

export interface LocalScan {
	/** Local edits not yet in the mailbox. */
	changes: PushChange[];
	/** Files whose mtime moved but whose content is still what was agreed. */
	touched: Array<[path: string, mtime: number]>;
}

/**
 * Finds local edits without changing anything, so it can also count what
 * is waiting to be sent.
 */
export async function scanLocal(
	store: LocalStore,
	scope: ShareScope,
	state: SyncState,
	now: () => number = () => Date.now(),
): Promise<LocalScan> {
	const scan: LocalScan = { changes: [], touched: [] };
	const present = new Set<string>();
	for (const file of await store.list()) {
		if (!inScope(scope, file.path)) {
			continue;
		}
		present.add(file.path);
		const rec = state.files[file.path];
		if (rec && rec.hash !== DELETED && rec.mtime === file.mtime) {
			continue;
		}
		const content = await store.read(file.path);
		if (content === null) {
			present.delete(file.path);
			continue;
		}
		if (rec && rec.hash === hashContent(content)) {
			scan.touched.push([file.path, file.mtime]);
			continue;
		}
		scan.changes.push({ path: file.path, content, baseRev: rec?.rev ?? 0, mtime: file.mtime });
	}
	for (const [path, rec] of Object.entries(state.files)) {
		if (rec.hash !== DELETED && !present.has(path) && inScope(scope, path)) {
			scan.changes.push({ path, content: null, baseRev: rec.rev, mtime: now() });
		}
	}
	return scan;
}

/**
 * One sync pass: push what changed here since the last pass, then apply what
 * the other side changed.
 *
 * When someone else changed a file we also changed, the mailbox sends their
 * version back. We merge the two against the version both sides last agreed
 * on (see mergeVersions), write the result here and send it again, so a
 * late edit never replaces the other side's work wholesale.
 */
export async function runSync(opts: SyncEngineOptions): Promise<SyncSummary> {
	const { store, transport, scope, device, state } = opts;
	const now = opts.now ?? (() => Date.now());
	const summary: SyncSummary = { pushed: 0, pulled: 0, merged: 0, remoteScope: null };

	// Files newly in scope may have arrived earlier and been skipped, so
	// fetch everything again. Files already in step are skipped cheaply.
	const key = scopeKey(scope);
	if (state.scopeKey !== key) {
		state.cursor = 0;
		state.scopeKey = key;
	}

	const scan = await scanLocal(store, scope, state, now);
	for (const [path, mtime] of scan.touched) {
		const rec = state.files[path];
		if (rec) {
			rec.mtime = mtime;
		}
	}
	const queue = scan.changes;
	const attempts = new Map<string, number>();

	let first = true;
	while (first || queue.length > 0) {
		first = false;
		const batch = queue.splice(0, BATCH_SIZE);
		const request: SyncRequest = { action: "sync", v: 3, cursor: state.cursor, device, changes: batch };
		if (opts.ownerKey) {
			request.scope = scope;
			request.ownerKey = opts.ownerKey;
		}
		const response = await transport(request);
		summary.remoteScope = response.scope ?? null;

		for (const result of response.results) {
			const pushed = batch.find((c) => c.path === result.path);
			if (!pushed) {
				continue;
			}
			if (result.status === "accepted") {
				state.files[result.path] = record(pushed.content, result.rev, pushed.mtime);
				summary.pushed++;
				continue;
			}
			const current = result.current;
			if (!current || !inScope(scope, current.path)) {
				continue;
			}
			const tries = (attempts.get(pushed.path) ?? 0) + 1;
			attempts.set(pushed.path, tries);
			const retry = await mergeRejected(store, state, pushed, current, tries);
			if (retry) {
				queue.push(retry);
				summary.merged++;
			} else {
				summary.pulled++;
			}
		}

		for (const entry of response.changes) {
			if (!inScope(scope, entry.path)) {
				continue;
			}
			const rec = state.files[entry.path];
			if (rec && rec.rev >= entry.rev) {
				continue;
			}
			const remote = entry.deleted ? null : entry.content;
			const remoteHash = remote === null ? DELETED : hashContent(remote);
			const local = await store.read(entry.path);
			const localHash = local === null ? DELETED : hashContent(local);
			if (localHash === remoteHash) {
				state.files[entry.path] = record(remote, entry.rev);
				continue;
			}
			const untouchedHere = rec ? localHash === rec.hash : local === null;
			if (!untouchedHere) {
				// Edited here during this pass; the next pass sends it and
				// merges it with this version.
				continue;
			}
			await applyRemote(store, state, entry);
			summary.pulled++;
		}

		state.cursor = Math.max(state.cursor, response.rev);
		await opts.saveState(state);
	}

	return summary;
}

/**
 * Handles a push the mailbox turned down because someone else changed the
 * file first. Returns the merged version to send again, or null when the
 * other side's version was simply taken.
 */
async function mergeRejected(
	store: LocalStore,
	state: SyncState,
	pushed: PushChange,
	current: RemoteEntry,
	tries: number,
): Promise<PushChange | null> {
	const remote = current.deleted ? null : current.content;
	const local = await store.read(pushed.path);
	if (local !== pushed.content) {
		// Edited again while this pass ran: leave it for the next pass.
		return null;
	}
	const base = state.files[pushed.path]?.base ?? null;
	const merged = mergeVersions(base, local, remote, pushed.mtime, current.mtime, isNote(pushed.path));

	// From here on, the other side's version is the agreed starting point.
	state.files[pushed.path] = record(remote, current.rev);
	if (merged === remote) {
		await applyRemote(store, state, current);
		return null;
	}
	if (tries > MAX_MERGE_ATTEMPTS) {
		return null;
	}
	if (merged !== local) {
		if (merged === null) {
			await store.remove(pushed.path);
		} else {
			await store.write(pushed.path, merged);
		}
	}
	return {
		path: pushed.path,
		content: merged,
		baseRev: current.rev,
		mtime: Math.max(pushed.mtime, current.mtime),
	};
}

async function applyRemote(store: LocalStore, state: SyncState, entry: RemoteEntry): Promise<void> {
	const content = entry.deleted ? null : entry.content;
	if (content === null) {
		if ((await store.read(entry.path)) !== null) {
			await store.remove(entry.path);
		}
	} else {
		await store.write(entry.path, content);
	}
	state.files[entry.path] = record(content, entry.rev);
}
