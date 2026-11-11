/**
 * App Studio: the two tiers of the AI builder's catalogue.
 *
 * BASE       every catalogue entry without a `since` above the base schema version. It is what
 *            the system prompt renders, byte for byte, so its text only moves when a base entry
 *            does.
 * EXTENSION  every entry marked `since: 3` or higher (schemaSince.mts lists the places a mark
 *            can sit). The prompt carries only an index of these (builderPrompt/extensionIndex.mts);
 *            the full entry is served on demand by app_inspect_catalog.
 *
 * The marks are the ones schemaSince.mts indexes for the schema version, so whatever makes a
 * definition need version 3 is also what leaves the pinned prompt. The tables outside the
 * component, knob, step and action specs (screen, theme, design, nav, section and node keys,
 * the items of a list prop, the data vocabulary) are split in catalogTiersKeys.mts.
 *
 * The catalogue is fixed after load, so both tiers are computed once. With no extension entry
 * the base tables ARE the live tables.
 */

import { createRequire } from 'node:module';
import { SCHEMA_VERSION_BASE } from '../shared/appDefinition/schemaVersion.mjs';
import { definitionKeys } from './definitionKeyRegistry.mts';
import { baseItemShape, baseKeyTables, componentShapeItems, keyItems, lateTypeEvents } from './catalogTiersKeys.mts';

type FieldSpec = { type?: string; since?: unknown; valuesSince?: unknown; values?: unknown[]; description?: unknown; itemShape?: Record<string, FieldSpec> } & Record<string, unknown>;
type ComponentSpec = { since?: unknown; description?: unknown; props?: Record<string, FieldSpec>; styleKnobs?: string[]; events?: string[]; eventsSince?: unknown; childrenSince?: unknown; childrenDescription?: unknown } & Record<string, unknown>;
type KindSpec = { since?: unknown; description?: unknown; fields: Record<string, FieldSpec> } & Record<string, unknown>;
type SpecHub = typeof import('./componentSpecs.js');

/** The spec tables that have a base and an extension tier, under the names the spec hub gives them. */
export type TieredTables = Pick<SpecHub, 'COMPONENT_SPECS' | 'STYLE_KNOBS' | 'ACTION_KINDS' | 'ACTION_SPECS' | 'STEP_KINDS' | 'STEP_SPECS' | 'DATA_MUTATING_STEP_KINDS'>
    & Pick<SpecHub, 'SCREEN_SPEC' | 'THEME_SPEC' | 'DESIGN_SPEC' | 'NAV_STYLES' | 'SECTION_STYLE_KNOBS'>
    & { FIELD_TYPES: readonly string[]; FILTER_OPS: readonly string[]; AGG_FNS: readonly string[]; DATE_BUCKETS: readonly string[] };

/** The lines of the extension index, in the order it prints them. A new family goes where it reads best: nothing depends on the position of the others. */
export const EXTENSION_FAMILIES = Object.freeze([
    'componentTypes', 'props', 'itemKeys', 'styleKnobs', 'enumValues',
    'screenKeys', 'sectionKeys', 'nodeKeys', 'themeKeys', 'designKeys', 'navKeys',
    'stepKinds', 'stepFields', 'actionKinds', 'actionFields', 'bindingKinds', 'topLevelKeys', 'variableKeys', 'data',
] as const);
export type ExtensionFamily = typeof EXTENSION_FAMILIES[number];

/** Where an extension item sits in the catalogue: what its full entry is rendered from. */
export interface ExtensionItem {
    family: ExtensionFamily;
    /** The name the index lists and app_inspect_catalog answers to. Unique within its family. */
    name: string;
    /** The spec entry's own description ('' when it has none). */
    description: string;
    /**
     * The table the owner lives in, for a prop, a field, a key or an enum value. 'item' is the
     * item shape of a list prop, 'event' an event an existing type newly fires, 'keys' a key file of
     * componentSpecs/keys/ (a binding key and a query shape among them), 'data' the data vocabulary.
     */
    ownerTable?: 'component' | 'knob' | 'step' | 'action' | 'item' | 'event' | 'slot' | 'screen' | 'theme' | 'design' | 'keys' | 'data';
    /** The component type or kind that holds `key`; the key-mark or data family for 'keys' and 'data' (absent for a knob). */
    owner?: string;
    /** The prop, knob, field, key or word. */
    key?: string;
    /** The enum value, for the enumValues family. */
    value?: string;
    /** 'item' only: the list prop, the lists nested under it, then the key. */
    path?: string[];
}

type Mark = { since?: unknown; valuesSince?: unknown; description?: unknown; shape?: unknown };

/** The spec fields of a type that became a slot container after the base (componentSpecs/itemTemplates.js). */
const LATE_SLOT_FIELDS = Object.freeze(['container', 'slotContainer', 'childrenSince', 'childrenDescription']);

const nodeRequire = createRequire(import.meta.url);
const specs = nodeRequire('./componentSpecs.js') as SpecHub & {
    KEY_MARKS: Record<string, Record<string, Mark>>;
    BINDING_KIND_SINCE: Record<string, unknown>;
    BINDING_KIND_DOCS: Record<string, { shape?: unknown; description?: unknown } | undefined>;
};
const { EXTENSION_STEP_ENTRIES } = nodeRequire('./componentSpecs/stepRegistry.js') as {
    EXTENSION_STEP_ENTRIES: readonly { kind: string; description?: unknown }[];
};
const dataVocabulary = nodeRequire('../core/dataEngine/dataModel/vocabulary.js') as Record<'FIELD_TYPES' | 'FILTER_OPS' | 'AGG_FNS' | 'DATE_BUCKETS', readonly string[]>;
const { DATA_VOCABULARY_MARKS } = nodeRequire('../core/dataEngine/dataModel/vocabularySince.js') as { DATA_VOCABULARY_MARKS: Record<string, Record<string, Mark>> };

/** A catalogue to split: the tiered tables plus the three places an entry has no table of its own. */
export interface CatalogueSource {
    tables: TieredTables;
    bindingKindSince?: Record<string, unknown>;
    bindingKindDocs?: Record<string, { description?: unknown } | undefined>;
    definitionKeys?: readonly { key: string; since?: unknown; description?: unknown }[];
    /** A registry step kind's description: STEP_SPECS keeps only what the step executor reads. */
    stepDescriptions?: ReadonlyMap<string, string>;
    /** componentSpecs/keyMarks.js: family → key → mark. */
    keyMarks?: Readonly<Record<string, Readonly<Record<string, Mark>> | undefined>>;
    /** core/dataEngine/dataModel/vocabularySince.js: family → word → mark. */
    dataMarks?: Readonly<Record<string, Readonly<Record<string, Mark>> | undefined>>;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** True for a `since` above the base (the rule of schemaSince.mts). */
export function isExtensionSince(since: unknown): boolean {
    return typeof since === 'number' && Number.isInteger(since) && since > SCHEMA_VERSION_BASE;
}

/** The enum values of `spec` that were added after the base, as written in `values`. */
function extensionValues(spec: FieldSpec | undefined): string[] {
    const marks = spec?.valuesSince;
    if (!marks || typeof marks !== 'object' || Array.isArray(marks) || !Array.isArray(spec?.values)) return [];
    const marked = marks as Record<string, unknown>;
    return spec.values.map((v) => String(v)).filter((v) => Object.hasOwn(marked, v) && isExtensionSince(marked[v]));
}

/** `spec` without its extension enum values and, for a list, the extension keys of its items (the same object when it has none). */
function baseField<T extends FieldSpec>(spec: T): T {
    const dropped = extensionValues(spec);
    const shape = spec?.itemShape && typeof spec.itemShape === 'object' ? baseItemShape(spec.itemShape, baseField) : spec?.itemShape;
    if (!dropped.length && shape === spec?.itemShape) return spec;
    const base = { ...spec, ...(shape === spec.itemShape ? {} : { itemShape: shape }) };
    if (dropped.length) {
        base.values = (spec.values as unknown[]).filter((v) => !dropped.includes(String(v)));
        delete base.valuesSince; // the base copy is the entry as it was before the values were added
    }
    return base;
}

/** A field table without its extension fields and extension enum values. */
function baseFields<T extends FieldSpec>(fields: Record<string, T> | undefined): Record<string, T> {
    const out: Record<string, T> = {};
    for (const [key, spec] of Object.entries(fields || {})) {
        if (!isExtensionSince(spec?.since)) out[key] = baseField(spec);
    }
    return out;
}

function baseKindSpecs(table: Record<string, KindSpec>): Record<string, KindSpec> {
    const out: Record<string, KindSpec> = {};
    for (const [kind, spec] of Object.entries(table)) {
        if (!isExtensionSince(spec.since)) out[kind] = { ...spec, fields: baseFields(spec.fields) };
    }
    return out;
}

function computeBase(source: CatalogueSource): TieredTables {
    const { tables } = source;
    const knobs = baseFields(tables.STYLE_KNOBS as unknown as Record<string, FieldSpec>);
    const components: Record<string, ComponentSpec> = Object.create(null);
    for (const [type, spec] of Object.entries(tables.COMPONENT_SPECS as unknown as Record<string, ComponentSpec>)) {
        if (isExtensionSince(spec.since)) continue;
        components[type] = {
            ...spec,
            props: baseFields(spec.props),
            styleKnobs: (spec.styleKnobs || []).filter((knob) => Object.hasOwn(knobs, knob)),
        };
        const lateEvents = lateTypeEvents(spec);
        if (lateEvents.length) {
            // The base copy is the entry as it was before the events were added: a type that fired nothing had no list.
            const baseEvents = (spec.events as string[]).filter((event) => !lateEvents.includes(event));
            if (baseEvents.length) components[type].events = baseEvents; else delete components[type].events;
            delete components[type].eventsSince;
        }
        // A type that became a slot container later (`childrenSince`, componentSpecs/itemTemplates.js):
        // the base copy is the type as it was, holding no children.
        if (isExtensionSince(spec.childrenSince)) {
            for (const field of LATE_SLOT_FIELDS) delete components[type][field];
        }
    }
    const stepSpecs = baseKindSpecs(tables.STEP_SPECS as unknown as Record<string, KindSpec>);
    const actionSpecs = baseKindSpecs(tables.ACTION_SPECS as unknown as Record<string, KindSpec>);
    const base = {
        ...tables, // what has one tier only
        ...baseKeyTables(source, knobs, baseFields),
        COMPONENT_SPECS: components,
        STYLE_KNOBS: knobs,
        ACTION_KINDS: tables.ACTION_KINDS.filter((kind) => Object.hasOwn(actionSpecs, kind)),
        ACTION_SPECS: actionSpecs,
        STEP_KINDS: tables.STEP_KINDS.filter((kind) => Object.hasOwn(stepSpecs, kind)),
        STEP_SPECS: stepSpecs,
        DATA_MUTATING_STEP_KINDS: tables.DATA_MUTATING_STEP_KINDS.filter((kind) => Object.hasOwn(stepSpecs, kind)),
    };
    return base as unknown as TieredTables;
}

/** The extension fields and enum values of one field table. */
function fieldItems(table: 'component' | 'step' | 'action', owner: string, fields: Record<string, FieldSpec> | undefined,
    fieldFamily: ExtensionFamily, valuePrefix: string, out: ExtensionItem[]): void {
    for (const [key, spec] of Object.entries(fields || {})) {
        if (!spec || typeof spec !== 'object') continue;
        if (isExtensionSince(spec.since)) {
            out.push({ family: fieldFamily, name: `${owner}.${key}`, description: text(spec.description), ownerTable: table, owner, key });
            continue;
        }
        for (const value of extensionValues(spec)) {
            out.push({ family: 'enumValues', name: `${valuePrefix}${owner}.${key}=${value}`, description: '', ownerTable: table, owner, key, value });
        }
    }
}

function kindItems(table: 'step' | 'action', kinds: Record<string, KindSpec>, described: ReadonlyMap<string, string> | undefined, out: ExtensionItem[]): void {
    for (const [kind, spec] of Object.entries(kinds)) {
        if (!spec || typeof spec !== 'object') continue;
        if (isExtensionSince(spec.since)) {
            const description = text(spec.description) || described?.get(kind) || '';
            out.push({ family: table === 'step' ? 'stepKinds' : 'actionKinds', name: kind, description });
            continue;
        }
        fieldItems(table, kind, spec.fields, table === 'step' ? 'stepFields' : 'actionFields', `${table}.`, out);
    }
}

function computeExtensions(source: CatalogueSource): ExtensionItem[] {
    const out: ExtensionItem[] = [];
    const { tables } = source;
    for (const [type, spec] of Object.entries(tables.COMPONENT_SPECS as unknown as Record<string, ComponentSpec>)) {
        if (!spec || typeof spec !== 'object') continue;
        // The props of an extension type are part of its own entry.
        if (isExtensionSince(spec.since)) {
            out.push({ family: 'componentTypes', name: type, description: text(spec.description) });
            continue;
        }
        fieldItems('component', type, spec.props, 'props', '', out);
        componentShapeItems(type, spec.props, out);
        for (const event of lateTypeEvents(spec)) out.push({ family: 'nodeKeys', name: `${type}.${event}`, description: '', ownerTable: 'event', owner: type, key: event });
        if (isExtensionSince(spec.childrenSince)) {
            out.push({ family: 'nodeKeys', name: `${type}.children`, description: text(spec.childrenDescription), ownerTable: 'slot', owner: type, key: 'children' });
        }
    }
    for (const [knob, spec] of Object.entries(tables.STYLE_KNOBS as unknown as Record<string, FieldSpec>)) {
        if (!spec || typeof spec !== 'object') continue;
        if (isExtensionSince(spec.since)) {
            out.push({ family: 'styleKnobs', name: knob, description: text(spec.description), ownerTable: 'knob', key: knob });
            continue;
        }
        for (const value of extensionValues(spec)) {
            out.push({ family: 'enumValues', name: `style.${knob}=${value}`, description: '', ownerTable: 'knob', key: knob, value });
        }
    }
    kindItems('step', tables.STEP_SPECS as unknown as Record<string, KindSpec>, source.stepDescriptions, out);
    kindItems('action', tables.ACTION_SPECS as unknown as Record<string, KindSpec>, undefined, out);
    for (const [kind, since] of Object.entries(source.bindingKindSince || {})) {
        if (isExtensionSince(since)) out.push({ family: 'bindingKinds', name: kind, description: text(source.bindingKindDocs?.[kind]?.description) });
    }
    for (const entry of source.definitionKeys || []) {
        if (isExtensionSince(entry.since)) out.push({ family: 'topLevelKeys', name: entry.key, description: text(entry.description) });
    }
    keyItems(source, out);
    // Code-point order within a family: the index text is the same on every machine.
    const rank = (item: ExtensionItem) => EXTENSION_FAMILIES.indexOf(item.family);
    return out.sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Split a catalogue: its extension items (by family, then by name) and its base tables. A
 * catalogue without a mark is its own base: the very same tables come back.
 */
export function splitCatalogue(source: CatalogueSource): { items: readonly ExtensionItem[]; base: TieredTables } {
    const items = Object.freeze(computeExtensions(source));
    return { items, base: items.length ? computeBase(source) : source.tables };
}

/** Test-only replacements for tables and mark tables that are frozen (see _setCatalogueOverlay). */
export type CatalogueOverlay = Partial<TieredTables> & Pick<CatalogueSource, 'keyMarks' | 'dataMarks'>;

let generation = 0;
let overlay: CatalogueOverlay | null = null;
let cached: { generation: number; items: readonly ExtensionItem[]; base: TieredTables; full: TieredTables } | null = null;

/** The live tables that have two tiers: the spec hub's own objects and the data vocabulary's lists. */
function liveTables(): TieredTables {
    const { keyMarks: _keyMarks, dataMarks: _dataMarks, ...tables } = overlay || {};
    return {
        COMPONENT_SPECS: specs.COMPONENT_SPECS, STYLE_KNOBS: specs.STYLE_KNOBS,
        ACTION_KINDS: specs.ACTION_KINDS, ACTION_SPECS: specs.ACTION_SPECS,
        STEP_KINDS: specs.STEP_KINDS, STEP_SPECS: specs.STEP_SPECS, DATA_MUTATING_STEP_KINDS: specs.DATA_MUTATING_STEP_KINDS,
        SCREEN_SPEC: specs.SCREEN_SPEC, THEME_SPEC: specs.THEME_SPEC, DESIGN_SPEC: specs.DESIGN_SPEC,
        NAV_STYLES: specs.NAV_STYLES, SECTION_STYLE_KNOBS: specs.SECTION_STYLE_KNOBS,
        FIELD_TYPES: dataVocabulary.FIELD_TYPES, FILTER_OPS: dataVocabulary.FILTER_OPS,
        AGG_FNS: dataVocabulary.AGG_FNS, DATE_BUCKETS: dataVocabulary.DATE_BUCKETS,
        ...tables,
    };
}

function tiers(): { items: readonly ExtensionItem[]; base: TieredTables; full: TieredTables } {
    if (cached && cached.generation === generation) return cached;
    const full = liveTables();
    cached = {
        generation,
        full,
        ...splitCatalogue({
            tables: full,
            bindingKindSince: specs.BINDING_KIND_SINCE,
            bindingKindDocs: specs.BINDING_KIND_DOCS,
            definitionKeys: definitionKeys(),
            stepDescriptions: new Map(EXTENSION_STEP_ENTRIES.map((e) => [e.kind, text(e.description)])),
            keyMarks: overlay?.keyMarks || specs.KEY_MARKS,
            dataMarks: overlay?.dataMarks || DATA_VOCABULARY_MARKS,
        }),
    };
    return cached;
}

/** The whole catalogue: the live tables (the spec hub's own objects), one object per generation. */
export function fullCatalogue(): TieredTables {
    return tiers().full;
}

/** The mark tables the live tiers were split with (a test's overlay, or what ships). */
export function catalogueMarks(): Required<Pick<CatalogueSource, 'keyMarks' | 'dataMarks'>> {
    return { keyMarks: overlay?.keyMarks || specs.KEY_MARKS, dataMarks: overlay?.dataMarks || DATA_VOCABULARY_MARKS };
}

/** The catalogue without anything marked `since` 3 or higher. */
export function baseCatalogue(): TieredTables {
    return tiers().base;
}

/** Every extension item, by family (in EXTENSION_FAMILIES order), then by name. */
export function extensionItems(): readonly ExtensionItem[] {
    return tiers().items;
}

export function hasExtensions(): boolean {
    return tiers().items.length > 0;
}

/** Changes when a test swapped the catalogue: a text cached under another number is stale. */
export function catalogueGeneration(): number {
    return generation;
}

/** Test-only: the live tables were changed in place, so compute both tiers again. */
export function _catalogueChanged(): void {
    generation += 1;
    cached = null;
}

/**
 * Test-only: stand-ins for the tables and mark tables a test cannot change in place because
 * they are frozen (DESIGN_SPEC, NAV_STYLES, the data vocabulary and its marks). `null` takes
 * them out again. Only the tiers read it: canonicalize and the tool schemas keep the real tables.
 */
export function _setCatalogueOverlay(next: CatalogueOverlay | null): void {
    overlay = next;
    _catalogueChanged();
}
