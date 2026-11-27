/**
 * The repository paths of moved server files, found and rewritten in text, for scripts/module-move.mjs.
 *
 * A mention is `server/<rest>` written as a repository path: not preceded by a word
 * character, a dot or a path segment (so `modules/x/server/...`, `*\/server/...` and
 * `my-server/...` are not mentions; `(^|/)server/...` in a regex is). What `<rest>` names
 * decides what happens to it, given where every file of the tree ends up:
 *
 *   a moving file (`server/<tp>`, or the same without its extension)  rewritten to modules/<id>/server/<tp>
 *   a directory or glob all of whose files go to ONE moving module   rewritten the same way
 *   a directory or glob whose files end up in several roots           a SPLIT: not rewritten, reported
 *   the package itself (`server/`, `server/**`, `server/*.js`)        left alone, reported as package-wide
 *   anything else (a core file, an unknown path)                      left alone
 *
 * Zero dependencies beyond the glob compiler of the ownership map.
 */

import { globToRegExp } from '../module-map-edges.mjs';

/** `server/<rest>` as a repository path; see the header for what does not count. */
const MENTION = /(?<![\w.@$-])(?<![\w.*@$-]\/)server\/([\w./*?@+-]*)/g;
const GLOB = /[*?]/;
/** Extensions tried for a mention written without one. */
const STEM_EXT = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.json'];

/**
 * @typedef {object} Mention
 * @property {'file' | 'dir' | 'glob' | 'package' | 'other'} kind
 * @property {string | null} to   the module id the named files move to; null: leave it
 * @property {string[]} [split]   the roots ('core' or ids) the named files end up in, when more than one
 */

/**
 * @param {Map<string, string>} dest every tree path of the package -> where it is after the move ('core' or a module id)
 * @param {Map<string, string>} moving the tree paths this move takes -> their module id
 */
export function createMentionResolver(dest, moving) {
    const all = [...dest.keys()];
    /** @type {Map<string, Mention>} */
    const cache = new Map();

    /**
     * @param {'dir' | 'glob'} kind
     * @param {string[]} files
     * @returns {Mention}
     */
    function group(kind, files) {
        if (!files.some((f) => moving.has(f))) return { kind, to: null };
        const roots = [...new Set(files.map((f) => /** @type {string} */ (dest.get(f))))].sort();
        return roots.length === 1 ? { kind, to: roots[0] } : { kind, to: null, split: roots };
    }

    /**
     * @param {string} rest the part after `server/`, trailing punctuation already removed
     * @returns {Mention}
     */
    function classify(rest) {
        const p = rest.replace(/\/+$/, '');
        if (p === '' || GLOB.test(p.split('/')[0])) return { kind: 'package', to: null };
        if (dest.has(p)) return { kind: 'file', to: moving.get(p) ?? null };
        if (GLOB.test(p)) {
            const re = globToRegExp(p);
            return group('glob', all.filter((f) => re.test(f)));
        }
        const under = all.filter((f) => f.startsWith(`${p}/`));
        if (under.length) return group('dir', under);
        const stem = STEM_EXT.map((ext) => p + ext).find((f) => dest.has(f));
        return stem ? { kind: 'file', to: moving.get(stem) ?? null } : { kind: 'other', to: null };
    }

    return {
        /** @param {string} rest */
        classify(rest) {
            if (!cache.has(rest)) cache.set(rest, classify(rest));
            return /** @type {Mention} */ (cache.get(rest));
        },
    };
}

/**
 * Is the mention at `offset` a value of its own: quoted on its own (`"server/x/"`), or the
 * whole of a YAML list item or value (`- server/x/**`, `paths: server/x`), not in a comment?
 * A mention inside a sentence (a reason, a comment) is prose.
 * @param {string} text
 * @param {number} offset
 * @param {number} length
 */
export function standalone(text, offset, length) {
    const before = text.slice(text.lastIndexOf('\n', offset - 1) + 1, offset);
    const end = text.indexOf('\n', offset);
    const after = text.slice(offset + length, end === -1 ? text.length : end);
    const quote = before.slice(-1);
    if ((quote === '"' || quote === "'" || quote === '`') && after.startsWith(quote)) return true;
    if (before.includes('#')) return false;
    return /^\s*(?:-\s+|[\w.-]+:\s+)?$/.test(before) && /^\s*$/.test(after);
}

/**
 * @typedef {object} TextResult
 * @property {string} text        the rewritten text
 * @property {{ line: number, from: string, to: string }[]} rewrites
 * @property {{ line: number, mention: string, roots: string[], standalone: boolean }[]} splits  standalone: the mention is a value of its own (see standalone())
 * @property {{ line: number, mention: string }[]} packageWide   only those in a text that also names moving files
 */

/**
 * Rewrite the mentions of moving files in one text.
 * @param {string} text
 * @param {ReturnType<typeof createMentionResolver>} resolver
 * @returns {TextResult}
 */
export function rewriteMentions(text, resolver) {
    /** @type {TextResult} */
    const out = { text, rewrites: [], splits: [], packageWide: [] };
    if (!text.includes('server/')) return out;
    const lineAt = (offset) => text.slice(0, offset).split('\n').length;
    out.text = text.replace(MENTION, (whole, raw, offset) => {
        const rest = raw.replace(/\.+$/, '');
        const tail = raw.slice(rest.length);
        const hit = resolver.classify(rest);
        if (hit.split) out.splits.push({ line: lineAt(offset), mention: `server/${rest}`, roots: hit.split, standalone: standalone(text, offset, whole.length) });
        if (hit.kind === 'package') out.packageWide.push({ line: lineAt(offset), mention: `server/${rest}` });
        if (!hit.to) return whole;
        const to = `modules/${hit.to}/server/${rest}`;
        out.rewrites.push({ line: lineAt(offset), from: `server/${rest}`, to });
        return to + tail;
    });
    if (!out.rewrites.length && !out.splits.length) out.packageWide = [];
    return out;
}
