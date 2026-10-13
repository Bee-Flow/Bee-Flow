/**
 * Templates, import and export (routes/automation/importExport.js), as the
 * caller experiences them.
 *
 * The module registers its routes on a router it is handed (crud.js hands it
 * its own, so the route order there stays what it always was); here they are
 * registered on a bare router of their own, mounted in a real Express app with
 * the terminal error handler, so what is asserted is the response a client gets.
 *
 * Run: node --test routes/automation/importExport.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('node:http');
const path = require('node:path');
const Module = require('node:module');

const SERVER = path.resolve(__dirname, '..', '..');

/** Replace a module in the require cache before importExport.js pulls it in. */
function stub(id, exports) {
    const resolved = require.resolve(path.join(SERVER, id));
    const m = new Module(resolved);
    m.exports = exports;
    m.loaded = true;
    require.cache[resolved] = m;
}

const calls = { create: [], usage: [], kb: [], evidence: [] };
let rows = {};
let verdict = { ok: true, errors: [], warnings: [] };

stub('stores/automationStore', {
    createAutomation: async (input) => { calls.create.push(input); return { id: 'a-new', ...input }; },
    getAutomation: async (id) => rows[id] || null,
});
stub('auth/datatableAccess', {
    resolveDatatablePrincipal: async () => ({ orgId: 'org-1' }),
    datatableScopesFor: () => [],
    gradeForPrincipal: () => null,
});
stub('stores/datatableStore', { listDatatablesForScope: async () => [], listGrantsForTables: async () => new Map() });
stub('automation/liveSideEffects', { kbFindingsFor: async () => [] });
stub('automation/validate', { validateDefinition: () => verdict });
stub('automation/toolRegistry', { TOOL_REGISTRY: [], loadTools: () => [] });
stub('automation/deliverableEvents', { getDeliverableEvents: () => [] });
stub('core/integrations/integrationTools', { getUserPermittedApps: async () => new Set() });
stub('automation/datatableUsageSync', { syncDatatableUsage: async (...args) => { calls.usage.push(args); } });
stub('core/kb/kbSourceSync', { syncKbSources: async (...args) => { calls.kb.push(args); } });
stub('stores/complianceStore', { addEvidence: async (row) => { calls.evidence.push(row); } });
stub('automation/templates', {
    CATEGORIES: ['general'],
    listTemplatesFor: async () => [{ id: 't1', title: 'Weekly digest', source: 'builtin' }],
    getTemplateFor: async (id) => (id === 't1' ? { id: 't1', title: 'Weekly digest' } : null),
});

const { registerTemplateAndImportRoutes, registerExportRoute } = require('./importExport');
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

let server; let baseUrl;
test.before(async () => {
    const router = express.Router();
    registerTemplateAndImportRoutes(router);
    registerExportRoute(router);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { user: { id: 'u1', organizationId: 'org-1' }, isAuthenticated: true }; next(); });
    app.use('/api/automation', router);
    app.use(terminalErrorHandler);
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise((r) => server.close(r)); });

test.beforeEach(() => {
    for (const list of Object.values(calls)) list.length = 0;
    rows = {};
    verdict = { ok: true, errors: [], warnings: [] };
});

const send = async (method, p, body) => {
    const res = await fetch(`${baseUrl}/api/automation${p}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
};

const file = (automation) => ({ automation: { title: 'Weekly digest', definition: { trigger: { id: 't', kind: 'manual' }, steps: [] }, ...automation } });

describe('templates', () => {
    test('the list carries the categories beside the templates', async () => {
        const { status, body } = await send('GET', '/templates');
        assert.strictEqual(status, 200);
        assert.deepStrictEqual(body.categories, ['general']);
        assert.strictEqual(body.templates[0].id, 't1');
    });

    test('an unknown template is a 404 that says so', async () => {
        const { status, body } = await send('GET', '/templates/nope');
        assert.strictEqual(status, 404);
        assert.strictEqual(body.error, 'Template not found');
    });
});

describe('POST /import', () => {
    test('a file that is not an export is refused before anything is written', async () => {
        const { status, body } = await send('POST', '/import', { automation: { title: '', definition: 'x' } });
        assert.strictEqual(status, 400);
        assert.strictEqual(body.error, 'Invalid import file');
        assert.ok(body.details.length > 0);
        assert.strictEqual(calls.create.length, 0);
    });

    test('a definition the validator refuses is a 400 with its findings', async () => {
        verdict = { ok: false, errors: [{ code: 'x.broken', message: 'broken' }], warnings: [] };
        const { status, body } = await send('POST', '/import', file());
        assert.strictEqual(status, 400);
        assert.strictEqual(body.error, 'Invalid definition');
        assert.strictEqual(body.details[0].code, 'x.broken');
        assert.strictEqual(calls.create.length, 0);
    });

    test('a good file lands as the caller\'s draft, stamped with the caller\'s organisation', async () => {
        const { status, body } = await send('POST', '/import', file({ userId: 'someone-else', isActive: true }));
        assert.strictEqual(status, 200);
        assert.strictEqual(body.automation.id, 'a-new');
        assert.strictEqual(calls.create.length, 1);
        const created = calls.create[0];
        assert.strictEqual(created.userId, 'u1', 'owned by the importer, never by the file');
        assert.strictEqual(created.organizationId, 'org-1');
        assert.strictEqual(created.isActive, undefined, 'the file\'s isActive is dropped');
        // The usage index and the knowledge-base sources follow the stored definition.
        assert.strictEqual(calls.usage.length, 1);
        assert.strictEqual(calls.usage[0][1], 'org-1');
        assert.deepStrictEqual(calls.usage[0][3], { label: 'automation import' });
        assert.strictEqual(calls.kb.length, 1);
    });

    test('a back-pointer to an app button is removed and reported, not refused', async () => {
        const { status, body } = await send('POST', '/import',
            file({ definition: { trigger: { id: 't', kind: 'manual', appRef: { appId: 'app-1', buttonId: 'b1' } }, steps: [] } }));
        assert.strictEqual(status, 200);
        assert.ok(body.warnings.some(w => w.code === 'import.app_ref_removed'));
        assert.strictEqual(calls.create[0].definition.trigger.appRef, undefined);
    });

    test('a schedule that does not parse is a warning on an imported draft', async () => {
        const { status, body } = await send('POST', '/import', file({ triggerType: 'schedule', scheduleCron: 'not a cron' }));
        assert.strictEqual(status, 200);
        assert.ok(body.warnings.some(w => w.code === 'import.bad_cron'));
        assert.strictEqual(calls.create[0].nextRunAt, null);
    });
});

describe('GET /:id/export', () => {
    test('an unknown automation is a 404', async () => {
        const { status } = await send('GET', '/missing/export');
        assert.strictEqual(status, 404);
    });

    test('the owner gets a sanitised envelope, and the export is stamped as evidence', async () => {
        rows.a1 = { id: 'a1', userId: 'u1', title: 'Mine', definition: { trigger: { id: 't', kind: 'manual' }, steps: [], manualTriggerPayload: { subject: 'private' } } };
        const { status, body } = await send('GET', '/a1/export');
        assert.strictEqual(status, 200);
        assert.strictEqual(body.envelope.automation.title, 'Mine');
        assert.strictEqual(body.envelope.automation.definition.manualTriggerPayload, undefined);
        assert.ok(body.warnings.length > 0);
        // The stamp is written on `finish`, after the response.
        for (let i = 0; i < 50 && calls.evidence.length === 0; i++) await new Promise(r => setImmediate(r));
        assert.strictEqual(calls.evidence.length, 1);
        assert.strictEqual(calls.evidence[0].subject_id, 'automations');
    });
});
