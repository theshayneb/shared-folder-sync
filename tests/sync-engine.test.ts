import { describe, expect, it } from "vitest";
import { ShareScope } from "../src/scope";
import { emptyState, LocalStore, runSync, SyncState, Transport } from "../src/sync-engine";
import { createMailbox } from "./mailbox-harness";

const SCOPE: ShareScope = {
	folders: ["Reference/Grocery Items"],
	files: ["Utilities/Bases/ShoppingList.base"],
};

const MILK = "Reference/Grocery Items/Milk.md";
const BASE = "Utilities/Bases/ShoppingList.base";

const note = (inStock: boolean) =>
	`---\nType: Household\nLocation: Dairy\nIn_Stock: ${inStock}\ntags:\n  - grocery\n---\n`;

let clock = 1000;
const tick = () => (clock += 1000);

/** An in-memory vault whose writes get a fresh mtime, like real files. */
class MemoryVault implements LocalStore {
	files = new Map<string, { content: string; mtime: number }>();
	/** Runs inside the next write, to simulate an edit landing mid-sync. */
	onWrite: (() => void) | null = null;

	set(path: string, content: string) {
		this.files.set(path, { content, mtime: tick() });
	}
	get(path: string) {
		return this.files.get(path)?.content ?? null;
	}
	list() {
		return Promise.resolve([...this.files].map(([path, f]) => ({ path, mtime: f.mtime })));
	}
	read(path: string) {
		return Promise.resolve(this.get(path));
	}
	write(path: string, content: string) {
		this.set(path, content);
		const hook = this.onWrite;
		this.onWrite = null;
		hook?.();
		return Promise.resolve();
	}
	remove(path: string) {
		this.files.delete(path);
		return Promise.resolve();
	}
}

class Device {
	vault = new MemoryVault();
	state: SyncState = emptyState();
	constructor(
		private readonly transport: Transport,
		private readonly name: string,
	) {}
	sync() {
		return runSync({
			store: this.vault,
			transport: this.transport,
			scope: SCOPE,
			device: this.name,
			state: this.state,
			saveState: () => Promise.resolve(),
			now: tick,
		});
	}
}

function setupPair() {
	const mailbox = createMailbox();
	mailbox.runSetup();
	return { mailbox, me: new Device(mailbox.transport, "me"), roommate: new Device(mailbox.transport, "roommate") };
}

describe("sharing a grocery folder between two vaults", () => {
	it("gives the roommate every grocery note and the base", async () => {
		const { me, roommate } = setupPair();
		me.vault.set(MILK, note(false));
		me.vault.set(BASE, "views:\n  - type: table\n");
		me.vault.set("Journal/Private.md", "not shared");

		expect(await me.sync()).toEqual({ pushed: 2, pulled: 0 });
		expect(await roommate.sync()).toEqual({ pushed: 0, pulled: 2 });

		expect(roommate.vault.get(MILK)).toBe(note(false));
		expect(roommate.vault.get(BASE)).toBe("views:\n  - type: table\n");
		expect(roommate.vault.get("Journal/Private.md")).toBeNull();
	});

	it("shows a roommate's checked-off item and new item on my side", async () => {
		const { me, roommate } = setupPair();
		me.vault.set(MILK, note(false));
		await me.sync();
		await roommate.sync();

		roommate.vault.set(MILK, note(true));
		roommate.vault.set("Reference/Grocery Items/Eggs.md", note(false));
		await roommate.sync();
		await me.sync();

		expect(me.vault.get(MILK)).toBe(note(true));
		expect(me.vault.get("Reference/Grocery Items/Eggs.md")).toBe(note(false));
	});

	it("deletes an item on both sides", async () => {
		const { me, roommate } = setupPair();
		me.vault.set(MILK, note(false));
		await me.sync();
		await roommate.sync();

		await roommate.vault.remove(MILK);
		await roommate.sync();
		await me.sync();

		expect(me.vault.get(MILK)).toBeNull();
		expect(await me.sync()).toEqual({ pushed: 0, pulled: 0 });
	});

	it("keeps the later edit when both people change the same item", async () => {
		const { me, roommate } = setupPair();
		me.vault.set(MILK, note(false));
		await me.sync();
		await roommate.sync();

		me.vault.set(MILK, note(true) + "earlier");
		roommate.vault.set(MILK, note(true) + "later");
		await roommate.sync();
		await me.sync();
		await roommate.sync();

		expect(me.vault.get(MILK)).toBe(note(true) + "later");
		expect(roommate.vault.get(MILK)).toBe(note(true) + "later");
	});

	it("doesn't send anything when nothing changed", async () => {
		const { me, roommate } = setupPair();
		me.vault.set(MILK, note(false));
		await me.sync();
		await roommate.sync();

		expect(await me.sync()).toEqual({ pushed: 0, pulled: 0 });
		expect(await roommate.sync()).toEqual({ pushed: 0, pulled: 0 });
	});

	it("doesn't overwrite an edit made while a sync is writing files", async () => {
		const { me, roommate } = setupPair();
		me.vault.set(MILK, note(false));
		me.vault.set(BASE, "v1");
		await me.sync();
		await roommate.sync();

		me.vault.set(MILK, note(true));
		me.vault.set(BASE, "v2");
		await me.sync();

		// Milk arrives first; while it is being written the roommate edits the
		// base, whose newer version from me hasn't been applied yet.
		roommate.vault.onWrite = () => roommate.vault.set(BASE, "roommate's base");
		await roommate.sync();
		expect(roommate.vault.get(MILK)).toBe(note(true));
		expect(roommate.vault.get(BASE)).toBe("roommate's base");

		await roommate.sync();
		await me.sync();
		expect(me.vault.get(BASE)).toBe("roommate's base");
	});

	it("ignores files the mailbox holds outside the shared paths", async () => {
		const { mailbox, roommate } = setupPair();
		await mailbox.transport({
			action: "sync",
			cursor: 0,
			device: "other",
			changes: [{ path: "Journal/Planted.md", content: "x", baseRev: 0, mtime: 1 }],
		});
		await roommate.sync();
		expect(roommate.vault.get("Journal/Planted.md")).toBeNull();
	});

	it("sends a large first upload in several requests", async () => {
		const { me, roommate } = setupPair();
		for (let i = 0; i < 120; i++) {
			me.vault.set(`Reference/Grocery Items/Item ${i}.md`, note(i % 2 === 0));
		}
		expect((await me.sync()).pushed).toBe(120);
		expect((await roommate.sync()).pulled).toBe(120);
	});
});
