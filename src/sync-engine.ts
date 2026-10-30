import { inScope, ShareScope } from "./scope";

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
	cursor: number;
	device: string;
	changes: PushChange[];
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
}

export type Transport = (request: SyncRequest) => Promise<SyncResponse>;

export interface FileRecord {
	/** Hash of the content both sides agreed on; "" for a deleted file. */
	hash: string;
	rev: number;
	/** Local mtime when the hash was taken, to skip rereading unchanged files. */
	mtime?: number;
}

export interface SyncState {
	cursor: number;
	files: Record<string, FileRecord>;
}

export interface SyncSummary {
	pushed: number;
	pulled: number;
}

const DELETED = "";
const BATCH_SIZE = 50;

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
	/** Called after every round trip so progress survives a crash. */
	saveState: (state: SyncState) => Promise<void>;
	now?: () => number;
}

/**
 * One sync pass: push what changed here since the last pass, then apply what
 * the other side changed. The server settles conflicting edits of the same
 * file; a local edit made while a pass runs is kept and pushed next pass.
 */
export async function runSync(opts: SyncEngineOptions): Promise<SyncSummary> {
	const { store, transport, scope, device, state } = opts;
	const now = opts.now ?? (() => Date.now());
	const summary: SyncSummary = { pushed: 0, pulled: 0 };

	const changes: PushChange[] = [];
	const present = new Set<string>();
	for (const file of await store.list()) {
		if (!inScope(scope, file.path)) {
			continue;
		}
		present.add(file.path);
		const record = state.files[file.path];
		if (record && record.hash !== DELETED && record.mtime === file.mtime) {
			continue;
		}
		const content = await store.read(file.path);
		if (content === null) {
			present.delete(file.path);
			continue;
		}
		const hash = hashContent(content);
		if (record && record.hash === hash) {
			record.mtime = file.mtime;
			continue;
		}
		changes.push({ path: file.path, content, baseRev: record?.rev ?? 0, mtime: file.mtime });
	}
	for (const [path, record] of Object.entries(state.files)) {
		if (record.hash !== DELETED && !present.has(path) && inScope(scope, path)) {
			changes.push({ path, content: null, baseRev: record.rev, mtime: now() });
		}
	}

	let offset = 0;
	do {
		const batch = changes.slice(offset, offset + BATCH_SIZE);
		offset += BATCH_SIZE;
		const response = await transport({ action: "sync", cursor: state.cursor, device, changes: batch });

		for (const result of response.results) {
			const pushed = batch.find((c) => c.path === result.path);
			if (!pushed) {
				continue;
			}
			if (result.status === "accepted") {
				state.files[result.path] = {
					hash: pushed.content === null ? DELETED : hashContent(pushed.content),
					rev: result.rev,
					mtime: pushed.content === null ? undefined : pushed.mtime,
				};
				summary.pushed++;
			} else if (result.current && inScope(scope, result.current.path)) {
				await applyRemote(store, state, result.current);
				summary.pulled++;
			}
		}

		for (const entry of response.changes) {
			if (!inScope(scope, entry.path)) {
				continue;
			}
			const record = state.files[entry.path];
			if (record && record.rev >= entry.rev) {
				continue;
			}
			const remoteHash = entry.deleted || entry.content === null ? DELETED : hashContent(entry.content);
			const local = await store.read(entry.path);
			const localHash = local === null ? DELETED : hashContent(local);
			if (localHash === remoteHash) {
				state.files[entry.path] = { hash: remoteHash, rev: entry.rev };
				continue;
			}
			const untouchedHere = record ? localHash === record.hash : local === null;
			if (!untouchedHere) {
				// Edited here during this pass; the next pass pushes it and the
				// server decides which edit is newer.
				continue;
			}
			await applyRemote(store, state, entry);
			summary.pulled++;
		}

		state.cursor = Math.max(state.cursor, response.rev);
		await opts.saveState(state);
	} while (offset < changes.length);

	return summary;
}

async function applyRemote(store: LocalStore, state: SyncState, entry: RemoteEntry): Promise<void> {
	if (entry.deleted || entry.content === null) {
		if ((await store.read(entry.path)) !== null) {
			await store.remove(entry.path);
		}
		state.files[entry.path] = { hash: DELETED, rev: entry.rev };
	} else {
		await store.write(entry.path, entry.content);
		state.files[entry.path] = { hash: hashContent(entry.content), rev: entry.rev };
	}
}
