/**
 * App Studio: the two tiers of the catalogue outside the component, knob, step and action
 * tables (catalogTiers.mts owns those and calls in here).
 *
 *   SCREEN_SPEC, THEME_SPEC, DESIGN_SPEC   a key with `since`, an enum value with `valuesSince`
 *   a list prop's itemShape                the same marks on a key of the items (and of a
 *                                          list nested in them)
 *   COMPONENT_SPECS[type].eventsSince      an event an existing type newly fires
 *   componentSpecs/keys/<family>/<key>.js  section, node, nav and nav-group keys, and a knob
 *                                          newly allowed on sections (keyMarks.js)
 *   NAV_STYLES, SECTION_STYLE_KNOBS        lists whose late entries those key files mark
 *   the data vocabulary                    field types, field and table options, filter operators,
 *                                          aggregate functions, date buckets and the words
 *                                          of a row rule (`rowRule`), marked in
 *                                          core/dataEngine/dataModel/vocabularySince.js
 *   keys/binding, keys/queryShape          a key a data binding newly takes, a form the value
 *                                          under a key of a read newly takes (queryMarks.js):
 *                                          listed with the data vocabulary, in the `data` family
 *
 * Pure: everything is computed from the source it is handed.
 */

import { SCHEMA_VERSION_BASE } from '../shared/appDefinition/schemaVersion.mjs';
import type { CatalogueSource, ExtensionFamily, ExtensionItem, TieredTables } from './catalogTiers.mts';

type FieldSpec = { type?: string; since?: unknown; valuesSince?: unknown; values?: unknown[]; description?: unknown; itemShape?: Record<string, FieldSpec> } & Record<string, unknown>;
type Mark = { since?: unknown; valuesSince?: unknown; description?: unknown; shape?: unknown };
type MarkTable = Readonly<Record<string, Mark>>;

/** The data-vocabulary families, with the list each one extends and the prefix of an item's name. */
export const DATA_FAMILIES = Object.freeze([
    { family: 'fieldTypes', table: 'FIELD_TYPES', prefix: 'fieldType' },
    { family: 'fieldOptions', table: null, prefix: 'fieldOption' },
    { family: 'tableOptions', table: null, prefix: 'tableOption' },
    { family: 'filterOps', table: 'FILTER_OPS', prefix: 'filterOp' },
    { family: 'aggFns', table: 'AGG_FNS', prefix: 'aggFn' },
    { family: 'dateBuckets', table: 'DATE_BUCKETS', prefix: 'dateBucket' },
    { family: 'rowRule', table: null, prefix: 'rowRule' },
] as const);
type DataListName = 'FIELD_TYPES' | 'FILTER_OPS' | 'AGG_FNS' | 'DATE_BUCKETS';

/** The key-mark families of keyMarks.js: the index family and the name prefix of each. */
const KEY_MARK_NAMES: Readonly<Record<string, { family: ExtensionFamily; prefix: string }>> = Object.freeze({
    section: { family: 'sectionKeys', prefix: 'section.' },
    sectionStyle: { family: 'sectionKeys', prefix: 'section.style.' },
    node: { family: 'nodeKeys', prefix: 'node.' },
    nav: { family: 'navKeys', prefix: 'nav.' },
    navGroup: { family: 'navKeys', prefix: 'nav.groups[].' },
    binding: { family: 'data', prefix: 'binding.' },
    queryShape: { family: 'data', prefix: '' }, // the file name is the whole name: <key>.<name>
});

/** The spec tables whose keys are fixed objects of a definition: the index family and name prefix of each. */
const KEY_TABLES = Object.freeze([
    { table: 'SCREEN_SPEC', family: 'screenKeys', prefix: 'screen' },
    { table: 'THEME_SPEC', family: 'themeKeys', prefix: 'theme' },
    { table: 'DESIGN_SPEC', family: 'designKeys', prefix: 'design' },
] as const);

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function isExtension(since: unknown): boolean {
    return typeof since === 'number' && Number.isInteger(since) && since > SCHEMA_VERSION_BASE;
}

/** The values `marks` adds after the base, as strings. */
function markedValues(marks: unknown): string[] {
    if (!isObject(marks)) return [];
    return Object.keys(marks).filter((value) => isExtension(marks[value]));
}

/** The enum values of `spec` that were added after the base, in the order `values` lists them. */
function lateValues(spec: FieldSpec): string[] {
    if (!Array.isArray(spec.values)) return [];
    const marked = markedValues(spec.valuesSince);
    return spec.values.map((v) => String(v)).filter((v) => marked.includes(v));
}

/** The events of a component type that were added after the base (`eventsSince`), in the order `events` lists them. */
export function lateTypeEvents(spec: { events?: unknown; eventsSince?: unknown }): string[] {
    if (!Array.isArray(spec.events)) return [];
    const marked = markedValues(spec.eventsSince);
    return spec.events.map(String).filter((event) => marked.includes(event));
}

// ── The base tier ───────────────────────────────────────────────────────────

/** `shape` without its extension keys, their values and the same inside nested lists; the same object when nothing is marked. */
export function baseItemShape(shape: Record<string, FieldSpec>, baseField: (spec: FieldSpec) => FieldSpec): Record<string, FieldSpec> {
    let changed = false;
    const out: Record<string, FieldSpec> = {};
    for (const [key, spec] of Object.entries(shape)) {
        if (isExtension(spec?.since)) {
            changed = true;
            continue;
        }
        out[key] = baseField(spec);
        if (out[key] !== spec) changed = true;
    }
    return changed ? out : shape;
}

function withoutMarked<T>(list: readonly T[] | undefined, dropped: readonly string[]): readonly T[] | undefined {
    if (!list || !dropped.length) return list;
    return list.filter((entry) => !dropped.includes(String(entry)));
}

/**
 * The base form of the tables this module tiers. `baseFields` is catalogTiers' own (drops a
 * marked key and a marked enum value); a table the source does not carry stays absent.
 */
export function baseKeyTables(
    source: CatalogueSource,
    baseKnobs: Record<string, unknown>,
    baseFields: (fields: Record<string, FieldSpec>) => Record<string, FieldSpec>,
): Partial<TieredTables> {
    const tables = source.tables as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const { table } of KEY_TABLES) {
        if (isObject(tables[table])) out[table] = baseFields(tables[table] as Record<string, FieldSpec>);
    }
    if (Array.isArray(tables.NAV_STYLES)) out.NAV_STYLES = withoutMarked(tables.NAV_STYLES, markedValues(source.keyMarks?.nav?.style?.valuesSince));
    if (Array.isArray(tables.SECTION_STYLE_KNOBS)) {
        const late = Object.entries(source.keyMarks?.sectionStyle || {}).filter(([, mark]) => isExtension(mark.since)).map(([knob]) => knob);
        out.SECTION_STYLE_KNOBS = (tables.SECTION_STYLE_KNOBS as string[]).filter((knob) => Object.hasOwn(baseKnobs, knob) && !late.includes(knob));
    }
    for (const { family, table } of DATA_FAMILIES) {
        if (!table || !Array.isArray(tables[table])) continue;
        const late = Object.entries(source.dataMarks?.[family] || {}).filter(([, mark]) => isExtension(mark.since)).map(([word]) => word);
        out[table] = withoutMarked(tables[table] as string[], late);
    }
    return out as Partial<TieredTables>;
}

// ── The extension items ─────────────────────────────────────────────────────

/** The keys and enum values added to the items of one list prop, nested lists included. */
function shapeItems(type: string, prop: string, shape: Record<string, FieldSpec> | undefined, trail: string[], out: ExtensionItem[]): void {
    if (!isObject(shape) || trail.length > 4) return;
    const at = `${type}.${[prop, ...trail].map((part) => `${part}[]`).join('.')}`;
    for (const [key, spec] of Object.entries(shape as Record<string, FieldSpec>)) {
        if (!isObject(spec)) continue;
        const path = [prop, ...trail, key];
        if (isExtension(spec.since)) {
            out.push({ family: 'itemKeys', name: `${at}.${key}`, description: text(spec.description), ownerTable: 'item', owner: type, key, path });
            continue;
        }
        for (const value of lateValues(spec)) {
            out.push({ family: 'enumValues', name: `${at}.${key}=${value}`, description: '', ownerTable: 'item', owner: type, key, value, path });
        }
        shapeItems(type, prop, spec.itemShape, [...trail, key], out);
    }
}

/** Every item-shape item of the BASE props of one component type (an extension prop is its own item). */
export function componentShapeItems(type: string, props: Record<string, FieldSpec> | undefined, out: ExtensionItem[]): void {
    for (const [prop, spec] of Object.entries(props || {})) {
        if (isObject(spec) && !isExtension(spec.since)) shapeItems(type, prop, spec.itemShape, [], out);
    }
}

function specTableItems(source: CatalogueSource, out: ExtensionItem[]): void {
    const tables = source.tables as unknown as Record<string, Record<string, FieldSpec> | undefined>;
    for (const { table, family, prefix } of KEY_TABLES) {
        for (const [key, spec] of Object.entries(tables[table] || {})) {
            if (!isObject(spec)) continue;
            if (isExtension(spec.since)) {
                out.push({ family, name: `${prefix}.${key}`, description: text(spec.description), ownerTable: prefix, key });
                continue;
            }
            for (const value of lateValues(spec)) {
                out.push({ family: 'enumValues', name: `${prefix}.${key}=${value}`, description: '', ownerTable: prefix, key, value });
            }
        }
    }
}

function keyMarkItems(marks: CatalogueSource['keyMarks'], out: ExtensionItem[]): void {
    for (const [markFamily, table] of Object.entries(marks || {})) {
        const names = KEY_MARK_NAMES[markFamily];
        if (!names || !isObject(table)) continue;
        for (const [key, mark] of Object.entries(table as MarkTable)) {
            if (!isObject(mark)) continue;
            if (isExtension(mark.since)) out.push({ family: names.family, name: `${names.prefix}${key}`, description: text(mark.description), ownerTable: 'keys', owner: markFamily, key });
            for (const value of markedValues(mark.valuesSince)) {
                out.push({ family: 'enumValues', name: `${names.prefix}${key}=${value}`, description: text(mark.description), ownerTable: 'keys', owner: markFamily, key, value });
            }
        }
    }
}

function dataItems(marks: CatalogueSource['dataMarks'], out: ExtensionItem[]): void {
    for (const { family, prefix } of DATA_FAMILIES) {
        for (const [word, mark] of Object.entries(marks?.[family] || {})) {
            if (isObject(mark) && isExtension(mark.since)) {
                out.push({ family: 'data', name: `${prefix}.${word}`, description: text(mark.description), ownerTable: 'data', owner: family, key: word });
            }
        }
    }
}

/** The extension items of everything this module tiers, in no particular order (catalogTiers sorts). */
export function keyItems(source: CatalogueSource, out: ExtensionItem[]): void {
    specTableItems(source, out);
    keyMarkItems(source.keyMarks, out);
    dataItems(source.dataMarks, out);
}
