/**
 * A public (anonymous) app never runs the KB query log steps, whatever its published definition holds.
 * A neighbouring step kind still gets past that gate (it reaches the data context), so the refusal is
 * about the kind and not about the harness.
 *
 * Run: cd server && node --test routes/studioAppPublic.kbLog.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../testUtils/routeHarness');
const { issueVisitorToken } = require('../auth/publicShareToken');

const { api } = h.routeUnderTest(test, '/api/public-app', () => {
    const studioAppStore = require('../stores/studioAppStore');
    const publicAccess = require('../appStudio/publicAccess');
    const st = (value) => ({ kind: 'static', value });
    const definition = {
        actions: {
            a1: { kind: 'sequence', steps: [
                { kind: 'kb_log_query', kbId: st('k'), resultVar: 'q' },
                { kind: 'kb_log_review', kbId: st('k'), entryId: st('e'), status: st('reviewed') },
                { kind: 'toast', message: 'x' },
            ] },
        },
    };
    test.mock.method(studioAppStore, 'getPublicPage', async () => ({ appId: 'app1' }));
    test.mock.method(studioAppStore, 'getStudioApp', async () => ({ id: 'app1', userId: 'owner', isPublished: true, publishedDefinition: definition }));
    test.mock.method(publicAccess, 'resolvePublicSurface', () => ({ ok: true, actionIds: new Set(['a1']) }));
    return require('./studioAppPublic');
}, { gates: false, user: null });

const PAGE = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6';
const visitor = { authorization: `Bearer ${issueVisitorToken({ pageToken: PAGE, appId: 'app1', viewerId: 'anon-1' })}` };
const step = (stepIndex) => api.call('POST', `/api/public-app/${PAGE}/actions/a1/step`, { body: { stepIndex, formValues: {}, vars: {} }, headers: visitor });

test('kb_log_query and kb_log_review are refused on a public app', async () => {
    for (const i of [0, 1]) {
        const res = await step(i);
        assert.strictEqual(res.status, 403, res.text);
        assert.match(res.text, /not available on a public app/);
    }
});

test('a client-only step is stopped by the earlier server-kind gate, not by the KB log refusal', async () => {
    const res = await step(2);
    assert.strictEqual(res.status, 400, res.text);
});
