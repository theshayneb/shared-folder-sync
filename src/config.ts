import { SyncState } from "./sync-engine";

export interface ShareConfig {
	/** Local id; never sent anywhere. */
	id: string;
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
}

export interface SharedFolderSyncSettings {
	/** Your own mailbox, used to create shares. */
	mailboxUrl: string;
	ownerCode: string;
	shares: ShareConfig[];
	intervalSeconds: number;
}

export const DEFAULT_SETTINGS: SharedFolderSyncSettings = {
	mailboxUrl: "",
	ownerCode: "",
	shares: [],
	intervalSeconds: 30,
};

export const MIN_INTERVAL_SECONDS = 10;

export interface PluginData {
	settings: SharedFolderSyncSettings;
	/**
	 * Sync progress per device, then per share. data.json can itself be
	 * copied between your own devices (for example by Obsidian Sync), so each
	 * device keeps its own entry, keyed by an id that never leaves the device.
	 */
	states: Record<string, Record<string, SyncState>>;
}

/** Share id given to the single share that version 0.1.0 stored. */
export const LEGACY_SHARE_ID = "legacy";

/**
 * Reads saved data from any version. Version 0.1.0 kept one share's
 * connection in the settings and one sync state per device; that becomes a
 * share, so nothing has to be set up again.
 */
export function migrateData(data: Record<string, unknown>): PluginData {
	const raw = (data.settings ?? {}) as Record<string, unknown>;
	const str = (v: unknown) => (typeof v === "string" ? v : "");
	const settings: SharedFolderSyncSettings = {
		mailboxUrl: str(raw.mailboxUrl),
		ownerCode: str(raw.ownerCode),
		shares: Array.isArray(raw.shares) ? (raw.shares as ShareConfig[]) : [],
		intervalSeconds:
			typeof raw.intervalSeconds === "number" ? raw.intervalSeconds : DEFAULT_SETTINGS.intervalSeconds,
	};

	const rawStates = (data.states ?? {}) as Record<string, unknown>;
	const states: Record<string, Record<string, SyncState>> = {};
	for (const [device, value] of Object.entries(rawStates)) {
		if (typeof value !== "object" || value === null) {
			continue;
		}
		states[device] =
			"cursor" in value
				? { [LEGACY_SHARE_ID]: value as SyncState }
				: (value as Record<string, SyncState>);
	}

	if (!Array.isArray(raw.shares) && str(raw.webAppUrl) !== "" && str(raw.shareCode) !== "") {
		settings.shares.push({
			id: LEGACY_SHARE_ID,
			name: "Shared folder",
			webAppUrl: str(raw.webAppUrl),
			shareCode: str(raw.shareCode),
			folders: str(raw.folders),
			files: str(raw.files),
			joined: false,
		});
	}
	return { settings, states };
}
