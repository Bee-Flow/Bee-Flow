'use strict';
/**
 * The test bench's probe of the model, the guard version check, and what a
 * failed guard call may say about itself.
 *
 * Run: cd server && node --test core/privacy/customTypes/probe.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { probeGuard } = require('./probe');
const { compareVersions } = require('./guardCapabilities');
const { _describeFailure } = require('../piiDetection/guardClient');

const endpoint = { url: 'http://guard.test', apiKey: 'k' };
const deps = (over = {}) => ({
    getGuardEndpoint: async () => endpoint,
    supportsCustomLabels: async () => true,
    probeViaGuard: async () => ({ candidates: [{ text_idx: 0, label: 'cdt_00000000a1', start: 3, end: 11, score: 0.83 }], model_ready: true }),
    ...over,
});

test('candidates come back as the guard sent them, malformed ones dropped', async () => {
    const r = await probeGuard(['a text'], { cdt_00000000a1: 'code name' }, {
        deps: deps({
            probeViaGuard: async (ep, texts, labels, priority) => {
                assert.equal(priority, 'bulk', 'the bench queues behind interactive chat');
                assert.deepEqual(labels, { cdt_00000000a1: 'code name' });
                return { candidates: [{ text_idx: 0, label: 'cdt_00000000a1', start: 3, end: 11, score: 0.83 }, { text_idx: 'x' }, { text_idx: 0, label: 'l', start: 5, end: 5, score: 1 }] };
            },
        }),
    });
    assert.deepEqual(r, { candidates: [{ text_idx: 0, label: 'cdt_00000000a1', start: 3, end: 11, score: 0.83 }] });
});

test('every way the answer cannot be had is a 503 guard_unavailable', async () => {
    const cases = [
        deps({ getGuardEndpoint: async () => ({ url: null }) }),
        deps({ supportsCustomLabels: async () => false }),
        deps({ probeViaGuard: async () => { throw Object.assign(new Error('guard-service /pii/probe returned 503'), { status: 503 }); } }),
        deps({ probeViaGuard: async () => { throw new Error('ECONNREFUSED'); } }),
        deps({ probeViaGuard: async () => ({ candidates: [], model_ready: false }) }),
    ];
    for (const d of cases) {
        await assert.rejects(probeGuard(['t'], { cdt_00000000a1: 'x' }, { deps: d }), (err) => {
            assert.equal(err.status, 503);
            assert.equal(err.code, 'guard_unavailable');
            assert.ok(!/ECONNREFUSED/.test(err.message), 'no transport detail in the admin\'s message');
            return true;
        });
    }
});

test('versions compare numerically', () => {
    assert.equal(compareVersions('2.3.0', '2.3.0'), 0);
    assert.equal(compareVersions('2.10.0', '2.3.0'), 1);
    assert.equal(compareVersions('2.2.9', '2.3.0'), -1);
    assert.equal(compareVersions('3', '2.3.0'), 1);
    assert.equal(compareVersions(null, '2.3.0'), -1);
});

test('a failed guard response is described by status, error types and locations, never by its body', () => {
    const body = JSON.stringify({ detail: [{ type: 'extra_forbidden', loc: ['body', 'custom_labels'], msg: 'Extra inputs', input: 'Jan Jansen woont op de Dorpsstraat 1' }] });
    const d = _describeFailure(422, body);
    assert.deepEqual(d, { types: ['extra_forbidden'], locs: ['body.custom_labels'] });
    assert.ok(!JSON.stringify(d).includes('Jansen'));
    assert.deepEqual(_describeFailure(500, 'Traceback: secret text'), { types: [], locs: [] });
});
