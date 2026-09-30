/**
 * Split a tool's schema properties into "essential" (shown) and "advanced"
 * (behind "Show N more options") — the progressive-disclosure policy, pure.
 * Port of agent-hub `Builder/mapping/partitionInputs.js`; pinned by
 * mapping.lockstep.test.ts.
 */

import type { BindingValue, JsonSchemaProp } from './types';

// Frequently-primary names, shown even when optional. A result cap is here on
// purpose: hidden, gmail_search's 10 silently capped a 201-mail run (BFSF-358A).
const COMMON_PRIMARY = new Set([
    'query', 'q', 'prompt', 'message', 'body', 'text', 'content', 'input',
    'url', 'to', 'subject', 'name', 'path', 'title', 'email',
    'maxresults', 'max_results',
]);

/** Is a binding empty (so the field counts as unset)? */
export function isEmptyBinding(b: BindingValue | unknown): boolean {
    if (b == null) return true;
    if (typeof b !== 'object') return false;
    const v = b as { kind?: unknown; value?: unknown; path?: unknown };
    if (v.kind === 'literal' && (v.value == null || v.value === '')) return true;
    if (v.kind === 'ref' && !v.path) return true;
    if ((v.kind === 'template' || v.kind === 'expr') && !v.value) return true;
    return false;
}

function isEssential(key: string, prop: JsonSchemaProp, required: Set<string>, inputs: Record<string, unknown>): boolean {
    if (required.has(key)) return true;
    if (!isEmptyBinding(inputs[key])) return true;
    if (prop['x-primary'] === true) return true;
    if (prop['x-advanced'] === true) return false;
    return COMMON_PRIMARY.has(String(key).toLowerCase());
}

/**
 * required → set → x-primary / x-advanced → common name → advanced. Never an
 * empty default view: the first property is promoted. Declaration order kept.
 */
export function partitionInputs(
    properties: Record<string, JsonSchemaProp> | null | undefined,
    requiredSet: Set<string> | null | undefined,
    currentInputs: Record<string, unknown> | null | undefined = {},
): { essentialKeys: string[]; advancedKeys: string[] } {
    const props = properties || {};
    const required = requiredSet || new Set<string>();
    const inputs = currentInputs || {};
    const essentialKeys: string[] = [];
    const advancedKeys: string[] = [];
    for (const key of Object.keys(props)) {
        const essential = isEssential(key, props[key] || {}, required, inputs);
        (essential ? essentialKeys : advancedKeys).push(key);
    }
    if (essentialKeys.length === 0 && advancedKeys.length > 0) essentialKeys.push(advancedKeys.shift() as string);
    return { essentialKeys, advancedKeys };
}
