/**
 * What the promo-code admin routes accept, and what they say when they refuse
 * (routes/stripe/promoCodes.js).
 *
 * A promotion code discounts real invoices, and three of its fields were read
 * for truthiness only. `firstTimeOnly: 'false'` — the spelling a form-encoded
 * or hand-written client sends — passed through `!!` as TRUE, so the code was
 * created with the first_time_transaction restriction the admin had just
 * switched off, under a 200 reporting the code created. A misspelled key did
 * the same silently, and `?limit=-5` reached Stripe as a negative page size.
 *
 * Run: cd server && node --test routes/stripe/promoCodes.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every Stripe write lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../../services/stripeService': {
        isEnabled: async () => true,
        listPromoCodes: async (limit) => { touched.push({ what: 'listPromoCodes', args: [limit] }); return []; },
        createPromoCode: async (o) => { touched.push({ what: 'createPromoCode', args: [o] }); return { couponId: 'c1', promoCodeId: 'p1', code: o.code }; },
        deactivatePromoCode: async (id) => { touched.push({ what: 'deactivatePromoCode', args: [id] }); },
        activatePromoCode: async (id) => { touched.push({ what: 'activatePromoCode', args: [id] }); },
    },
    '../../stores/userStore': { logSubscriptionAudit: async () => {} },
    './shared': { requireCloud: pass, stripeIpLimiter: pass, stripeUserLimiter: pass },
    '../../auth/permissions': { hasPermission: async () => true },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:stripe-promocodes-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /stripe[\\/]promoCodes\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./promoCodes');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, query = {}, body = {} }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query, headers: {},
            session: { user: { id: 'admin', role: 'admin' }, isAuthenticated: true, isAdmin: true },
            get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

/** The editor's body, minus whatever this test wants to break. */
const validBody = (over = {}) => ({
    code: 'LAUNCH20', discountType: 'percent', discountValue: 20,
    currency: 'EUR', duration: 'once', firstTimeOnly: false, ...over,
});

test.beforeEach(() => { touched.length = 0; });

test("firstTimeOnly: 'false' is refused, instead of restricting the code it just switched off", async () => {
    const res = await dispatch({ method: 'POST', url: '/promo-codes', body: validBody({ firstTimeOnly: 'false' }) });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'firstTimeOnly is true or false.');
    assert.ok(res.body.details.some((d) => d.path === 'body.firstTimeOnly'));
    assert.deepStrictEqual(touched, [], 'no coupon was created');
});

test('a misspelled restriction key is refused rather than dropped in silence', async () => {
    const res = await dispatch({ method: 'POST', url: '/promo-codes', body: validBody({ firstTimeonly: true }) });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/firstTimeonly/.test(res.body.error), `the 400 names the key: ${res.body.error}`);
    assert.deepStrictEqual(touched, []);
});

test('a repeating discount without durationMonths is refused here, not by Stripe', async () => {
    const res = await dispatch({ method: 'POST', url: '/promo-codes', body: validBody({ duration: 'repeating' }) });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A repeating discount needs durationMonths.');
    assert.deepStrictEqual(touched, []);
});

test('an unknown duration is answered in words, not with Stripe internals', async () => {
    const res = await dispatch({ method: 'POST', url: '/promo-codes', body: validBody({ duration: 'forevr' }) });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'duration is once, repeating or forever.');
    assert.deepStrictEqual(touched, []);
});

test('the two old hand-written gates still refuse what they always refused', async () => {
    const missing = await dispatch({ method: 'POST', url: '/promo-codes', body: validBody({ code: '' }) });
    assert.strictEqual(missing.statusCode, 400);
    assert.strictEqual(missing.body.error, 'A promo code needs a code, e.g. LAUNCH20.');

    const over = await dispatch({ method: 'POST', url: '/promo-codes', body: validBody({ discountValue: 120 }) });
    assert.strictEqual(over.statusCode, 400);
    assert.strictEqual(over.body.error, 'A percentage discount cannot exceed 100%.');

    const zero = await dispatch({ method: 'POST', url: '/promo-codes', body: validBody({ discountValue: 0 }) });
    assert.strictEqual(zero.statusCode, 400);
    assert.strictEqual(zero.body.error, 'discountValue must be a positive number.');
    assert.deepStrictEqual(touched, []);
});

test('the editor body the admin console sends still reaches Stripe, trimmed', async () => {
    const res = await dispatch({
        method: 'POST', url: '/promo-codes',
        body: validBody({ code: '  SPRING  ', duration: 'repeating', durationMonths: 3, maxRedemptions: 50, firstTimeOnly: true }),
    });
    assert.strictEqual(res.statusCode, 200);
    const args = touched.find((t) => t.what === 'createPromoCode').args[0];
    assert.strictEqual(args.code, 'SPRING');
    assert.strictEqual(args.durationMonths, 3);
    assert.strictEqual(args.maxRedemptions, 50);
    assert.strictEqual(args.firstTimeOnly, true);
});

test('a negative page size is refused rather than handed to Stripe', async () => {
    const res = await dispatch({ method: 'GET', url: '/promo-codes', query: { limit: '-5' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'limit must be at least 1.');
    assert.deepStrictEqual(touched, []);
});

test('a non-numeric page size is refused, not silently turned into 25', async () => {
    const res = await dispatch({ method: 'GET', url: '/promo-codes', query: { limit: 'all' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'limit must be a number.');
    assert.deepStrictEqual(touched, []);
});

test('a page size above the ceiling is still clamped, not refused', async () => {
    const res = await dispatch({ method: 'GET', url: '/promo-codes', query: { limit: '500' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched[0].args, [100]);
});

test('no page size at all still reads the default page', async () => {
    const res = await dispatch({ method: 'GET', url: '/promo-codes', query: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched[0].args, [25]);
});

test('the activate/deactivate PUTs take only their path id and are unaffected', async () => {
    const res = await dispatch({ method: 'PUT', url: '/promo-codes/promo_1/deactivate' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched[0], { what: 'deactivatePromoCode', args: ['promo_1'] });
});
