/**
 * The webpage_screenshot render (services/webpageRender.js) runs the author's
 * HTML/JS in the shared browser. Requests off the preview origin go through
 * the host screen: public hosts load, private and metadata addresses do not.
 *
 * Run: cd server && node --test services/webpageRender.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const webpageStore = require('../stores/webpageStore');
const browserProvider = require('./browserProvider');
const { captureWebpage } = require('./webpageRender');

test('captureWebpage screens every request off the preview origin before the page opens', async (t) => {
    const saved = {
        getWebpage: webpageStore.getWebpage,
        readAllSlots: webpageStore.readAllSlots,
        withContext: browserProvider.withContext,
    };
    t.after(() => {
        webpageStore.getWebpage = saved.getWebpage;
        webpageStore.readAllSlots = saved.readAllSlots;
        browserProvider.withContext = saved.withContext;
    });

    webpageStore.getWebpage = async (id, userId) => (id === 'wp-1' && userId === 'u1' ? { id: 'wp-1', settings: { framework: 'vanilla' } } : null);
    webpageStore.readAllSlots = async () => ({ html: '<img src="http://169.254.169.254/latest/meta-data/">', css: '', js: '' });

    const seen = { contextRoutes: [], routesBeforePage: -1 };
    browserProvider.withContext = async (_opts, fn) => fn({
        route: async (_m, h) => { seen.contextRoutes.push(h); },
        routeWebSocket: async () => {},
        newPage: async () => {
            seen.routesBeforePage = seen.contextRoutes.length;
            return {
                setDefaultTimeout() {}, on() {}, route: async () => {}, goto: async () => {},
                waitForFunction: async () => {}, waitForTimeout: async () => {},
                evaluate: async () => ({ childCount: 1, guardText: null }),
                screenshot: async () => Buffer.from('not-a-png'),
            };
        },
    });

    await captureWebpage({ webpageId: 'wp-1', userId: 'u1' });
    assert.equal(seen.routesBeforePage, 1, 'a context route is installed before newPage');

    const verdict = async (url) => {
        let out = null;
        await seen.contextRoutes[0]({
            request: () => ({ url: () => url }),
            continue: async () => { out = 'continue'; },
            abort: async () => { out = 'abort'; },
        });
        return out;
    };
    assert.equal(await verdict('http://169.254.169.254/latest/meta-data/'), 'abort');
    assert.equal(await verdict('http://127.0.0.1:9222/json'), 'abort');
    assert.equal(await verdict('http://192.168.1.1/'), 'abort');
    assert.equal(await verdict('https://93.184.216.34/react.js'), 'continue');
});
