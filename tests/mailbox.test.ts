import { describe, expect, it } from "vitest";
import { createMailbox } from "./mailbox-harness";

const KEY = "12345678abcd";

describe("mailbox script", () => {
	it("prints a share code during setup and refuses requests without it", () => {
		const mailbox = createMailbox();
		expect(mailbox.post({ key: "anything", action: "ping" })).toEqual({ ok: false, error: "not-set-up" });

		mailbox.runSetup();
		expect(mailbox.logs[0]).toBe(`Share code: ${KEY}`);
		expect(mailbox.post({ key: "wrong", action: "ping" })).toEqual({ ok: false, error: "bad-share-code" });
		expect(mailbox.post({ key: KEY, action: "ping" })).toEqual({ ok: true });
	});

	it("stores pushed notes and hands them to the next reader", () => {
		const mailbox = createMailbox();
		mailbox.runSetup();
		const pushed = mailbox.post({
			key: KEY,
			action: "sync",
			cursor: 0,
			changes: [{ path: "Groceries/Milk.md", content: "In_Stock: false", baseRev: 0, mtime: 10 }],
		});
		expect(pushed.results).toEqual([{ path: "Groceries/Milk.md", status: "accepted", rev: 1 }]);
		expect((JSON.parse(mailbox.storedText()) as { rev: number }).rev).toBe(1);

		const read = mailbox.post({ key: KEY, action: "sync", cursor: 0, changes: [] });
		expect(read.changes).toEqual([
			{ path: "Groceries/Milk.md", rev: 1, content: "In_Stock: false", deleted: false, mtime: 10 },
		]);
		expect(mailbox.post({ key: KEY, action: "sync", cursor: 1, changes: [] }).changes).toEqual([]);
	});

	it("keeps the newer of two edits made from the same starting point", () => {
		const mailbox = createMailbox();
		mailbox.runSetup();
		const push = (content: string, baseRev: number, mtime: number) =>
			mailbox.post({ key: KEY, action: "sync", cursor: 0, changes: [{ path: "a.md", content, baseRev, mtime }] });

		push("v1", 0, 100);
		push("roommate edit", 1, 300);
		const older = push("my older edit", 1, 200) as { results: Array<Record<string, unknown>> };
		expect(older.results[0]).toMatchObject({ status: "rejected", current: { content: "roommate edit" } });

		const newer = push("my newer edit", 1, 400) as { results: Array<Record<string, unknown>> };
		expect(newer.results[0]).toMatchObject({ status: "accepted", rev: 3 });
	});

	it("ignores paths that could escape the vault or touch settings", () => {
		const mailbox = createMailbox();
		mailbox.runSetup();
		const bad = ["../x.md", "/abs.md", ".hidden/plugins/x/data.json", "a//b.md", "a\\b.md"];
		const response = mailbox.post({
			key: KEY,
			action: "sync",
			cursor: 0,
			changes: bad.map((path) => ({ path, content: "x", baseRev: 0, mtime: 1 })),
		});
		expect(response.results).toEqual([]);
		expect(response.rev).toBe(0);
	});
});
