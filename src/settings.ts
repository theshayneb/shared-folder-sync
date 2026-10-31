import { App, ButtonComponent, Notice, PluginSettingTab, Setting } from "obsidian";
import { MIN_INTERVAL_SECONDS, ShareConfig } from "./config";
import { decodeInvite } from "./invite";
import type SharedFolderSyncPlugin from "./main";

/** Turns a button into a two-step confirm so one stray tap can't delete. */
function confirmButton(button: ButtonComponent, label: string, onConfirm: () => Promise<void>) {
	let armed = false;
	button.setButtonText(label).onClick(async () => {
		if (!armed) {
			armed = true;
			// setWarning() is deprecated and its replacement needs Obsidian 1.13.
			button.setButtonText("Tap again to confirm");
			button.buttonEl.addClass("mod-warning");
			window.setTimeout(() => {
				armed = false;
				button.setButtonText(label);
				button.buttonEl.removeClass("mod-warning");
			}, 4000);
			return;
		}
		await onConfirm();
	});
}

export class SharedFolderSyncSettingTab extends PluginSettingTab {
	private joinText = "";
	private newShareName = "";

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
			.setDesc("Paste an invite someone sent you. Each invite adds one share.")
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
					await this.plugin.joinShare(invite);
					this.display();
				}),
			);

		new Setting(containerEl).setName("Shares").setHeading();
		if (settings.shares.length === 0) {
			containerEl.createEl("p", {
				text: "No shares yet. Create one below, or join one with an invite.",
				cls: "setting-item-description",
			});
		}
		for (const share of settings.shares) {
			this.displayShare(containerEl, share);
		}

		new Setting(containerEl).setName("New share").setHeading();
		const hasMailbox = settings.mailboxUrl !== "" && settings.ownerCode !== "";
		new Setting(containerEl)
			.setName("Create a share")
			.setDesc(
				hasMailbox
					? "Give it a name, then pick its folders and files. Each share gets its own code, so you can share different things with different people."
					: "Set up your mailbox below first.",
			)
			.addText((text) =>
				text
					.setPlaceholder("Name, for example groceries")
					.setDisabled(!hasMailbox)
					.onChange((value) => {
						this.newShareName = value;
					}),
			)
			.addButton((button) =>
				button
					.setButtonText("Create")
					.setCta()
					.setDisabled(!hasMailbox)
					.onClick(async () => {
						if (await this.plugin.createShare(this.newShareName)) {
							this.newShareName = "";
							this.display();
						}
					}),
			);

		new Setting(containerEl).setName("Your mailbox").setHeading();
		new Setting(containerEl)
			.setName("Web app URL")
			.setDesc("The address shown after you deploy the mailbox script. It ends in /exec.")
			.addText((text) =>
				text
					.setPlaceholder("Paste web app URL")
					.setValue(settings.mailboxUrl)
					.onChange(async (value) => {
						settings.mailboxUrl = value.trim();
						await this.plugin.saveSettings();
					}),
			);
		new Setting(containerEl)
			.setName("Owner code")
			.setDesc(
				"Printed when you run setup in the mailbox script. Lets this vault create and delete shares. Never send it to anyone.",
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text.setValue(settings.ownerCode).onChange(async (value) => {
					settings.ownerCode = value.trim();
					await this.plugin.saveSettings();
				});
			})
			.addButton((button) =>
				button.setButtonText("Test").onClick(async () => {
					await this.plugin.testMailbox();
					this.display();
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
	}

	private displayShare(containerEl: HTMLElement, share: ShareConfig): void {
		const owned = this.plugin.isOwnedShare(share);
		const block = containerEl.createDiv({ cls: "shared-folder-sync-share" });
		new Setting(block).setName(share.name).setHeading();

		new Setting(block)
			.setName("Name")
			.setDesc(share.joined ? "Shared with you. The name is only shown here." : "Shown in the invite.")
			.addText((text) =>
				text.setValue(share.name).onChange(async (value) => {
					share.name = value.trim() || "Shared folder";
					await this.plugin.saveSettings();
				}),
			);

		const pathsDesc = share.joined
			? "Set by the person who shared this with you."
			: "One per line, from the vault root. Notes, bases, canvases and text files inside are shared.";
		new Setting(block)
			.setName("Folders")
			.setDesc(pathsDesc)
			.addTextArea((text) =>
				text
					.setPlaceholder("One folder per line")
					.setValue(share.folders)
					.setDisabled(share.joined)
					.onChange(async (value) => {
						share.folders = value;
						await this.plugin.saveSettings({ scopeChanged: true });
					}),
			);
		new Setting(block)
			.setName("Single files")
			.setDesc(share.joined ? pathsDesc : "One per line, from the vault root, such as a base kept in another folder.")
			.addTextArea((text) =>
				text
					.setPlaceholder("One file per line")
					.setValue(share.files)
					.setDisabled(share.joined)
					.onChange(async (value) => {
						share.files = value;
						await this.plugin.saveSettings({ scopeChanged: true });
					}),
			);

		const status = new Setting(block).setName("Status").setDesc(this.plugin.statusText(share));
		status
			.addButton((button) =>
				button.setButtonText("Sync now").onClick(async () => {
					await this.plugin.syncNow(true, share.id);
					status.setDesc(this.plugin.statusText(share));
				}),
			)
			.addButton((button) =>
				button.setButtonText("Copy invite").onClick(async () => {
					await this.plugin.copyInvite(share);
				}),
			)
			.addButton((button) =>
				confirmButton(button, owned && !share.joined ? "Delete share" : "Leave", async () => {
					await this.plugin.removeShare(share);
					this.display();
				}),
			);
	}
}
