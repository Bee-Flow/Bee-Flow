/**
 * Tolerant reading of an app_add_components call — the repairs that are
 * unambiguous, done BEFORE the build so a small model's near-miss lands
 * instead of costing a round:
 *
 *   • the root keys a model reaches for (`sectionId`, `containerId` — the
 *     very word app_add_screen's result uses — for parentId; `items`,
 *     `children`, `nodes` for components);
 *   • a type name that is not a type but has one obvious meaning
 *     (componentAliases.js: kpi → stat, datatable → data_grid);
 *   • a prop written beside `props` instead of inside it — hoisted ONLY when
 *     the type's spec declares that prop, so a real typo still gets the
 *     canonicalizer's "Dropped unknown …" hint;
 *   • JSON debris inside a string value → the batch arrived corrupted; say so
 *     instead of "unknown type undefined";
 *   • (2026-09-13) a `container` given a title — the model wants a titled
 *     panel, and that is a `card` (container declares only `look`): the type
 *     is changed and the look mapped, so the title lands instead of being
 *     dropped;
 *   • (2026-09-13) entry keys at the ROOT beside `components` (`type:
 *     "section"`, a duplicate `children` tree, `style`) — ignored as before,
 *     but now SAID, because a resend that grows debris is a model that has
 *     lost the shape, and silence let it grow for four rounds.
 *
 * Every repair is written to `notes`, which ride the success result: the
 * shape is corrected here, the habit by the note. Pure.
 */

'use strict';

const { getSpec } = require('../componentSpecs');
const { canonicalComponentType, COMPONENT_TYPE_ALIASES } = require('./componentAliases');
const { looksGarbled } = require('../../core/llm/partialJsonScan');

const ROOT_PARENT_ALIASES = ['sectionId', 'containerId', 'parent', 'target', 'parentID'];
const ROOT_LIST_ALIASES = ['items', 'children', 'nodes', 'entries', 'elements'];
// Entry-shaped keys that have no meaning at the root of the call.
const ROOT_DEBRIS_KEYS = ['type', 'props', 'style', 'children', 'tempId', 'visibleWhen', 'enabledWhen'];
// container → card: container's looks mapped onto card's (formSpecs.js).
const CONTAINER_TO_CARD_LOOK = { panel: 'default', tinted: 'tinted', outlined: 'flat', plain: 'flat' };
// Entry keys that are legitimately NOT props (see definitionTools COMPONENT_ENTRY_KEYS).
const ENTRY_OWN_KEYS = new Set(['type', 'props', 'style', 'children', 'tempId', 'visibleWhen', 'enabledWhen', 'readOnly', 'visibleToRoles', 'computed', 'validations']);

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function normaliseEntry(entry, at, notes, depth = 0) {
    if (!isObject(entry)) return entry;
    const out = { ...entry };
    // Entry-level keys that landed INSIDE props. Measured 2026-09-16 on a live
    // dashboard build: a `list` arrived as {props:{columns, source, look, style,
    // type:"list"}} — well-formed JSON, one level too deep — and the entry, now
    // typeless, was refused as "the call's JSON is broken", three times. No
    // component has a prop called type/style/children/tempId (or any other node
    // field), so a node field found in props can only be a nesting slip.
    if (isObject(out.props)) {
        const props = { ...out.props };
        const lifted = [];
        for (const k of ENTRY_OWN_KEYS) {
            if (k === 'props') continue;
            if (Object.hasOwn(props, k) && out[k] === undefined) {
                out[k] = props[k];
                delete props[k];
                lifted.push(k);
            }
        }
        if (lifted.length) {
            out.props = props;
            notes.push(`${at}: ${lifted.map(k => `"${k}"`).join(', ')} ${lifted.length > 1 ? 'were' : 'was'} inside props — moved out. props holds the component's OWN settings; type, style and children sit beside it.`);
        }
    }
    // Type alias.
    if (typeof out.type === 'string' && !getSpec(out.type)) {
        const canon = canonicalComponentType(out.type);
        if (canon && canon !== out.type && getSpec(canon)) {
            notes.push(`${at}: type "${out.type}" read as "${canon}".`);
            out.type = canon;
        }
    }
    // A titled container is a card. `container` is a real type, so the alias
    // table never fires for it; only the title tells what was meant. Runs
    // AFTER the alias so the names that MAP to container (section, group, row)
    // reach it too — a "section" with a title is a card like any other.
    if (out.type === 'container') {
        const props = isObject(out.props) ? out.props : {};
        const titled = ['title', 'description'].find((k) => (typeof props[k] === 'string' && props[k].trim()) || (typeof out[k] === 'string' && out[k].trim()));
        if (titled) {
            const look = typeof props.look === 'string' ? props.look : null;
            const mapped = look && CONTAINER_TO_CARD_LOOK[look] ? CONTAINER_TO_CARD_LOOK[look] : null;
            const nextProps = { ...props };
            if (look !== null) { if (mapped) nextProps.look = mapped; else delete nextProps.look; }
            out.type = 'card';
            out.props = nextProps;
            notes.push(`${at}: a container with a ${titled} read as card (container has no ${titled}${look ? `; look ${look} → ${mapped || 'default'}` : ''}).`);
        }
    }
    const spec = typeof out.type === 'string' ? getSpec(out.type) : null;
    // Stray props beside `props`.
    if (spec && spec.props && typeof spec.props === 'object') {
        const stray = Object.keys(out).filter((k) => !ENTRY_OWN_KEYS.has(k) && Object.prototype.hasOwnProperty.call(spec.props, k));
        if (stray.length) {
            const props = isObject(out.props) ? { ...out.props } : {};
            const moved = [];
            for (const k of stray) {
                if (!(k in props)) { props[k] = out[k]; moved.push(k); }
                delete out[k];
            }
            out.props = props;
            if (moved.length) notes.push(`${at}: ${moved.map((k) => `"${k}"`).join(', ')} ${moved.length > 1 ? 'were' : 'was'} placed next to props — moved inside props. Component settings go INSIDE props.`);
        }
    }
    if (Array.isArray(out.children) && depth < 6) {
        out.children = out.children.map((c, i) => normaliseEntry(c, `${at}.children[${i}]`, notes, depth + 1));
    }
    return out;
}

/**
 * @returns {{ args: object, notes: string[], garbled: boolean }}
 */
function normaliseAddComponentsArgs(rawArgs) {
    const notes = [];
    const a = isObject(rawArgs) ? { ...rawArgs } : {};
    if ((a.parentId === undefined || a.parentId === null || a.parentId === '')) {
        const alias = ROOT_PARENT_ALIASES.find((k) => typeof a[k] === 'string' && a[k]);
        if (alias) {
            a.parentId = a[alias];
            delete a[alias];
            notes.push(`"${alias}" read as parentId — every add goes under \`parentId\` (the sectionId app_add_screen returned IS the parentId to pass).`);
        }
    }
    if (!Array.isArray(a.components)) {
        const alias = ROOT_LIST_ALIASES.find((k) => Array.isArray(a[k]));
        if (alias) {
            a.components = a[alias];
            delete a[alias];
            notes.push(`"${alias}" read as components.`);
        } else if (isObject(a.component) && !a.components) {
            a.components = [a.component];
            delete a.component;
            notes.push('"component" read as a one-entry components list.');
        }
    } else {
        const debris = ROOT_DEBRIS_KEYS.filter((k) => a[k] !== undefined);
        if (debris.length) {
            for (const k of debris) delete a[k];
            notes.push(`root keys ${debris.join(', ')} ignored — component entries belong in components[] (the call takes only parentId, components, index).`);
        }
    }
    const garbled = looksGarbled(a);
    if (Array.isArray(a.components)) {
        a.components = a.components.map((e, i) => normaliseEntry(e, `components[${i}]`, notes));
    }
    return { args: a, notes, garbled };
}

module.exports = { normaliseAddComponentsArgs, normaliseEntry, ROOT_PARENT_ALIASES, ROOT_LIST_ALIASES, COMPONENT_TYPE_ALIASES };
