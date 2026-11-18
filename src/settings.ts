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

	/**
	 * Redraws after another device's settings arrived, unless you're typing
	 * in one of the fields, which a redraw would interrupt.
	 */
	refresh(): void {
		const { containerEl } = this;
		if (!containerEl.isConnected) {
			return;
		}
		const focused = activeDocument.activeElement;
		if (focused && containerEl.contains(focused) && focused.matches("input, textarea")) {
			return;
		}
		this.display();
	}

	display(): void {
		const { containerEl, plugin } = this;
		const background = plugin.isBackgroundOn();
		containerEl.empty();

		new Setting(containerEl).setName("This device").setHeading();
		new Setting(containerEl)
			.setName("Run background tasks on this device")
			.setDesc(
				"Talks to the mailbox: checks for changes, sends your edits and writes incoming notes. Turn this on for one always-on device. Your other devices get shared notes through Obsidian Sync. Saved on this device only.",
			)
			.addToggle((toggle) =>
				toggle.setValue(background).onChange((value) => {
					plugin.setBackground(value);
					this.display();
				}),
			);

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
					await plugin.joinShare(invite);
					this.display();
				}),
			);

		new Setting(containerEl).setName("Shares").setHeading();
		const shares = plugin.shares();
		if (shares.length === 0) {
			containerEl.createEl("p", {
				text: "No shares yet. Create one below, or join one with an invite.",
				cls: "setting-item-description",
			});
		}
		for (const share of shares) {
			this.displayShare(containerEl, share, background);
		}

		new Setting(containerEl).setName("New share").setHeading();
		const { url, ownerCode } = plugin.data.mailbox.value;
		const hasMailbox = url !== "" && ownerCode !== "";
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
						if (await plugin.createShare(this.newShareName)) {
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
					.setValue(url)
					.onChange((value) => void plugin.setMailbox({ url: value.trim() })),
			);
		new Setting(containerEl)
			.setName("Owner code")
			.setDesc(
				"Printed when you run setup in the mailbox script. Lets this vault create and delete shares. Never send it to anyone.",
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text.setValue(ownerCode).onChange((value) => void plugin.setMailbox({ ownerCode: value.trim() }));
			})
			.addButton((button) =>
				button.setButtonText("Test").onClick(async () => {
					await plugin.testMailbox();
				}),
			);

		if (background) {
			new Setting(containerEl).setName("Syncing").setHeading();
			new Setting(containerEl)
				.setName("Check for changes every (seconds)")
				.setDesc(
					`Edits in shared files also sync shortly after you make them, once Obsidian Sync has finished. Minimum ${MIN_INTERVAL_SECONDS}.`,
				)
				.addText((text) =>
					text.setValue(String(plugin.data.intervalSeconds.value)).onChange((value) => {
						const seconds = Number.parseInt(value, 10);
						if (Number.isFinite(seconds) && seconds >= MIN_INTERVAL_SECONDS) {
							void plugin.setIntervalSeconds(seconds);
						}
					}),
				);
		}
	}

	private displayShare(containerEl: HTMLElement, share: ShareConfig, background: boolean): void {
		const { plugin } = this;
		const owned = plugin.isOwnedShare(share);
		const block = containerEl.createDiv({ cls: "shared-folder-sync-share" });
		new Setting(block).setName(share.name).setHeading();

		if (!background) {
			block.createEl("p", {
				text: "Background tasks are off on this device. Your always-on device syncs this share.",
				cls: "setting-item-description",
			});
		}

		new Setting(block)
			.setName("Name")
			.setDesc(share.joined ? "Shared with you. The name is only shown here." : "Shown in the invite.")
			.addText((text) =>
				text
					.setValue(share.name)
					.onChange(
						(value) => void plugin.updateShare(share.id, { name: value.trim() || "Shared folder" }, true),
					),
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
					.onChange((value) => void plugin.updateShare(share.id, { folders: value }, true)),
			);
		new Setting(block)
			.setName("Single files")
			.setDesc(share.joined ? pathsDesc : "One per line, from the vault root, such as a base kept in another folder.")
			.addTextArea((text) =>
				text
					.setPlaceholder("One file per line")
					.setValue(share.files)
					.setDisabled(share.joined)
					.onChange((value) => void plugin.updateShare(share.id, { files: value }, true)),
			);

		const status = new Setting(block).setName("Status").setDesc(plugin.statusText(share));
		if (background) {
			status.addButton((button) =>
				button.setButtonText("Send changes now").onClick(async () => {
					await plugin.syncNow(true, share.id);
					status.setDesc(plugin.statusText(share));
				}),
			);
		}
		status
			.addButton((button) =>
				button.setButtonText("Copy invite").onClick(async () => {
					await plugin.copyInvite(share);
				}),
			)
			.addButton((button) =>
				confirmButton(button, owned && !share.joined ? "Delete share" : "Leave", async () => {
					await plugin.removeShare(share);
					this.display();
				}),
			);
	}
}
