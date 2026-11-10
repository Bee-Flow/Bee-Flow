/**
 * App Studio builder tools: the optional section keys (title, name, collapsible, maxWidth,
 * visibleWhen, visibleToRoles) as app_add_section and app_update_section take them, beside
 * `style`, at the top level of the call.
 *
 * Built from an allow-list (the keys the canonicalizer keeps, canonicalize/screens.js), never
 * from whatever else the call carries. A null value removes the key; every value is cleaned by
 * the canonicalizer when the tool adopts the result, which also reports what it dropped.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { SECTION_OPTIONAL_KEYS } = nodeRequire('../../canonicalize/screens.js') as { SECTION_OPTIONAL_KEYS: Record<string, unknown> };

/** The section keys this tool call sets (null = remove), or null when it names none. */
export function sectionKeyPatch(args: unknown): Record<string, unknown> | null {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
    const source = args as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const key of Object.keys(SECTION_OPTIONAL_KEYS)) {
        if (Object.hasOwn(source, key) && source[key] !== undefined) patch[key] = source[key];
    }
    return Object.keys(patch).length ? patch : null;
}

/** The names, for an error that says what the call may carry. */
export const SECTION_KEY_NAMES: readonly string[] = Object.freeze(Object.keys(SECTION_OPTIONAL_KEYS));
