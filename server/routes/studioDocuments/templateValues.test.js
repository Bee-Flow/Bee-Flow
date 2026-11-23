/**
 * PUT /api/studio-documents/:id/values (routes/studioDocuments/templateValues.mts),
 * the form under a chat answer that fills in a template. DB-free: the store is a
 * fake handed to the router factory, the contract code is the real one, and the
 * request goes through express (body validation, error answers) for real.
 * Organisation isolation against the real store: tenantIsolation.matrix.test.js.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { makeTemplateValuesRouter } = require('./templateValues.mts');

const CONTRACT = {
    parameters: [
        { key: 'client_name', type: 'text', label: 'Client name', required: true },
        { key: 'amount', type: 'number', label: 'Amount', required: true },
        { key: 'date', type: 'date', label: 'Offer date' },
        { key: 'lines', type: 'list', label: 'Lines', fields: [{ key: 'what', type: 'text' }, { key: 'price', type: 'number' }] },
    ],
};
const BODY = '<p>{{client_name}} {{amount}} {{date}}</p>';

function fakeStore() {
    const docs = new Map();
    const writes = [];
    const add = (doc) => docs.set(doc.id, { versionId: 'v1', kind: 'document', docType: 'quote', bodyHtml: BODY, settings: { contract: CONTRACT }, ...doc });
    add({ id: 'doc-1', userId: 'alice', name: 'Offer', settings: { contract: CONTRACT, sampleValues: { client_name: 'Van Dijk' }, templateFill: { conversationId: 'c1', templateId: 't1', startedAt: '2026-11-20T10:00:00.000Z' } } });
    add({ id: 'doc-viewer', userId: 'bob', name: 'Shared to read', sharingRole: 'viewer' });
    // Made from the library and filled in in the editor: no conversation started it.
    add({ id: 'doc-library', userId: 'alice', name: 'From the library', settings: { contract: CONTRACT, sampleValues: { client_name: 'Van Dijk', amount: 5 } } });
    add({ id: 'tpl-1', userId: 'alice', name: 'A template', kind: 'template' });
    let conflictOnce = false;
    return {
        docs, writes,
        failNextWithConflict() { conflictOnce = true; },
        async getDocument(id, userId) {
            const d = docs.get(id);
            if (!d) return null;
            if (d.userId !== userId && !d.sharingRole) return null;
            return structuredClone(d);
        },
        async updateDocument(id, userId, updates) {
            if (conflictOnce) {
                conflictOnce = false;
                // Someone else saved meanwhile: the stored values moved on.
                const d = docs.get(id);
                d.settings = { ...d.settings, sampleValues: { ...d.settings.sampleValues, date: '2026-01-02' } };
                d.versionId = 'v-other';
                throw Object.assign(new Error('This document changed while you were editing.'), { status: 409, errorClass: 'document_conflict' });
            }
            writes.push({ id, userId, updates });
            const d = docs.get(id);
            if (!d || d.userId !== userId) return null;
            Object.assign(d, { settings: updates.settings, versionId: `${d.versionId}+` });
            return structuredClone(d);
        },
    };
}

async function withServer(store, fn, deps = {}) {
    const app = express();
    app.use(express.json());
    const requireAuth = (req, res, next) => {
        const user = req.headers['x-user'];
        if (!user) return res.status(401).json({ error: 'Authentication required' });
        req.session = { user: { id: String(user) } };
        return next();
    };
    app.use('/api/studio-documents', makeTemplateValuesRouter({ store: () => store, requireAuth, ...deps }));
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message, code: err.code }));
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api/studio-documents`;
    const send = async (method, path, body, user) => {
        const res = await fetch(`${base}/${path}`, {
            method, headers: { 'content-type': 'application/json', ...(user ? { 'x-user': user } : {}) }, body: method === 'GET' ? undefined : JSON.stringify(body),
        });
        return { status: res.status, body: await res.json(), cache: res.headers.get('cache-control') };
    };
    const put = (id, body, user = 'alice') => send('PUT', `${id}/values`, body, user);
    const review = (id, user = 'alice') => send('POST', `${id}/values/review`, {}, user);
    const preview = (id, user = 'alice') => send('GET', `${id}/values/preview`, undefined, user);
    try { await fn(put, review, preview); } finally { server.close(); }
}

test('saves what fits, answers what is missing, and names each value that does not fit', async () => {
    const store = fakeStore();
    await withServer(store, async (put) => {
        const res = await put('doc-1', { values: { amount: '12,5', date: '2026-02-30', colour: 'red', lines: [{ what: 'Hours', price: '40' }] } });
        assert.equal(res.status, 200);
        assert.deepEqual(res.body.values, { client_name: 'Van Dijk', amount: 12.5, lines: [{ what: 'Hours', price: 40 }] });
        assert.deepEqual(res.body.rejected.map((r) => r.key).sort(), ['colour', 'date']);
        assert.match(res.body.rejected.find((r) => r.key === 'date').message, /YYYY-MM-DD/);
        assert.deepEqual(res.body.missingRequired, []);
        assert.equal(res.body.complete, true);
        assert.equal(res.body.documentId, 'doc-1');
        assert.equal(res.body.finished, false);
        assert.equal(store.writes[0].updates.source, 'autosave', 'the person\'s edit, not an AI revision');
        assert.equal(store.docs.get('doc-1').settings.templateFill.conversationId, 'c1', 'the conversation link is kept');
    });
});

test('null clears a field, and then it is missing again', async () => {
    const store = fakeStore();
    await withServer(store, async (put) => {
        const res = await put('doc-1', { values: { client_name: null } });
        assert.deepEqual(res.body.values, {});
        assert.deepEqual(res.body.missingRequired.map((m) => m.label), ['Client name', 'Amount']);
        assert.equal(res.body.complete, false);
    });
});

test('finish marks the fill finished only when nothing required is missing', async () => {
    const store = fakeStore();
    await withServer(store, async (put) => {
        const early = await put('doc-1', { values: {}, finish: true });
        assert.equal(early.body.finished, false);
        assert.deepEqual(early.body.missingRequired.map((m) => m.label), ['Amount']);
        assert.equal(store.docs.get('doc-1').settings.templateFill.finishedAt, undefined);
        const done = await put('doc-1', { values: { amount: 10 }, finish: true });
        assert.equal(done.body.finished, true);
        assert.ok(store.docs.get('doc-1').settings.templateFill.finishedAt);
    });
});

test('a document that no conversation started is finished the same way, and stays finished', async () => {
    const store = fakeStore();
    await withServer(store, async (put) => {
        const done = await put('doc-library', { values: {}, finish: true });
        assert.equal(done.body.finished, true);
        assert.ok(store.docs.get('doc-library').settings.templateFill.finishedAt);
        const writes = store.writes.length;
        const again = await put('doc-library', { values: {}, finish: true });
        assert.equal(again.body.finished, true);
        assert.equal(store.writes.length, writes, 'finishing twice writes nothing more');
    });
});

test('a save that lost a race is merged once more on the fresh document', async () => {
    const store = fakeStore();
    store.failNextWithConflict();
    await withServer(store, async (put) => {
        const res = await put('doc-1', { values: { amount: 7 } });
        assert.equal(res.status, 200);
        assert.deepEqual(res.body.values, { client_name: 'Van Dijk', date: '2026-01-02', amount: 7 }, 'the other save is kept');
    });
});

test('the body is checked: values is an object, and nothing else is taken', async () => {
    const store = fakeStore();
    await withServer(store, async (put) => {
        for (const body of [{ values: 'x' }, { values: [1] }, {}, { values: {}, extra: 1 }, { values: {}, finish: 'yes' }]) {
            const res = await put('doc-1', body);
            assert.equal(res.status, 400, JSON.stringify(body));
        }
        const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`k${i}`, 'x']));
        assert.equal((await put('doc-1', { values: many })).status, 400);
        assert.equal(store.writes.length, 0, 'a refused body changes nothing');
    });
});

test('access: signed in, a document the caller may see, an editor, and never a template', async () => {
    const store = fakeStore();
    await withServer(store, async (put) => {
        assert.equal((await put('doc-1', { values: { amount: 1 } }, null)).status, 401);
        assert.equal((await put('doc-1', { values: { amount: 1 } }, 'eve')).status, 404, 'a stranger gets the same 404 as a missing id');
        assert.equal((await put('nope', { values: {} })).status, 404);
        const viewer = await put('doc-viewer', { values: { amount: 1 } }, 'alice');
        assert.equal(viewer.status, 403);
        assert.equal(viewer.body.code, 'document_read_only');
        const template = await put('tpl-1', { values: { amount: 1 } });
        assert.equal(template.status, 400);
        assert.equal(template.body.code, 'document_not_fillable');
        assert.equal(store.writes.length, 0);
    });
});

// ── The final check ─────────────────────────────────────────────────

const REVIEW = { at: '2026-11-23T09:00:00.000Z', by: 'alice', source: 'form', checked: 2 };
const remarkOn = (value, extra) => ({ reason: 'Looks off.', was: JSON.stringify(value), ...extra });
const kinds = (body) => body.review.findings.map((f) => f.kind);
const pass = (_req, _res, next) => next();

test('the check stores the assistant\'s remarks; taking a wording over or changing the value clears a remark, dismissing keeps the value', async () => {
    const store = fakeStore();
    const asked = [];
    const reviewer = async (doc, who) => {
        asked.push({ id: doc.id, ...who });
        return { ...REVIEW, findings: [
            remarkOn('Van Dijk', { key: 'client_name', kind: 'rewrite', suggestion: 'Van Dijk Groep B.V.' }),
            remarkOn(5, { key: 'amount', kind: 'doubt' }),
        ] };
    };
    await withServer(store, async (put, review) => {
        await put('doc-1', { values: { amount: 5 } });
        const checked = await review('doc-1');
        assert.equal(checked.status, 200);
        assert.deepEqual(asked, [{ id: 'doc-1', userId: 'alice', orgId: null }]);
        assert.deepEqual(kinds(checked.body), ['rewrite', 'doubt']);
        assert.equal(checked.body.review.findings[0].was, undefined, 'the reader is not handed the bookkeeping');
        assert.equal(checked.body.complete, true);

        // Taking the suggested wording over is a plain save of that value: the remark goes with the old value.
        const taken = await put('doc-1', { values: { client_name: 'Van Dijk Groep B.V.' } });
        assert.deepEqual(kinds(taken.body), ['doubt']);
        // "Keep mine": the remark goes, the value stays.
        const kept = await put('doc-1', { values: {}, dismiss: ['amount'] });
        assert.deepEqual(kinds(kept.body), []);
        assert.equal(kept.body.values.amount, 5);
        assert.ok(kept.body.review.at, 'it stays a checked document');
    }, { reviewer, limit: async () => null, limiter: pass });
});

test('the check is refused in words when the AI may not be used, and says so when the model fails', async () => {
    await withServer(fakeStore(), async (_put, review) => {
        const out = await review('doc-1');
        assert.equal(out.status, 402);
        assert.equal(out.body.code, 'ai_limit_reached');
    }, { reviewer: async () => assert.fail('never asked'), limit: async () => 'Your AI budget for this month is used up.', limiter: pass });
    const noModel = Object.assign(new Error('No AI model is configured, so the check could not run.'), { status: 503, errorClass: 'fill_review_no_model' });
    await withServer(fakeStore(), async (_put, review) => {
        const none = await review('doc-1');
        assert.equal(none.status, 503);
        assert.equal(none.body.code, 'fill_review_no_model');
    }, { reviewer: async () => { throw noModel; }, limit: async () => null, limiter: pass });
    await withServer(fakeStore(), async (_put, review) => {
        const broke = await review('doc-1');
        assert.equal(broke.status, 502);
        assert.equal(broke.body.code, 'fill_review_failed');
        assert.doesNotMatch(broke.body.error, /provider/, 'a provider\'s own words never reach the client');
        assert.equal((await review('doc-viewer')).status, 403, 'a reader does not start a check');
        assert.equal((await review('tpl-1')).status, 400);
        assert.equal((await review('doc-1', 'mallory')).status, 404);
    }, { reviewer: async () => { throw Object.assign(new Error('401 from the provider: the account was rejected'), { status: 401 }); }, limit: async () => null, limiter: pass });
});

test('the preview is a read: anyone who may open the document gets it, never from a stored copy', async () => {
    const asked = [];
    const preview = async (doc, orgId) => { asked.push({ id: doc.id, orgId }); return { html: `<html>${doc.name}</html>`, gaps: ['amount'] }; };
    await withServer(fakeStore(), async (_put, _review, get) => {
        const own = await get('doc-1');
        assert.equal(own.status, 200);
        assert.deepEqual(own.body, { html: '<html>Offer</html>', gaps: ['amount'] });
        assert.equal(own.cache, 'no-store');
        assert.equal((await get('doc-viewer')).status, 200, 'a reader who may only view sees it too');
        assert.equal((await get('tpl-1')).status, 400, 'a template itself is not filled in');
        assert.equal((await get('doc-1', 'mallory')).status, 404);
        assert.equal((await get('nope')).status, 404);
        assert.equal((await get('doc-1', '')).status, 401);
        assert.deepEqual(asked, [{ id: 'doc-1', orgId: null }, { id: 'doc-viewer', orgId: null }]);
    }, { preview });
});

test('a preview that is refused answers the reason; one that breaks stays a plain 500', async () => {
    const refused = Object.assign(new Error('A presentation is previewed in its own slide viewer.'), { status: 422, errorClass: 'fill_preview_unsupported' });
    await withServer(fakeStore(), async (_put, _review, get) => {
        const out = await get('doc-1');
        assert.equal(out.status, 422);
        assert.equal(out.body.code, 'fill_preview_unsupported');
    }, { preview: async () => { throw refused; } });
    await withServer(fakeStore(), async (_put, _review, get) => {
        assert.equal((await get('doc-1')).status, 500);
    }, { preview: async () => { throw new Error('the composer fell over'); } });
});
