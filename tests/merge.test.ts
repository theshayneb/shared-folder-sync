import { describe, expect, it } from "vitest";
import { mergeVersions } from "../src/merge";

const note = (props: Record<string, string>, body = "Notes about this item.\n") =>
	"---\n" + Object.entries(props).map(([k, v]) => `${k}: ${v}`).join("\n") + "\ntags:\n  - grocery\n---\n" + body;

const BASE = note({ Type: "Household", Location: "Paper Goods", In_Stock: "true" });

describe("merging two edits of a note", () => {
	it("keeps both people's changes to different properties", () => {
		// My phone ticked In_Stock hours ago; my roommate moved the item since.
		const mine = note({ Type: "Household", Location: "Paper Goods", In_Stock: "false" });
		const theirs = note({ Type: "Household", Location: "Aisle 7", In_Stock: "true" });
		const merged = mergeVersions(BASE, mine, theirs, 1000, 9000, true);
		expect(merged).toBe(note({ Type: "Household", Location: "Aisle 7", In_Stock: "false" }));
	});

	it("gives the same property to the newer edit", () => {
		const older = note({ Type: "Household", Location: "Paper Goods", In_Stock: "false" });
		const newer = note({ Type: "Household", Location: "Paper Goods", In_Stock: "true", });
		const tickedLater = note({ Type: "Household", Location: "Paper Goods", In_Stock: "maybe" });
		expect(mergeVersions(BASE, older, tickedLater, 1000, 2000, true)).toBe(tickedLater);
		expect(mergeVersions(BASE, tickedLater, older, 2000, 1000, true)).toBe(tickedLater);
		expect(mergeVersions(BASE, newer, newer, 1, 2, true)).toBe(newer);
	});

	it("keeps a property one side added and drops one the other side removed", () => {
		const added = BASE.replace("tags:", "Store: Costco\ntags:");
		const removed = BASE.replace("Type: Household\n", "");
		const merged = mergeVersions(BASE, added, removed, 1, 2, true);
		expect(merged).toContain("Store: Costco");
		expect(merged).not.toContain("Type:");
		expect(merged).toContain("Location: Paper Goods");
	});

	it("merges the body line by line", () => {
		const base = note({ In_Stock: "true" }, "line one\nline two\nline three\n");
		const mine = note({ In_Stock: "true" }, "line one (mine)\nline two\nline three\n");
		const theirs = note({ In_Stock: "true" }, "line one\nline two\nline three (theirs)\n");
		expect(mergeVersions(base, mine, theirs, 1, 2, true)).toBe(
			note({ In_Stock: "true" }, "line one (mine)\nline two\nline three (theirs)\n"),
		);
	});

	it("keeps an edit over a delete", () => {
		const edited = note({ Type: "Household", Location: "Paper Goods", In_Stock: "false" });
		expect(mergeVersions(BASE, null, edited, 9000, 1000, true)).toBe(edited);
		expect(mergeVersions(BASE, edited, null, 1000, 9000, true)).toBe(edited);
		expect(mergeVersions(BASE, BASE, null, 1, 2, true)).toBeNull();
	});

	it("takes the newer file whole when there is no shared starting point", () => {
		expect(mergeVersions(null, "mine", "theirs", 2000, 1000, true)).toBe("mine");
		expect(mergeVersions(null, "mine", "theirs", 1000, 2000, true)).toBe("theirs");
	});

	it("merges files that aren't notes, such as a base, line by line", () => {
		const base = "filters:\n  - a\nviews:\n  - table\n";
		const mine = "filters:\n  - b\nviews:\n  - table\n";
		const theirs = "filters:\n  - a\nviews:\n  - cards\n";
		expect(mergeVersions(base, mine, theirs, 1, 2, false)).toBe("filters:\n  - b\nviews:\n  - cards\n");
	});
});
