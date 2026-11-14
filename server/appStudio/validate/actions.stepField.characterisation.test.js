// @typecheck
'use strict';

/**
 * Characterisation (golden) test for the per-field step validator, driven
 * through the exported validateAction: every field of every step kind in
 * STEP_SPECS (as a step of a sequence) and of every action kind validated per
 * field (as a bare action), each given every value of a palette that reaches
 * each field type's branches (absent, null, strings short, empty, too long,
 * https and http, numbers, booleans, lists, objects, bindings, switch cases,
 * known and unknown ids), with a data model and without one. The finding
 * lists (code, severity, path, message, hint, in order) are kept per kind as
 * a sha256; a readable sample keeps one field of each type for ten of the values (lines cut to 120).
 *
 * Regenerate the golden file ONLY for an intended behaviour change:
 *   UPDATE_GOLDEN=1 node --test appStudio/validate/actions.stepField.characterisation.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { validateAction } = require('./actions');
const { STEP_SPECS, ACTION_SPECS, LIMITS } = require('../componentSpecs');

const GOLDEN = path.join(__dirname, 'actions.stepField.characterisation.golden.json');
const PER_FIELD_ACTION_KINDS = ['ai_extract', 'ai_generate', 'kb_query', 'create_record', 'call_action'];

/** A step list `d` conditions deep. @param {number} d @returns {unknown[]} */
function nest(d) { return d === 0 ? [{ kind: 'toast', message: 'x' }] : [{ kind: 'condition', expr: 'true', then: nest(d - 1) }]; }

const PALETTE = [
    undefined, null, 'text', '', 'x'.repeat(5000), 'https://example.com/a', 'http://example.com/a', 'not a url',
    7, 2.5, -3, 0, 100000, true, [], ['a', 'b'], [1], Array.from({ length: 60 }, () => 'a'),
    {}, { kind: 'static', value: 1 }, { kind: 'formula', expr: 'form.x' }, { kind: 'formula', expr: '((' },
    [{ value: 1, steps: [] }], ['x'], [{ value: 1, steps: 'no' }], 'tbl_a', 'tbl_missing', 'scr_a', 'scr_x',
    'modal_a', 'auto_1', 'doc_1', 'conn_mail', 'form.x', 'fast', { mode: 'read' },
    'tbl_linked_ro', 'tbl_linked_rw', 'tbl_linked_bad',
    // A step list nested to the depth limit, and one whose formula reads `error` (only legal in a catch).
    nest(LIMITS.MAX_ACTION_DEPTH - 1),
    [{ steps: nest(LIMITS.MAX_ACTION_DEPTH - 1) }],
    [{ kind: 'condition', expr: 'error.message == "x"', then: [] }],
];

/** @param {Record<string, unknown>} over */
function makeCtx(over) {
    /** @type {string[]} */
    const findings = [];
    const fmt = (/** @type {string} */ s) => (/** @type {any} */ r) => findings.push(`${s} ${r.code} @${r.path}: ${r.message} | ${r.hint}`);
    return {
        findings,
        ctx: {
            pushE: fmt('E'),
            pushW: fmt('W'),
            screenIds: new Set(['scr_a']),
            modalIds: new Set(['modal_a']),
            ownedAutomations: new Map([['auto_1', { isActive: true }]]),
            dataTables: new Map([['tbl_a', new Set(['name', 'doc'])], ['tbl_linked_ro', new Set(['name'])], ['tbl_linked_rw', new Set(['name'])], ['tbl_linked_bad', new Set(['name'])]]),
            dataTableSources: new Map(/** @type {Array<[string, unknown]>} */ ([['tbl_linked_ro', { kind: 'datatable', datatableId: 'dt_1', mode: 'read' }], ['tbl_linked_rw', { kind: 'datatable', datatableId: 'dt_1', mode: 'readwrite' }], ['tbl_linked_bad', 'nope']])),
            dataMailboxConnectors: new Set(['conn_mail']),
            ownedDocuments: new Map([['doc_1', { id: 'doc_1', name: 'Invoice' }]]),
            aiBrowsingEnabled: false,
            ...over,
        },
    };
}

/** The palette entries the readable sample shows (absent, null, text, long, http, a number, true, a list, a binding, switch cases). */
const SAMPLED_VALUES = [0, 1, 2, 4, 6, 8, 13, 15, 19, 22];

const CTX_VARIANTS = { model: {}, noModel: { dataTables: null, dataTableSources: null, dataMailboxConnectors: null, ownedAutomations: undefined }, asWarnings: { dataRefsAsWarnings: true } };

/**
 * @param {'step' | 'action'} as
 * @param {string} kind
 * @param {string} field
 * @param {unknown} value
 * @param {Record<string, unknown>} over
 */
function findingsFor(as, kind, field, value, over) {
    const { findings, ctx } = makeCtx(over);
    const body = { kind, [field]: value };
    try {
        if (as === 'step') validateAction('act_1', { kind: 'sequence', steps: [body] }, 'actions.act_1', ctx);
        else validateAction('act_1', body, 'actions.act_1', ctx);
    } catch (e) {
        findings.push(`THROW ${/** @type {Error} */ (e).message}`);
    }
    return findings;
}

test('per-field step validation: every kind matches the golden digest, the sample in full', () => {
    /** @type {Record<string, string>} */
    const digests = {};
    /** @type {Record<string, unknown>} */
    const sample = {};
    /** @type {Set<string>} */
    const sampledTypes = new Set();
    const groups = /** @type {Array<['step' | 'action', string, Record<string, { type: string }>]>} */ ([
        ...Object.entries(STEP_SPECS).map(([kind, spec]) => ['step', kind, spec.fields]),
        ...PER_FIELD_ACTION_KINDS.map((kind) => ['action', kind, ACTION_SPECS[kind].fields]),
    ]);
    for (const [as, kind, fields] of groups) {
        const hash = crypto.createHash('sha256');
        for (const [field, spec] of Object.entries(fields)) {
            const takeSample = as === 'step' && !sampledTypes.has(spec.type);
            if (takeSample) sampledTypes.add(spec.type);
            for (const [variant, over] of Object.entries(CTX_VARIANTS)) {
                PALETTE.forEach((value, i) => {
                    const found = findingsFor(as, kind, field, value, over);
                    hash.update(`${field}#${variant}#${i}\n${found.join('\n')}\n`);
                    if (takeSample && variant === 'model' && SAMPLED_VALUES.includes(i)) sample[`${kind}.${field} (${spec.type}) #${i}`] = found.map((f) => f.slice(0, 120));
                });
            }
        }
        digests[`${as}:${kind}`] = hash.digest('hex');
    }
    const actual = { digests, sample };
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n');
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    assert.deepEqual(Object.keys(actual.sample), Object.keys(golden.sample));
    for (const name of Object.keys(actual.sample)) assert.deepEqual(actual.sample[name], golden.sample[name], name);
    assert.deepEqual(Object.keys(actual.digests), Object.keys(golden.digests));
    for (const name of Object.keys(actual.digests)) assert.equal(actual.digests[name], golden.digests[name], name);
});
