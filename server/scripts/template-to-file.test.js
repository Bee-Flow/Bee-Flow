/**
 * template-to-file — the bridge from a template MODULE to an importable file.
 *
 * Two things are worth pinning. The first is that both module shapes load, so
 * "it exports the template" and "it wraps the template" are not a coin toss the
 * user discovers at the wrong moment. The second is the one that gives the
 * script its reason to exist: what it writes must pass the import gate, because
 * a converter that emits a file the product refuses has only moved the
 * disappointment later.
 *
 * Run: cd server && node --test scripts/template-to-file.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadFromModule } = require('./template-to-file');
const { buildExport, sanitizeImport } = require('../appStudio/templatePortability');
const { getTemplate } = require('../appStudio/templates');

function writeModule(body) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-'));
    const file = path.join(dir, `m${Math.random().toString(36).slice(2)}.js`);
    fs.writeFileSync(file, body, 'utf8');
    return file;
}

const MINIMAL = `{
    id: 'app-x', version: 2, title: 'X', description: 'd', category: 'Data', icon: 'LayoutGrid', tags: [],
    definition: { meta: { name: 'X' }, screens: [{ id: 'scr_1', name: 'Home', sections: [] }] },
}`;

test('a module that IS the template loads', () => {
    const tpl = loadFromModule(writeModule(`module.exports = ${MINIMAL};`));
    assert.equal(tpl.title, 'X');
});

test('a module that WRAPS the template loads too', () => {
    const tpl = loadFromModule(writeModule(`module.exports = { template: ${MINIMAL} };`));
    assert.equal(tpl.title, 'X');
});

test('what the converter writes is what the import gate accepts', () => {
    // The whole contract, end to end, against a real shipped template rather
    // than a fixture: convert it the way the script does, then read it back the
    // way the route does.
    const template = getTemplate('app-quote-intake') || getTemplate('app-request-form');
    const { envelope } = buildExport(template, { exportedAt: new Date().toISOString() });

    const verdict = sanitizeImport(JSON.parse(JSON.stringify(envelope)));
    assert.deepEqual(verdict.errors, []);
    assert.equal(verdict.template.title, template.title);
    assert.ok(verdict.report.screens > 0);
});

test('every shipped template converts to a file this installation would import', () => {
    // The gallery is 21 modules maintained by hand. This is the test that says
    // so when one of them stops being portable — which is a real regression the
    // moment someone hands a colleague "the template we use".
    const { listTemplates } = require('../appStudio/templates');
    const broken = [];
    for (const row of listTemplates()) {
        const { envelope } = buildExport(getTemplate(row.id), { exportedAt: '2026-01-01T00:00:00.000Z' });
        const verdict = sanitizeImport(JSON.parse(JSON.stringify(envelope)));
        if (!verdict.template) broken.push(`${row.id}: ${verdict.errors.join('; ')}`);
    }
    assert.deepEqual(broken, []);
});
