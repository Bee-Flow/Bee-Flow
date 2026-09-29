/**
 * App Studio builder tools — building ONE component node (recursively, for a
 * container) out of a batch entry: the vocabulary of keys an entry may carry,
 * the did-you-mean for a key that is not one, and the hard rejects (unknown
 * type, bad or duplicate tempId) that cost the entry rather than the batch.
 */

'use strict';

const { COMPONENT_TYPES, EVENT_NAMES, getSpec } = require('../../componentSpecs');
const ops = require('../../definitionOps');
const { pickClosestId, levenshtein } = require('../../../automation/validate/helpers');
const { TEMP_ID_RX } = require('../schemas');
const { NODE_AUTHORABLE_FIELDS, normalizeNodeField } = require('../shared');
const { flattenEntries } = require('./componentEntries');
const { entrySig, shellSig } = require('./batchIdentity');

// Every key an app_add_components entry may carry. The canonicalizer teaches
// unknown PROP and STYLE keys beautifully ("Dropped unknown prop keys: …") but
// never sees entry-level keys, because buildComponentNode hands it the node it
// built, not the entry — so `computed`, `onClick` or a typo'd `visibleIf`
// used to vanish with the call still reporting success. Diffed below, in the
// canonicalizer's own wording.
const COMPONENT_ENTRY_KEYS = ['type', 'props', 'style', 'children', 'tempId', ...NODE_AUTHORABLE_FIELDS];
const COMPONENT_ENTRY_KEY_SET = new Set(COMPONENT_ENTRY_KEYS);

/**
 * "Did you mean" for a KEY. pickClosestId falls back to the first candidate
 * when nothing is close — right for ids (any real id helps the model), wrong
 * here, where it would answer "onClick" with `type`. Same distance rule, no
 * fallback: a suggestion or nothing.
 */
function nearestKey(key, candidates) {
    const near = pickClosestId(key, candidates);
    if (!near) return null;
    const k = String(key);
    return levenshtein(k, String(near)) <= Math.max(3, Math.floor(k.length / 2)) ? near : null;
}

/**
 * Build one component node (recursively for containers) from a batch entry.
 * Throws { message } on a hard reject (unknown type, bad tempId) — the caller
 * drops THAT entry and reports it at its path (partial apply, since
 * 2026-09-17; before that the whole batch was refused). Non-fatal teaching
 * (dropped entry keys) is pushed onto `hints` and surfaced with the result.
 *
 * `partial` (optional): { failed, fragments, built } — when given, a child of
 * a container that cannot be built is dropped and reported at
 * `<at>.children[j]` while the container lands, and every container that
 * lands is recorded in `built` (call path → node) so the report can name the
 * real id a dropped child resends under, at ANY depth (card > form > input);
 * without it (the legacy callers and the tests that pin one node) a bad
 * child throws through.
 */
function buildComponentNode(entry, at, taken, tempSeen, idMap, added, hints = [], partial = null) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`${at}: each component must be an object { type, props?, style?, children?, tempId? }.`);
    }
    // `kind` for `type` — the design phase speaks in element "kinds" and the
    // model copies the word (measured 2026-09-14).
    if (entry.type === undefined && typeof entry.kind === 'string' && getSpec(entry.kind)) {
        hints.push(`${at}: "kind" read as "type".`);
        entry = { ...entry, type: entry.kind };
        delete entry.kind;
    }
    const type = entry.type;
    const spec = getSpec(type);
    if (!spec) {
        if (type === undefined) {
            // An entry with no type at all is a JSON tail that closed too early
            // (measured: `"type":"card}],parentId:"` three levels deep) — the
            // legal-types list does not help; fewer components per call does.
            const keys = Object.keys(entry).slice(0, 6).join(', ');
            throw new Error(`${at} has no "type" (keys: ${keys || 'none'}) — the call's JSON is broken at that entry; it was not applied. Resend it as its own call, one card per call, with complete well-formed JSON.`);
        }
        const suggestion = pickClosestId(type, COMPONENT_TYPES);
        throw new Error(`${at}: unknown component type ${JSON.stringify(type)}.${suggestion ? ` Did you mean "${suggestion}"?` : ''} Legal types: ${COMPONENT_TYPES.join(', ')}.`);
    }
    if (entry.tempId !== undefined) {
        if (typeof entry.tempId !== 'string' || !TEMP_ID_RX.test(entry.tempId)) {
            throw new Error(`${at}: tempId ${JSON.stringify(entry.tempId)} must match [A-Za-z][A-Za-z0-9_]* (max 25 chars).`);
        }
        if (tempSeen.has(entry.tempId)) throw new Error(`${at}: duplicate tempId "${entry.tempId}" in this call.`);
        tempSeen.add(entry.tempId);
    }

    const node = {
        id: ops.uniqueId('component', taken),
        type,
        props: (entry.props && typeof entry.props === 'object' && !Array.isArray(entry.props)) ? entry.props : {},
        style: (entry.style && typeof entry.style === 'object' && !Array.isArray(entry.style)) ? entry.style : {},
        visible: true,
    };
    // Optional v2 node fields (visibleWhen/enabledWhen/readOnly/visibleToRoles
    // + computed/validations) — a bad shape rejects THIS entry, same rule as
    // an unknown type (the caller decides what that costs: the batch for the
    // legacy callers, the one entry under the partial apply).
    for (const field of NODE_AUTHORABLE_FIELDS) {
        if (entry[field] === undefined || entry[field] === null) continue;
        const norm = normalizeNodeField(field, entry[field]);
        if (norm.error) throw new Error(`${at}: ${norm.error}`);
        node[field] = norm.value;
    }
    // Entry-level keys the canonicalizer will never see. Silence here is how a
    // whole capability stayed invisible, so say the same thing it says.
    const unknownKeys = Object.keys(entry).filter((k) => !COMPONENT_ENTRY_KEY_SET.has(k));
    if (unknownKeys.length) {
        const named = unknownKeys.map((k) => {
            const near = nearestKey(k, COMPONENT_ENTRY_KEYS);
            return near ? `${k} (did you mean "${near}"?)` : k;
        });
        const events = unknownKeys.filter((k) => EVENT_NAMES.includes(k));
        hints.push(`${at}: Dropped unknown entry keys: ${named.join(', ')}. Legal keys: ${COMPONENT_ENTRY_KEYS.join(', ')}.${events.length ? ` Events (${events.join(', ')}) are wired with app_bind_action, not set on the entry.` : ''}`);
    }
    if (entry.tempId) idMap[entry.tempId] = node.id;
    added.push({ ...(entry.tempId ? { tempId: entry.tempId } : {}), id: node.id, type });
    // The partial batch record: this node's identity and the node it was
    // built under (null at the top of the batch), so a corrected resend of
    // the batch can tell what already landed — at any depth.
    if (partial && Array.isArray(partial.nodes)) {
        partial.nodes.push({ id: node.id, type, sig: entrySig(entry), shellSig: spec.container ? shellSig(entry) : null, parentNodeId: partial.parentNodeId || null });
    }

    const rawChildren = Array.isArray(entry.children) ? entry.children : null;
    const buildChildren = (children) => {
        if (!partial) {
            return children.map((child, i) => buildComponentNode(child, `${at}.children[${i}]`, taken, tempSeen, idMap, added, hints));
        }
        // Partial: the children list is flattened the same way the top level
        // is (type-less groups lifted, cut groups and fragments taken out),
        // then each child is built on its own. A child that cannot be built
        // is dropped and reported at its path; the container still lands.
        const out = [];
        const outerParent = partial.parentNodeId;
        partial.parentNodeId = node.id;
        try {
            for (const item of flattenEntries(children, `${at}.children`, partial)) {
                try {
                    out.push(buildComponentNode(item.entry, item.at, taken, tempSeen, idMap, added, hints, partial));
                } catch (e) {
                    partial.failed.push({ path: item.at, error: e.message });
                }
            }
        } finally {
            partial.parentNodeId = outerParent;
        }
        return out;
    };
    if (spec.container) {
        // Recorded BEFORE its children are built: a container cannot fail
        // once it is here (nothing below throws), so a child dropped inside
        // it — however deep — can be told the id it resends under.
        if (partial && partial.built instanceof Map) partial.built.set(at, node);
        node.children = buildChildren(rawChildren || []);
    } else if (rawChildren && rawChildren.length) {
        // Non-container with children: keep them on the node — canonicalize
        // hoists salvageable ones as following siblings and reports the repair
        // as a hint, teaching the model without losing its work.
        node.children = buildChildren(rawChildren);
    }
    return node;
}

module.exports = {
    COMPONENT_ENTRY_KEYS,
    buildComponentNode,
};
