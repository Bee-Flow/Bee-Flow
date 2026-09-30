'use strict';

/**
 * The notebooks gates in front of a notebook made inside a project
 * (routes/projects/notebookGate.js): the real gates run in /api/notebooks'
 * order, a refusal is said as a coded project refusal, and a gate that
 * throws is an error, not a pass.
 *
 * Run: cd server && node --test routes/projects/notebookGate.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { makeNotebookGate, makeNotebookKindGate, passNotebookGate, realGates, runGate } = require('./notebookGate');
const { readGate } = require('../../auth/gateMeta');

const pass = (req, res, next) => next();
const refuse = (status) => (req, res) => res.status(status).json({ error: 'no' });

/** Run the middleware; resolve with what it did: next(), next(err) or a throw. */
async function outcome(mw, req = {}) {
    const res = { headers: {}, set(k, v) { this.headers[k] = v; return this; } };
    let nextArg = 'not called';
    try {
        await mw(req, res, (err) => { nextArg = err; });
    } catch (err) {
        return { thrown: err, res };
    }
    return { next: nextArg, res };
}

test('runGate: null when the gate lets the request through, the refusal it wrote otherwise', async () => {
    assert.strictEqual(await runGate(pass, {}), null);
    assert.deepStrictEqual(await runGate(refuse(403), {}), { status: 403, headers: {} });
    const withHeader = (req, res) => { res.set('Retry-After', '1'); return res.status(503).json({}); };
    assert.deepStrictEqual(await runGate(withHeader, {}), { status: 503, headers: { 'Retry-After': '1' } });
    const asyncPass = async (req, res, next) => { await Promise.resolve(); next(); };
    assert.strictEqual(await runGate(asyncPass, {}), null);
});

test('runGate: a gate that throws, or passes an error on, rejects', async () => {
    await assert.rejects(runGate(() => { throw new Error('boom'); }, {}), /boom/);
    await assert.rejects(runGate(async () => { throw new Error('async boom'); }, {}), /async boom/);
    await assert.rejects(runGate((req, res, next) => next(new Error('passed on')), {}), /passed on/);
});

test('every gate passes: next() once, in order, and each gate saw the request', async () => {
    const seen = [];
    const gate = (name) => (req, res, next) => { seen.push([name, req.id]); next(); };
    const r = await outcome(makeNotebookGate({ gates: [gate('module'), gate('capability'), gate('feature'), gate('permission')] }), { id: 'r1' });
    assert.strictEqual(r.next, undefined);
    assert.deepStrictEqual(seen, [['module', 'r1'], ['capability', 'r1'], ['feature', 'r1'], ['permission', 'r1']]);
});

test('the first refusal stops the chain and is a 403 notebooks_unavailable', async () => {
    let later = 0;
    for (const status of [403, 404]) {
        const r = await outcome(makeNotebookGate({ gates: [refuse(status), (req, res, next) => { later += 1; next(); }] }));
        assert.strictEqual(r.thrown.status, 403);
        assert.strictEqual(r.thrown.code, 'notebooks_unavailable');
    }
    assert.strictEqual(later, 0, 'nothing after the refusing gate ran');
});

test('a gate that cannot tell (5xx) is a 503 notebooks_unknown, with its Retry-After', async () => {
    const unsure = (req, res) => { res.set('Retry-After', '1'); return res.status(503).json({ error: 'entitlement_unavailable' }); };
    const r = await outcome(makeNotebookGate({ gates: [unsure] }));
    assert.strictEqual(r.thrown.status, 503);
    assert.strictEqual(r.thrown.code, 'notebooks_unknown');
    assert.strictEqual(r.res.headers['Retry-After'], '1');
});

test('no session stays a 401', async () => {
    const r = await outcome(makeNotebookGate({ gates: [refuse(401)] }));
    assert.strictEqual(r.thrown.status, 401);
});

test('a gate that throws is an error, never a pass', async () => {
    const r = await outcome(makeNotebookGate({ gates: [() => { throw new Error('store down'); }] }));
    assert.match(r.thrown.message, /store down/);
});

test('the gates are bound once, on first use', async () => {
    let built = 0;
    const mw = makeNotebookGate({ gates: () => { built += 1; return [pass]; } });
    assert.strictEqual(built, 0, 'making the middleware binds nothing');
    await outcome(mw);
    await outcome(mw);
    assert.strictEqual(built, 1);
    assert.strictEqual(mw.name, 'requireNotebooksMw', 'the name the route-table baseline records');
});

test('without fakes it binds the same gates as /api/notebooks, in the same order', () => {
    // Read the tags the gates carry (auth/gateMeta.js): module, capability and
    // permission say what they enforce; the feature switch is the operator's
    // kill-switch (boot/featureGate.js), a plain function named `gate`.
    const gates = realGates();
    const seen = gates.map((g) => readGate(g) || { name: g.name });
    assert.deepStrictEqual(seen.map((g) => g.axis || g.name), ['module', 'capability', 'gate', 'rbac']);
    assert.strictEqual(seen[0].id, 'notebooks');
    assert.strictEqual(seen[1].id, 'notebooks');
    assert.ok(seen[3].anyOf.includes('use_notebooks'));
});

test('passNotebookGate: resolves on a pass, rejects with the refusal, and needs no real response', async () => {
    await passNotebookGate(makeNotebookGate({ gates: [pass] }), {});
    await assert.rejects(passNotebookGate(makeNotebookGate({ gates: [refuse(403)] }), {}), { status: 403, code: 'notebooks_unavailable' });
    // A stream has started: the Retry-After of an unsure gate lands on the stand-in, not on the stream.
    const unsure = (req, res) => { res.set('Retry-After', '1'); return res.status(503).json({}); };
    await assert.rejects(passNotebookGate(makeNotebookGate({ gates: [unsure] }), {}), { status: 503, code: 'notebooks_unknown' });
});

test('a co-editing refusal is worded for opening, not creating', async () => {
    const r = await outcome(makeNotebookGate({ gates: [refuse(403)], refusal: 'cannot be opened here' }));
    assert.strictEqual(r.thrown.code, 'notebooks_unavailable');
    assert.strictEqual(r.thrown.message, 'cannot be opened here');
});

test('the kind gate asks the notebooks gates for a notebook only, and a failed lookup is not a pass', async () => {
    let asked = 0;
    const gate = makeNotebookGate({ gates: [(req, res) => { asked += 1; return res.status(403).json({}); }] });
    const byBody = makeNotebookKindGate(gate, (req) => req.body.kind);
    assert.strictEqual(byBody.name, 'requireNotebookKindMw', 'the name the route-table baseline records');

    const page = await outcome(byBody, { body: { kind: 'document' } });
    assert.strictEqual(page.next, undefined, 'a page goes on without asking');
    assert.strictEqual(asked, 0);

    let nexts = 0;
    const counted = (mw) => (req, res) => mw(req, res, () => { nexts += 1; });
    await assert.rejects(counted(byBody)({ body: { kind: 'notebook' } }, {}), { code: 'notebooks_unavailable' });
    assert.strictEqual(asked, 1);

    const lookupFails = makeNotebookKindGate(gate, async () => { const e = new Error('Not found'); e.status = 404; throw e; });
    await assert.rejects(counted(lookupFails)({}, {}), { status: 404 });
    assert.strictEqual(nexts, 0, 'neither a refused notebook nor an unknown kind goes on');
});
