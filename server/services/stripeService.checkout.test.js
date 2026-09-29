/**
 * BFSF-243 — hosted-checkout recurring-billing disclosure.
 *
 * Regression guard for the invalid `custom_text.submit_button` key that made
 * Stripe reject EVERY subscription Checkout Session (strict parameter
 * validation → invalid_request_error → 500 from POST /api/stripe/checkout).
 * The only valid CustomText key for the pay-button note is `submit`.
 *
 * We call the REAL createCheckoutSession with the `stripe` npm module and
 * ../stores/configStore stubbed via the require-cache trick (same seam as
 * routes/stripe.subscriptionDeleted.test.js). Consumer checkouts skip the
 * org customer-resolution block, so the fake client only needs
 * checkout.sessions.create.
 *
 * Run: cd server && node --test services/stripeService.checkout.test.js
 */

const assert = require('assert');
const { test } = require('node:test');

// ── Spy/fixture state ────────────────────────────────────────────────────────
const createdSessions = [];      // params passed to checkout.sessions.create
let configFixture = {};          // getConfig(key) fixture per test

function resetSpies() {
    createdSessions.length = 0;
    configFixture = { stripe_tax_enabled: false, stripe_tos_consent_enabled: false };
}

// ── Stub module-level deps BEFORE requiring the service ─────────────────────
function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

stub('../stores/configStore', {
    getSecret: async (key) => (key === 'stripe_secret_key' ? 'sk_test_fake' : null),
    getConfig: async (key) => configFixture[key],
});

// Fake Stripe SDK: a constructor whose instance records session params.
stub('stripe', function FakeStripe() {
    return {
        checkout: {
            sessions: {
                create: async (params) => {
                    createdSessions.push(params);
                    return { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/test' };
                },
            },
        },
    };
});

const stripeService = require('./stripeService');

// Minimal consumer-plan fixture; consumer checkouts skip org/VAT resolution.
function plan(extra = {}) {
    return {
        id: 'plan_launch',
        stripe_price_id: 'price_123',
        billing_interval: 'monthly',
        trial_days: 0,
        per_seat: false,
        ...extra,
    };
}

async function checkout(planOverrides = {}) {
    await stripeService.createCheckoutSession({
        plan: plan(planOverrides),
        subscriberType: 'consumer',
        userId: 'user_1',
        userEmail: 'user@example.com',
        successUrl: 'https://app.example/success',
        cancelUrl: 'https://app.example/cancel',
    });
    assert.strictEqual(createdSessions.length, 1, 'exactly one session created');
    return createdSessions[0];
}

// ═══════════════════════════════════════════════════════════════════════════

test('monthly plan: custom_text.submit carries the incasso disclosure (no submit_button)', async () => {
    resetSpies();
    const params = await checkout();

    // THE regression guard: only the valid key, never submit_button.
    assert.deepStrictEqual(Object.keys(params.custom_text), ['submit'],
        'custom_text must contain exactly the valid `submit` key');
    const msg = params.custom_text.submit.message;
    assert.ok(msg && msg.length > 0, 'disclosure message is non-empty');
    assert.ok(msg.includes('automatische incasso'), 'NL incasso wording present');
    assert.ok(msg.includes('Maandabonnement'), 'monthly NL wording');
    assert.ok(msg.includes('monthly'), 'monthly EN wording');
    assert.ok(!msg.includes('Jaarabonnement'), 'no yearly wording on a monthly plan');
    assert.ok(msg.length < 1200, 'under Stripe custom_text 1200-char limit');
    assert.strictEqual(params.locale, 'auto', 'hosted page follows the browser locale');
});

test('yearly plan: disclosure is interval-aware', async () => {
    resetSpies();
    const params = await checkout({ billing_interval: 'yearly' });

    const msg = params.custom_text.submit.message;
    assert.ok(msg.includes('Jaarabonnement'), 'yearly NL wording');
    assert.ok(msg.includes('yearly'), 'yearly EN wording');
    assert.ok(!msg.includes('Maandabonnement'), 'no monthly wording on a yearly plan');
});

test('consent_collection only when stripe_tos_consent_enabled is set', async () => {
    resetSpies();
    let params = await checkout();
    assert.strictEqual(params.consent_collection, undefined,
        'no ToS consent by default (Stripe hard-fails without a Dashboard ToS URL)');

    resetSpies();
    configFixture.stripe_tos_consent_enabled = true;
    params = await checkout();
    assert.deepStrictEqual(params.consent_collection, { terms_of_service: 'required' },
        'flag enables the ToS consent checkbox');
});

test('session shape stays intact around the disclosure', async () => {
    resetSpies();
    const params = await checkout();
    assert.strictEqual(params.mode, 'subscription');
    assert.deepStrictEqual(params.line_items, [{ price: 'price_123', quantity: 1 }]);
    assert.strictEqual(params.customer_email, 'user@example.com');
    assert.strictEqual(params.allow_promotion_codes, true);
});
