/** Contract readers for the locale, catalogue and release-note payloads. */

import { field, pick, shapeListOf, shapeOf } from '@/core/api/contract';
import type { Catalogue } from '@/core/i18n';

import type { Locale, ReleaseNote } from '../model/types';

export const readLocales: (raw: unknown) => Locale[] = shapeListOf({
    code: field.str(''),
    name: field.str(''),
    isOrgDefault: field.optBool,
    enabled: field.optBool,
});

/**
 * A string catalogue: every string value kept, anything else dropped. Null
 * when the body is not an object at all, so a missing catalogue is not
 * mistaken for an empty one and written over the cached strings.
 */
export function readCatalogue(raw: unknown): Catalogue | null {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out: Catalogue = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === 'string') out[key] = value;
    }
    return out;
}

const readReleaseNote: (raw: unknown) => ReleaseNote = shapeOf({
    id: field.str(''),
    version: field.strOrNull,
    title: field.str(''),
    lead: field.str(''),
    items: field.strArray,
    publishedAt: field.str(''),
});

/** `{ entries: [...] }` → the notes; a body without the list reads as none. */
export function readReleaseNotes(raw: unknown): ReleaseNote[] {
    return field.list(readReleaseNote)(pick(raw, 'entries'));
}
