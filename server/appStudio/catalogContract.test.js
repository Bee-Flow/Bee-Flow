'use strict';
/**
 * The contract every catalogue entry added after the frozen base must satisfy.
 *
 * Nothing here depends on how many entries ship: the registries may be empty or hold fifty
 * files. A valid addition needs no edit of this file; an invalid one fails with the name of
 * the entry and what to change.
 *
 *   - Nothing joins the BASE: the base tier is, name for name, the frozen one
 *     (componentSpecs/__tests__/baseVocabulary.pin.json). Whatever is new carries a mark.
 *   - Every mark is well formed: `since` is an integer of 3 or more, wherever it sits.
 *   - Every extension item can be indexed for the AI builder: a one-token name, a
 *     description whose first sentence fits the index.
 *   - Each kind of entry carries what its readers need: a step kind an answer for every
 *     execution form, a type the phone's disposition, a top-level key its `public` flag.
 *
 * Run: node --test appStudio/catalogContract.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const specs = require('./componentSpecs');
const tiers = require('./catalogTiers.mts');
const since = require('./schemaSince.mts');
const shared = require('../shared/appDefinition/schemaVersion.mjs');
const { projectVocabulary, vocabularyProblems, PIN_FILE } = require('./baseVocabulary.mts');
const { gloss, GLOSS_MAX_CHARS } = require('./builderPrompt/extensionIndex.mts');
const stepRegistry = require('./componentSpecs/stepRegistry');
const { POLICY_FORMS } = require('./componentSpecs/stepMeta');
const { checkTypeExtension } = require('./componentSpecs/typeExtensions');
const { KEY_MARK_FAMILIES } = require('./componentSpecs/keyMarks');
const { definitionKeys, BASE_DEFINITION_KEYS } = require('./definitionKeyRegistry.mts');
const { SECTION_OPTIONAL_KEYS } = require('./canonicalize/screens');
const { DATA_VOCABULARY_MARKS } = require('../core/dataEngine/dataModel/vocabularySince');
const { canonicalizeAppDefinition } = require('./canonicalize');

const { COMPONENT_SPECS, STYLE_KNOBS, STEP_SPECS, ACTION_SPECS, SCREEN_SPEC, THEME_SPEC, DESIGN_SPEC, KEY_MARKS } = specs;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isSince = (v) => Number.isInteger(v) && v >= 3;
/** Fail with every problem at once: an entry is usually wrong in more than one way. */
const noProblems = (problems, what) => assert.equal(problems.length, 0, `${what}:\n  ${problems.join('\n  ')}`);

// ── Nothing joins the base ──────────────────────────────────────────────────

test('the base vocabulary is the frozen one: every name added after it carries a since mark', () => {
    const pinned = JSON.parse(fs.readFileSync(PIN_FILE, 'utf8'));
    noProblems(vocabularyProblems(pinned, projectVocabulary()), 'Vocabulary was added to (or taken from) the frozen base');
});

test('the check names what joined the base and the mark it is missing', () => {
    const pinned = { componentTypes: { heading: { props: { text: true, tone: ['"a"'] }, styleKnobs: ['span'], events: [] } }, stepKinds: { toast: { message: true } }, navStyles: ['tabs'], fieldTypes: ['text'] };
    const live = {
        componentTypes: { heading: { props: { text: true, tone: ['"a"', '"b"'], kicker: true }, styleKnobs: ['span', 'glow'], events: ['onClick'] }, gauge: { props: {}, styleKnobs: [], events: [] } },
        stepKinds: { toast: { message: true, seconds: true }, wait: {} },
        navStyles: ['tabs', 'dock'],
        fieldTypes: ['text', 'money'],
    };
    const text = vocabularyProblems(pinned, live).join('\n');
    assert.match(text, /componentTypes: gauge is not part of the frozen base\. A new type is a file componentSpecs\/types\/<type>\.js/);
    assert.match(text, /componentTypes › heading › props: kicker is not part of the frozen base\. Mark the prop since: 3/);
    assert.match(text, /heading › props › tone: "b" is not part of the frozen base\. .*valuesSince: \{ <value>: 3 \}/);
    assert.match(text, /heading › styleKnobs: glow .*knob group file/);
    assert.match(text, /heading › events: onClick .*eventsSince: \{ <event>: 3 \}/);
    assert.match(text, /stepKinds: wait .*componentSpecs\/steps\/<kind>\.js/);
    assert.match(text, /stepKinds › toast: seconds .*Mark the field since: 3/);
    assert.match(text, /navStyles: dock .*componentSpecs\/keys\/nav\/style\.js/);
    assert.match(text, /fieldTypes: money .*DATA_VOCABULARY_MARKS/);
    assert.match(vocabularyProblems(live, pinned).join('\n'), /componentTypes: gauge was removed from the base/);
    assert.match(vocabularyProblems({ navStyles: ['a', 'b'] }, { navStyles: ['b', 'a'] }).join('\n'), /the base order changed/);
    assert.deepEqual(vocabularyProblems(live, JSON.parse(JSON.stringify(live))), []);
});

// ── Every mark is well formed ───────────────────────────────────────────────

/** The problems of the marks on one spec entry: `since`, `valuesSince` (against `values`), `eventsSince` (against `events`). */
function markProblems(where, spec) {
    if (!isObject(spec)) return [];
    const out = [];
    if (spec.since !== undefined && !isSince(spec.since)) out.push(`${where}: since is ${JSON.stringify(spec.since)}; an entry added after the base carries an integer of 3 or more (an entry of the base carries none)`);
    for (const [marks, list, word] of [['valuesSince', 'values', 'value'], ['eventsSince', 'events', 'event']]) {
        if (spec[marks] === undefined) continue;
        if (!isObject(spec[marks])) { out.push(`${where}: ${marks} is { <${word}>: <since> }`); continue; }
        for (const [name, value] of Object.entries(spec[marks])) {
            if (!isSince(value)) out.push(`${where}: ${marks}.${name} is ${JSON.stringify(value)}; use an integer of 3 or more`);
            if (Array.isArray(spec[list]) && !spec[list].map(String).includes(name)) out.push(`${where}: ${marks} marks "${name}", which is not in ${list}`);
        }
    }
    for (const [key, item] of Object.entries(isObject(spec.itemShape) ? spec.itemShape : {})) out.push(...markProblems(`${where}[].${key}`, item));
    return out;
}

function tableMarkProblems(label, table, inner) {
    const out = [];
    for (const [name, spec] of Object.entries(table || {})) {
        out.push(...markProblems(`${label}.${name}`, spec));
        for (const [key, field] of Object.entries((inner && isObject(spec) && spec[inner]) || {})) out.push(...markProblems(`${label}.${name}.${inner}.${key}`, field));
    }
    return out;
}

test('every since mark in the catalogue is an integer of 3 or more, and marks something that exists', () => {
    const problems = [
        ...tableMarkProblems('COMPONENT_SPECS', COMPONENT_SPECS, 'props'),
        ...tableMarkProblems('STYLE_KNOBS', STYLE_KNOBS),
        ...tableMarkProblems('STEP_SPECS', STEP_SPECS, 'fields'),
        ...tableMarkProblems('ACTION_SPECS', ACTION_SPECS, 'fields'),
        ...tableMarkProblems('SCREEN_SPEC', SCREEN_SPEC),
        ...tableMarkProblems('THEME_SPEC', THEME_SPEC),
        ...tableMarkProblems('DESIGN_SPEC', DESIGN_SPEC),
    ];
    for (const [kind, value] of Object.entries(specs.BINDING_KIND_SINCE)) {
        if (!isSince(value)) problems.push(`BINDING_KIND_SINCE.${kind} is ${JSON.stringify(value)}; use an integer of 3 or more`);
        if (!specs.BINDING_KINDS.includes(kind)) problems.push(`BINDING_KIND_SINCE marks "${kind}", which is not in BINDING_KINDS`);
    }
    for (const [family, table] of Object.entries(DATA_VOCABULARY_MARKS)) {
        for (const [word, mark] of Object.entries(table)) {
            if (!isSince(mark.since)) problems.push(`DATA_VOCABULARY_MARKS.${family}.${word}: since is ${JSON.stringify(mark.since)}; use an integer of 3 or more`);
        }
    }
    noProblems(problems, 'A since mark is malformed');
    // And the marks the helpers above accept are the ones the two readers act on.
    assert.deepEqual(markProblems('x', { since: '3' }).length, 1);
    assert.deepEqual(markProblems('x', { since: 2 }).length, 1);
    assert.deepEqual(markProblems('x', { values: ['a'], valuesSince: { b: 3, a: 2 } }).length, 2);
    assert.deepEqual(markProblems('x', { events: ['onClick'], eventsSince: { onClick: 3 } }), []);
    assert.deepEqual(markProblems('x', { type: 'list', itemShape: { k: { since: 1 } } }).length, 1);
});

test('a theme or design key added after the base is optional: it is written only when set', () => {
    const problems = [];
    for (const [label, table] of [['THEME_SPEC', THEME_SPEC], ['DESIGN_SPEC', DESIGN_SPEC]]) {
        for (const [key, spec] of Object.entries(table)) {
            if (spec.since !== undefined && spec.optional !== true) problems.push(`${label}.${key}: add optional: true (a key without it is written into every stored app on its next save)`);
        }
    }
    noProblems(problems, 'A late theme or design key would change existing apps');
});

// ── Every extension item can be indexed ─────────────────────────────────────

const NAME_OK = /^[^\s;,\u0000-\u001f\u007f-\u009f]{1,80}$/;
/** The first sentence of a description, as the index would print it if nothing had to be cut. */
function firstSentence(description) {
    const flat = String(description).trim();
    const stop = flat.indexOf('. ');
    if (stop >= 0) return flat.slice(0, stop);
    return flat.endsWith('.') ? flat.slice(0, -1) : flat;
}
/** True for a line break, another control character or a Unicode line separator. */
const breaksLine = (text) => [...text].some((ch) => { const c = ch.codePointAt(0); return c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029; });

/** Why `description` cannot be an index gloss, as sentences. */
function descriptionProblems(where, description) {
    if (typeof description !== 'string' || !description.trim()) return [`${where}: add a description (one sentence on what it does; the AI builder's index shows its first sentence)`];
    const first = firstSentence(description);
    const out = [];
    if (first.length > GLOSS_MAX_CHARS) out.push(`${where}: the first sentence of its description is ${first.length} characters; keep it to ${GLOSS_MAX_CHARS} (say more in a second sentence)`);
    if (first.includes(';')) out.push(`${where}: the first sentence of its description holds a ';' (the separator between index entries); use a comma or a second sentence`);
    if (breaksLine(description)) out.push(`${where}: its description holds a line break or control character; write it on one line`);
    if (!out.length && gloss(description) !== first) out.push(`${where}: the index would print "${gloss(description)}" instead of its first sentence`);
    return out;
}

test('every shipped extension item has a one-token name, unique in its family, and a description the index can print', () => {
    const problems = [];
    const seen = new Set();
    for (const item of tiers.extensionItems()) {
        const where = `${item.family} ${JSON.stringify(item.name)}`;
        if (!NAME_OK.test(item.name)) problems.push(`${where}: a name is one token of at most 80 characters (no space, comma or semicolon)`);
        if (seen.has(`${item.family}\n${item.name}`)) problems.push(`${where}: listed twice in its family`);
        seen.add(`${item.family}\n${item.name}`);
        if (!tiers.EXTENSION_FAMILIES.includes(item.family)) problems.push(`${where}: unknown family`);
        // An enum value and a new event of a type are explained by the entry they belong to.
        if (item.family === 'enumValues' || item.ownerTable === 'event') continue;
        problems.push(...descriptionProblems(where, item.description));
    }
    noProblems(problems, 'An extension item cannot be listed for the AI builder');
});

test('the description rules catch what the index cannot print', () => {
    assert.deepEqual(descriptionProblems('x', 'A radial meter for one number. It fills clockwise; slowly.'), []);
    assert.match(descriptionProblems('x', '').join(), /add a description/);
    assert.match(descriptionProblems('x', `${'word '.repeat(20)}end.`).join(), /keep it to 72/);
    assert.match(descriptionProblems('x', 'One thing; another thing.').join(), /holds a ';'/);
    assert.match(descriptionProblems('x', 'Line one\nline two.').join(), /line break/);
});

test('no component type is named like the prefix of another kind of item', () => {
    // 'screen.x', 'theme.x', 'node.x' … name keys of those objects; a type of that name would collide with them.
    const reserved = ['screen', 'section', 'node', 'theme', 'design', 'nav', 'style', 'step', 'action', 'fieldType', 'fieldOption', 'filterOp', 'aggFn', 'dateBucket'];
    assert.deepEqual(specs.COMPONENT_TYPES.filter((type) => reserved.includes(type)), [], `a component type may not be named ${reserved.join(', ')}`);
});

// ── What each kind of entry carries ─────────────────────────────────────────

test('every shipped step kind of the registry answers every execution form, declares its slots and has its executor', () => {
    const problems = [];
    for (const entry of stepRegistry.EXTENSION_STEP_ENTRIES) {
        problems.push(...stepRegistry.stepKindProblems(entry, entry.kind));
        for (const form of Object.keys(POLICY_FORMS)) {
            if (!Object.hasOwn(entry.policy || {}, form)) problems.push(`${entry.kind}: policy.${form} is missing (an explicit answer per execution form, 'refuse' included)`);
        }
        if (!Array.isArray(entry.childSlots)) problems.push(`${entry.kind}: childSlots is missing ([] when the kind holds no steps)`);
        problems.push(...descriptionProblems(`step kind ${entry.kind}`, entry.description));
        if (specs.STEP_SPECS[entry.kind]?.since !== entry.since) problems.push(`${entry.kind}: its STEP_SPECS entry does not carry its since`);
        const handler = path.join(__dirname, 'actionExecutor', 'steps', `${entry.kind}.mts`);
        if (entry.side === 'server' && !fs.existsSync(handler)) problems.push(`${entry.kind}: a server kind needs its executor actionExecutor/steps/${entry.kind}.mts (export async function runStep(app, model, step, ctx))`);
    }
    noProblems(problems, 'A step kind of the registry is incomplete');
    // The base kinds are frozen: none of them carries a since.
    for (const kind of require('./componentSpecs/actionSpecsActionKinds').BASE_STEP_KINDS) assert.equal(STEP_SPECS[kind].since, undefined, `${kind} is base`);
});

test('every shipped extension type says what the phone does with it, and why', () => {
    const problems = [];
    const ctx = { baseSpecs: Object.fromEntries(specs.BASE_COMPONENT_TYPES.map((t) => [t, COMPONENT_SPECS[t]])), styleKnobs: STYLE_KNOBS, eventNames: specs.EVENT_NAMES };
    for (const type of specs.COMPONENT_TYPES.slice(specs.BASE_COMPONENT_TYPES.length)) {
        const spec = COMPONENT_SPECS[type];
        try { checkTypeExtension(type, spec, ctx, `componentSpecs/types/${type}.js`); } catch (e) { problems.push(e.message); }
        problems.push(...descriptionProblems(`type ${type}`, spec.description));
    }
    noProblems(problems, 'An extension type is incomplete');
    assert.deepEqual(specs.COMPONENT_TYPES.slice(0, specs.BASE_COMPONENT_TYPES.length), [...specs.BASE_COMPONENT_TYPES], 'the base types come first, in their own order');
});

test('every shipped knob of a knob group is new vocabulary with a description', () => {
    const problems = [];
    for (const group of specs.EXTENSION_STYLE_KNOB_GROUPS) {
        if (!isSince(group.since)) problems.push(`knob group ${group.name}: since must be an integer of 3 or more`);
        for (const knob of group.knobs) {
            const spec = STYLE_KNOBS[knob];
            if (!spec || !isSince(spec.since)) problems.push(`knob ${knob} (group ${group.name}): carries since: 3 or more`);
            problems.push(...descriptionProblems(`knob ${knob} (group ${group.name})`, spec?.description));
        }
    }
    noProblems(problems, 'A knob group is incomplete');
});

test('every shipped top-level key declares whether a public page gets it, and how the AI builder writes it', () => {
    const problems = [];
    for (const entry of definitionKeys()) {
        const where = `definitionKeys/${entry.key}.js`;
        if (!isSince(entry.since)) problems.push(`${where}: since must be an integer of 3 or more`);
        if (typeof entry.public !== 'boolean') problems.push(`${where}: declare public: false (or true, after review): an anonymous visitor gets the key only with true`);
        if (BASE_DEFINITION_KEYS.includes(entry.key)) problems.push(`${where}: "${entry.key}" is a base key`);
        if (typeof entry.shape !== 'string' || !entry.shape.trim()) problems.push(`${where}: add shape (the value's shape, as catalogue text)`);
        problems.push(...descriptionProblems(where, entry.description));
    }
    noProblems(problems, 'A top-level key is incomplete');
});

test('every binding kind added after the base says what it looks like', () => {
    const problems = [];
    for (const kind of Object.keys(specs.BINDING_KIND_SINCE)) {
        const docs = specs.BINDING_KIND_DOCS[kind];
        if (!docs || typeof docs.shape !== 'string' || !docs.shape.trim()) problems.push(`binding kind ${kind}: add BINDING_KIND_DOCS.${kind}.shape`);
        problems.push(...descriptionProblems(`binding kind ${kind}`, docs?.description));
    }
    noProblems(problems, 'A binding kind is incomplete');
});

test('every section key the canonicalizer keeps, every event and every key file is accounted for', () => {
    const problems = [];
    for (const key of Object.keys(SECTION_OPTIONAL_KEYS)) {
        if (!Object.hasOwn(KEY_MARKS.section, key)) problems.push(`section key "${key}" (canonicalize/screens.js): add componentSpecs/keys/section/${key}.js with since: 3, shape and description`);
    }
    for (const event of specs.EVENT_NAMES) {
        if (!KEY_MARK_FAMILIES.node.includes(event) && !Object.hasOwn(KEY_MARKS.node, event)) problems.push(`event "${event}": add componentSpecs/keys/node/${event}.js with since: 3, shape and description`);
    }
    for (const knob of Object.keys(KEY_MARKS.sectionStyle)) {
        if (!Object.hasOwn(STYLE_KNOBS, knob)) problems.push(`componentSpecs/keys/sectionStyle/${knob}.js: "${knob}" is not a style knob`);
        if (!specs.SECTION_STYLE_KNOBS.includes(knob)) problems.push(`componentSpecs/keys/sectionStyle/${knob}.js: add "${knob}" to SECTION_STYLE_KNOBS (shared/appDefinition/sectionStyle.mjs), or remove the file`);
    }
    for (const style of Object.keys(KEY_MARKS.nav.style?.valuesSince || {})) {
        if (!specs.NAV_STYLES.includes(style)) problems.push(`componentSpecs/keys/nav/style.js marks "${style}", which is not in NAV_STYLES`);
    }
    noProblems(problems, 'A key is not accounted for');
});

// ── What the marks add up to ────────────────────────────────────────────────

test('the schema-version index holds exactly the marks: integers of 3 or more, nothing for the base', () => {
    const index = since.buildSinceIndex(since.liveCatalogue());
    const walk = (node, trail) => {
        for (const [key, value] of Object.entries(node)) {
            if (isObject(value)) walk(value, `${trail}.${key}`);
            else assert.ok(isSince(value), `${trail}.${key} is ${JSON.stringify(value)}`);
        }
    };
    walk(index, 'index');
    // Field types and field options live in the data model, outside the definition: they are items without an index entry.
    const indexed = tiers.extensionItems().filter((item) => !(item.ownerTable === 'data' && ['fieldTypes', 'fieldOptions'].includes(item.owner)));
    assert.equal(shared.sinceIndexIsEmpty(index), indexed.length === 0, 'the index is empty exactly when nothing indexed ships');
});

test('a blank app, and a base component of every type, still need the base version', () => {
    const def = specs.emptyDefinition('Blank');
    def.screens[0].sections[0].children = specs.BASE_COMPONENT_TYPES
        .filter((type) => !['tab', 'modal'].includes(type))
        .map((type, i) => ({ id: `cmp_base${String(i).padStart(4, '0')}`, type, props: {} }));
    def.actions = Object.fromEntries(specs.ACTION_KINDS.filter((kind) => ACTION_SPECS[kind].since === undefined).map((kind, i) => [`act_base${String(i).padStart(4, '0')}`, { kind }]));
    const { def: canon } = canonicalizeAppDefinition(def);
    assert.equal(canon.schemaVersion, specs.SCHEMA_VERSION_BASE, 'a default written for an entry added after the base would raise this: make the entry emit-when-present');
    assert.equal(canonicalizeAppDefinition(specs.emptyDefinition('Blank')).def.schemaVersion, specs.SCHEMA_VERSION_BASE);
});
