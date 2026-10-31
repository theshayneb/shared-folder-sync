import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import type { SyncRequest, SyncResponse, Transport } from "../src/sync-engine";

const CODE = readFileSync(new URL("../apps-script/Code.gs", import.meta.url), "utf8");

export interface FakeMailbox {
	/** Calls the deployed script's doPost the way a web request would. */
	post(body: object): Record<string, unknown>;
	/** Transport for the sync engine on one share, wired straight to doPost. */
	transportFor(shareCode: string): Transport;
	/** Creates a share with the owner code and returns its share code. */
	createShare(name: string): string;
	ownerCode(): string;
	/** Script properties, to inspect or to fake an older version's data. */
	props: Map<string, string>;
	/** The Drive files the script keeps, by id. */
	files: Map<string, string>;
	trashed: Set<string>;
	logs: string[];
	runSetup(): void;
}

/** Runs the real Apps Script file against in-memory stand-ins for Google's services. */
export function createMailbox(): FakeMailbox {
	const props = new Map<string, string>();
	const files = new Map<string, string>();
	const trashed = new Set<string>();
	const logs: string[] = [];
	let nextId = 1;
	let nextUuid = 1;

	const fileHandle = (id: string) => ({
		getId: () => id,
		getName: () => "shared-folder-sync-store.json",
		getBlob: () => ({ getDataAsString: () => files.get(id) ?? "" }),
		setContent: (text: string) => files.set(id, text),
		setTrashed: (value: boolean) => (value ? trashed.add(id) : trashed.delete(id)),
	});

	const sandbox = {
		PropertiesService: {
			getScriptProperties: () => ({
				getProperty: (k: string) => props.get(k) ?? null,
				setProperty: (k: string, v: string) => props.set(k, v),
				deleteProperty: (k: string) => props.delete(k),
				getProperties: () => Object.fromEntries(props),
			}),
		},
		DriveApp: {
			getFileById: (id: string) => {
				if (!files.has(id)) throw new Error("not found");
				return fileHandle(id);
			},
			createFile: (_name: string, content: string) => {
				const id = `file-${nextId++}`;
				files.set(id, content);
				return fileHandle(id);
			},
		},
		MimeType: { PLAIN_TEXT: "text/plain" },
		LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => undefined }) },
		Utilities: { getUuid: () => `uuid-${nextUuid++}` },
		Logger: { log: (m: string) => logs.push(m) },
		ContentService: {
			MimeType: { JSON: "application/json" },
			createTextOutput: (text: string) => ({ text, setMimeType() { return this; } }),
		},
	};
	const context = createContext(sandbox);
	runInContext(CODE, context);
	const g = context as unknown as {
		setup(): void;
		doPost(e: { postData: { contents: string } }): { text: string };
	};

	const post = (body: object) =>
		JSON.parse(g.doPost({ postData: { contents: JSON.stringify(body) } }).text) as Record<string, unknown>;

	const ownerCode = () => props.get("OWNER_CODE") ?? "";

	return {
		post,
		logs,
		props,
		files,
		trashed,
		ownerCode,
		runSetup: () => g.setup(),
		createShare: (name: string) => {
			const data = post({ key: ownerCode(), action: "create-share", name });
			if (typeof data.code !== "string") throw new Error(String(data.error));
			return data.code;
		},
		transportFor: (shareCode: string) => (request: SyncRequest) => {
			const data = post({ ...request, key: shareCode });
			if (data.ok !== true) throw new Error(String(data.error));
			return Promise.resolve(data as unknown as SyncResponse);
		},
	};
}
