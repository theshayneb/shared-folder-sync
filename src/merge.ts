import { diff3Merge } from "node-diff3";

/**
 * Merges two edits of one shared file made from a common starting point.
 *
 * - `base` is the version both sides last agreed on, or null when unknown.
 * - `local` and `remote` are the two edits; null means deleted.
 * - `localTime` and `remoteTime` are the files' modified times. They settle
 *   only a change both sides made to the same spot: the newer one wins.
 *
 * In a note, frontmatter merges property by property, so one person ticking
 * `In_Stock` and another changing `Location` both survive. The body, and
 * whole non-note files such as a .base, merge line by line. Without a base
 * there is nothing to compare against, so the newer file wins whole.
 */
export function mergeVersions(
	base: string | null,
	local: string | null,
	remote: string | null,
	localTime: number,
	remoteTime: number,
	isNote: boolean,
): string | null {
	const localWins = localTime > remoteTime;
	if (local === remote) {
		return local;
	}
	if (base === null) {
		return localWins ? local : remote;
	}
	if (local === base) {
		return remote;
	}
	if (remote === base) {
		return local;
	}
	// An edit beats a delete, so nobody's change disappears unseen.
	if (local === null) {
		return remote;
	}
	if (remote === null) {
		return local;
	}
	if (!isNote) {
		return mergeLines(base, local, remote, localWins);
	}

	const b = splitNote(base);
	const l = splitNote(local);
	const r = splitNote(remote);
	const body = mergeLines(b.body, l.body, r.body, localWins);
	if (l.frontmatter === null && r.frontmatter === null) {
		return body;
	}
	const frontmatter =
		mergeFrontmatter(b.frontmatter ?? "", l.frontmatter ?? "", r.frontmatter ?? "", localWins) ??
		mergeLines(b.frontmatter ?? "", l.frontmatter ?? "", r.frontmatter ?? "", localWins);
	return `---\n${frontmatter === "" ? "" : frontmatter + "\n"}---\n${body}`;
}

interface SplitNote {
	/** The YAML between the --- lines, without them; null when there is none. */
	frontmatter: string | null;
	body: string;
}

const FRONTMATTER = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

function splitNote(text: string): SplitNote {
	const match = FRONTMATTER.exec(text);
	if (!match) {
		return { frontmatter: null, body: text };
	}
	return { frontmatter: match[1] ?? "", body: text.slice(match[0].length) };
}

/** Line-based three-way merge; overlapping changes go to the newer side. */
function mergeLines(base: string, local: string, remote: string, localWins: boolean): string {
	const regions = diff3Merge(local.split("\n"), base.split("\n"), remote.split("\n"), {
		excludeFalseConflicts: true,
	});
	const out: string[] = [];
	for (const region of regions) {
		if (region.ok) {
			out.push(...region.ok);
		} else {
			out.push(...(localWins ? region.conflict.a : region.conflict.b));
		}
	}
	return out.join("\n");
}

/** A top-level property's lines, keyed by property name, in file order. */
type Properties = Map<string, string>;

const KEY_LINE = /^([^\s#-][^:]*?):(?:\s|$)/;
/** Comments or blank lines before the first property. */
const PRELUDE = "\u0000prelude";

/** Returns null when the YAML can't be split into properties safely. */
function parseProperties(yaml: string): Properties | null {
	const props: Properties = new Map();
	let current = PRELUDE;
	const lines: string[] = [];
	const flush = () => {
		if (lines.length > 0 || current !== PRELUDE) {
			props.set(current, lines.join("\n"));
		}
		lines.length = 0;
	};
	for (const line of yaml === "" ? [] : yaml.split("\n")) {
		const key = KEY_LINE.exec(line)?.[1]?.trim();
		if (key !== undefined) {
			flush();
			if (props.has(key)) {
				return null;
			}
			current = key;
		}
		lines.push(line);
	}
	flush();
	return props;
}

function mergeFrontmatter(base: string, local: string, remote: string, localWins: boolean): string | null {
	const b = parseProperties(base);
	const l = parseProperties(local);
	const r = parseProperties(remote);
	if (!b || !l || !r) {
		return null;
	}
	const keys = [...l.keys(), ...[...r.keys()].filter((k) => !l.has(k))];
	const out: string[] = [];
	for (const key of keys) {
		const bv = b.get(key);
		const lv = l.get(key);
		const rv = r.get(key);
		let value: string | undefined;
		if (lv === rv || rv === bv) {
			value = lv;
		} else if (lv === bv) {
			value = rv;
		} else {
			value = localWins ? lv : rv;
		}
		if (value !== undefined) {
			out.push(value);
		}
	}
	return out.join("\n");
}
