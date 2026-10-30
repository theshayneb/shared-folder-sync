import { Notice, Plugin, TAbstractFile } from "obsidian";
import { encodeInvite } from "./invite";
import { inScope, parsePathList, ShareScope } from "./scope";
import {
	DEFAULT_SETTINGS,
	MIN_INTERVAL_SECONDS,
	SharedFolderSyncSettings,
	SharedFolderSyncSettingTab,
} from "./settings";
import { emptyState, runSync, SyncState } from "./sync-engine";
import { createTransport, pingMailbox } from "./transport";
import { VaultStore } from "./vault-store";

interface PluginData {
	settings: SharedFolderSyncSettings;
	/**
	 * Sync progress per device. data.json can itself be copied between your
	 * own devices (for example by Obsidian Sync), so each device keeps its own
	 * entry, keyed by an id that never leaves the device.
	 */
	states: Record<string, SyncState>;
}

const DEVICE_ID_KEY = "shared-folder-sync-device-id";

interface SettingsChange {
	connectionChanged?: boolean;
	scopeChanged?: boolean;
	intervalChanged?: boolean;
}

/** Wait this long after the last edit to a shared file before syncing. */
const EDIT_DEBOUNCE_MS = 3000;

export default class SharedFolderSyncPlugin extends Plugin {
	settings: SharedFolderSyncSettings = { ...DEFAULT_SETTINGS };
	private deviceId = "";
	private states: Record<string, SyncState> = {};
	private state: SyncState = emptyState();
	private running = false;
	private runAgain = false;
	private intervalId: number | null = null;
	private editTimer: number | null = null;
	private lastStatus = "Not synced yet.";
	private lastErrorShown = "";

	async onload(): Promise<void> {
		await this.loadPluginData();
		this.addSettingTab(new SharedFolderSyncSettingTab(this.app, this));

		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => void this.syncNow(true),
		});
		this.addCommand({
			id: "copy-invite",
			name: "Copy invite for the other person",
			callback: () => void this.copyInvite(),
		});
		this.addRibbonIcon("refresh-cw", "Sync shared folder", () => void this.syncNow(true));

		const onVaultChange = (file: TAbstractFile, oldPath?: string) => {
			const scope = this.scope();
			if (inScope(scope, file.path) || (oldPath !== undefined && inScope(scope, oldPath))) {
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

	scope(): ShareScope {
		return { folders: parsePathList(this.settings.folders), files: parsePathList(this.settings.files) };
	}

	private isConfigured(): boolean {
		const scope = this.scope();
		return (
			this.settings.webAppUrl !== "" &&
			this.settings.shareCode !== "" &&
			scope.folders.length + scope.files.length > 0
		);
	}

	statusText(): string {
		return this.lastStatus;
	}

	async syncNow(manual: boolean): Promise<void> {
		if (!this.isConfigured()) {
			if (manual) {
				new Notice("Set the web app URL, share code and at least one shared folder or file first.");
			}
			return;
		}
		if (this.running) {
			this.runAgain = true;
			return;
		}
		this.running = true;
		try {
			let pushed = 0;
			let pulled = 0;
			do {
				this.runAgain = false;
				const summary = await runSync({
					store: new VaultStore(this.app, this.scope()),
					transport: createTransport(this.settings.webAppUrl, this.settings.shareCode),
					scope: this.scope(),
					device: this.deviceId,
					state: this.state,
					saveState: () => this.savePluginData(),
				});
				pushed += summary.pushed;
				pulled += summary.pulled;
			} while (this.runAgain);
			this.lastStatus = `Last synced ${new Date().toLocaleTimeString()}.`;
			this.lastErrorShown = "";
			if (manual) {
				new Notice(`Shared folder synced: ${pushed} sent, ${pulled} received.`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.lastStatus = `Sync failed: ${message}`;
			// Background syncs repeat; show each distinct failure once.
			if (manual || message !== this.lastErrorShown) {
				new Notice(`Shared folder sync failed: ${message}`);
				this.lastErrorShown = message;
			}
		} finally {
			this.running = false;
		}
	}

	async testConnection(): Promise<void> {
		try {
			await pingMailbox(this.settings.webAppUrl, this.settings.shareCode);
			new Notice("Connected to the mailbox.");
		} catch (error) {
			new Notice(error instanceof Error ? error.message : String(error));
		}
	}

	async copyInvite(): Promise<void> {
		if (!this.isConfigured()) {
			new Notice("Set the web app URL, share code and at least one shared folder or file first.");
			return;
		}
		const invite = encodeInvite({
			url: this.settings.webAppUrl,
			shareCode: this.settings.shareCode,
			scope: this.scope(),
		});
		try {
			await navigator.clipboard.writeText(invite);
			new Notice("Invite copied. Send it privately.");
		} catch {
			new Notice("Couldn't copy to the clipboard.");
		}
	}

	async saveSettings(change: SettingsChange): Promise<void> {
		if (change.connectionChanged) {
			// A different mailbox has its own history; start over against it.
			this.state = emptyState();
			this.states = {};
		}
		await this.savePluginData();
		if (change.intervalChanged) {
			this.restartInterval();
		}
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
		const data = ((await this.loadData()) ?? {}) as Partial<PluginData>;
		this.settings = { ...DEFAULT_SETTINGS, ...data.settings };
		this.states = data.states ?? {};
		const stored: unknown = this.app.loadLocalStorage(DEVICE_ID_KEY);
		if (typeof stored === "string" && stored !== "") {
			this.deviceId = stored;
		} else {
			this.deviceId = Math.random().toString(36).slice(2, 10);
			this.app.saveLocalStorage(DEVICE_ID_KEY, this.deviceId);
		}
		this.state = this.states[this.deviceId] ?? emptyState();
	}

	private async savePluginData(): Promise<void> {
		this.states[this.deviceId] = this.state;
		const data: PluginData = { settings: this.settings, states: this.states };
		await this.saveData(data);
	}
}
