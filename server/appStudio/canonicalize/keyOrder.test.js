'use strict';

/**
 * A definition read back from the database, against canonicalize and the hashes taken over it.
 * Postgres JSONB hands the keys of every object back in its own order (shorter first, then
 * bytewise), not in the order they were written.
 *
 * canonicalize keeps the stored key order inside many parts. The cleaners of schema 2 pass style
 * maps, read filters and sorts with the bindings in them, option / colour / tone / column lists,
 * step value maps and mappings, inline rows and the actions map through as written, and the
 * frozen corpus bytes depend on that order, so it stays. The since-3 parts that are cleaned by
 * those same cleaners keep it too (styleWhen rule styles, call_action params, code step inputs,
 * server step input mappings, accordion items). The since-3 binding keys orderBy, expand and
 * groupFilter write the keys of their entries in one fixed order.
 *
 * So a definition read back can canonicalize to other BYTES than the one that was written. What
 * holds, checked for every corpus app in JSONB's order:
 *   - the same JSON value, and canonicalize keeps the read-back bytes (idempotent);
 *   - the template install hash and the "unchanged since install" check (templateUpgrade) and a
 *     stage payload hash (projects/stages/model) do not move: they hash a key-sorted text;
 *   - the fingerprint of every trigger does not move, so a trigger armed at publish is not
 *     disarmed at its first fire by a definition read back in another order;
 *   - the bytes are the same, except for the apps listed below, whose parts keep the stored order.
 *
 * Run: cd server && node --test appStudio/canonicalize/keyOrder.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { corpusNames, readCorpus } = require('../compat/corpus.mts');
const { canonicalOf } = require('../compat/expectations.mts');
const { hashDefinition, isPristine } = require('../templateUpgrade');
const { hashOf } = require('../../projects/stages/model');
const { armedTriggersOf } = require('../triggers/triggerSync.mts');
const { triggerLimits } = require('../triggers/triggerLimits.mts');
const { entriesInKeyOrder } = require('../componentSpecs/entryKeyOrder');
const { sameJsonValue } = require('../../shared/format/sameJsonValue.mjs');
const { rekey, reversed, jsonb } = require('../../testUtils/jsonKeyOrder.testkit');

/**
 * Schema-2 apps whose canonical bytes follow the stored key order: old behaviour of the schema-2
 * cleaners (see the header). Hashes already taken over them are key-sorted, so it stays as it is.
 */
const KEEPS_STORED_ORDER_V2 = new Set([
    'column-rights', 'computed-read-time', 'data-model-field-rules', 'data-model-field-types', 'dataset-params',
    'legacy-onerror-array', 'lockstep-sample', 'public-intake', 'sample-kitchen-sink', 'sample-v2-rich',
    'sample-v2-showcase', 'sample-v21-batch', 'template-ai-act-register', 'template-approval-inbox',
    'template-asset-inventory', 'template-bi-reports', 'template-breach-register', 'template-crm-pipeline',
    'template-data-subject-requests', 'template-event-planner', 'template-invoice-approvals',
    'template-knowledge-governance', 'template-meeting-dossier', 'template-ops-dashboard',
    'template-processing-register', 'template-quote-intake', 'template-request-form', 'template-sprint-board',
    'template-support-desk', 'template-team-directory', 'template-ticket-tracker', 'trace-invoice-dashboard',
    'trace-invoice-tracker', 'viewer-row-rules',
]);

/**
 * Schema-3 apps whose canonical bytes follow the stored key order: every difference sits in a part
 * a schema-2 cleaner keeps as written, or in a since-3 part cleaned by one of them (the header
 * names them). Writing those in a fixed order would change the frozen bytes of these apps.
 */
const KEEPS_STORED_ORDER_V3 = new Set([
    'box-knobs', 'component-variants', 'data-model-linked-records', 'flex-aggregate-more', 'flex-filter-tree-order-by',
    'flex-relation-expand', 'hover-backdrop', 'layout-v2', 'logic-control-flow', 'logic-parallel', 'new-types-basic',
    'paged-record-lists', 'rich-markdown-motion', 'template-field-service', 'template-inbound-orders',
    'template-request-approval', 'template-sales-dashboard', 'typography-text-knobs', 'v3-code-step-quote',
    'v3-ui-steps', 'v3-watchers-and-triggers', 'value-format', 'vocab-style-when', 'vocab-theme-scope',
    'web-service-step', 'wide-server-scope', 'widget-item-templates', 'widgets-advanced', 'zz-record-triggers',
    'zz-schedule-triggers', 'zz-webhook-trigger',
]);

const NOW = 1_000_000;
const LIMITS = triggerLimits({});
const text = (v) => JSON.stringify(v);
const fingerprints = (def) => armedTriggersOf(def, NOW, LIMITS).map((t) => [t.triggerId, t.fingerprint]);

for (const name of corpusNames()) {
    test(`${name}: read back in JSONB key order, the same value, hashes and trigger fingerprints`, () => {
        const canonical = canonicalOf(readCorpus(name).definition);
        const stored = rekey(canonical, jsonb);
        const again = canonicalOf(stored);
        assert.ok(sameJsonValue(again, canonical), 'the same JSON value');
        assert.equal(text(canonicalOf(again)), text(again), 'canonicalize keeps the read-back bytes');

        const installHash = hashDefinition(canonical);
        for (const [label, def] of [['as read', stored], ['saved again', again]]) {
            assert.equal(hashDefinition(def), installHash, `template install hash, ${label}`);
            assert.equal(isPristine({ templateInstallHash: installHash, definition: def }), true, `unchanged since install, ${label}`);
            assert.equal(hashOf(def), hashOf(canonical), `stage payload hash, ${label}`);
            assert.deepEqual(fingerprints(def), fingerprints(canonical), `trigger fingerprints, ${label}`);
        }

        const v3 = canonical.schemaVersion === 3;
        if (KEEPS_STORED_ORDER_V2.has(name) || KEEPS_STORED_ORDER_V3.has(name)) {
            assert.equal((v3 ? KEEPS_STORED_ORDER_V3 : KEEPS_STORED_ORDER_V2).has(name), true, `${name} is listed under the wrong schema version`);
            assert.notEqual(text(again), text(canonical), `${name} now canonicalizes to the same bytes in any key order: take it off the list`);
        } else {
            assert.equal(text(again), text(canonical), 'the same canonical bytes');
        }
    });
}

test('the lists name corpus apps only, and some corpus apps arm triggers', () => {
    const names = new Set(corpusNames());
    for (const name of [...KEEPS_STORED_ORDER_V2, ...KEEPS_STORED_ORDER_V3]) assert.ok(names.has(name), name);
    const armed = corpusNames().flatMap((name) => fingerprints(canonicalOf(readCorpus(name).definition)));
    assert.ok(armed.length >= 4, `the fingerprint check covers ${armed.length} triggers`);
});

/** The orderBy, expand and groupFilter lists of a definition, as JSON texts. */
function readLists(value, out = []) {
    if (Array.isArray(value)) value.forEach((v) => readLists(v, out));
    else if (value && typeof value === 'object') {
        for (const [key, v] of Object.entries(value)) {
            if (['orderBy', 'expand', 'groupFilter'].includes(key) && Array.isArray(v)) out.push(text(v));
            else readLists(v, out);
        }
    }
    return out;
}

test('orderBy, expand and groupFilter come out with their keys in one order, whatever order they were stored in', () => {
    let seen = 0;
    for (const name of corpusNames()) {
        const canonical = canonicalOf(readCorpus(name).definition);
        const lists = readLists(canonical);
        seen += lists.length;
        for (const order of [jsonb, reversed]) assert.deepEqual(readLists(canonicalOf(rekey(canonical, order))), lists, name);
    }
    assert.ok(seen >= 5, `${seen} lists checked`);
});

test('entriesInKeyOrder: declared keys first, the rest sorted; values, list order and non-objects as written', () => {
    const clean = entriesInKeyOrder(['field', 'dir']);
    const out = clean([{ zeta: 1, dir: 'desc', alpha: [2, 1], field: 'a' }, 'loose', null, { dir: 'asc' }]);
    assert.equal(text(out), text([{ field: 'a', dir: 'desc', alpha: [2, 1], zeta: 1 }, 'loose', null, { dir: 'asc' }]));
    assert.equal(clean('not a list'), 'not a list');
    const own = clean([JSON.parse('{"__proto__": {"x": 1}, "field": "a"}')])[0];
    assert.equal(Object.getPrototypeOf(own), Object.prototype, 'a key named __proto__ stays a plain key');
    assert.deepEqual(Object.keys(own), ['field', '__proto__']);
});
