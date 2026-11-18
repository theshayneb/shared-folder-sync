import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeApp, FakeDataFile, notices, Platform, requests, setRequestHandler } from "./stubs/obsidian";
import { emptyData, liveShares, serializeData, ShareEntry } from "../src/config";
import SharedFolderSyncPlugin, { SETTLE } from "../src/main";
import { scopeKey } from "../src/scope";
import { createMailbox, FakeMailbox } from "./mailbox-harness";

const MILK = "Reference/Grocery Items/Milk.md";

/** A page whose visibility the tests flip, standing in for the app window. */
class FakeDocument extends EventTarget {
	visibilityState = "visible";
}

let doc: FakeDocument;
let mailbox: FakeMailbox;
let shareCode: string;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-11-18T12:00:00Z"));
	doc = new FakeDocument();
	// After useFakeTimers, so these are the fake timers.
	vi.stubGlobal("window", { setTimeout, clearTimeout, setInterval, clearInterval });
	vi.stubGlobal("activeDocument", doc);
	notices.length = 0;
	mailbox = createMailbox();
	mailbox.runSetup();
	shareCode = mailbox.createShare("Groceries");
	setRequestHandler((body) => mailbox.post(body as object));
	Platform.isDesktopApp = true;
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	setRequestHandler(null);
});

function groceries(patch: Partial<ShareEntry> = {}): ShareEntry {
	return {
		name: "Groceries",
		webAppUrl: "https://script.google.com/macros/s/abc/exec",
		shareCode,
		folders: "Reference/Grocery Items",
		files: "",
		joined: true,
		updatedAt: 1000,
		...patch,
	};
}

/** data.json holding the Groceries share, as Obsidian Sync would deliver it. */
function dataFileWith(shares: Record<string, ShareEntry> = { g: groceries() }): FakeDataFile {
	const file = new FakeDataFile();
	file.raw = JSON.stringify(serializeData({ ...emptyData(), shares }));
	return file;
}

async function startDevice(opts: { desktop: boolean; dataFile?: FakeDataFile; app?: FakeApp }) {
	Platform.isDesktopApp = opts.desktop;
	const app = opts.app ?? new FakeApp();
	const plugin = new SharedFolderSyncPlugin(app as never, {} as never);
	(plugin as unknown as { dataFile: FakeDataFile }).dataFile = opts.dataFile ?? dataFileWith();
	await plugin.onload();
	for (const ready of app.layoutReady) {
		ready();
	}
	const dataFile = (plugin as unknown as { dataFile: FakeDataFile }).dataFile;
	return { app, plugin, dataFile };
}

const syncRequests = () => requests.filter((r) => (r as { action?: string }).action === "sync");

describe("a phone or tablet (background tasks off)", () => {
	it("never talks to the mailbox on its own, whatever happens", async () => {
		const { app } = await startDevice({ desktop: false });
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		app.vault.set(MILK, "edited on the phone");
		doc.visibilityState = "visible";
		doc.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(requests).toEqual([]);
	});

	it("leaves a by-hand sync to the always-on device", async () => {
		const { plugin } = await startDevice({ desktop: false });
		await plugin.syncNow(true);
		expect(requests).toEqual([]);
		expect(notices.at(-1)).toContain("always-on device");
	});

	it("syncs anyway where Obsidian Sync is off, since nothing else would bring changes", async () => {
		const app = new FakeApp();
		app.coreSync = { enabled: false, instance: {} };
		const { plugin } = await startDevice({ desktop: false, app });
		expect(plugin.isBackgroundOn()).toBe(true);
	});

	it("keeps the switch on this device only", async () => {
		const { app, plugin, dataFile } = await startDevice({ desktop: false });
		plugin.setBackground(true);
		expect(app.localStorage.get("shared-folder-sync-background")).toBe("true");
		expect(dataFile.raw).not.toContain("background");
	});
});

describe("the always-on desktop", () => {
	it("waits for Obsidian Sync to settle after starting, then syncs", async () => {
		const { app } = await startDevice({ desktop: true });
		app.coreSync = { enabled: true, instance: { syncing: true } };
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(syncRequests()).toEqual([]);

		app.coreSync = { enabled: true, instance: { syncing: false } };
		await vi.advanceTimersByTimeAsync(SETTLE.afterStartWhenIdle);
		expect(syncRequests().length).toBeGreaterThan(0);
	});

	it("waits the longer time when Sync can't say whether it's busy", async () => {
		const app = new FakeApp();
		app.coreSync = { enabled: true, instance: {} };
		await startDevice({ desktop: true, app });
		await vi.advanceTimersByTimeAsync(SETTLE.afterStart - 20_000);
		expect(syncRequests()).toEqual([]);
		await vi.advanceTimersByTimeAsync(40_000);
		expect(syncRequests().length).toBeGreaterThan(0);
	});

	it("holds an edit while files are still arriving, then sends it", async () => {
		const { app } = await startDevice({ desktop: true });
		await vi.advanceTimersByTimeAsync(SETTLE.afterStartWhenIdle + 1000);
		const before = syncRequests().length;

		app.vault.set(MILK, "ticked on the phone, brought by Obsidian Sync");
		await vi.advanceTimersByTimeAsync(SETTLE.quietWhenIdle - 5000);
		expect(syncRequests().length).toBe(before);
		await vi.advanceTimersByTimeAsync(30_000);
		const sent = syncRequests().flatMap((r) => (r as { changes: Array<{ path: string }> }).changes);
		expect(sent.map((c) => c.path)).toContain(MILK);
	});

	it("waits again after waking from sleep", async () => {
		const { app } = await startDevice({ desktop: true });
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		const before = syncRequests().length;
		doc.dispatchEvent(new Event("visibilitychange"));
		app.coreSync = { enabled: true, instance: { syncing: true } };
		await vi.advanceTimersByTimeAsync(2 * 60_000);
		expect(syncRequests().length).toBe(before);
	});

	it("keeps sync progress in local storage and never writes data.json while syncing", async () => {
		const { app, dataFile } = await startDevice({ desktop: true });
		app.vault.set(MILK, "milk");
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(mailbox.post({ key: shareCode, action: "sync", cursor: 0, changes: [] }).rev).toBe(1);
		expect([...app.localStorage.keys()].some((k) => k.startsWith("shared-folder-sync-state-"))).toBe(true);
		expect(dataFile.writes).toBe(0);
	});

	it("doesn't rewrite its saved progress on idle checks", async () => {
		const { app } = await startDevice({ desktop: true });
		app.vault.set(MILK, "milk");
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		const saves = vi.spyOn(app, "saveLocalStorage");
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(syncRequests().length).toBeGreaterThan(5);
		expect(saves).not.toHaveBeenCalled();
	});

	it("shows how many changes are waiting while Obsidian Sync is busy, and sends them on request", async () => {
		const { app, plugin } = await startDevice({ desktop: true });
		app.coreSync = { enabled: true, instance: { syncing: true } };
		app.vault.set(MILK, "milk");
		await vi.advanceTimersByTimeAsync(5000);
		expect(plugin.pendingText()).toBe("Shared: 1 change waiting for Obsidian Sync");

		await plugin.syncNow(true);
		expect(plugin.pendingText()).toMatch(/^Shared: synced /);
	});
});

describe("data.json shared by your devices", () => {
	it("is not written when Obsidian starts", async () => {
		const { dataFile } = await startDevice({ desktop: false });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(dataFile.writes).toBe(0);
	});

	it("takes in another device's newer edit without saving it back", async () => {
		const { plugin, dataFile } = await startDevice({ desktop: false });
		dataFile.raw = dataFileWith({ g: groceries({ name: "Food", updatedAt: 5000 }) }).raw;
		await plugin.onExternalSettingsChange();
		expect(plugin.shares().map((s) => s.name)).toEqual(["Food"]);
		expect(dataFile.writes).toBe(0);
	});

	it("keeps its own unsaved edit when an older copy arrives, and saves once", async () => {
		const { plugin, dataFile } = await startDevice({ desktop: false });
		plugin.data.shares.g!.name = "Mine";
		plugin.data.shares.g!.updatedAt = Date.now();
		dataFile.raw = dataFileWith({ g: groceries({ name: "Stale", updatedAt: 2000 }) }).raw;

		await plugin.onExternalSettingsChange();
		expect(plugin.shares().map((s) => s.name)).toEqual(["Mine"]);
		expect(dataFile.writes).toBe(1);
		await plugin.onExternalSettingsChange();
		expect(dataFile.writes).toBe(1);
	});

	it("lets two devices' edits to different shares both survive, then goes quiet", async () => {
		const shared = dataFileWith({ g: groceries(), c: groceries({ name: "Chores", folders: "Chores" }) });
		const desktop = await startDevice({ desktop: true, dataFile: shared });
		const tablet = await startDevice({ desktop: false, dataFile: shared });

		await desktop.plugin.updateShare("g", { name: "Groceries (desktop)" });
		// The tablet hasn't seen that yet and edits from its stale copy.
		await tablet.plugin.updateShare("c", { folders: "Chores\nCleaning" });
		await desktop.plugin.onExternalSettingsChange();
		await tablet.plugin.onExternalSettingsChange();

		for (const { plugin } of [desktop, tablet]) {
			const byName = Object.fromEntries(plugin.shares().map((s) => [s.id, s]));
			expect(byName.g?.name).toBe("Groceries (desktop)");
			expect(byName.c?.folders).toBe("Chores\nCleaning");
		}
		const writes = shared.writes;
		await desktop.plugin.onExternalSettingsChange();
		await tablet.plugin.onExternalSettingsChange();
		expect(shared.writes).toBe(writes);
	});

	it("keeps a share deleted on one device deleted when a stale copy comes back", async () => {
		const shared = dataFileWith();
		const desktop = await startDevice({ desktop: true, dataFile: shared });
		await desktop.plugin.removeShare({ ...groceries(), id: "g" });
		expect(desktop.plugin.shares()).toEqual([]);

		shared.raw = dataFileWith({ g: groceries({ name: "Stale" }) }).raw;
		await desktop.plugin.onExternalSettingsChange();
		expect(desktop.plugin.shares()).toEqual([]);
	});

	it("carries a 0.2.0 tablet's data forward and picks up its sync progress", async () => {
		const legacy = new FakeDataFile();
		// 0.2.0 saved this alongside its cursor.
		const state = { cursor: 4, files: {}, scopeKey: scopeKey({ folders: ["Reference/Grocery Items"], files: [] }) };
		legacy.raw = JSON.stringify({
			settings: { mailboxUrl: "", ownerCode: "", intervalSeconds: 30, shares: [{ id: "g", ...groceries() }] },
			states: { tablet: { g: state } },
		});
		const app = new FakeApp();
		app.saveLocalStorage("shared-folder-sync-device-id", "tablet");
		const { plugin, dataFile } = await startDevice({ desktop: true, dataFile: legacy, app });
		expect(liveShares(plugin.data).map((s) => s.id)).toEqual(["g"]);
		expect(dataFile.writes).toBe(0);

		await vi.advanceTimersByTimeAsync(5 * 60_000);
		const first = syncRequests()[0] as { cursor: number };
		expect(first.cursor).toBe(4);
	});
});
