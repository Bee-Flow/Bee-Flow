// @typecheck
'use strict';

/**
 * Characterisation (golden) test for captureTemplate: every built-in template
 * captured five ways (with its seed, with its seed as live rows, with a
 * one-row ceiling, without a data model, with full meta and datasets), plus
 * the refusals (no title, no definition, a definition from a newer schema,
 * validation errors, over the size ceiling) and the warning paths (orphan
 * rows, a seed for other tables and columns, dropped demo people, dangling
 * dataset bindings, approver seats and staged approvals, automation, connector
 * and knowledge-base references). Each result is kept as a sha256 of the
 * whole answer, next to its readable report and errors.
 *
 * Regenerate the golden file ONLY for an intended behaviour change:
 *   UPDATE_GOLDEN=1 node --test appStudio/templateCapture.captureTemplate.characterisation.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { captureTemplate } = require('./templateCapture');
const { TEMPLATES } = require('./templates');
const { emptyDefinition } = require('./componentSpecs');

/** emptyDefinition with fixed ids (it mints random ones), so every run captures the same app. @param {string} name */
function baseDef(name) {
    const def = /** @type {any} */ (emptyDefinition(name));
    def.homeScreenId = 'scr_home01';
    def.screens[0].id = 'scr_home01';
    def.screens[0].sections[0].id = 'sec_main01';
    return def;
}

const GOLDEN = path.join(__dirname, 'templateCapture.captureTemplate.characterisation.golden.json');
const LIST = /** @type {any[]} */ (Array.isArray(TEMPLATES) ? TEMPLATES : Object.values(TEMPLATES));

/** @param {any} t */
const fromTemplate = (t) => ({ definition: t.definition, dataModel: t.dataModel, seed: t.seed, seedPeople: t.seedPeople, datasets: t.datasets, meta: { title: t.title } });

/** A definition with every reference the capture scrubs or reports. */
function referencingDefinition() {
    const def = baseDef('Refs');
    def.actions = {
        act_run001: { kind: 'run_automation', automationId: 'auto-live-1' },
        act_seq001: { kind: 'sequence', steps: [
            { kind: 'request_approval', prompt: { kind: 'static', value: 'ok?' }, stages: [{ key: 's1', name: 'First', approvers: [{ userId: 'u_1' }], rule: 'first' }] },
            { kind: 'request_approval', prompt: { kind: 'static', value: 'ok?' }, assigneeUserId: 'u_2' },
        ] },
    };
    return def;
}

/** @type {Record<string, Record<string, any>>} */
const EXTRA = {
    noTitle: { definition: baseDef('x'), meta: {} },
    blankTitle: { definition: baseDef('x'), meta: { title: '   ' } },
    noDefinition: { meta: { title: 'T' } },
    definitionNotObject: { definition: 'app', meta: { title: 'T' } },
    noArgs: {},
    newerSchema: { definition: { ...baseDef('x'), schemaVersion: 999 }, meta: { title: 'T' } },
    validationErrors: { definition: { ...baseDef('x'), actions: { act_aaaaaa: { kind: 'navigate', screenId: 'scr_nope' }, act_bbbbbb: { kind: 'bogus' } } }, meta: { title: 'T' } },
    references: { definition: referencingDefinition(), meta: { title: 'Refs', description: 'd'.repeat(500), icon: 'Box', category: 'c'.repeat(50), tags: ['a', 'a', 'b', 7, 'x'.repeat(50)], id: 'tpl_1', version: 3 } },
    badVersion: { definition: baseDef('x'), meta: { title: 'T', version: 0, id: '' } },
    orphanRows: { definition: baseDef('x'), seed: { tbl_a: [{ a: 1 }, { a: 2 }], tbl_b: 'x' }, meta: { title: 'T' } },
    emptyModel: { definition: baseDef('x'), dataModel: { tables: [] }, seed: { tbl_a: [{}] }, meta: { title: 'T' } },
};

/** A built-in template seeded past the size ceiling: 100 rows of 50 kB text in its first text column. */
function oversized() {
    const t = LIST.find((x) => x.dataModel && x.dataModel.tables.some((/** @type {any} */ tb) => tb.fields.some((/** @type {any} */ f) => f.type === 'text')));
    const table = t.dataModel.tables.find((/** @type {any} */ tb) => tb.fields.some((/** @type {any} */ f) => f.type === 'text'));
    const field = table.fields.find((/** @type {any} */ f) => f.type === 'text');
    return { ...fromTemplate(t), seed: { [table.id]: Array.from({ length: 100 }, (_, i) => ({ [field.key]: `${i}`.padEnd(50 * 1024, 'x') })) } };
}
EXTRA.oversized = oversized();

/** Knowledge-base and uploaded-file references, a dangling dataset binding, a seed and demo people that do not fit. */
function edgeCases() {
    const kb = baseDef('kb');
    kb.actions = { act_kbq001: { kind: 'kb_query', query: { kind: 'static', value: 'q' }, knowledgeBaseIds: ['kb_1', 'kb_2'], resultVar: 'r' } };
    const files = baseDef('files');
    files.theme.logo = 'asset:a1';
    files.screens[0].sections[0].children = [{ id: 'cmp_img001', type: 'image', props: { src: 'asset:a2' } }];
    const ds = baseDef('ds');
    ds.actions = { act_dsref01: { kind: 'sequence', steps: [{ kind: 'set_variable', name: 'x', value: { kind: 'dataset', datasetId: 'ds_gone' } }] } };
    const t = LIST.find((x) => x.dataModel && x.seed);
    const tb = t.dataModel.tables[0];
    return {
        kbRefs: { definition: kb, meta: { title: 'KB' } },
        assetRefs: { definition: files, meta: { title: 'Files' } },
        assetRefsAsked: { definition: files, meta: { title: 'Files' }, assets: [] },
        danglingDataset: { definition: ds, datasets: [{ id: 'ds_kept', name: 'Kept' }], meta: { title: 'DS' } },
        seedThatDoesNotFit: {
            ...fromTemplate(t),
            seed: { ...t.seed, [tb.id]: [{ nope_col: 1, [tb.fields[0].key]: 'x' }] },
            seedPeople: { roster: { table: 'tbl_nope' }, assign: { table: tb.id, idField: 'nope' } },
        },
    };
}
Object.assign(EXTRA, edgeCases());

/** The variants every built-in template is captured in. */
const VARIANTS = {
    /** @param {any} t */
    asIs: (t) => fromTemplate(t),
    /** @param {any} t */
    rows: (t) => ({ ...fromTemplate(t), seed: null, rowsByTable: t.seed || {} }),
    /** @param {any} t */
    oneRow: (t) => ({ ...fromTemplate(t), maxSeedRows: 1 }),
    /** @param {any} t */
    noModel: (t) => ({ ...fromTemplate(t), dataModel: null }),
    /** @param {any} t */
    fullMeta: (t) => ({
        ...fromTemplate(t),
        seed: t.seed ? { ...t.seed, tbl_not_there: [{ a: 1 }] } : { tbl_not_there: [{ a: 1 }] },
        seedPeople: { people: 'nope' },
        datasets: [{ id: 'ds_1', name: 'Open items', tableId: null }, { id: 'ds_2' }, { name: 'No id' }],
        meta: { title: `${t.title} copy`, description: 'About it', icon: 'Star', category: 'Ops', tags: ['one', 'two'], version: 2 },
    }),
};

/** @param {unknown} v */
const sha = (v) => crypto.createHash('sha256').update(JSON.stringify(v) ?? 'undefined').digest('hex');

/** @param {any} r */
const readable = (r) => (r.ok
    ? { ok: true, report: r.report, templateKeys: Object.keys(r.template), title: r.template.title, sha: sha(r) }
    : { ok: false, errors: r.errors, sha: sha(r) });

test('captureTemplate: every case matches the golden result', () => {
    /** @type {Record<string, unknown>} */
    const actual = {};
    for (const t of LIST) {
        for (const [variant, make] of Object.entries(VARIANTS)) actual[`${t.id}/${variant}`] = readable(captureTemplate(make(t)));
    }
    for (const [name, opts] of Object.entries(EXTRA)) actual[name] = readable(captureTemplate(/** @type {any} */ (opts)));
    actual.noOptions = readable(/** @type {any} */ (captureTemplate)());
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n');
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    assert.deepEqual(Object.keys(actual), Object.keys(golden));
    for (const name of Object.keys(actual)) assert.deepEqual(actual[name], golden[name], name);
});
