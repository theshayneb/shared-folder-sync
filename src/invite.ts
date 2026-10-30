import { ShareScope } from "./scope";

const PREFIX = "sfs1:";

export interface Invite {
	url: string;
	shareCode: string;
	scope: ShareScope;
}

function toBase64(text: string): string {
	let binary = "";
	for (const byte of new TextEncoder().encode(text)) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

function fromBase64(b64: string): string {
	const binary = atob(b64);
	const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}

/** One string holding everything the other person needs to join. */
export function encodeInvite(invite: Invite): string {
	return (
		PREFIX +
		toBase64(
			JSON.stringify({
				u: invite.url,
				k: invite.shareCode,
				d: invite.scope.folders,
				f: invite.scope.files,
			}),
		)
	);
}

/** Returns null when the text isn't an invite made by this plugin. */
export function decodeInvite(text: string): Invite | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith(PREFIX)) {
		return null;
	}
	try {
		const data: unknown = JSON.parse(fromBase64(trimmed.slice(PREFIX.length)));
		if (typeof data !== "object" || data === null) {
			return null;
		}
		const { u, k, d, f } = data as Record<string, unknown>;
		const isStringList = (v: unknown): v is string[] =>
			Array.isArray(v) && v.every((x) => typeof x === "string");
		if (typeof u !== "string" || typeof k !== "string" || !isStringList(d) || !isStringList(f)) {
			return null;
		}
		return { url: u, shareCode: k, scope: { folders: d, files: f } };
	} catch {
		return null;
	}
}
