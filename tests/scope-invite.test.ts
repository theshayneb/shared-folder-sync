import { describe, expect, it } from "vitest";
import { decodeInvite, encodeInvite } from "../src/invite";
import { inScope, parsePathList } from "../src/scope";

describe("shared paths", () => {
	it("accepts paths typed with Windows backslashes and stray slashes", () => {
		expect(parsePathList("Reference\\Grocery Items\\\n/Utilities/Bases/ShoppingList.base\n\n")).toEqual([
			"Reference/Grocery Items",
			"Utilities/Bases/ShoppingList.base",
		]);
	});

	it("shares notes inside a folder but not attachments or look-alike folders", () => {
		const scope = { folders: ["Reference/Grocery Items"], files: [] };
		expect(inScope(scope, "Reference/Grocery Items/Milk.md")).toBe(true);
		expect(inScope(scope, "Reference/Grocery Items/Sub/Eggs.md")).toBe(true);
		expect(inScope(scope, "Reference/Grocery Items/photo.png")).toBe(false);
		expect(inScope(scope, "Reference/Grocery Items Old/Milk.md")).toBe(false);
	});
});

describe("invites", () => {
	it("carries the mailbox and shared paths, including non-ASCII names", () => {
		const invite = {
			name: "Groceries",
			url: "https://script.google.com/macros/s/abc/exec",
			shareCode: "secret",
			scope: { folders: ["Épicerie"], files: ["Utilities/Bases/ShoppingList.base"] },
		};
		expect(decodeInvite(encodeInvite(invite))).toEqual(invite);
	});

	it("rejects text that isn't an invite", () => {
		expect(decodeInvite("hello")).toBeNull();
		expect(decodeInvite("sfs1:not-base64!")).toBeNull();
	});
});

describe("invites from version 0.1.0", () => {
	it("still decode, with a default name", () => {
		const old = "sfs1:" + btoa(JSON.stringify({ u: "https://x/exec", k: "c", d: ["A"], f: [] }));
		expect(decodeInvite(old)).toEqual({
			name: "Shared folder",
			url: "https://x/exec",
			shareCode: "c",
			scope: { folders: ["A"], files: [] },
		});
	});
});
