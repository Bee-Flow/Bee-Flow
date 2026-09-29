/**
 * Singular and plural for the counted phrases in this section.
 *
 * "1 sources · 1 documents · 1 refresh automatically" is on the first screen
 * of the section, and it is the kind of wrong that makes a careful product
 * look careless. Every counted phrase here can genuinely be one: a knowledge
 * base with a single source, a PDF with a single page, a folder holding one
 * file.
 *
 * The convention is the product's own (shared/UsedByTab.jsx:388): the BASE
 * key is the singular and `<key>_plural` is the many form, so a translator
 * sees the pair together in the Languages panel. Languages with more than two
 * plural forms are not modelled — neither English nor Dutch needs it, and
 * inventing a scheme for a language the product does not ship would be
 * guessing at rules nobody here can check.
 */

/** The key for `count`: the base for one, `<key>_plural` for anything else. */
export function pluralKey(key, count) {
    return Number(count) === 1 ? key : `${key}_plural`;
}

/** `t()` for a counted phrase — pass BOTH English forms, as t() wants a fallback. */
export function nOf(t, key, count, one, many, extra = {}) {
    const n = Number(count) || 0;
    return n === 1
        ? t(key, one, { count: n, ...extra })
        : t(`${key}_plural`, many, { count: n, ...extra });
}
