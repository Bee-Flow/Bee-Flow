/**
 * One or many as a KEY, never as a letter — the web's `nOf`
 * (agent-hub KnowledgeStudio/plural.js).
 *
 * The singular sits under `key`, every other count under `key_plural`, so a
 * translator sees the pair and a language with its own plural rule can say it
 * properly. Baking `rule${n === 1 ? '' : 's'}` into a sentence would be
 * English grammar in code, which no translation can undo.
 *
 * The translate function is a parameter because this folder may import
 * nothing; any `t(key, fallback, params)` fits.
 */

type Translate = (key: string, fallback: string, params?: Record<string, string | number>) => string;

export function pluralKey(key: string, count: number): string {
    return Number(count) === 1 ? key : `${key}_plural`;
}

export function nOf(
    t: Translate,
    key: string,
    count: number,
    forms: readonly [one: string, many: string],
): string {
    const n = Number(count) || 0;
    return n === 1 ? t(key, forms[0], { count: n }) : t(`${key}_plural`, forms[1], { count: n });
}
