/**
 * What the webpage bridge-grant routes accept, and what they say when they
 * refuse (routes/webpagesGrants.js).
 *
 * `fixedArgs` are the arguments an author pins so a visitor cannot choose them
 * — the channel, the recipient, the sheet — on a bridge that runs as the
 * author. A misspelled `fixedargs`, or the same object sent as a JSON string,
 * used to store the grant WITHOUT pins and answer `{ success: true }`. What this
 * file pins is the part a caller can act on:
 *
 *   - the 400 NAMES the field (`body.fixedArgs`), not just "invalid request";
 *   - the message is a sentence;
 *   - the grant is never written, so a refused request changes nothing.
 *
 * Run: cd server && node --test routes/webpagesGrants.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every grant write lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../stores/webpageStore': {
        getWebpage: async (id, userId) => { touched.push({ what: 'getWebpage', args: [id, userId] }); return { id, userId }; },
    },
    '../integrations/webpageGrants': {
        grantIntegration: async (p) => {
            touched.push({ what: 'grantIntegration', args: [p] });
            return { success: true, tool: p.tool, integrationId: 'slack', grants: {} };
        },
        grantAutomation: async (p) => {
            touched.push({ what: 'grantAutomation', args: [p] });
            return { success: true, automationId: p.automationId, title: 'A', grants: {} };
        },
        revokeIntegration: async () => ({ success: true, removed: null, grants: {} }),
        revokeAutomation: async () => ({ success: true, removed: null, grants: {} }),
        describeGrants: async () => ({}),
    },
    '../core/webpages/webpageBindings': { describePageActions: async () => ({}) },
    '../core/webpages/webpageDataCards': { buildDataCards: async () => ({}) },
    '../auth/permissions': { requireAuth: pass },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:webpages-grants-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]webpagesGrants\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./webpagesGrants');
test.after(() => { Module._resolveFilename = originalResolve; });

const { dispatcher } = require('../core/http/routeHarness');

const dispatch = dispatcher(router);

test.beforeEach(() => { touched.length = 0; });

async function refuses(request, field) {
    const res = await dispatch(request);
    assert.strictEqual(res.statusCode, 400, `${request.url} -> ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the grants');
    return res;
}

// ═══ POST /:id/grants/integrations ══════════════════════════════════

test('misspelled pins are refused, not stored as an unpinned grant', async () => {
    await refuses({
        method: 'POST', url: '/wp1/grants/integrations',
        body: { tool: 'slack_send_message', fixedargs: { channel: '#sales' } },
    }, 'body');
});

test('pins sent as a JSON string are refused in words, not dropped', async () => {
    const res = await refuses({
        method: 'POST', url: '/wp1/grants/integrations',
        body: { tool: 'slack_send_message', fixedArgs: '{"channel":"#sales"}' },
    }, 'body.fixedArgs');
    assert.match(res.body.error, /fixedArgs is a JSON object/);
});

test('pins sent as a list are refused — a list pins nothing', async () => {
    await refuses({
        method: 'POST', url: '/wp1/grants/integrations',
        body: { tool: 'slack_send_message', fixedArgs: ['#sales'] },
    }, 'body.fixedArgs');
});

test('a grant without a tool is refused in words, not with "Required"', async () => {
    const res = await refuses({ method: 'POST', url: '/wp1/grants/integrations', body: {} }, 'body.tool');
    assert.strictEqual(res.body.error, 'Name the integration action to grant (tool).');
});

test('the grant the Apps panel sends still arrives with its pins intact', async () => {
    const res = await dispatch({
        method: 'POST', url: '/wp1/grants/integrations',
        body: { tool: 'slack_send_message', fixedArgs: { channel: '#sales' }, label: 'Notify sales' },
    });
    assert.strictEqual(res.statusCode, 200);
    const args = touched.find((t) => t.what === 'grantIntegration').args[0];
    assert.strictEqual(args.tool, 'slack_send_message');
    assert.deepStrictEqual(args.fixedArgs, { channel: '#sales' });
    assert.strictEqual(args.label, 'Notify sales');
});

test('the bare grant the blueprint installer sends still works', async () => {
    const res = await dispatch({ method: 'POST', url: '/wp1/grants/integrations', body: { tool: 'gmail_search' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'grantIntegration').args[0].fixedArgs, undefined);
});

// ═══ POST /:id/grants/automations ═══════════════════════════════════

test('a misspelled automation id is refused, not answered "automationId is required" after the lookup', async () => {
    await refuses({ method: 'POST', url: '/wp1/grants/automations', body: { automationID: 'a1' } }, 'body');
});

test('an automation grant still reaches the grant function', async () => {
    const res = await dispatch({ method: 'POST', url: '/wp1/grants/automations', body: { automationId: 'a1' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'grantAutomation').args[0].automationId, 'a1');
});
