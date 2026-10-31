import { describe, expect, it } from "vitest";
import { createMailbox } from "./mailbox-harness";

function setUp() {
	const mailbox = createMailbox();
	mailbox.runSetup();
	return mailbox;
}

describe("mailbox script", () => {
	it("prints an owner code during setup and refuses requests until then", () => {
		const mailbox = createMailbox();
		expect(mailbox.post({ key: "anything", action: "ping" })).toEqual({ ok: false, error: "not-set-up" });

		mailbox.runSetup();
		const owner = mailbox.ownerCode();
		expect(mailbox.logs[0]).toBe(`Owner code: ${owner}`);
		expect(mailbox.post({ key: owner, action: "ping" })).toEqual({ ok: true, owner: true });
		expect(mailbox.post({ key: "wrong", action: "ping" })).toEqual({ ok: false, error: "bad-share-code" });
	});

	it("gives each share its own code and keeps their notes apart", () => {
		const mailbox = setUp();
		const groceries = mailbox.createShare("Groceries");
		const chores = mailbox.createShare("Chores");
		expect(groceries).not.toBe(chores);
		expect(mailbox.post({ key: groceries, action: "ping" })).toEqual({ ok: true, name: "Groceries" });

		mailbox.post({
			key: groceries,
			action: "sync",
			cursor: 0,
			changes: [{ path: "Groceries/Milk.md", content: "In_Stock: false", baseRev: 0, mtime: 10 }],
		});

		const read = mailbox.post({ key: groceries, action: "sync", cursor: 0, changes: [] });
		expect(read.changes).toEqual([
			{ path: "Groceries/Milk.md", rev: 1, content: "In_Stock: false", deleted: false, mtime: 10 },
		]);
		expect(mailbox.post({ key: groceries, action: "sync", cursor: 1, changes: [] }).changes).toEqual([]);
		expect(mailbox.post({ key: chores, action: "sync", cursor: 0, changes: [] }).changes).toEqual([]);
	});

	it("only lets the owner create, list and delete shares", () => {
		const mailbox = setUp();
		const code = mailbox.createShare("Groceries");
		expect(mailbox.post({ key: code, action: "create-share", name: "Sneaky" })).toMatchObject({ ok: false });
		expect(mailbox.post({ key: code, action: "list-shares" })).toMatchObject({ ok: false });

		const list = mailbox.post({ key: mailbox.ownerCode(), action: "list-shares" }) as {
			shares: Array<{ code: string; name: string }>;
		};
		expect(list.shares.map((s) => s.name)).toEqual(["Groceries"]);

		expect(mailbox.post({ key: mailbox.ownerCode(), action: "revoke-share", code })).toEqual({ ok: true });
		expect(mailbox.post({ key: code, action: "ping" })).toEqual({ ok: false, error: "bad-share-code" });
		expect(mailbox.trashed.size).toBe(1);
	});

	it("stores a share's paths only when the owner code comes with them", () => {
		const mailbox = setUp();
		const code = mailbox.createShare("Groceries");
		const scope = { folders: ["Reference/Grocery Items"], files: ["Utilities/Bases/ShoppingList.base"] };

		const member = mailbox.post({ key: code, action: "sync", cursor: 0, changes: [], scope, ownerKey: "guess" });
		expect(member.scope).toBeNull();

		const owner = mailbox.post({
			key: code,
			action: "sync",
			cursor: 0,
			changes: [],
			scope,
			ownerKey: mailbox.ownerCode(),
		});
		expect(owner.scope).toEqual(scope);
		expect(mailbox.post({ key: code, action: "sync", cursor: 0, changes: [] }).scope).toEqual(scope);
	});

	it("keeps the newer of two edits made from the same starting point", () => {
		const mailbox = setUp();
		const key = mailbox.createShare("Groceries");
		const push = (content: string, baseRev: number, mtime: number) =>
			mailbox.post({ key, action: "sync", cursor: 0, changes: [{ path: "a.md", content, baseRev, mtime }] });

		push("v1", 0, 100);
		push("roommate edit", 1, 300);
		const older = push("my older edit", 1, 200) as { results: Array<Record<string, unknown>> };
		expect(older.results[0]).toMatchObject({ status: "rejected", current: { content: "roommate edit" } });

		const newer = push("my newer edit", 1, 400) as { results: Array<Record<string, unknown>> };
		expect(newer.results[0]).toMatchObject({ status: "accepted", rev: 3 });
	});

	it("ignores paths that could escape the vault or touch settings", () => {
		const mailbox = setUp();
		const key = mailbox.createShare("Groceries");
		const bad = ["../x.md", "/abs.md", ".hidden/plugins/x/data.json", "a//b.md", "a\\b.md"];
		const response = mailbox.post({
			key,
			action: "sync",
			cursor: 0,
			changes: bad.map((path) => ({ path, content: "x", baseRev: 0, mtime: 1 })),
		});
		expect(response.results).toEqual([]);
		expect(response.rev).toBe(0);
	});

	it("keeps a share code from version 0.1.0 working after the script is updated", () => {
		const mailbox = createMailbox();
		mailbox.files.set("old-file", JSON.stringify({ rev: 1, files: { "a.md": { rev: 1, content: "hi", mtime: 5 } } }));
		mailbox.props.set("SHARE_CODE", "oldcode");
		mailbox.props.set("STORE_FILE_ID", "old-file");

		mailbox.runSetup();
		const read = mailbox.post({ key: "oldcode", action: "sync", cursor: 0, changes: [] });
		expect(read.changes).toEqual([{ path: "a.md", rev: 1, content: "hi", deleted: false, mtime: 5 }]);
		expect(mailbox.props.has("SHARE_CODE")).toBe(false);
	});
});
