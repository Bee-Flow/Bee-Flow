/**
 * Find/replace edits of one source text, the way an agent changes a component without
 * sending the whole file: `[{ find, replace }]`, each `find` must occur exactly once in the
 * text as it stands after the edits before it, applied in order, and nothing is saved when
 * one of them fails. The blog's bodyEdits follow the same rules (cms/mcp/blog.js).
 *
 * Used by the CMS React component tool (cmsBuilder/builderToolsReact.mts) and the App Studio
 * react_block tool (appStudio/builderTools/appEditReactBlock.mts).
 */

/** Most find/replace pairs in one call, and the longest `find`. */
export const SOURCE_EDITS_MAX = 20;
export const FIND_MAX_CHARS = 5000;

export type SourceEdit = { find: string, replace: string };

/** A failed edit: thrown inside a change so nothing is saved, turned into a tool error outside. */
export class SourceEditFailure extends Error {
    fixHint: string;
    constructor(message: string, fixHint: string) {
        super(message);
        this.fixHint = fixHint;
    }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** What is wrong with a `sourceEdits` argument, or null when it is a usable list. */
export function sourceEditsProblem(edits: unknown): string | null {
    if (!Array.isArray(edits) || !edits.length) return 'sourceEdits must be a non-empty list of {find, replace}.';
    if (edits.length > SOURCE_EDITS_MAX) return `At most ${SOURCE_EDITS_MAX} sourceEdits per call; split the work.`;
    for (const [i, e] of edits.entries()) {
        if (!isPlainObject(e) || typeof e.find !== 'string' || typeof e.replace !== 'string' || !e.find) {
            return `sourceEdits[${i}] must be {find: non-empty text, replace: text}.`;
        }
        if (e.find.length > FIND_MAX_CHARS) return `sourceEdits[${i}].find is longer than ${FIND_MAX_CHARS} characters; send source whole instead.`;
    }
    return null;
}

/**
 * Apply find/replace edits in order; throws SourceEditFailure when a find is missing or not
 * unique. `readHint` says where the caller reads the exact current text.
 */
export function applySourceEdits(source: string, edits: SourceEdit[], readHint: string): string {
    let out = source;
    for (const [i, e] of edits.entries()) {
        const first = out.indexOf(e.find);
        if (first < 0) {
            throw new SourceEditFailure(`sourceEdits[${i}].find was not found in the source (nothing was changed).`,
                `Copy the exact text from ${readHint}, including whitespace and line breaks. Earlier edits in this call are applied first.`);
        }
        if (out.indexOf(e.find, first + 1) >= 0) {
            throw new SourceEditFailure(`sourceEdits[${i}].find occurs more than once (nothing was changed).`, 'Include more surrounding text so it is unique.');
        }
        out = out.slice(0, first) + e.replace + out.slice(first + e.find.length);
    }
    return out;
}
