/**
 * App Studio: the NAMES of the frozen base vocabulary, and the check that nothing joins it.
 *
 * Every app made before schema version 3 relies on the base: its types, props, enum values,
 * knobs, step and action kinds with their fields, screen, theme and design keys, nav styles,
 * events, binding kinds and data words. Whatever is added later carries a `since` mark
 * (schemaSince.mts lists where), which keeps it out of the base tier (catalogTiers.mts).
 *
 * projectVocabulary() writes the base tier down as plain names;
 * componentSpecs/__tests__/baseVocabulary.pin.json is that projection of the frozen base, and
 * catalogContract.test.js compares the two. So vocabulary added WITHOUT a mark fails there, by
 * name and with the mark to add, instead of as a changed prompt hash; vocabulary added WITH a
 * mark never touches the pin.
 *
 *   node server/appStudio/baseVocabulary.mts --write   write the pin again (only for a
 *                                                      deliberate change of the base itself)
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { baseCatalogue } from './catalogTiers.mts';
import { BASE_DEFINITION_KEYS } from './definitionKeyRegistry.mts';

type FieldSpec = { type?: string; values?: unknown[]; itemShape?: Record<string, FieldSpec> };
type Names = Record<string, unknown>;

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PIN_FILE = path.join(HERE, 'componentSpecs', '__tests__', 'baseVocabulary.pin.json');

const nodeRequire = createRequire(import.meta.url);
const specs = nodeRequire('./componentSpecs.js') as {
    BINDING_KINDS: string[];
    BINDING_KIND_SINCE: Record<string, unknown>;
    EVENT_NAMES: string[];
    KEY_MARKS: Record<string, Record<string, { since?: unknown }>>;
};

/** One field: its enum values (as JSON text, so null and '' stay apart), its item shape, or true. */
function fieldNames(spec: FieldSpec): unknown {
    if (spec?.type === 'enum' && Array.isArray(spec.values)) return spec.values.map((v) => JSON.stringify(v));
    if (spec?.itemShape && typeof spec.itemShape === 'object') return tableNames(spec.itemShape);
    return true;
}

function tableNames(table: Record<string, FieldSpec> | undefined): Names {
    const out: Names = {};
    for (const [key, spec] of Object.entries(table || {})) out[key] = fieldNames(spec);
    return out;
}

function kindNames(table: Record<string, { fields?: Record<string, FieldSpec> }>): Names {
    const out: Names = {};
    for (const [kind, spec] of Object.entries(table)) out[kind] = tableNames(spec.fields);
    return out;
}

/** The base tier of the live catalogue, as names only. Deterministic: tables keep their own order. */
export function projectVocabulary(): Names {
    const base = baseCatalogue() as unknown as Record<string, unknown>;
    const types: Names = {};
    for (const [type, spec] of Object.entries(base.COMPONENT_SPECS as Record<string, { props?: Record<string, FieldSpec>; styleKnobs?: string[]; events?: string[] }>)) {
        types[type] = { props: tableNames(spec.props), styleKnobs: [...(spec.styleKnobs || [])], events: [...(spec.events || [])] };
    }
    const lateNodeKeys = Object.entries(specs.KEY_MARKS.node || {}).filter(([, mark]) => mark.since !== undefined).map(([key]) => key);
    return {
        componentTypes: types,
        styleKnobs: tableNames(base.STYLE_KNOBS as Record<string, FieldSpec>),
        stepKinds: kindNames(base.STEP_SPECS as Record<string, { fields?: Record<string, FieldSpec> }>),
        serverStepKinds: [...(base.DATA_MUTATING_STEP_KINDS as string[])],
        actionKinds: kindNames(base.ACTION_SPECS as Record<string, { fields?: Record<string, FieldSpec> }>),
        screenKeys: tableNames(base.SCREEN_SPEC as Record<string, FieldSpec>),
        themeKeys: tableNames(base.THEME_SPEC as Record<string, FieldSpec>),
        designKeys: tableNames(base.DESIGN_SPEC as Record<string, FieldSpec>),
        navStyles: [...(base.NAV_STYLES as string[])],
        sectionStyleKnobs: [...(base.SECTION_STYLE_KNOBS as string[])],
        events: specs.EVENT_NAMES.filter((event) => !lateNodeKeys.includes(event)),
        bindingKinds: specs.BINDING_KINDS.filter((kind) => specs.BINDING_KIND_SINCE[kind] === undefined),
        topLevelKeys: [...BASE_DEFINITION_KEYS],
        fieldTypes: [...(base.FIELD_TYPES as string[])],
        filterOps: [...(base.FILTER_OPS as string[])],
        aggFns: [...(base.AGG_FNS as string[])],
        dateBuckets: [...(base.DATE_BUCKETS as string[])],
    };
}

/** What to do about a name that joined the base, by the place it sits in. */
const HINTS: readonly [test: (trail: string[]) => boolean, hint: string][] = [
    [(t) => t.length === 1 && t[0] === 'componentTypes', 'A new type is a file componentSpecs/types/<type>.js carrying since: 3 and mobile.reason.'],
    [(t) => t[0] === 'componentTypes' && t[2] === 'styleKnobs', 'A per-type knob list is frozen: grant a new knob by rule with a knob group file (componentSpecs/styleKnobGroups/<group>.js).'],
    [(t) => t[0] === 'componentTypes' && t[2] === 'events', 'Add the event to the type\'s `events` AND mark it: eventsSince: { <event>: 3 }.'],
    [(t) => t[0] === 'componentTypes' && t.length === 3, 'Mark the prop since: 3 (it is then written only when a node carries it).'],
    [(t) => t[0] === 'componentTypes', 'Mark it where it is declared: since: 3 on a new item key, valuesSince: { <value>: 3 } beside `values` for a new enum value.'],
    [(t) => t.length === 1 && t[0] === 'styleKnobs', 'A new knob comes from a knob group file (componentSpecs/styleKnobGroups/<group>.js), each knob with since: 3.'],
    [(t) => t.length === 1 && (t[0] === 'stepKinds' || t[0] === 'serverStepKinds'), 'A new step kind is a file componentSpecs/steps/<kind>.js carrying since: 3, policy and childSlots.'],
    [(t) => t.length === 1 && t[0] === 'actionKinds', 'Mark the action kind since: 3 in ACTION_SPECS.'],
    [(t) => t[0] === 'stepKinds' || t[0] === 'actionKinds', 'Mark the field since: 3, or a new enum value with valuesSince: { <value>: 3 } beside `values`.'],
    [(t) => t.length === 1 && ['screenKeys', 'themeKeys', 'designKeys'].includes(t[0]), 'Mark the key since: 3 in its spec table (a theme or design key also needs optional: true).'],
    [(t) => ['screenKeys', 'themeKeys', 'designKeys', 'styleKnobs'].includes(t[0]), 'Add valuesSince: { <value>: 3 } beside `values`.'],
    [(t) => t[0] === 'navStyles', 'Mark the style in componentSpecs/keys/nav/style.js: valuesSince: { <style>: 3 }.'],
    [(t) => t[0] === 'sectionStyleKnobs', 'Mark the knob with a file componentSpecs/keys/sectionStyle/<knob>.js carrying since: 3.'],
    [(t) => t[0] === 'events', 'Mark the event with a file componentSpecs/keys/node/<event>.js carrying since: 3.'],
    [(t) => t[0] === 'bindingKinds', 'Mark the kind in BINDING_KIND_SINCE (componentSpecs/bindings.js) and describe it in BINDING_KIND_DOCS.'],
    [(t) => t[0] === 'topLevelKeys', 'A new top-level key is a file definitionKeys/<key>.js carrying since: 3; the base list never grows.'],
    [() => true, 'Mark the word in DATA_VOCABULARY_MARKS (core/dataEngine/dataModel/vocabularySince.js): { since: 3, description }.'],
];

function hintFor(trail: string[]): string {
    return (HINTS.find(([test]) => test(trail)) as (typeof HINTS)[number])[1];
}

const isObject = (v: unknown): v is Names => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The names of one level: the keys of an object, the entries of a list. */
function namesOf(v: unknown): string[] {
    if (Array.isArray(v)) return v.map(String);
    return isObject(v) ? Object.keys(v) : [];
}

/**
 * Every difference between the pinned base and the live one, as sentences: a name that joined
 * the base (with the mark it is missing), a name that left it, a list that changed order.
 */
export function vocabularyProblems(pinned: unknown, live: unknown, trail: string[] = []): string[] {
    const at = trail.join(' › ') || 'the base vocabulary';
    const [was, now] = [namesOf(pinned), namesOf(live)];
    const out: string[] = [];
    for (const name of now) {
        if (!was.includes(name)) out.push(`${at}: ${name} is not part of the frozen base. ${hintFor(trail)}`);
    }
    for (const name of was) {
        if (!now.includes(name)) out.push(`${at}: ${name} was removed from the base, or marked as an extension: apps stored before rely on it.`);
    }
    if (!out.length && was.join('\n') !== now.join('\n')) out.push(`${at}: the base order changed (${was.join(', ')} became ${now.join(', ')}): the pinned prompt renders in this order.`);
    if (isObject(pinned) && isObject(live)) {
        for (const name of was) {
            if (Object.hasOwn(live, name)) out.push(...vocabularyProblems(pinned[name], live[name], [...trail, name]));
        }
    }
    return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--write')) {
    fs.mkdirSync(path.dirname(PIN_FILE), { recursive: true });
    fs.writeFileSync(PIN_FILE, `${JSON.stringify(projectVocabulary(), null, 1)}\n`);
    process.stdout.write(`wrote ${path.relative(process.cwd(), PIN_FILE)}\n`);
}
