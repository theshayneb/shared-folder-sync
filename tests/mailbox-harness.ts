import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import type { SyncRequest, SyncResponse, Transport } from "../src/sync-engine";

const CODE = readFileSync(new URL("../apps-script/Code.gs", import.meta.url), "utf8");

export interface FakeMailbox {
	/** Calls the deployed script's doPost the way a web request would. */
	post(body: object): Record<string, unknown>;
	/** Transport for the sync engine, wired straight to doPost. */
	transport: Transport;
	/** The JSON the script keeps in Drive. */
	storedText(): string;
	logs: string[];
	runSetup(): void;
}

/** Runs the real Apps Script file against in-memory stand-ins for Google's services. */
export function createMailbox(): FakeMailbox {
	const props = new Map<string, string>();
	const files = new Map<string, string>();
	const logs: string[] = [];
	let nextId = 1;

	const fileHandle = (id: string) => ({
		getId: () => id,
		getName: () => "shared-folder-sync-store.json",
		getBlob: () => ({ getDataAsString: () => files.get(id) ?? "" }),
		setContent: (text: string) => files.set(id, text),
	});

	const sandbox = {
		PropertiesService: {
			getScriptProperties: () => ({
				getProperty: (k: string) => props.get(k) ?? null,
				setProperty: (k: string, v: string) => props.set(k, v),
				deleteProperty: (k: string) => props.delete(k),
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
		Utilities: { getUuid: () => "1234-5678-abcd" },
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

	return {
		post,
		logs,
		runSetup: () => g.setup(),
		storedText: () => [...files.values()][0] ?? "",
		transport: (request: SyncRequest) => {
			const data = post({ ...request, key: props.get("SHARE_CODE") });
			if (data.ok !== true) throw new Error(String(data.error));
			return Promise.resolve(data as unknown as SyncResponse);
		},
	};
}
