import { requestUrl, RequestUrlResponse } from "obsidian";
import { SyncRequest, SyncResponse } from "./sync-engine";

const ERROR_MESSAGES: Record<string, string> = {
	"bad-share-code": "The share code doesn't match the mailbox. Check it in settings.",
	"not-set-up": "The mailbox script hasn't been set up. Run the setup function in Apps Script once.",
	busy: "The mailbox is busy. It will try again shortly.",
	"bad-request": "The mailbox didn't understand the request.",
};

export class MailboxError extends Error {}

async function post(url: string, body: string): Promise<RequestUrlResponse> {
	const response = await requestUrl({
		url,
		method: "POST",
		contentType: "text/plain;charset=utf-8",
		body,
		throw: false,
	});
	// Apps Script answers a POST with a redirect to where the result waits.
	// Most clients follow it on their own; follow it here if one didn't.
	if (response.status >= 300 && response.status < 400) {
		const location = response.headers["location"] ?? response.headers["Location"];
		if (location) {
			return requestUrl({ url: location, method: "GET", throw: false });
		}
	}
	return response;
}

async function call(url: string, shareCode: string, payload: object): Promise<Record<string, unknown>> {
	let response: RequestUrlResponse;
	try {
		response = await post(url, JSON.stringify({ ...payload, key: shareCode }));
	} catch (error) {
		throw new MailboxError(`Couldn't reach the mailbox (${error instanceof Error ? error.message : String(error)}).`);
	}
	if (response.status !== 200) {
		throw new MailboxError(`The mailbox answered with HTTP ${response.status}. Check the web app URL.`);
	}
	let data: unknown;
	try {
		data = JSON.parse(response.text);
	} catch {
		throw new MailboxError(
			"The mailbox didn't answer with sync data. Check the web app URL and that access is set to anyone.",
		);
	}
	if (typeof data !== "object" || data === null) {
		throw new MailboxError("The mailbox sent an unexpected answer.");
	}
	const record = data as Record<string, unknown>;
	if (record.ok !== true) {
		const code = typeof record.error === "string" ? record.error : "unknown";
		throw new MailboxError(ERROR_MESSAGES[code] ?? `The mailbox reported an error: ${code}.`);
	}
	return record;
}

export function createTransport(url: string, shareCode: string) {
	return async (request: SyncRequest): Promise<SyncResponse> => {
		const data = await call(url, shareCode, request);
		if (typeof data.rev !== "number" || !Array.isArray(data.results) || !Array.isArray(data.changes)) {
			throw new MailboxError("The mailbox sent an unexpected answer.");
		}
		return data as unknown as SyncResponse;
	};
}

export async function pingMailbox(url: string, shareCode: string): Promise<void> {
	await call(url, shareCode, { action: "ping" });
}
