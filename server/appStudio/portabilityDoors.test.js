/**
 * Every way an app is copied, and what of the parts outside its screens each one carries:
 *
 *   save as template (captureTemplate)      uploaded files carried; data model extras, triggers,
 *   template file (buildExport / import)    column rights, variables, CSS, tokens, fonts and
 *   app archive (sanitizeAppImport)         shell as written
 *   Blueprint / release / stage deploy      uploaded files NOT carried, and said so
 *                                           (projects/appDefinitionGate.mts)
 *
 * The install halves (create from a template, template upgrade, the AI apply tool, the archive
 * route) all store the files through portableAssetStore.mts (portableAssets.test.js); a version
 * restore and a Blueprint install are in their own route and install tests.
 *
 * Run: cd server && node --test appStudio/portabilityDoors.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { png, entry, entriesFor, CORPUS_ASSET_IDS, corpusApp } = require('../testUtils/portableAssets.testkit');
const { captureTemplate, normalizeSeed } = require('./templateCapture');
const { buildExport, sanitizeImport, EXPORT_SUPPORTED_VERSIONS } = require('./templatePortability');
const { sanitizeAppImport, APP_FORMAT } = require('./appPortability');
const { canonicalizeAppDefinition } = require('./canonicalize');
const { canonicalizeDataModel } = require('./dataModel');
const { SCHEMA_VERSION_CURRENT } = require('./componentSpecs');
const { gateReleaseApps, appCopyNotes } = require('../projects/appDefinitionGate.mts');

function capture(app, extra = {}) {
    const out = captureTemplate({ definition: app.definition, dataModel: app.dataModel || null, meta: { title: 'Copy' }, ...extra });
    assert.equal(out.ok, true, out.errors && out.errors.join('; '));
    return out;
}
const roundTrip = (template) => sanitizeImport(buildExport(template).envelope);
const archive = (template, extra = {}) => ({ format: APP_FORMAT, schemaVersion: EXPORT_SUPPORTED_VERSIONS.at(-1), template, ...extra });

test('save as template: the files the app uses come along and its references stay', () => {
    const app = corpusApp('asset-refs');
    const { template, report } = capture(app, { assets: [...entriesFor(app.definition), entry('spare', png(9))] });
    assert.deepEqual(template.assets.map((a) => a.id), CORPUS_ASSET_IDS);
    assert.equal(template.definition.design.logoUrl, `asset:${CORPUS_ASSET_IDS[0]}`);
    assert.deepEqual(report.portable.assets, { carried: 3, left: 0 });
});

test('save as template without files is the capture of before: references cut, and said', () => {
    const { template, report } = capture(corpusApp('asset-refs'));
    assert.equal('assets' in template, false);
    assert.equal(template.definition.design.logoUrl, null);
    assert.ok(report.warnings.some((w) => w.includes('uploaded file reference(s) removed')), report.warnings.join(' | '));
});

test('the files have their own budget: a large picture does not count against the template ceiling', () => {
    const app = corpusApp('asset-refs');
    const big = entry(CORPUS_ASSET_IDS[0], png(4.5 * 1024 * 1024));
    const { template, report } = capture(app, { assets: [big] });
    assert.deepEqual(template.assets.map((a) => a.id), [CORPUS_ASSET_IDS[0]]);
    assert.ok(report.bytes < 4 * 1024 * 1024);
});

test('template file: the files travel out and are decided again on the way in', () => {
    const app = corpusApp('asset-refs');
    const { template } = capture(app, { assets: entriesFor(app.definition) });
    const { envelope } = buildExport(template);
    assert.equal(envelope.template.assets.length, 3);
    // A file edited after export: the bytes of an SVG under a picture's name and sha.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    envelope.template.assets[1] = { ...envelope.template.assets[1], data: svg.toString('base64') };
    const back = sanitizeImport(envelope);
    assert.deepEqual(back.errors, []);
    assert.deepEqual(back.template.assets.map((a) => a.id), [CORPUS_ASSET_IDS[0], CORPUS_ASSET_IDS[2]]);
    assert.ok(back.warnings.some((w) => w.includes(`asset:${CORPUS_ASSET_IDS[1]}`)), back.warnings.join(' | '));
    assert.deepEqual(back.report.portable.assets, { carried: 2, left: 1 });
});

test('app archive: the files travel in the design half and are decided again', () => {
    const app = corpusApp('asset-refs');
    const out = sanitizeAppImport(archive({ definition: app.definition, assets: entriesFor(app.definition) }));
    assert.deepEqual(out.errors, []);
    assert.deepEqual(out.template.assets.map((a) => a.id), CORPUS_ASSET_IDS);
    assert.deepEqual(out.report.portable.assets, { carried: 3, left: 0 });
});

test('a definition of a newer schema is refused at every file door; an older one is left as it is', () => {
    const newer = { ...corpusApp('empty-definition').definition, schemaVersion: SCHEMA_VERSION_CURRENT + 1 };
    const file = buildExport({ title: 'Later', definition: newer }).envelope;
    file.schemaVersion = EXPORT_SUPPORTED_VERSIONS.at(-1);
    assert.match(sanitizeImport(file).errors.join(' '), /newer/);
    assert.match(sanitizeAppImport(archive({ definition: newer })).errors.join(' '), /newer/);
    const { template, report } = capture(corpusApp('empty-definition'));
    assert.equal(template.definition.schemaVersion, 2);
    assert.equal('portable' in report, false);
    assert.equal(buildExport(template).envelope.schemaVersion, 1);
});

test('data model: lookup, rollup, many relation, delete rule and indexes travel; a seed keeps the links and never a derived value', () => {
    const app = corpusApp('data-model-linked-records');
    const rowsByTable = {
        tbl_atag01: [{ id: 'rec_t1', label: 'VIP' }],
        tbl_acct01: [{ id: 'rec_a1', name: 'Acme', order_count: 3, open_total: 10, tags: ['rec_t1', 'rec_elsewhere'] }],
        tbl_aord01: [{ id: 'rec_o1', amount: 10, status: 'open', customer: 'rec_a1', customer_name: 'Acme' }],
    };
    const { template } = capture(app, { rowsByTable });
    assert.deepEqual(template.dataModel, canonicalizeDataModel(app.dataModel).model);
    assert.deepEqual(template.seed.tbl_acct01, [{ $id: 'accounts_1', name: 'Acme', tags: [{ $ref: 'account_tags_1' }] }]);
    assert.deepEqual(template.seed.tbl_aord01, [{ $id: 'account_orders_1', amount: 10, status: 'open', customer: { $ref: 'accounts_1' } }]);

    const fromFile = normalizeSeed(template.dataModel, {
        tbl_atag01: [{ $id: 't1', label: 'VIP' }],
        tbl_acct01: [{ name: 'Acme', order_count: 9, tags: [{ $ref: 't1' }, { $ref: 'nope' }, 'rec_x'] }],
    }, 100);
    assert.deepEqual(fromFile.seed.tbl_acct01, [{ name: 'Acme', tags: [{ $ref: 't1' }] }]);
    assert.equal(fromFile.dropped.refs, 2);
    assert.deepEqual(fromFile.dropped.fields, ['accounts.order_count']);
});

test('column rights travel as written; a role the copy does not have is named, not dropped', () => {
    const app = corpusApp('column-rights');
    const budget = app.dataModel.tables[0].fields.find((f) => f.key === 'budget');
    budget.access = { read: ['lead', 'ghost'] };
    const { template, report } = capture(app);
    const kept = template.dataModel.tables[0].fields.find((f) => f.key === 'budget');
    assert.deepEqual(kept.access, { read: ['lead', 'ghost'] });
    assert.equal(report.portable.columnRights.unknownRoles.length, 1);
    assert.match(report.portable.columnRights.unknownRoles[0], /"ghost"/);
    assert.ok(report.warnings.some((w) => w.startsWith('Column rights:')));
});

test('triggers travel switched off; a webhook carries no address or secret, and the report says a publish makes them', () => {
    const app = corpusApp('zz-webhook-trigger');
    const { template, report } = capture(app);
    assert.deepEqual(template.definition.triggers, canonicalizeAppDefinition(app.definition).def.triggers);
    assert.deepEqual(report.portable.triggers, { count: 2, webhooks: 2, armed: false });
    assert.equal(report.warnings.some((w) => w.includes('trigger')), false, 'news, not a warning: the dialog says it from the summary');
    const text = JSON.stringify(buildExport(template).envelope);
    assert.equal(/secret|endpoint/i.test(text), false);
    assert.deepEqual(roundTrip(template).report.portable.triggers, report.portable.triggers);
});

for (const name of ['custom-css', 'design-font-roles', 'wishlist-variables', 'nav-shell-options', 'vocab-theme-scope']) {
    test(`definition-only parts pass every door unchanged: ${name}`, () => {
        const app = corpusApp(name);
        const canonical = canonicalizeAppDefinition(structuredClone(app.definition)).def;
        const { template } = capture(app, { assets: entriesFor(app.definition) });
        const back = roundTrip(template);
        const viaArchive = sanitizeAppImport(archive({ definition: template.definition, assets: template.assets }));
        for (const copy of [template.definition, back.template.definition, viaArchive.template.definition]) {
            for (const key of Object.keys(canonical).filter((k) => k !== 'meta')) assert.deepEqual(copy[key], canonical[key], key);
        }
    });
}

test('Blueprint, release and stage: the files do not travel, and every report says so', () => {
    const def = corpusApp('asset-refs').definition;
    assert.match(appCopyNotes('Desk', def)[0], /"Desk" uses 3 uploaded file\(s\)/);
    assert.match(appCopyNotes('Hooks', corpusApp('zz-webhook-trigger').definition).join(' '), /2 trigger\(s\).*new address and secret/);
    assert.deepEqual(appCopyNotes('Plain', corpusApp('empty-definition').definition), []);
    const { blocking, warnings } = gateReleaseApps([{ kind: 'app', ref: 'app_1', entity: { definition: def } }]);
    assert.deepEqual(blocking, []);
    const found = warnings.find((w) => w.code === 'app.assets_not_carried');
    assert.equal(found.count, 3);
    assert.match(found.message, /not part of a release/);
});
