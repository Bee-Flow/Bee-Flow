/**
 * entity.mts: the one shape every list parser hands to the store, whatever the list's format.
 *
 * A listed person, organisation, vessel or aircraft with its names (the primary one first),
 * birth dates ('YYYY-MM-DD' or 'YYYY'), countries (ISO codes where known, else the folded
 * name), programmes or regimes, the list's own reference and a link where the listing can be
 * read. Parsers build it with `makeEntity`, which drops empties and duplicates.
 */

import { birthDateKey, countryKey, nameKeys } from './normalize.mts';

export type EntityKind = 'person' | 'entity' | 'vessel' | 'aircraft' | 'unknown';

export interface ParsedEntity {
    entityId: string;
    kind: EntityKind;
    names: string[];
    birthDates: string[];
    countries: string[];
    programmes: string[];
    reference: string | null;
    url: string | null;
}

export interface EntityDraft {
    entityId: unknown;
    kind?: EntityKind;
    names: unknown[];
    birthDates?: unknown[];
    countries?: unknown[];
    programmes?: unknown[];
    reference?: unknown;
    url?: unknown;
}

const MAX_NAMES = 200;
const MAX_NAME_CHARS = 300;

const text = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : typeof v === 'number' ? String(v) : '');

function unique(values: Iterable<string>, max = 100): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const v of values) {
        if (!v || seen.has(v.toLowerCase())) continue;
        seen.add(v.toLowerCase());
        out.push(v);
        if (out.length >= max) break;
    }
    return out;
}

/** A clean entity, or null when it has no id or no name. */
export function makeEntity(d: EntityDraft): ParsedEntity | null {
    const entityId = text(d.entityId);
    const names = unique(d.names.map((n) => text(n).slice(0, MAX_NAME_CHARS)), MAX_NAMES);
    if (!entityId || !names.length) return null;
    const dates = unique((d.birthDates ?? []).map(birthDateKey).filter((x): x is string => !!x));
    const countries = unique((d.countries ?? []).map(countryKey).filter((x): x is string => !!x));
    const programmes = unique((d.programmes ?? []).map(text));
    const reference = text(d.reference) || null;
    const url = text(d.url) || null;
    return { entityId, kind: d.kind ?? 'unknown', names, birthDates: dates, countries, programmes, reference, url };
}

/** Arrays from a parsed XML node that may be missing, one value or many. */
export function asArray<T>(v: T | T[] | null | undefined): T[] {
    if (v === undefined || v === null) return [];
    return Array.isArray(v) ? v : [v];
}

/** An entity with the lookup keys of each of its names (`keys[i]` for `names[i]`), as the store keeps it. */
export type IndexedEntity = ParsedEntity & { keys: string[][] };

export function indexEntity(e: ParsedEntity): IndexedEntity {
    return { ...e, keys: e.names.map((n) => nameKeys(n)) };
}
