'use strict';
/**
 * detectPii with "Your own data" ids in the category list, against a fake
 * guard over HTTP.
 *
 * What is pinned:
 *   - a list without custom ids sends exactly today's body and uses today's
 *     cache key (the fork must be invisible to every existing caller);
 *   - words/patterns run without a guard: `guardAbsent` instead of null, and a
 *     custom-only list never calls the guard at all;
 *   - `ai` types go as custom_labels only to a guard that says it is 2.3.0 or
 *     newer (read from /health, even from a 503 while it loads);
 *   - a 422 on the field: retried once without it, the ai ids degraded, the
 *     breaker NOT tripped, and the error message carries no request text;
 *   - breaker open: degraded, Node findings kept;
 *   - a changed word is a cache miss (the id did not change, the spec did);
 *   - a windowed scan keeps custom offsets absolute.
 *
 * Run: cd server && node --test core/privacy/piiDetection/detect.custom.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.NODE_ENV = 'test';
// configStore answers from an empty database, so the endpoint comes from env.
require('../../http/routeHarness').recordDb();

const pii = require('../piiDetection');
const { invalidateGuardEndpointCache } = require('./guardEndpoint');
const { noteGuardFailure, circuitIsOpen } = require('./requestShaping');
const { clearGuardCapabilities } = require('../customTypes/guardCapabilities');
const registry = require('../customTypes/registry');
const { _resetPlanCache } = require('../customTypes/plan');

const WORDS = 'cdt_00000000a1';
const PATTERN = 'cdt_00000000b2';
const AI = 'cdt_00000000c3';
const TYPES = [
    { id: WORDS, name: 'Project code names', method: 'words', tokenKey: 'project_code', words: { values: ['Falcon'], caseSensitive: false, wholeWord: true } },
    { id: PATTERN, name: 'Customer numbers', method: 'pattern', tokenKey: 'customer_number', pattern: { source: 'KL-\\d{5}', caseSensitive: false, engine: 're2' } },
    { id: AI, name: 'Codenames', method: 'ai', tokenKey: 'codename', ai: { prompt: 'internal project codename', floor: 0.5 } },
];

const guard = { version: '2.3.0', healthStatus: 200, reject422: false, fail: false, bodies: [], healthHits: 0 };
let server;
let url;

function find(text, needle) {
    const out = [];
    let i = text.indexOf(needle);
    while (i >= 0) { out.push(i); i = text.indexOf(needle, i + needle.length); }
    return out;
}

test.before(async () => {
    server = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/health') {
            guard.healthHits += 1;
            res.writeHead(guard.healthStatus, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: guard.healthStatus === 200 ? 'ok' : 'degraded', version: guard.version }));
            return;
        }
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const body = JSON.parse(raw);
            guard.bodies.push(body);
            if (guard.fail) { res.writeHead(500); res.end('boom'); return; }
            if (guard.reject422 && body.custom_labels) {
                res.writeHead(422, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ detail: [{ type: 'extra_forbidden', loc: ['body', 'custom_labels'], msg: 'Extra inputs are not permitted', input: body.text }] }));
                return;
            }
            const cats = body.enabled_categories;
            const wantsPerson = cats === null || (Array.isArray(cats) && (cats.includes('Person') || (cats.length === 0 && !body.custom_labels)));
            const entities = wantsPerson
                ? find(body.text, 'Jan Jansen').map(o => ({ text: 'Jan Jansen', category: 'Person', label: 'Person Name', confidence: 0.9, offset: o, length: 10 }))
                : [];
            const out = { hasPii: entities.length > 0, entities, degraded: false, engine_fingerprint: 'fp1' };
            if (body.custom_labels) {
                out.custom_entities = body.custom_labels.flatMap(l => find(body.text, 'Blue Heron').map(o => ({
                    text: 'Blue Heron', category: l.id, label: l.id, confidence: 0.8, offset: o, length: 10, source: 'model_custom',
                })));
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(out));
        });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); delete process.env.PII_SERVICE_URL; });

test.beforeEach(() => {
    process.env.PII_SERVICE_URL = url;
    invalidateGuardEndpointCache();
    clearGuardCapabilities();
    pii._resetGuardCircuit();
    registry._resetRegistry();
    _resetPlanCache();
    registry.syncOrg('org1', TYPES);
    Object.assign(guard, { version: '2.3.0', healthStatus: 200, reject422: false, fail: false, bodies: [], healthHits: 0 });
});

const TEXT = 'Jan Jansen leads Falcon, ref KL-12345, codename Blue Heron.';

test('no custom ids: exactly today\'s request body and cache key', async () => {
    const r = await pii.detectPii(TEXT, ['Person', 'Email'], 0.7);
    assert.equal(guard.bodies.length, 1);
    assert.deepEqual(Object.keys(guard.bodies[0]), ['text', 'confidence_threshold', 'enabled_categories']);
    assert.equal(guard.healthHits, 0, 'no version probe on the built-in path');
    assert.deepEqual(r.entities.map(e => e.category), ['Person']);
    assert.equal('guardAbsent' in r, false);
    const { cacheKey } = require('./scanCache');
    assert.ok(!cacheKey('detect', TEXT, ['Person'], 0.7).includes(':c='));
});

test('built-ins, words, pattern and ai in one scan, merged in text order', async () => {
    const r = await pii.detectPii(TEXT, ['Person', WORDS, PATTERN, AI], 0.7);
    assert.equal(guard.bodies.length, 1);
    const sent = guard.bodies[0];
    assert.deepEqual(sent.enabled_categories, ['Person']);
    assert.deepEqual(sent.custom_labels, [{ id: AI, prompt: 'internal project codename', floor: 0.5 }]);
    assert.deepEqual(r.entities.map(e => [e.text, e.category, e.label]), [
        ['Jan Jansen', 'Person', 'Person Name'],
        ['Falcon', WORDS, 'Project code names'],
        ['KL-12345', PATTERN, 'Customer numbers'],
        ['Blue Heron', AI, 'Codenames'],
    ]);
    assert.equal(r.degraded, false);
    assert.match(r.engineFingerprint, /^fp1\+c[0-9a-f]{12}$/, 'the identity covers the Node specs too');
});

test('ai types only: the guard gets [] plus custom_labels, meaning no built-ins', async () => {
    const r = await pii.detectPii(TEXT, [AI], 0.7);
    assert.deepEqual(guard.bodies[0].enabled_categories, []);
    assert.deepEqual(r.entities.map(e => e.category), [AI]);
});

test('a custom-only words/pattern list never calls the guard', async () => {
    const r = await pii.detectPii(TEXT, [WORDS, PATTERN], 0.7);
    assert.equal(guard.bodies.length, 0);
    assert.equal(guard.healthHits, 0);
    assert.deepEqual(r.entities.map(e => e.text), ['Falcon', 'KL-12345']);
    assert.equal(r.engineFingerprint, null, 'a Node-only answer is never memoised by the ledger');
    assert.equal('guardAbsent' in r, false, 'nothing needed the guard');
});

test('no guard installed: guardAbsent with the Node findings, never cached', async () => {
    delete process.env.PII_SERVICE_URL;
    invalidateGuardEndpointCache();
    const r = await pii.detectPii(TEXT, ['Person', WORDS], 0.7);
    assert.equal(r.guardAbsent, true);
    assert.equal(r.degraded, false);
    assert.deepEqual(r.entities.map(e => e.text), ['Falcon']);
    // Installing the guard takes effect at once: the guard-less answer was not cached.
    process.env.PII_SERVICE_URL = url;
    invalidateGuardEndpointCache();
    const again = await pii.detectPii(TEXT, ['Person', WORDS], 0.7);
    assert.deepEqual(again.entities.map(e => e.text), ['Jan Jansen', 'Falcon']);
});

test('an old guard: no custom_labels sent, the ai ids degraded, the rest scanned', async () => {
    guard.version = '2.2.0';
    const r = await pii.detectPii(TEXT, ['Person', WORDS, AI], 0.7);
    assert.equal('custom_labels' in guard.bodies[0], false);
    assert.equal(r.degraded, true);
    assert.equal(r.degradedReason, 'custom_labels_unsupported');
    assert.deepEqual(r.degradedCategories, [AI]);
    assert.deepEqual(r.entities.map(e => e.text), ['Jan Jansen', 'Falcon']);
});

test('the version is read from a 503 /health too (model still loading)', async () => {
    guard.healthStatus = 503;
    await pii.detectPii(TEXT, [AI], 0.7);
    assert.ok(guard.bodies[0].custom_labels, 'custom_labels sent on the strength of the 503 body');
});

test('a 422 on custom_labels: one retry without them, ai degraded, breaker untouched, no text in the message', async () => {
    guard.reject422 = true;
    const warnings = [];
    const log = require('../../../telemetry/log');
    const orig = log.warn;
    log.warn = (...a) => { warnings.push(a.join(' ')); };
    try {
        for (let i = 0; i < 4; i++) {
            const r = await pii.detectPii(`${TEXT} ${i}`, ['Person', AI], 0.7);
            assert.equal(r.degradedReason, 'custom_labels_rejected');
            assert.deepEqual(r.degradedCategories, [AI]);
            assert.deepEqual(r.entities.map(e => e.text), ['Jan Jansen'], 'the retry still scanned the built-ins');
        }
    } finally { log.warn = orig; }
    assert.equal(circuitIsOpen(), false, 'four 422s in a row and the breaker is still shut');
    assert.ok(guard.healthHits >= 4, 'the version memo was cleared every time');
    const msg = warnings.find(w => w.includes('custom_labels'));
    assert.ok(msg && msg.includes('422') && msg.includes('extra_forbidden'), msg);
    assert.ok(!warnings.some(w => w.includes('Jan Jansen')), 'the guard\'s echo of the input never reaches a log line');
});

test('breaker open: degraded, the Node findings kept', async () => {
    noteGuardFailure(); noteGuardFailure(); noteGuardFailure();
    const r = await pii.detectPii(TEXT, ['Person', WORDS], 0.7);
    assert.equal(guard.bodies.length, 0);
    assert.equal(r.degraded, true);
    assert.equal(r.degradedReason, 'guard_circuit_open');
    assert.deepEqual(r.degradedCategories, ['Person']);
    assert.deepEqual(r.entities.map(e => e.text), ['Falcon']);
});

test('an unknown id is degraded, never silently skipped', async () => {
    const r = await pii.detectPii(TEXT, [WORDS, 'cdt_00000000ff'], 0.7);
    assert.equal(r.degraded, true);
    assert.equal(r.degradedReason, 'custom_type_unknown');
    assert.deepEqual(r.degradedCategories, ['cdt_00000000ff']);
    assert.deepEqual(r.entities.map(e => e.text), ['Falcon']);
});

test('an id two orgs list is degraded as a conflict, and runs neither org\'s matcher', async () => {
    registry.syncOrg('org2', [{ ...TYPES[0], name: 'Copied', words: { values: ['Osprey'], caseSensitive: false, wholeWord: true } }]);
    const r = await pii.detectPii('Falcon and Osprey', [WORDS], 0.7);
    assert.equal(r.degradedReason, 'custom_type_conflict');
    assert.deepEqual(r.degradedCategories, [WORDS]);
    assert.deepEqual(r.entities, []);
});

test('a changed word is a cache miss; an unchanged one is a hit', async () => {
    const text = 'Falcon and Osprey';
    const first = await pii.detectPii(text, [WORDS], 0.7);
    assert.deepEqual(first.entities.map(e => e.text), ['Falcon']);
    registry.syncOrg('org1', [{ ...TYPES[0], words: { ...TYPES[0].words, values: ['Falcon', 'Osprey'] } }, TYPES[1], TYPES[2]]);
    const second = await pii.detectPii(text, [WORDS], 0.7);
    assert.deepEqual(second.entities.map(e => e.text), ['Falcon', 'Osprey']);
    second.entities[0].text = 'mutated';
    const third = await pii.detectPii(text, [WORDS], 0.7);
    assert.equal(third.entities[0].text, 'Falcon', 'callers get clones, the cache stays pristine');
});

test('a big paste is windowed with the labels on every window; offsets stay absolute', async () => {
    const pad = 'x '.repeat(5000);
    const text = `${pad}Blue Heron ${pad}Falcon ${pad}Blue Heron`;
    const r = await pii.detectPii(text, ['Person', WORDS, AI], 0.7);
    assert.ok(guard.bodies.length > 1);
    assert.ok(guard.bodies.every(b => Array.isArray(b.custom_labels)));
    for (const e of r.entities) assert.equal(text.slice(e.offset, e.offset + e.length), e.text);
    assert.deepEqual(r.entities.map(e => e.text), ['Blue Heron', 'Falcon', 'Blue Heron']);
});

test('types passed in directly (the bench) are used instead of the registry', async () => {
    const r = await pii.detectPii('Osprey', [WORDS], 0.7, {
        customTypes: [{ ...TYPES[0], name: 'Draft', words: { values: ['Osprey'], caseSensitive: false, wholeWord: true } }],
    });
    assert.deepEqual(r.entities.map(e => [e.text, e.label]), [['Osprey', 'Draft']]);
});
