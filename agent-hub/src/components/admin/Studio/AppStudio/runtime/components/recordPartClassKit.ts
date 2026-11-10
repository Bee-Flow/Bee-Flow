// Support for the part-class tests of the record, document and interaction family
// (LK7b): the parts a type DECLARES in the server spec, and the `bfa-<type>__<part>`
// classes a mounted component really carries.
import { createRequire } from 'node:module';
import { expect } from 'vitest';

const require = createRequire(import.meta.url);
const specs = require('../../../../../../../../server/appStudio/componentSpecs.js') as {
    COMPONENT_SPECS: Record<string, { parts?: string[] }>;
};

/** The types this family covers: the other three families cover content, inputs and lists. */
export const RECORD_FAMILY_TYPES = [
    'badge_list', 'progress', 'stepper', 'file_gallery', 'connector_status', 'timeline',
    'message_thread', 'record_detail', 'file_preview', 'pdf_compare', 'ai_chat',
    'document_viewer', 'document_compare',
] as const;

export function declaredParts(type: string): string[] {
    return specs.COMPONENT_SPECS[type]?.parts ?? [];
}

/** Every `bfa-` token under (and on) these roots. */
function bfaTokens(roots: Element[]): string[] {
    const out = new Set<string>();
    for (const root of roots) {
        for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
            for (const token of Array.from(el.classList)) if (token.startsWith('bfa-')) out.add(token);
        }
    }
    return [...out];
}

/**
 * Every declared part is on at least one of the mounts, and no `bfa-` class of this
 * type is undeclared or misspelled. A class that belongs to another known type is not
 * this type's business (a shared piece may carry its own).
 */
export function expectPartsMatch(type: string, roots: Element[]): void {
    const prefix = `bfa-${type}__`;
    const declared = declaredParts(type);
    expect(declared.length, `${type} declares parts`).toBeGreaterThanOrEqual(3);
    const tokens = bfaTokens(roots);
    const known = Object.keys(specs.COMPONENT_SPECS).map((t) => `bfa-${t}__`);
    const stray = tokens.filter((t) => !t.startsWith(prefix) && !known.some((k) => t.startsWith(k)));
    expect(stray, `${type}: bfa- classes that name no type`).toEqual([]);
    const rendered = tokens.filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length));
    expect([...new Set(rendered)].sort(), `${type}: rendered parts`).toEqual([...declared].sort());
}
