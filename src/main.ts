import { App, FuzzySuggestModal, Notice, Platform, Plugin, TAbstractFile } from "obsidian";
import {
	canonicalJson,
	liveShares,
	MIN_INTERVAL_SECONDS,
	Mailbox,
	mergeData,
	pruneTombstones,
	readData,
	ReadResult,
	serializeData,
	ShareConfig,
	ShareEntry,
	SyncedData,
	emptyData,
} from "./config";
import { encodeInvite, Invite } from "./invite";
import { inScope, parsePathList, ShareScope, scopeKey } from "./scope";
import { SharedFolderSyncSettingTab } from "./settings";
import { emptyState, runSync, scanLocal, SyncState } from "./sync-engine";
import { createShare, createTransport, MailboxError, pingMailbox, revokeShare } from "./transport";
import { VaultStore } from "./vault-store";

// Local storage keys. Local storage belongs to this device and this vault,
// and Obsidian Sync never carries it.
const DEVICE_ID_KEY = "shared-folder-sync-device-id";
const BACKGROUND_KEY = "shared-folder-sync-background";
const stateKey = (shareId: string) => `shared-folder-sync-state-${shareId}`;

/** Wait this long after the last edit to a shared file before syncing. */
const EDIT_DEBOUNCE_MS = 3000;
/** Wait this long after the last keystroke in settings before saving. */
const SAVE_DEBOUNCE_MS = 1000;
/** How often to look again while waiting for Obsidian Sync to settle. */
const SETTLE_RETRY_MS = 15_000;

/**
 * Obsidian Sync writes what other devices did as ordinary file changes, so
 * nothing automatic happens until it has likely caught up. When the core
 * Sync plugin says it is idle, shorter waits are enough; when it can't tell
 * us, wait longer. Mirrors plex-to-obsidian's syncSettled().
 */
export const SETTLE = {
	afterStart: 3 * 60_000,
	quiet: 60_000,
	afterStartWhenIdle: 30_000,
	quietWhenIdle: 15_000,
};

function newId(): string {
	return Math.random().toString(36).slice(2, 10);
}

type CoreSync = { enabled?: boolean; instance?: { syncing?: unknown } } | null | undefined;

/** The core Sync plugin, through undocumented internals; any of it may be missing. */
function coreSync(app: App): CoreSync {
	try {
		const internal = (app as unknown as { internalPlugins?: { getPluginById?: (id: string) => CoreSync } })
			.internalPlugins;
		return internal?.getPluginById?.("sync");
	} catch {
		return undefined;
	}
}

class ShareSuggestModal extends FuzzySuggestModal<ShareConfig> {
	constructor(
		app: App,
		private readonly shares: ShareConfig[],
		private readonly onPick: (share: ShareConfig) => void,
	) {
		super(app);
		this.setPlaceholder("Pick a share to copy its invite");
	}
	getItems(): ShareConfig[] {
		return this.shares;
	}
	getItemText(share: ShareConfig): string {
		return share.name;
	}
	onChooseItem(share: ShareConfig): void {
		this.onPick(share);
	}
}

export default class SharedFolderSyncPlugin extends Plugin {
	/** Settings shared by your devices (data.json). */
	data: SyncedData = emptyData();
	private deviceId = "";
	private legacyStates: ReadResult["legacyStates"] = {};
	/** Per-device sync progress, and what was last written to local storage. */
	private states = new Map<string, SyncState>();
	private savedStates = new Map<string, string>();

	private saveChain: Promise<void> = Promise.resolve();
	private running = false;
	private runAgain = false;
	private intervalId: number | null = null;
	private intervalSeconds = 0;
	private editTimer: number | null = null;
	private saveTimer: number | null = null;
	private settleTimer: number | null = null;
	private pendingTimer: number | null = null;

	private readonly startedAt = Date.now();
	private resumedAt = 0;
	private lastVaultChange = 0;
	private waitingForSettle = false;
	private pendingCount = 0;
	private lastSynced: number | null = null;
	private statuses = new Map<string, string>();
	private lastErrorShown = new Map<string, string>();
	private statusBarEl: HTMLElement | null = null;
	private settingTab: SharedFolderSyncSettingTab | null = null;

	async onload(): Promise<void> {
		await this.loadAll();
		this.settingTab = new SharedFolderSyncSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
		this.statusBarEl = this.addStatusBarItem();

		this.addCommand({
			id: "sync-now",
			name: "Send changes now",
			callback: () => void this.syncNow(true),
		});
		this.addCommand({
			id: "copy-invite",
			name: "Copy invite for a share",
			callback: () => {
				const shares = this.shares();
				if (shares.length === 0) {
					new Notice("There are no shares yet. Create one in settings.");
					return;
				}
				new ShareSuggestModal(this.app, shares, (share) => void this.copyInvite(share)).open();
			},
		});
		this.addRibbonIcon("refresh-cw", "Send shared folder changes now", () => void this.syncNow(true));

		const onVaultChange = (file: TAbstractFile, oldPath?: string) => {
			this.lastVaultChange = Date.now();
			const touched = this.shares().some((share) => {
				const scope = this.scopeOf(share);
				return inScope(scope, file.path) || (oldPath !== undefined && inScope(scope, oldPath));
			});
			if (touched) {
				this.scheduleEditSync();
				this.schedulePendingCount();
			}
		};
		this.registerEvent(this.app.vault.on("modify", (file) => onVaultChange(file)));
		this.registerEvent(this.app.vault.on("create", (file) => onVaultChange(file)));
		this.registerEvent(this.app.vault.on("delete", (file) => onVaultChange(file)));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => onVaultChange(file, oldPath)));

		// A laptop waking up, or a phone returning: Obsidian Sync has catching
		// up to do, so it gets the same head start as a fresh launch.
		this.registerDomEvent(activeDocument, "visibilitychange", () => {
			if (activeDocument.visibilityState === "visible") {
				this.resumedAt = Date.now();
				this.requestAutoSync();
			}
		});

		this.app.workspace.onLayoutReady(() => {
			this.restartInterval();
			this.requestAutoSync();
			this.schedulePendingCount();
		});
	}

	onunload(): void {
		for (const timer of [this.editTimer, this.saveTimer, this.settleTimer, this.pendingTimer]) {
			if (timer !== null) {
				window.clearTimeout(timer);
			}
		}
	}

	/**
	 * Another device changed data.json and Obsidian Sync brought it here.
	 * Merge it with what this device holds, keeping the newest version of
	 * each entry, and save only if that changed the file.
	 */
	async onExternalSettingsChange(): Promise<void> {
		await this.persist();
		this.restartInterval();
		this.settingTab?.refresh();
		this.requestAutoSync();
		this.schedulePendingCount();
	}

	// ---- Shares and settings ------------------------------------------------

	shares(): ShareConfig[] {
		return liveShares(this.data);
	}

	scopeOf(share: Pick<ShareEntry, "folders" | "files">): ShareScope {
		return { folders: parsePathList(share.folders), files: parsePathList(share.files) };
	}

	/** Shares in your own mailbox, whose paths this vault sets for everyone. */
	isOwnedShare(share: ShareConfig): boolean {
		const { url, ownerCode } = this.data.mailbox.value;
		return ownerCode !== "" && share.webAppUrl === url;
	}

	private hasMailbox(): boolean {
		const { url, ownerCode } = this.data.mailbox.value;
		return url !== "" && ownerCode !== "";
	}

	/** Records an edit you made to a share and saves it (after typing stops, with `debounce`). */
	async updateShare(id: string, patch: Partial<ShareEntry>, debounce = false): Promise<void> {
		const share = this.data.shares[id];
		if (!share) {
			return;
		}
		Object.assign(share, patch, { updatedAt: Date.now() });
		if ("folders" in patch || "files" in patch) {
			this.scheduleEditSync();
		}
		await this.save(debounce);
	}

	async setMailbox(patch: Partial<Mailbox>): Promise<void> {
		this.data.mailbox = { value: { ...this.data.mailbox.value, ...patch }, updatedAt: Date.now() };
		await this.save(true);
	}

	async setIntervalSeconds(seconds: number): Promise<void> {
		this.data.intervalSeconds = { value: Math.max(MIN_INTERVAL_SECONDS, seconds), updatedAt: Date.now() };
		await this.save(true);
		this.restartInterval();
	}

	private async save(debounce: boolean): Promise<void> {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		if (debounce) {
			this.saveTimer = window.setTimeout(() => {
				this.saveTimer = null;
				void this.persist();
			}, SAVE_DEBOUNCE_MS);
			return;
		}
		await this.persist();
	}

	/**
	 * Read, merge, then write: re-read data.json, keep the newest version of
	 * every entry from it and from memory, and write only if that adds
	 * something the file doesn't already say. Saves run one at a time.
	 *
	 * "Already says" is judged by content, not by layout: a file written in an
	 * older format (say, by a device still running 0.2.0) is not rewritten
	 * just to change its format, or two versions would rewrite it back and
	 * forth. Keys this version doesn't own are left as they are.
	 */
	persist(): Promise<void> {
		this.saveChain = this.saveChain
			.then(async () => {
				const now = Date.now();
				const raw: unknown = await this.loadData();
				const disk = pruneTombstones(readData(raw).data, now);
				const merged = pruneTombstones(mergeData(disk, this.data), now);
				this.data = merged;
				if (canonicalJson(merged) === canonicalJson(disk)) {
					return;
				}
				const others = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
				await this.saveData({ ...others, ...serializeData(merged) });
			})
			.catch((error: unknown) => {
				console.error("Shared Folder Sync: couldn't save settings", error);
			});
		return this.saveChain;
	}

	// ---- This device ----------------------------------------------------------

	/**
	 * Whether this device talks to the mailbox on its own. Stored on this
	 * device only. Defaults to on for desktops, and on for a phone or tablet
	 * where Obsidian Sync is off, since nothing else would bring changes there.
	 */
	isBackgroundOn(): boolean {
		const stored: unknown = this.app.loadLocalStorage(BACKGROUND_KEY);
		if (typeof stored === "boolean") {
			return stored;
		}
		return Platform.isDesktopApp || coreSync(this.app)?.enabled === false;
	}

	setBackground(on: boolean): void {
		this.app.saveLocalStorage(BACKGROUND_KEY, on);
		this.restartInterval();
		if (on) {
			this.requestAutoSync();
			this.schedulePendingCount();
		}
		this.updateStatusBar();
	}

	/**
	 * Whether Obsidian Sync has likely caught up since Obsidian started or
	 * came back, with no file changes for a while and Sync not busy.
	 */
	syncSettled(now = Date.now()): boolean {
		const sync = coreSync(this.app);
		const syncing = sync?.enabled ? sync.instance?.syncing : undefined;
		if (syncing === true) {
			return false;
		}
		const idleKnown = syncing === false;
		const start = Math.max(this.startedAt, this.resumedAt);
		const afterStart = idleKnown ? SETTLE.afterStartWhenIdle : SETTLE.afterStart;
		const quiet = idleKnown ? SETTLE.quietWhenIdle : SETTLE.quiet;
		return now - start >= afterStart && now - this.lastVaultChange >= quiet;
	}

	// ---- Syncing ----------------------------------------------------------------

	private canSync(share: ShareConfig): boolean {
		if (share.webAppUrl === "" || share.shareCode === "") {
			return false;
		}
		// A joined share with no paths yet still syncs, to learn them.
		const scope = this.scopeOf(share);
		return share.joined || scope.folders.length + scope.files.length > 0;
	}

	statusText(share: ShareConfig): string {
		if (!this.isBackgroundOn()) {
			return "Synced by your always-on device. Changes reach this device through Obsidian Sync.";
		}
		if (!this.canSync(share)) {
			return "Add at least one folder or file to start sharing.";
		}
		const status = this.statuses.get(share.id) ?? "Not synced yet.";
		return this.waitingForSettle ? `${status} Waiting for Obsidian Sync to finish…` : status;
	}

	/** Automatic syncing: only with background tasks on, and once Sync has settled. */
	requestAutoSync(): void {
		if (!this.isBackgroundOn()) {
			return;
		}
		if (!this.syncSettled()) {
			this.waitingForSettle = true;
			this.updateStatusBar();
			if (this.settleTimer === null) {
				this.settleTimer = window.setTimeout(() => {
					this.settleTimer = null;
					this.requestAutoSync();
				}, SETTLE_RETRY_MS);
			}
			return;
		}
		this.waitingForSettle = false;
		void this.runShares(false);
	}

	/**
	 * You asked to sync now. Skips the wait for Obsidian Sync, because you
	 * chose to. Devices without background tasks leave syncing to your
	 * always-on device.
	 */
	async syncNow(manual: boolean, onlyShareId?: string): Promise<void> {
		if (!this.isBackgroundOn()) {
			if (manual) {
				new Notice(
					"Syncing runs on your always-on device. Turn on background tasks in settings to sync from this one.",
				);
			}
			return;
		}
		await this.runShares(manual, onlyShareId);
	}

	private async runShares(manual: boolean, onlyShareId?: string): Promise<void> {
		const pick = (all: boolean) =>
			this.shares().filter((s) => all || onlyShareId === undefined || s.id === onlyShareId);
		if (manual && !pick(false).some((s) => this.canSync(s))) {
			new Notice("There's nothing to sync yet. Add folders or files to a share in settings.");
			return;
		}
		if (this.running) {
			this.runAgain = true;
			return;
		}
		this.running = true;
		try {
			// A request made while this ran may be for any share (a new
			// join, say), so repeat passes cover them all.
			let first = true;
			do {
				this.runAgain = false;
				for (const share of pick(!first)) {
					if (this.canSync(share) && this.data.shares[share.id]?.deletedAt === undefined) {
						await this.syncShare(share.id, manual);
					}
				}
				first = false;
			} while (this.runAgain);
		} finally {
			this.running = false;
			await this.countPending();
		}
	}

	private async syncShare(id: string, manual: boolean): Promise<void> {
		const entry = () => this.data.shares[id];
		const name = entry()?.name ?? "Shared folder";
		try {
			let pushed = 0;
			let pulled = 0;
			// The second pass runs only when the owner changed the paths.
			for (let pass = 0; pass < 2; pass++) {
				const share = entry();
				if (!share) {
					return;
				}
				const scope = this.scopeOf(share);
				const config: ShareConfig = { ...share, id };
				const summary = await runSync({
					store: new VaultStore(this.app, scope),
					transport: createTransport(share.webAppUrl, share.shareCode),
					scope,
					device: this.deviceId,
					state: this.stateFor(id),
					ownerKey:
						this.isOwnedShare(config) && !share.joined ? this.data.mailbox.value.ownerCode : undefined,
					saveState: () => Promise.resolve(this.saveState(id)),
				});
				pushed += summary.pushed + summary.merged;
				pulled += summary.pulled;
				const remote = summary.remoteScope;
				if (!share.joined || !remote || scopeKey(remote) === scopeKey(scope)) {
					break;
				}
				await this.updateShare(id, {
					folders: remote.folders.join("\n"),
					files: remote.files.join("\n"),
				});
			}
			this.lastSynced = Date.now();
			this.statuses.set(id, `Last synced ${new Date(this.lastSynced).toLocaleTimeString()}.`);
			this.lastErrorShown.delete(id);
			if (manual) {
				new Notice(`${name} synced: ${pushed} sent, ${pulled} received.`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.statuses.set(id, `Sync failed: ${message}`);
			// Background syncs repeat; show each distinct failure once.
			if (manual || message !== this.lastErrorShown.get(id)) {
				new Notice(`${name} didn't sync: ${message}`);
				this.lastErrorShown.set(id, message);
			}
		}
	}

	private stateFor(id: string): SyncState {
		let state = this.states.get(id);
		if (state) {
			return state;
		}
		const stored: unknown = this.app.loadLocalStorage(stateKey(id));
		if (stored && typeof stored === "object" && "cursor" in stored && "files" in stored) {
			state = stored as SyncState;
			this.savedStates.set(id, JSON.stringify(state));
		} else {
			// Progress that 0.2.0 kept in data.json, if this device has any.
			state = this.legacyStates[this.deviceId]?.[id] ?? emptyState();
		}
		this.states.set(id, state);
		return state;
	}

	/** Writes a share's sync progress to local storage, only if it changed. */
	private saveState(id: string): void {
		const state = this.states.get(id);
		if (!state) {
			return;
		}
		const json = JSON.stringify(state);
		if (this.savedStates.get(id) !== json) {
			this.app.saveLocalStorage(stateKey(id), state);
			this.savedStates.set(id, json);
		}
	}

	private scheduleEditSync(): void {
		if (!this.isBackgroundOn()) {
			return;
		}
		if (this.editTimer !== null) {
			window.clearTimeout(this.editTimer);
		}
		this.editTimer = window.setTimeout(() => {
			this.editTimer = null;
			this.requestAutoSync();
		}, EDIT_DEBOUNCE_MS);
	}

	private restartInterval(): void {
		const seconds = this.isBackgroundOn() ? this.data.intervalSeconds.value : 0;
		if (seconds === this.intervalSeconds) {
			return;
		}
		if (this.intervalId !== null) {
			window.clearInterval(this.intervalId);
			this.intervalId = null;
		}
		this.intervalSeconds = seconds;
		if (seconds > 0) {
			this.intervalId = window.setInterval(() => this.requestAutoSync(), seconds * 1000);
			this.registerInterval(this.intervalId);
		}
	}

	// ---- Waiting-to-send indicator ------------------------------------------------

	private schedulePendingCount(): void {
		if (this.pendingTimer !== null) {
			window.clearTimeout(this.pendingTimer);
		}
		this.pendingTimer = window.setTimeout(() => {
			this.pendingTimer = null;
			void this.countPending();
		}, 1000);
	}

	/** Counts local edits not yet sent, for the status bar. */
	private async countPending(): Promise<void> {
		let count = 0;
		if (this.isBackgroundOn()) {
			for (const share of this.shares()) {
				if (this.canSync(share)) {
					const scope = this.scopeOf(share);
					const scan = await scanLocal(new VaultStore(this.app, scope), scope, this.stateFor(share.id));
					count += scan.changes.length;
				}
			}
		}
		this.pendingCount = count;
		this.updateStatusBar();
	}

	pendingText(): string {
		if (!this.isBackgroundOn() || this.shares().length === 0) {
			return "";
		}
		if (this.pendingCount > 0) {
			const noun = this.pendingCount === 1 ? "change" : "changes";
			return this.waitingForSettle
				? `Shared: ${this.pendingCount} ${noun} waiting for Obsidian Sync`
				: `Shared: ${this.pendingCount} ${noun} waiting to send`;
		}
		return this.lastSynced === null ? "" : `Shared: synced ${new Date(this.lastSynced).toLocaleTimeString()}`;
	}

	private updateStatusBar(): void {
		this.statusBarEl?.setText(this.pendingText());
	}

	// ---- Mailbox actions you start --------------------------------------------------

	async testMailbox(): Promise<void> {
		if (!this.hasMailbox()) {
			new Notice("Enter the web app URL and owner code first.");
			return;
		}
		const { url, ownerCode } = this.data.mailbox.value;
		try {
			const { owner } = await pingMailbox(url, ownerCode);
			new Notice(
				owner
					? "Connected to your mailbox."
					: "That's a share code, not the owner code. The owner code is printed by setup.",
			);
		} catch (error) {
			new Notice(error instanceof Error ? error.message : String(error));
		}
	}

	/** Returns true when the share was created. */
	async createShare(name: string): Promise<boolean> {
		const cleanName = name.trim() || "Shared folder";
		const { url, ownerCode } = this.data.mailbox.value;
		try {
			const code = await createShare(url, ownerCode, cleanName);
			this.data.shares[newId()] = {
				name: cleanName,
				webAppUrl: url,
				shareCode: code,
				folders: "",
				files: "",
				joined: false,
				updatedAt: Date.now(),
			};
			await this.persist();
			new Notice(`Created ${cleanName}. Add its folders and files, then copy the invite.`);
			return true;
		} catch (error) {
			new Notice(error instanceof Error ? error.message : String(error));
			return false;
		}
	}

	async joinShare(invite: Invite): Promise<void> {
		const existing = this.shares().find((s) => s.webAppUrl === invite.url && s.shareCode === invite.shareCode);
		if (existing) {
			new Notice(`You've already joined ${existing.name}.`);
			return;
		}
		const id = newId();
		this.data.shares[id] = {
			name: invite.name,
			webAppUrl: invite.url,
			shareCode: invite.shareCode,
			folders: invite.scope.folders.join("\n"),
			files: invite.scope.files.join("\n"),
			joined: true,
			updatedAt: Date.now(),
		};
		await this.persist();
		if (this.isBackgroundOn()) {
			await this.syncNow(true, id);
		} else {
			new Notice(`Joined ${invite.name}. Your always-on device will start syncing it.`);
		}
	}

	/**
	 * Removes a share from this vault. For a share in your own mailbox it is
	 * also deleted there, so its code stops working for everyone. Shared
	 * files stay in the vault either way.
	 */
	async removeShare(share: ShareConfig): Promise<void> {
		if (this.isOwnedShare(share) && !share.joined) {
			const { url, ownerCode } = this.data.mailbox.value;
			try {
				await revokeShare(url, ownerCode, share.shareCode);
			} catch (error) {
				// Already gone from the mailbox is fine; anything else stops here.
				const gone = error instanceof MailboxError && error.message.includes("doesn't know this code");
				if (!gone) {
					new Notice(error instanceof Error ? error.message : String(error));
					return;
				}
			}
		}
		const entry = this.data.shares[share.id];
		if (entry) {
			const now = Date.now();
			Object.assign(entry, { deletedAt: now, updatedAt: now });
		}
		this.states.delete(share.id);
		this.savedStates.delete(share.id);
		this.app.saveLocalStorage(stateKey(share.id), null);
		this.statuses.delete(share.id);
		await this.persist();
		new Notice(`Removed ${share.name}. Its files stay in your vault.`);
	}

	async copyInvite(share: ShareConfig): Promise<void> {
		const invite = encodeInvite({
			name: share.name,
			url: share.webAppUrl,
			shareCode: share.shareCode,
			scope: this.scopeOf(share),
		});
		try {
			await navigator.clipboard.writeText(invite);
			new Notice(`Invite for ${share.name} copied. Send it privately.`);
		} catch {
			new Notice("Couldn't copy to the clipboard.");
		}
	}

	// ---- Loading ----------------------------------------------------------------------

	/** Reads data.json and this device's id. Writes nothing to data.json. */
	private async loadAll(): Promise<void> {
		const read = readData(await this.loadData());
		this.data = read.data;
		this.legacyStates = read.legacyStates;

		const stored: unknown = this.app.loadLocalStorage(DEVICE_ID_KEY);
		if (typeof stored === "string" && stored !== "") {
			this.deviceId = stored;
		} else {
			this.deviceId = newId();
			this.app.saveLocalStorage(DEVICE_ID_KEY, this.deviceId);
		}
	}
}
