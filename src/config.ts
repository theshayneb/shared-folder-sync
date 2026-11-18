import { SyncState } from "./sync-engine";

/**
 * What lives in data.json, and so travels between your devices through
 * Obsidian Sync: the shares, your mailbox and the check interval.
 *
 * Obsidian Sync settles a conflict in data.json by laying one device's
 * top-level keys over the other's, so a device that saves last can carry
 * stale copies of everything. To keep that harmless, every entry records
 * when you last edited it (`updatedAt`), deleted shares stay behind as
 * tombstones (`deletedAt`), and every save first re-reads the file and keeps
 * the newest version of each entry (`mergeData`).
 *
 * Anything that belongs to one device (sync progress, the background-tasks
 * switch) is in local storage instead and never written here.
 */

export interface ShareEntry {
	name: string;
	webAppUrl: string;
	shareCode: string;
	/** Newline-separated folder paths. */
	folders: string;
	/** Newline-separated file paths, such as a .base file. */
	files: string;
	/**
	 * True when this vault joined through an invite: the paths then follow
	 * whatever the share's owner sets.
	 */
	joined: boolean;
	/** When this share was last edited, on any device (ms). */
	updatedAt: number;
	/** Set when the share was deleted; the entry stays as a tombstone. */
	deletedAt?: number;
}

/** A share as the rest of the plugin uses it. */
export type ShareConfig = ShareEntry & { id: string };

export interface Stamped<T> {
	value: T;
	updatedAt: number;
}

export interface Mailbox {
	url: string;
	ownerCode: string;
}

export interface SyncedData {
	mailbox: Stamped<Mailbox>;
	intervalSeconds: Stamped<number>;
	shares: Record<string, ShareEntry>;
}

export const DATA_FORMAT = 3;
export const DEFAULT_INTERVAL_SECONDS = 30;
export const MIN_INTERVAL_SECONDS = 10;
/** Tombstones older than this are dropped. */
export const TOMBSTONE_DAYS = 180;

/**
 * Stamp for values nobody has set. Below 0, which is what data from versions
 * before 0.3.0 gets, so neither can ever beat a real edit.
 */
const UNSET = -1;
/** Stamp for entries read from a version before 0.3.0. */
const LEGACY = 0;

/** Share id given to the single share that version 0.1.0 stored. */
export const LEGACY_SHARE_ID = "legacy";

export function emptyData(): SyncedData {
	return {
		mailbox: { value: { url: "", ownerCode: "" }, updatedAt: UNSET },
		intervalSeconds: { value: DEFAULT_INTERVAL_SECONDS, updatedAt: UNSET },
		shares: {},
	};
}

export function liveShares(data: SyncedData): ShareConfig[] {
	return Object.entries(data.shares)
		.filter(([, share]) => share.deletedAt === undefined)
		.map(([id, share]) => ({ ...share, id }));
}

const shareStamp = (s: ShareEntry) => Math.max(s.updatedAt, s.deletedAt ?? -Infinity);

/**
 * Picks the newer of two versions. On a tie the larger serialized value
 * wins, so every device picks the same one and they don't bounce.
 */
function newer<T>(a: T, b: T, stamp: (x: T) => number): T {
	const sa = stamp(a);
	const sb = stamp(b);
	if (sa !== sb) {
		return sa > sb ? a : b;
	}
	return canonicalJson(a) >= canonicalJson(b) ? a : b;
}

/** Keeps the newest version of every entry. Order of a and b doesn't matter. */
export function mergeData(a: SyncedData, b: SyncedData): SyncedData {
	const shares: Record<string, ShareEntry> = {};
	for (const id of new Set([...Object.keys(a.shares), ...Object.keys(b.shares)])) {
		const x = a.shares[id];
		const y = b.shares[id];
		shares[id] = x && y ? newer(x, y, shareStamp) : (x ?? y)!;
	}
	return {
		mailbox: newer(a.mailbox, b.mailbox, (m) => m.updatedAt),
		intervalSeconds: newer(a.intervalSeconds, b.intervalSeconds, (m) => m.updatedAt),
		shares,
	};
}

/** Drops tombstones old enough that no device can still hold the share. */
export function pruneTombstones(data: SyncedData, now: number): SyncedData {
	const cutoff = now - TOMBSTONE_DAYS * 24 * 60 * 60 * 1000;
	const shares = Object.fromEntries(
		Object.entries(data.shares).filter(([, s]) => s.deletedAt === undefined || s.deletedAt >= cutoff),
	);
	return { ...data, shares };
}

/** What gets written to data.json. */
export function serializeData(data: SyncedData): Record<string, unknown> {
	return {
		format: DATA_FORMAT,
		mailbox: data.mailbox,
		intervalSeconds: data.intervalSeconds,
		shares: data.shares,
	};
}

/** JSON with sorted keys, to compare two values regardless of key order. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, v: unknown) =>
		v && typeof v === "object" && !Array.isArray(v)
			? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : 1)))
			: v,
	);
}

export interface ReadResult {
	data: SyncedData;
	/** Sync progress kept in data.json before 0.3.0, per device then share. */
	legacyStates: Record<string, Record<string, SyncState>>;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function readShare(raw: unknown, stamp: number | null): ShareEntry | null {
	if (!isObject(raw)) {
		return null;
	}
	const share: ShareEntry = {
		name: str(raw.name) || "Shared folder",
		webAppUrl: str(raw.webAppUrl),
		shareCode: str(raw.shareCode),
		folders: str(raw.folders),
		files: str(raw.files),
		joined: raw.joined === true,
		updatedAt: stamp ?? num(raw.updatedAt, LEGACY),
	};
	if (stamp === null && typeof raw.deletedAt === "number") {
		share.deletedAt = raw.deletedAt;
	}
	return share;
}

/**
 * Reads data.json as any version wrote it, never dropping anything.
 *
 * A device still on 0.1.0 or 0.2.0 keeps writing its old `settings` key for
 * as long as it runs. Those shares join in with the oldest possible stamp:
 * they can add a share this version doesn't know, but never undo an edit or
 * bring back a deleted share.
 */
export function readData(raw: unknown): ReadResult {
	const data = emptyData();
	const legacyStates: Record<string, Record<string, SyncState>> = {};
	if (!isObject(raw)) {
		return { data, legacyStates };
	}

	if (isObject(raw.mailbox) && isObject(raw.mailbox.value)) {
		data.mailbox = {
			value: { url: str(raw.mailbox.value.url), ownerCode: str(raw.mailbox.value.ownerCode) },
			updatedAt: num(raw.mailbox.updatedAt, LEGACY),
		};
	}
	if (isObject(raw.intervalSeconds)) {
		data.intervalSeconds = {
			value: Math.max(MIN_INTERVAL_SECONDS, num(raw.intervalSeconds.value, DEFAULT_INTERVAL_SECONDS)),
			updatedAt: num(raw.intervalSeconds.updatedAt, LEGACY),
		};
	}
	if (isObject(raw.shares)) {
		for (const [id, value] of Object.entries(raw.shares)) {
			const share = readShare(value, null);
			if (share) {
				data.shares[id] = share;
			}
		}
	}

	return { data: mergeData(data, readLegacy(raw, legacyStates)), legacyStates };
}

/** The `settings` and `states` keys written by 0.1.0 and 0.2.0. */
function readLegacy(raw: Record<string, unknown>, legacyStates: ReadResult["legacyStates"]): SyncedData {
	const data = emptyData();
	const settings = isObject(raw.settings) ? raw.settings : null;
	if (settings) {
		if (str(settings.mailboxUrl) !== "" || str(settings.ownerCode) !== "") {
			data.mailbox = {
				value: { url: str(settings.mailboxUrl), ownerCode: str(settings.ownerCode) },
				updatedAt: LEGACY,
			};
		}
		if (typeof settings.intervalSeconds === "number") {
			data.intervalSeconds = {
				value: Math.max(MIN_INTERVAL_SECONDS, settings.intervalSeconds),
				updatedAt: LEGACY,
			};
		}
		if (Array.isArray(settings.shares)) {
			for (const value of settings.shares) {
				const share = readShare(value, LEGACY);
				if (share && isObject(value) && typeof value.id === "string" && value.id !== "") {
					data.shares[value.id] = share;
				}
			}
		} else if (str(settings.webAppUrl) !== "" && str(settings.shareCode) !== "") {
			// 0.1.0: one share, stored in the settings themselves.
			data.shares[LEGACY_SHARE_ID] = {
				name: "Shared folder",
				webAppUrl: str(settings.webAppUrl),
				shareCode: str(settings.shareCode),
				folders: str(settings.folders),
				files: str(settings.files),
				joined: false,
				updatedAt: LEGACY,
			};
		}
	}

	if (isObject(raw.states)) {
		for (const [device, value] of Object.entries(raw.states)) {
			if (isObject(value)) {
				legacyStates[device] =
					"cursor" in value
						? { [LEGACY_SHARE_ID]: value as unknown as SyncState }
						: (value as Record<string, SyncState>);
			}
		}
	}
	return data;
}
