/**
 * Just enough of Obsidian's API to run the plugin in tests. Vitest maps
 * imports of "obsidian" here (vitest.config.mjs).
 */

type Handler = (...args: unknown[]) => unknown;

export const Platform = { isDesktopApp: true, isMobile: false };

export const notices: string[] = [];
export class Notice {
	constructor(message: string) {
		notices.push(message);
	}
}

export interface RequestUrlResponse {
	status: number;
	text: string;
	headers: Record<string, string>;
}

let requestHandler: ((body: unknown) => unknown) | null = null;
export const requests: unknown[] = [];

/** Routes the plugin's web requests to `handler`, which gets the parsed body. */
export function setRequestHandler(handler: ((body: unknown) => unknown) | null): void {
	requestHandler = handler;
	requests.length = 0;
}

export function requestUrl(options: { body?: string }): Promise<RequestUrlResponse> {
	const body: unknown = options.body ? JSON.parse(options.body) : null;
	requests.push(body);
	if (!requestHandler) {
		return Promise.reject(new Error("no network in tests"));
	}
	return Promise.resolve({ status: 200, text: JSON.stringify(requestHandler(body)), headers: {} });
}

export class TAbstractFile {
	constructor(public path: string) {}
}

export class TFile extends TAbstractFile {
	stat = { mtime: 0 };
}

export class TFolder extends TAbstractFile {}

/** An in-memory vault that fires the same events as Obsidian's. */
export class FakeVault {
	files = new Map<string, TFile & { content: string }>();
	folders = new Set<string>();
	private handlers = new Map<string, Handler[]>();

	on(name: string, handler: Handler) {
		this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
		return { name };
	}
	trigger(name: string, ...args: unknown[]) {
		for (const handler of this.handlers.get(name) ?? []) {
			handler(...args);
		}
	}

	/** An edit, as you'd make by hand or as Obsidian Sync writes one. */
	set(path: string, content: string) {
		const existing = this.files.get(path);
		const file = existing ?? Object.assign(new TFile(path), { content: "" });
		file.content = content;
		file.stat = { mtime: Date.now() };
		this.files.set(path, file);
		this.trigger(existing ? "modify" : "create", file);
	}

	getFiles() {
		return [...this.files.values()];
	}
	getFileByPath(path: string) {
		return this.files.get(path) ?? null;
	}
	getFolderByPath(path: string) {
		return this.folders.has(path) ? new TFolder(path) : null;
	}
	read(file: TFile & { content: string }) {
		return Promise.resolve(file.content);
	}
	modify(file: TFile, content: string) {
		this.set(file.path, content);
		return Promise.resolve();
	}
	create(path: string, content: string) {
		this.set(path, content);
		return Promise.resolve(this.files.get(path));
	}
	createFolder(path: string) {
		this.folders.add(path);
		return Promise.resolve();
	}
	delete(path: string) {
		const file = this.files.get(path);
		if (file) {
			this.files.delete(path);
			this.trigger("delete", file);
		}
	}
}

export class FakeApp {
	vault = new FakeVault();
	localStorage = new Map<string, string>();
	layoutReady: Array<() => void> = [];
	/** The core Sync plugin as the settle check reads it. */
	coreSync: { enabled: boolean; instance: { syncing?: boolean } } | null = {
		enabled: true,
		instance: { syncing: false },
	};
	internalPlugins = { getPluginById: (id: string) => (id === "sync" ? this.coreSync : null) };
	fileManager = {
		trashFile: (file: TFile) => {
			this.vault.delete(file.path);
			return Promise.resolve();
		},
	};
	workspace = {
		onLayoutReady: (cb: () => void) => {
			this.layoutReady.push(cb);
		},
	};

	loadLocalStorage(key: string): unknown {
		const raw = this.localStorage.get(key);
		return raw === undefined ? null : JSON.parse(raw);
	}
	saveLocalStorage(key: string, data: unknown): void {
		if (data === null) {
			this.localStorage.delete(key);
		} else {
			this.localStorage.set(key, JSON.stringify(data));
		}
	}
}

export type App = FakeApp;

/** Stands in for data.json; several plugins can share one, like Obsidian Sync. */
export class FakeDataFile {
	raw: string | null = null;
	writes = 0;
}

export class Plugin {
	dataFile = new FakeDataFile();
	intervals: number[] = [];

	constructor(
		public app: FakeApp,
		public manifest: unknown = {},
	) {}

	loadData(): Promise<unknown> {
		return Promise.resolve(this.dataFile.raw === null ? null : JSON.parse(this.dataFile.raw));
	}
	saveData(data: unknown): Promise<void> {
		this.dataFile.raw = JSON.stringify(data);
		this.dataFile.writes++;
		return Promise.resolve();
	}
	addSettingTab(): void {}
	addStatusBarItem() {
		const el = { text: "", setText(t: string) { el.text = t; } };
		return el as unknown as HTMLElement & { text: string };
	}
	addCommand(): void {}
	addRibbonIcon(): void {}
	registerEvent(): void {}
	registerDomEvent(target: { addEventListener: (name: string, cb: Handler) => void }, name: string, cb: Handler) {
		target.addEventListener(name, cb);
	}
	registerInterval(id: number): number {
		this.intervals.push(id);
		return id;
	}
	register(): void {}
}

export class PluginSettingTab {
	containerEl = { isConnected: false } as unknown as HTMLElement;
	constructor(
		public app: FakeApp,
		public plugin: unknown,
	) {}
}

export class Setting {}
export class ButtonComponent {}

export class FuzzySuggestModal<T> {
	constructor(public app: FakeApp) {}
	setPlaceholder(): void {}
	open(): void {}
	getItems(): T[] {
		return [];
	}
}
