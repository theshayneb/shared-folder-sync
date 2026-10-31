import { App, FuzzySuggestModal, Notice, Plugin, TAbstractFile } from "obsidian";
import { encodeInvite, Invite } from "./invite";
import { inScope, parsePathList, ShareScope, scopeKey } from "./scope";
import {
	DEFAULT_SETTINGS,
	migrateData,
	MIN_INTERVAL_SECONDS,
	PluginData,
	ShareConfig,
	SharedFolderSyncSettings,
} from "./config";
import { SharedFolderSyncSettingTab } from "./settings";
import { emptyState, runSync, SyncState } from "./sync-engine";
import { createShare, createTransport, MailboxError, pingMailbox, revokeShare } from "./transport";
import { VaultStore } from "./vault-store";

interface SettingsChange {
	scopeChanged?: boolean;
	intervalChanged?: boolean;
}

const DEVICE_ID_KEY = "shared-folder-sync-device-id";

/** Wait this long after the last edit to a shared file before syncing. */
const EDIT_DEBOUNCE_MS = 3000;

function newId(): string {
	return Math.random().toString(36).slice(2, 10);
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
	settings: SharedFolderSyncSettings = { ...DEFAULT_SETTINGS, shares: [] };
	private deviceId = "";
	private states: Record<string, Record<string, SyncState>> = {};
	private running = false;
	private runAgain = false;
	private intervalId: number | null = null;
	private editTimer: number | null = null;
	private statuses = new Map<string, string>();
	private lastErrorShown = new Map<string, string>();

	async onload(): Promise<void> {
		await this.loadPluginData();
		this.addSettingTab(new SharedFolderSyncSettingTab(this.app, this));

		this.addCommand({
			id: "sync-now",
			name: "Sync all shares now",
			callback: () => void this.syncNow(true),
		});
		this.addCommand({
			id: "copy-invite",
			name: "Copy invite for a share",
			callback: () => {
				if (this.settings.shares.length === 0) {
					new Notice("There are no shares yet. Create one in settings.");
					return;
				}
				new ShareSuggestModal(this.app, this.settings.shares, (share) => void this.copyInvite(share)).open();
			},
		});
		this.addRibbonIcon("refresh-cw", "Sync shared folders", () => void this.syncNow(true));

		const onVaultChange = (file: TAbstractFile, oldPath?: string) => {
			const touched = this.settings.shares.some((share) => {
				const scope = this.scopeOf(share);
				return inScope(scope, file.path) || (oldPath !== undefined && inScope(scope, oldPath));
			});
			if (touched) {
				this.scheduleEditSync();
			}
		};
		this.registerEvent(this.app.vault.on("modify", (file) => onVaultChange(file)));
		this.registerEvent(this.app.vault.on("create", (file) => onVaultChange(file)));
		this.registerEvent(this.app.vault.on("delete", (file) => onVaultChange(file)));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => onVaultChange(file, oldPath)));

		// Phones pause apps in the background, so catch up when Obsidian returns.
		this.registerDomEvent(activeDocument, "visibilitychange", () => {
			if (activeDocument.visibilityState === "visible") {
				void this.syncNow(false);
			}
		});

		this.app.workspace.onLayoutReady(() => {
			this.restartInterval();
			void this.syncNow(false);
		});
	}

	onunload(): void {
		if (this.editTimer !== null) {
			window.clearTimeout(this.editTimer);
		}
	}

	scopeOf(share: ShareConfig): ShareScope {
		return { folders: parsePathList(share.folders), files: parsePathList(share.files) };
	}

	/** Shares in your own mailbox, whose paths this vault sets for everyone. */
	isOwnedShare(share: ShareConfig): boolean {
		return this.settings.ownerCode !== "" && share.webAppUrl === this.settings.mailboxUrl;
	}

	private hasMailbox(): boolean {
		return this.settings.mailboxUrl !== "" && this.settings.ownerCode !== "";
	}

	private canSync(share: ShareConfig): boolean {
		if (share.webAppUrl === "" || share.shareCode === "") {
			return false;
		}
		// A joined share with no paths yet still syncs, to learn them.
		const scope = this.scopeOf(share);
		return share.joined || scope.folders.length + scope.files.length > 0;
	}

	statusText(share: ShareConfig): string {
		if (!this.canSync(share)) {
			return "Add at least one folder or file to start sharing.";
		}
		return this.statuses.get(share.id) ?? "Not synced yet.";
	}

	/** Syncs every share, or only `onlyShareId`. */
	async syncNow(manual: boolean, onlyShareId?: string): Promise<void> {
		const pick = (all: boolean) =>
			this.settings.shares.filter((s) => all || onlyShareId === undefined || s.id === onlyShareId);
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
					if (this.canSync(share) && this.settings.shares.includes(share)) {
						await this.syncShare(share, manual);
					}
				}
				first = false;
			} while (this.runAgain);
		} finally {
			this.running = false;
		}
	}

	private async syncShare(share: ShareConfig, manual: boolean): Promise<void> {
		try {
			let pushed = 0;
			let pulled = 0;
			// The second pass runs only when the owner changed the paths.
			for (let pass = 0; pass < 2; pass++) {
				const scope = this.scopeOf(share);
				const summary = await runSync({
					store: new VaultStore(this.app, scope),
					transport: createTransport(share.webAppUrl, share.shareCode),
					scope,
					device: this.deviceId,
					state: this.stateFor(share),
					ownerKey: this.isOwnedShare(share) && !share.joined ? this.settings.ownerCode : undefined,
					saveState: () => this.savePluginData(),
				});
				pushed += summary.pushed;
				pulled += summary.pulled;
				const remote = summary.remoteScope;
				if (!share.joined || !remote || scopeKey(remote) === scopeKey(scope)) {
					break;
				}
				share.folders = remote.folders.join("\n");
				share.files = remote.files.join("\n");
				await this.savePluginData();
			}
			this.statuses.set(share.id, `Last synced ${new Date().toLocaleTimeString()}.`);
			this.lastErrorShown.delete(share.id);
			if (manual) {
				new Notice(`${share.name} synced: ${pushed} sent, ${pulled} received.`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.statuses.set(share.id, `Sync failed: ${message}`);
			// Background syncs repeat; show each distinct failure once.
			if (manual || message !== this.lastErrorShown.get(share.id)) {
				new Notice(`${share.name} didn't sync: ${message}`);
				this.lastErrorShown.set(share.id, message);
			}
		}
	}

	async testMailbox(): Promise<void> {
		if (!this.hasMailbox()) {
			new Notice("Enter the web app URL and owner code first.");
			return;
		}
		try {
			const { owner } = await pingMailbox(this.settings.mailboxUrl, this.settings.ownerCode);
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
		try {
			const code = await createShare(this.settings.mailboxUrl, this.settings.ownerCode, cleanName);
			this.settings.shares.push({
				id: newId(),
				name: cleanName,
				webAppUrl: this.settings.mailboxUrl,
				shareCode: code,
				folders: "",
				files: "",
				joined: false,
			});
			await this.savePluginData();
			new Notice(`Created ${cleanName}. Add its folders and files, then copy the invite.`);
			return true;
		} catch (error) {
			new Notice(error instanceof Error ? error.message : String(error));
			return false;
		}
	}

	async joinShare(invite: Invite): Promise<void> {
		const existing = this.settings.shares.find(
			(s) => s.webAppUrl === invite.url && s.shareCode === invite.shareCode,
		);
		if (existing) {
			new Notice(`You've already joined ${existing.name}.`);
			return;
		}
		const share: ShareConfig = {
			id: newId(),
			name: invite.name,
			webAppUrl: invite.url,
			shareCode: invite.shareCode,
			folders: invite.scope.folders.join("\n"),
			files: invite.scope.files.join("\n"),
			joined: true,
		};
		this.settings.shares.push(share);
		await this.savePluginData();
		await this.syncNow(true, share.id);
	}

	/**
	 * Removes a share from this vault. For a share in your own mailbox it is
	 * also deleted there, so its code stops working for everyone. Shared
	 * files stay in the vault either way.
	 */
	async removeShare(share: ShareConfig): Promise<void> {
		if (this.isOwnedShare(share) && !share.joined) {
			try {
				await revokeShare(this.settings.mailboxUrl, this.settings.ownerCode, share.shareCode);
			} catch (error) {
				// Already gone from the mailbox is fine; anything else stops here.
				const gone = error instanceof MailboxError && error.message.includes("doesn't know this code");
				if (!gone) {
					new Notice(error instanceof Error ? error.message : String(error));
					return;
				}
			}
		}
		this.settings.shares = this.settings.shares.filter((s) => s.id !== share.id);
		for (const perShare of Object.values(this.states)) {
			delete perShare[share.id];
		}
		this.statuses.delete(share.id);
		await this.savePluginData();
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

	async saveSettings(change: SettingsChange = {}): Promise<void> {
		await this.savePluginData();
		if (change.intervalChanged) {
			this.restartInterval();
		}
		if (change.scopeChanged) {
			this.scheduleEditSync();
		}
	}

	private stateFor(share: ShareConfig): SyncState {
		const perShare = (this.states[this.deviceId] ??= {});
		return (perShare[share.id] ??= emptyState());
	}

	private scheduleEditSync(): void {
		if (this.editTimer !== null) {
			window.clearTimeout(this.editTimer);
		}
		this.editTimer = window.setTimeout(() => {
			this.editTimer = null;
			void this.syncNow(false);
		}, EDIT_DEBOUNCE_MS);
	}

	private restartInterval(): void {
		if (this.intervalId !== null) {
			window.clearInterval(this.intervalId);
		}
		const seconds = Math.max(MIN_INTERVAL_SECONDS, this.settings.intervalSeconds);
		this.intervalId = window.setInterval(() => void this.syncNow(false), seconds * 1000);
		this.registerInterval(this.intervalId);
	}

	private async loadPluginData(): Promise<void> {
		const data = ((await this.loadData()) ?? {}) as Record<string, unknown>;
		const migrated = migrateData(data);
		this.settings = migrated.settings;
		this.states = migrated.states;

		const stored: unknown = this.app.loadLocalStorage(DEVICE_ID_KEY);
		if (typeof stored === "string" && stored !== "") {
			this.deviceId = stored;
		} else {
			this.deviceId = newId();
			this.app.saveLocalStorage(DEVICE_ID_KEY, this.deviceId);
		}
	}

	private async savePluginData(): Promise<void> {
		const data: PluginData = { settings: this.settings, states: this.states };
		await this.saveData(data);
	}
}
