import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { decodeInvite } from "./invite";
import type SharedFolderSyncPlugin from "./main";

export interface SharedFolderSyncSettings {
	webAppUrl: string;
	shareCode: string;
	/** Newline-separated folder paths. */
	folders: string;
	/** Newline-separated file paths, such as a .base file. */
	files: string;
	intervalSeconds: number;
}

export const DEFAULT_SETTINGS: SharedFolderSyncSettings = {
	webAppUrl: "",
	shareCode: "",
	folders: "",
	files: "",
	intervalSeconds: 30,
};

export const MIN_INTERVAL_SECONDS = 10;

export class SharedFolderSyncSettingTab extends PluginSettingTab {
	private joinText = "";

	constructor(
		app: App,
		private readonly plugin: SharedFolderSyncPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const settings = this.plugin.settings;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Join with an invite")
			.setDesc("Paste the invite the other person copied from their settings. It fills in everything below.")
			.addText((text) =>
				text.setPlaceholder("Paste invite").onChange((value) => {
					this.joinText = value;
				}),
			)
			.addButton((button) =>
				button.setButtonText("Join").onClick(async () => {
					const invite = decodeInvite(this.joinText);
					if (!invite) {
						new Notice("That isn't a valid invite.");
						return;
					}
					settings.webAppUrl = invite.url;
					settings.shareCode = invite.shareCode;
					settings.folders = invite.scope.folders.join("\n");
					settings.files = invite.scope.files.join("\n");
					await this.plugin.saveSettings({ connectionChanged: true });
					this.display();
					await this.plugin.syncNow(true);
				}),
			);

		new Setting(containerEl).setName("Mailbox").setHeading();

		new Setting(containerEl)
			.setName("Web app URL")
			.setDesc("The address shown after you deploy the mailbox script. It ends in /exec.")
			.addText((text) =>
				text
					.setPlaceholder("Paste web app URL")
					.setValue(settings.webAppUrl)
					.onChange(async (value) => {
						settings.webAppUrl = value.trim();
						await this.plugin.saveSettings({ connectionChanged: true });
					}),
			);

		new Setting(containerEl)
			.setName("Share code")
			.setDesc("Printed when you run setup in the mailbox script.")
			.addText((text) => {
				text.inputEl.type = "password";
				text.setValue(settings.shareCode).onChange(async (value) => {
					settings.shareCode = value.trim();
					await this.plugin.saveSettings({ connectionChanged: true });
				});
			})
			.addButton((button) =>
				button.setButtonText("Test").onClick(async () => {
					await this.plugin.testConnection();
				}),
			);

		new Setting(containerEl).setName("What to share").setHeading();

		new Setting(containerEl)
			.setName("Folders")
			.setDesc("One per line, from the vault root. Notes, bases, canvases and text files inside are shared.")
			.addTextArea((text) =>
				text
					.setPlaceholder("One folder per line")
					.setValue(settings.folders)
					.onChange(async (value) => {
						settings.folders = value;
						await this.plugin.saveSettings({ scopeChanged: true });
					}),
			);

		new Setting(containerEl)
			.setName("Single files")
			.setDesc("One per line, from the vault root. Use this for a base that lives outside the shared folder.")
			.addTextArea((text) =>
				text
					.setPlaceholder("One file per line")
					.setValue(settings.files)
					.onChange(async (value) => {
						settings.files = value;
						await this.plugin.saveSettings({ scopeChanged: true });
					}),
			);

		new Setting(containerEl)
			.setName("Copy invite")
			.setDesc(
				"Copies one line with the URL, share code and shared paths. Send it privately: anyone with it can edit the shared notes.",
			)
			.addButton((button) =>
				button.setButtonText("Copy invite").onClick(async () => {
					await this.plugin.copyInvite();
				}),
			);

		new Setting(containerEl).setName("Syncing").setHeading();

		new Setting(containerEl)
			.setName("Check for changes every (seconds)")
			.setDesc(`Edits in shared files also sync a few seconds after you make them. Minimum ${MIN_INTERVAL_SECONDS}.`)
			.addText((text) =>
				text.setValue(String(settings.intervalSeconds)).onChange(async (value) => {
					const seconds = Number.parseInt(value, 10);
					if (Number.isFinite(seconds) && seconds >= MIN_INTERVAL_SECONDS) {
						settings.intervalSeconds = seconds;
						await this.plugin.saveSettings({ intervalChanged: true });
					}
				}),
			);

		const status = new Setting(containerEl).setName("Sync now").setDesc(this.plugin.statusText());
		status.addButton((button) =>
			button.setButtonText("Sync now").onClick(async () => {
				await this.plugin.syncNow(true);
				status.setDesc(this.plugin.statusText());
			}),
		);
	}
}
