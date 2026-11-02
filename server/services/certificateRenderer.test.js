// @typecheck
/**
 * A certificate render context has no network: the HTML is self-contained, so
 * every request other than data:/about:/blob: is refused before the page loads
 * (the same block as the other PDF paths).
 *
 * Run: cd server && node --test services/certificateRenderer.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeSwaps } = require('../testUtils/swaps');
const browserProvider = require('./browserProvider');

/** @type {string[]} */
const events = [];
/** @type {Array<(route: any) => unknown>} */
const handlers = [];

const fakeContext = {
    route: async (/** @type {string} */ _pattern, /** @type {any} */ handler) => { events.push('route'); handlers.push(handler); },
    routeWebSocket: async () => { events.push('routeWebSocket'); },
    newPage: async () => {
        events.push('newPage');
        return {
            setContent: async () => { events.push('setContent'); },
            screenshot: async () => Buffer.from('png'),
            pdf: async () => Buffer.from('pdf'),
        };
    },
};

const { swap, restore } = makeSwaps();
swap(browserProvider, 'withContext', async (/** @type {unknown} */ _opts, /** @type {(c: any) => unknown} */ fn) => fn(fakeContext));
test.after(() => restore());

const { renderCertificatePng, renderCertificatePdf } = require('./certificateRenderer');

const RECORD = { recipientName: 'Test Person', title: 'Course', serial: 'S-1', issuedAt: '2026-01-01' };

for (const [label, render] of /** @type {const} */ ([['png', renderCertificatePng], ['pdf', renderCertificatePdf]])) {
    test(`${label}: the network is blocked before the page is created`, async () => {
        events.length = 0;
        handlers.length = 0;
        await render(RECORD);
        assert.deepStrictEqual(events.slice(0, 3), ['route', 'routeWebSocket', 'newPage']);

        /** @type {string[]} */
        const outcomes = [];
        const route = (/** @type {string} */ url) => ({
            request: () => ({ url: () => url }),
            continue: () => { outcomes.push(`continue ${url}`); },
            abort: () => { outcomes.push(`abort ${url}`); },
        });
        await handlers[0](route('http://169.254.169.254/latest/'));
        await handlers[0](route('data:image/png;base64,AA=='));
        assert.deepStrictEqual(outcomes, ['abort http://169.254.169.254/latest/', 'continue data:image/png;base64,AA==']);
    });
}
