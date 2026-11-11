// @typecheck strict
/**
 * Custom block: `{{ formula }}` inside a text or an attribute value.
 *
 * The end of a formula is the first `}}` outside a string and outside a brace the formula
 * opened itself, so `{{ {a: 1}.a }}` and `{{ "}}" }}` read as one formula.
 */

/**
 * Where the formula that starts right after the `{{` at `open` ends: the index of its `}}`,
 * or -1 when it never closes.
 * @param {string} text
 * @param {number} open  the index of the `{{`
 */
export function interpolationEnd(text, open) {
    let quote = '';
    let depth = 0;
    for (let i = open + 2; i < text.length; i++) {
        const c = text[i];
        if (quote) {
            if (c === '\\') i += 1;
            else if (c === quote) quote = '';
            continue;
        }
        if (c === '"' || c === "'") quote = c;
        else if (c === '{') depth += 1;
        else if (c === '}') {
            if (depth > 0) depth -= 1;
            else if (text[i + 1] === '}') return i;
            else return -1;
        }
    }
    return -1;
}

/**
 * `text` as its literal pieces and formulas, in order. A `{{` that never closes is literal text.
 * @param {string} text
 * @returns {Array<{ text: string } | { expr: string }>}
 */
export function splitInterpolations(text) {
    /** @type {Array<{ text: string } | { expr: string }>} */
    const out = [];
    let from = 0;
    for (;;) {
        const open = text.indexOf('{{', from);
        const end = open === -1 ? -1 : interpolationEnd(text, open);
        if (end === -1) {
            if (from < text.length) out.push({ text: text.slice(from) });
            return out;
        }
        if (open > from) out.push({ text: text.slice(from, open) });
        out.push({ expr: text.slice(open + 2, end).trim() });
        from = end + 2;
    }
}

/** The formulas of `text`, in order. */
export function formulasOf(/** @type {string} */ text) {
    /** @type {string[]} */
    const out = [];
    for (const part of splitInterpolations(text)) if ('expr' in part) out.push(part.expr);
    return out;
}

/** Does `text` hold a formula? */
export function hasInterpolation(/** @type {string} */ text) {
    return text.includes('{{') && formulasOf(text).length > 0;
}

const NAME_FIRST = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const NAME_REST = `${NAME_FIRST}0123456789_`;

const isName = (/** @type {string} */ name) => {
    if (!name || name.length > 40 || !NAME_FIRST.includes(name[0])) return false;
    for (const ch of name) if (!NAME_REST.includes(ch)) return false;
    return true;
};

/**
 * A data-each value: `formula as name`, or a formula alone (the item is then `item`).
 * Null when there is no formula.
 * @param {string} value
 * @returns {{ expr: string, name: string } | null}
 */
export function parseEach(value) {
    const text = value.trim();
    if (!text) return null;
    const at = text.lastIndexOf(' as ');
    if (at > 0) {
        const expr = text.slice(0, at).trim();
        const name = text.slice(at + 4).trim();
        if (expr && isName(name)) return { expr, name };
    }
    return { expr: text, name: 'item' };
}
