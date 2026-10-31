import { describe, expect, it } from "vitest";
import { LEGACY_SHARE_ID, migrateData } from "../src/config";

describe("saved data from version 0.1.0", () => {
	it("becomes one share with its sync progress kept", () => {
		const state = { cursor: 7, files: { "Reference/Grocery Items/Milk.md": { hash: "h1", rev: 7 } } };
		const migrated = migrateData({
			settings: {
				webAppUrl: "https://script.google.com/macros/s/abc/exec",
				shareCode: "code",
				folders: "Reference/Grocery Items",
				files: "Utilities/Bases/ShoppingList.base",
				intervalSeconds: 45,
			},
			states: { device1: state },
		});

		expect(migrated.settings).toEqual({
			mailboxUrl: "",
			ownerCode: "",
			intervalSeconds: 45,
			shares: [
				{
					id: LEGACY_SHARE_ID,
					name: "Shared folder",
					webAppUrl: "https://script.google.com/macros/s/abc/exec",
					shareCode: "code",
					folders: "Reference/Grocery Items",
					files: "Utilities/Bases/ShoppingList.base",
					joined: false,
				},
			],
		});
		expect(migrated.states).toEqual({ device1: { [LEGACY_SHARE_ID]: state } });
	});

	it("leaves current data and a fresh install alone", () => {
		expect(migrateData({}).settings.shares).toEqual([]);
		const current = {
			settings: { mailboxUrl: "u", ownerCode: "o", shares: [], intervalSeconds: 30 },
			states: { d: { s1: { cursor: 1, files: {} } } },
		};
		expect(migrateData(current)).toEqual(current);
	});
});
