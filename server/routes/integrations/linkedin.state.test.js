'use strict';
/**
 * The LinkedIn callback's CSRF state is checked like the other providers'
 * and spent on first use (routes/integrations/linkedin.js).
 *
 * Run: cd server && node --test routes/integrations/linkedin.state.test.js
 */
process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// The route reads its client id and secret through the config store at call
// time, so the real module is patched in place (and put back after the run).
const configStore = require('../../stores/configStore');
const log = require('../../telemetry/log');
const originals = { getSecret: configStore.getSecret, setSecret: configStore.setSecret, setConfig: configStore.setConfig, error: log.error, info: log.info };
configStore.getSecret = async () => 'configured';
configStore.setSecret = async () => {};
configStore.setConfig = async () => {};
log.error = () => {};
log.info = () => {};
test.after(() => { Object.assign(configStore, { getSecret: originals.getSecret, setSecret: originals.setSecret, setConfig: originals.setConfig }); Object.assign(log, { error: originals.error, info: originals.info }); });

const router = require('./linkedin');
const { dispatcher } = require('../../testUtils/routeHarness');
const dispatch = dispatcher(router);
const session = (extra = {}) => ({ user: { id: 'u1' }, save() {}, ...extra });
const refused = (res) => typeof res.body === 'string' && res.body.includes('Invalid state parameter');

test('a callback with no state against a session that holds none is refused, not matched', async () => {
    const res = await dispatch({ method: 'GET', url: '/callback?code=abc', session: session() });
    assert.equal(refused(res), true, 'undefined === undefined used to pass the check');
});

test('a state that differs is refused and the expected one is spent either way', async () => {
    const s = session({ linkedinState: 'expected', linkedinRedirectUri: 'https://app.example/cb' });
    const res = await dispatch({ method: 'GET', url: '/callback?code=abc&state=other', session: s });
    assert.equal(refused(res), true);
    assert.equal(s.linkedinState, undefined, 'one shot: the state leaves the session on first use');
    assert.equal(s.linkedinRedirectUri, undefined);
    const again = await dispatch({ method: 'GET', url: '/callback?code=abc&state=expected', session: s });
    assert.equal(refused(again), true, 'the state cannot be presented after it was spent');
});

test('the matching state is spent before the exchange, so a replay of the same callback is refused', async () => {
    const s = session({ linkedinState: 'expected', linkedinRedirectUri: 'https://app.example/cb' });
    const realFetch = global.fetch;
    let exchanges = 0;
    // The exchange itself is not under test: it fails fast and the route answers its failure page.
    global.fetch = async () => { exchanges++; return { ok: false, status: 503, text: async () => 'down' }; };
    try {
        const first = await dispatch({ method: 'GET', url: '/callback?code=abc&state=expected', session: s });
        assert.equal(refused(first), false, 'the state matched');
        assert.equal(exchanges, 1);
        assert.equal(s.linkedinState, undefined);
        const replay = await dispatch({ method: 'GET', url: '/callback?code=abc&state=expected', session: s });
        assert.equal(refused(replay), true);
        assert.equal(exchanges, 1, 'no second exchange');
    } finally { global.fetch = realFetch; }
});
