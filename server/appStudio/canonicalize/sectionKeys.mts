/**
 * App Studio canonicalizer: the optional keys of a section beside id, style and children.
 *
 * Each cleaner returns what the stored section keeps, or undefined to leave the key out. A value
 * that only restates the default (collapsible false, maxWidth "inherit", an empty role list, an
 * empty title or name) is left out too, so a section only carries a key that changes something
 * and a section that never had one keeps its bytes. canonicalize/screens.js writes them through
 * emitOptionalKeys in the order of SECTION_KEY_CLEANERS; each key has its mark in
 * componentSpecs/keys/section/<key>.js.
 */

import { createRequire } from 'node:module';

type Push = (code: string, path: string, message: string) => void;
type Cleaner = (value: unknown, path: string, push: Push) => unknown;

const nodeRequire = createRequire(import.meta.url);
const { LIMITS } = nodeRequire('../componentSpecs/limits.js') as { LIMITS: Record<string, number> };
const { truncate } = nodeRequire('./shared.js') as { truncate: (s: string, max: number, path: string, push: Push) => string };
const { cleanBoolOrFormula, cleanRoleRefs } = nodeRequire('./nodes.js') as {
    cleanBoolOrFormula: (raw: unknown, path: string, push: Push, code: string) => unknown;
    cleanRoleRefs: (raw: unknown, path: string, push: Push) => string[] | undefined;
};

/** The widths a section may be capped to; "inherit" (the screen's width) is the absent key. */
export const SECTION_MAX_WIDTHS = Object.freeze(['narrow', 'medium', 'wide', 'full']);

const INVALID = 'section.field_invalid';

/** A trimmed string of at most `max` characters, or undefined for an empty one. */
function textCleaner(max: number, label: string): Cleaner {
    return (value, path, push) => {
        if (typeof value !== 'string') {
            push(INVALID, path, `Section ${label} must be a string — dropped.`);
            return undefined;
        }
        const text = value.trim();
        return text ? truncate(text, max, path, push) : undefined;
    };
}

const cleanCollapsible: Cleaner = (value, path, push) => {
    if (typeof value !== 'boolean') {
        push(INVALID, path, 'Section collapsible must be true or false — dropped.');
        return undefined;
    }
    return value ? true : undefined;
};

const cleanMaxWidth: Cleaner = (value, path, push) => {
    if (value === 'inherit') return undefined;
    if (typeof value === 'string' && SECTION_MAX_WIDTHS.includes(value)) return value;
    push(INVALID, path, `Section maxWidth must be one of inherit, ${SECTION_MAX_WIDTHS.join(', ')} — dropped.`);
    return undefined;
};

const cleanVisibleWhen: Cleaner = (value, path, push) => cleanBoolOrFormula(value, path, push, 'section.logic_invalid');

const cleanRoles: Cleaner = (value, path, push) => {
    const keys = cleanRoleRefs(value, path, push);
    return keys && keys.length ? [...new Set(keys)] : undefined;
};

/** In the order a stored section carries them, after id, style and children. */
export const SECTION_KEY_CLEANERS: Readonly<Record<string, Cleaner>> = Object.freeze({
    name: textCleaner(LIMITS.MAX_SECTION_NAME_LEN, 'name'),
    title: textCleaner(LIMITS.MAX_SECTION_TITLE_LEN, 'title'),
    collapsible: cleanCollapsible,
    maxWidth: cleanMaxWidth,
    visibleWhen: cleanVisibleWhen,
    visibleToRoles: cleanRoles,
});
