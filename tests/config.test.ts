import { describe, expect, it } from "vitest";
import {
	canonicalJson,
	emptyData,
	LEGACY_SHARE_ID,
	liveShares,
	mergeData,
	pruneTombstones,
	readData,
	serializeData,
	ShareEntry,
	SyncedData,
	TOMBSTONE_DAYS,
} from "../src/config";

const DAY = 24 * 60 * 60 * 1000;

function share(patch: Partial<ShareEntry> = {}): ShareEntry {
	return {
		name: "Groceries",
		webAppUrl: "https://script.google.com/macros/s/abc/exec",
		shareCode: "code",
		folders: "Reference/Grocery Items",
		files: "Utilities/Bases/ShoppingList.base",
		joined: false,
		updatedAt: 1000,
		...patch,
	};
}

function withShares(shares: Record<string, ShareEntry>): SyncedData {
	return { ...emptyData(), shares };
}

describe("merging settings from two devices", () => {
	it("keeps the newest edit of each share, whichever device saved last", () => {
		const desktop = withShares({ g: share({ name: "Groceries", updatedAt: 5000 }), c: share({ name: "Chores" }) });
		const tablet = withShares({ g: share({ name: "Old name", updatedAt: 2000 }), c: share({ name: "Chores" }) });
		expect(mergeData(tablet, desktop).shares.g?.name).toBe("Groceries");
		expect(mergeData(desktop, tablet).shares.g?.name).toBe("Groceries");
	});

	it("doesn't drop a share just because a stale copy lacks it", () => {
		const desktop = withShares({ g: share(), new: share({ name: "Chores", updatedAt: 9000 }) });
		const tablet = withShares({ g: share() });
		expect(liveShares(mergeData(desktop, tablet)).map((s) => s.name)).toEqual(["Groceries", "Chores"]);
	});

	it("keeps a deleted share deleted against an older copy, but an edit after deleting wins", () => {
		const deleted = withShares({ g: share({ updatedAt: 3000, deletedAt: 3000 }) });
		const stale = withShares({ g: share({ updatedAt: 2000 }) });
		expect(liveShares(mergeData(stale, deleted))).toEqual([]);

		const editedLater = withShares({ g: share({ name: "Back", updatedAt: 4000 }) });
		expect(liveShares(mergeData(deleted, editedLater)).map((s) => s.name)).toEqual(["Back"]);
	});

	it("gives every device the same result, so saves don't bounce back and forth", () => {
		const a = withShares({ g: share({ name: "A", updatedAt: 1000 }) });
		const b = withShares({ g: share({ name: "B", updatedAt: 1000 }) });
		const ab = mergeData(a, b);
		expect(canonicalJson(ab)).toBe(canonicalJson(mergeData(b, a)));
		expect(canonicalJson(mergeData(ab, ab))).toBe(canonicalJson(ab));
		expect(canonicalJson(mergeData(ab, a))).toBe(canonicalJson(ab));
	});

	it("keeps the newest mailbox and interval separately from the shares", () => {
		const a = emptyData();
		a.mailbox = { value: { url: "u1", ownerCode: "o1" }, updatedAt: 5000 };
		const b = emptyData();
		b.intervalSeconds = { value: 60, updatedAt: 6000 };
		const merged = mergeData(a, b);
		expect(merged.mailbox.value.url).toBe("u1");
		expect(merged.intervalSeconds.value).toBe(60);
	});

	it("forgets tombstones only after they are months old", () => {
		const now = 1000 * DAY;
		const data = withShares({
			recent: share({ deletedAt: now - 10 * DAY }),
			old: share({ deletedAt: now - (TOMBSTONE_DAYS + 1) * DAY }),
		});
		expect(Object.keys(pruneTombstones(data, now).shares)).toEqual(["recent"]);
	});

	it("reads back exactly what it writes", () => {
		const data = withShares({ g: share(), d: share({ deletedAt: 2000 }) });
		data.mailbox = { value: { url: "u", ownerCode: "o" }, updatedAt: 7 };
		const roundTrip = readData(JSON.parse(JSON.stringify(serializeData(data)))).data;
		expect(canonicalJson(roundTrip)).toBe(canonicalJson(data));
	});
});

describe("data.json written by older versions", () => {
	it("turns 0.2.0 settings into shares and keeps each device's progress for it to pick up", () => {
		const state = { cursor: 7, files: { "Reference/Grocery Items/Milk.md": { hash: "h1", rev: 7 } } };
		const read = readData({
			settings: {
				mailboxUrl: "https://script.google.com/macros/s/abc/exec",
				ownerCode: "owner",
				intervalSeconds: 45,
				shares: [{ id: "g", ...share(), updatedAt: undefined }],
			},
			states: { phone: { g: state } },
		});
		expect(liveShares(read.data).map((s) => [s.id, s.name])).toEqual([["g", "Groceries"]]);
		expect(read.data.mailbox.value).toEqual({ url: "https://script.google.com/macros/s/abc/exec", ownerCode: "owner" });
		expect(read.data.intervalSeconds.value).toBe(45);
		expect(read.legacyStates).toEqual({ phone: { g: state } });
	});

	it("turns 0.1.0's single share into a share", () => {
		const read = readData({
			settings: { webAppUrl: "https://x/exec", shareCode: "c", folders: "A", files: "" },
			states: { phone: { cursor: 3, files: {} } },
		});
		expect(liveShares(read.data)).toMatchObject([{ id: LEGACY_SHARE_ID, webAppUrl: "https://x/exec", folders: "A" }]);
		expect(read.legacyStates).toEqual({ phone: { [LEGACY_SHARE_ID]: { cursor: 3, files: {} } } });
	});

	it("lets an old device's stale copy add a share but never undo an edit or a delete", () => {
		const current = serializeData(
			withShares({
				g: share({ name: "Groceries (renamed)", updatedAt: 5000 }),
				gone: share({ name: "Deleted", updatedAt: 6000, deletedAt: 6000 }),
			}),
		);
		// The tablet, still on 0.2.0, saved its own copy over the top.
		const mixed = {
			...current,
			settings: {
				mailboxUrl: "",
				ownerCode: "",
				shares: [
					{ id: "g", ...share({ name: "Groceries" }) },
					{ id: "gone", ...share({ name: "Deleted" }) },
					{ id: "tablet", ...share({ name: "Made on the tablet" }) },
				],
			},
		};
		const names = liveShares(readData(mixed).data).map((s) => s.name);
		expect(names.sort()).toEqual(["Groceries (renamed)", "Made on the tablet"]);
	});

	it("starts empty on a fresh install", () => {
		expect(liveShares(readData(null).data)).toEqual([]);
		expect(readData(undefined).data.intervalSeconds.value).toBe(30);
	});
});
