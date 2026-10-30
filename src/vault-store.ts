import { App, TFile } from "obsidian";
import { inScope, ShareScope } from "./scope";
import { LocalFile, LocalStore } from "./sync-engine";

export class VaultStore implements LocalStore {
	constructor(
		private readonly app: App,
		private readonly scope: ShareScope,
	) {}

	list(): Promise<LocalFile[]> {
		return Promise.resolve(
			this.app.vault
				.getFiles()
				.filter((file) => inScope(this.scope, file.path))
				.map((file) => ({ path: file.path, mtime: file.stat.mtime })),
		);
	}

	async read(path: string): Promise<string | null> {
		const file = this.app.vault.getFileByPath(path);
		return file ? this.app.vault.read(file) : null;
	}

	async write(path: string, content: string): Promise<void> {
		const existing = this.app.vault.getFileByPath(path);
		if (existing) {
			await this.app.vault.modify(existing, content);
			return;
		}
		await this.ensureFolder(path.slice(0, Math.max(0, path.lastIndexOf("/"))));
		await this.app.vault.create(path, content);
	}

	async remove(path: string): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		if (file instanceof TFile) {
			await this.app.fileManager.trashFile(file);
		}
	}

	private async ensureFolder(folder: string): Promise<void> {
		if (folder === "" || this.app.vault.getFolderByPath(folder)) {
			return;
		}
		await this.ensureFolder(folder.slice(0, Math.max(0, folder.lastIndexOf("/"))));
		await this.app.vault.createFolder(folder);
	}
}
