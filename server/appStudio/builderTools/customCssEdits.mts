/**
 * App Studio builder: small edits to the app's stylesheet (design.customCss) through
 * app_set_theme { customCssEdits: [{ find, replace }] }, the counterpart of the CMS's
 * sourceEdits on a React component.
 *
 * A full `customCss` replaces the whole stylesheet, and a builder that had only seen a cut
 * excerpt of it overwrote the rest without knowing (measured 2026-11-16). An edit names the text
 * it changes, so everything else stays as it was. Each `find` must occur exactly once in the text
 * as the edits before it left it: zero matches means the caller is working from a stylesheet it
 * has not read, two or more that the change is ambiguous. Either refuses the whole call.
 */

export const MAX_CSS_EDITS = 20;

export interface CssEditOutcome { css?: string; error?: string; _fixHint?: string }

const READ_HINT = 'Read the whole stylesheet with app_get_draft {section:"meta"} (its `customCss`) and copy `find` from it exactly, with enough of the rule around it to occur once.';

function countOccurrences(text: string, find: string): number {
    let count = 0;
    let at = text.indexOf(find);
    while (at !== -1 && count < 2) {
        count += 1;
        at = text.indexOf(find, at + 1);
    }
    return count;
}

/** One { find, replace } edit, or null when it is not one. */
function readEdit(raw: unknown): { find: string; replace: string } | null {
    if (!raw || typeof raw !== 'object') return null;
    const { find, replace } = raw as { find?: unknown; replace?: unknown };
    return typeof find === 'string' && find !== '' && typeof replace === 'string' ? { find, replace } : null;
}

/** Apply `edits` to `current` in order; the new text, or a refusal that changed nothing. */
export function applyCssEdits(current: unknown, edits: unknown): CssEditOutcome {
    if (!Array.isArray(edits) || !edits.length || edits.length > MAX_CSS_EDITS) {
        return { error: `customCssEdits is a list of 1-${MAX_CSS_EDITS} { find, replace } edits.`, _fixHint: READ_HINT };
    }
    if (typeof current !== 'string' || !current) {
        return { error: 'The app has no stylesheet yet, so there is nothing to edit.', _fixHint: 'Write one with app_set_theme { customCss: "<the stylesheet>" }.' };
    }
    let text = current;
    for (const [i, raw] of edits.entries()) {
        const edit = readEdit(raw);
        if (!edit) {
            return { error: `customCssEdits[${i}] needs a non-empty \`find\` and a \`replace\` string (empty to delete).`, _fixHint: READ_HINT };
        }
        const { find, replace } = edit;
        const count = countOccurrences(text, find);
        if (count !== 1) {
            const why = count === 0 ? 'does not occur in the stylesheet' : 'occurs more than once in the stylesheet';
            return { error: `customCssEdits[${i}].find ${why}; nothing was changed.`, _fixHint: READ_HINT };
        }
        const at = text.indexOf(find);
        text = `${text.slice(0, at)}${replace}${text.slice(at + find.length)}`;
    }
    return { css: text };
}
