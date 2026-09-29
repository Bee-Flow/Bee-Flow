/**
 * accountProvisioning — the shared org/consumer signup path.
 *
 * These lock in the behaviours that had drifted between the password route and
 * the OAuth callback before the two were merged onto this module: the org
 * feature flag, hard failure (not a warning) on a taken name/domain, the
 * free-email domain exemption, and exactly one trial grant on the right target.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// ── Stub every collaborator before requiring the module under test ──
const stubs = {
    config: new Map(),
    orgs: [],
    createdOrgs: [],
    createOrganizationResult: true,
    webSignupGate: { ok: true },
    setConfigCalls: [],
    setOrgSubscriptionCalls: [],
    trialCalls: [],
    updatedUsers: [],
    audits: [],
    // What sendVerificationEmail does: resolve with a result or throw.
    verificationSend: async () => ({ success: true }),
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    switch (request) {
        case '../stores/configStore':
            return {
                getConfig: async (k) => stubs.config.get(k),
                setConfig: async (k, v) => { stubs.setConfigCalls.push({ key: k, value: v }); },
            };
        case '../stores/userStore':
            return {
                getAllOrganizations: async () => stubs.orgs,
                getOrganization: async (id) => stubs.orgs.find(o => o.id === id) || null,
                createOrganization: async (org, opts) => {
                    stubs.createdOrgs.push({ org, opts });
                    return stubs.createOrganizationResult;
                },
                setOrgSubscription: async (...a) => { stubs.setOrgSubscriptionCalls.push(a); return true; },
                updateUser: async (id, u) => { stubs.updatedUsers.push({ id, updates: u }); return true; },
                claimNotification: async () => false,
                logAccessAudit: async (action, _type, _id, _actor, _ip, details) => { stubs.audits.push({ action, details }); },
            };
        case './signupGuards':
            return {
                checkWebSignupAllowed: async () => stubs.webSignupGate,
                resolveSignupLocale: async () => 'en',
            };
        case '../utils/freeEmailDomains':
            return {
                isFreeEmailDomain: (d, list) => list.includes(d),
                getEffectiveFreeEmailDomains: async () => ['gmail.com', 'outlook.com'],
            };
        case '../services/trialService':
            return {
                maybeAutoGrantOrgTrial: (id) => stubs.trialCalls.push({ org: id }),
                maybeAutoGrantConsumerTrial: (id) => stubs.trialCalls.push({ user: id }),
            };
        case '../core/privacy/signupShield':
            return { buildSignupShieldConfig: () => ({ piiDetectionCategories: ['email'], piiDetectionAction: 'block' }) };
        case '../core/privacy/userShieldDefaults':
            return { buildUserShieldConfig: () => ({ enabled: true, piiDetectionAction: 'tokenize', piiDetectionCategories: [] }) };
        case '../utils/emailService':
            return { getServiceEmailConfig: async () => ({ configured: true }), sendWelcomeEmail: async () => {}, sendVerificationEmail: (opts) => stubs.verificationSend(opts) };
        case '../stores/invitationStore':
            return { markAccepted: async () => true };
        default:
            return originalLoad(request, parent, isMain);
    }
};

// The interception stays in place for the whole file: finalizeAccount resolves
// trialService, the shield builders and emailService lazily (the codebase's
// convention for avoiding circular requires), so restoring the loader after the
// initial require would let those calls reach the real modules.
const ap = require('./accountProvisioning');

const REQ = { headers: {}, session: {} };

beforeEach(() => {
    stubs.config = new Map([['signup_org_enabled', true], ['signup_consumer_enabled', true]]);
    stubs.orgs = [];
    stubs.createdOrgs = [];
    stubs.createOrganizationResult = true;
    stubs.webSignupGate = { ok: true };
    stubs.recordedConsent = [];
    stubs.setConfigCalls = [];
    stubs.setOrgSubscriptionCalls = [];
    stubs.trialCalls = [];
    stubs.updatedUsers = [];
    stubs.audits = [];
    stubs.verificationSend = async () => ({ success: true });
    delete process.env.ALLOW_SIGNUPS;
    process.env.DEPLOYMENT_MODE = 'cloud';
});

describe('normalizeSignupIntent', () => {
    test('a new org name wins over everything', () => {
        const i = ap.normalizeSignupIntent({ newOrgName: 'Acme', organizationId: 'other' });
        assert.equal(i.accountType, 'organization');
    });

    test('an explicit organizationId is a join', () => {
        assert.equal(ap.normalizeSignupIntent({ organizationId: 'acme' }).accountType, 'join_existing');
    });

    test('an invite is a join, and carries its data', () => {
        const inviteData = { organization_id: 'acme', role: 'member' };
        const i = ap.normalizeSignupIntent({}, { inviteData, inviteToken: 'tok' });
        assert.equal(i.accountType, 'join_existing');
        assert.equal(i.organizationId, 'acme');
        assert.equal(i.invite.token, 'tok');
    });

    test('no org in cloud mode is a consumer account', () => {
        assert.equal(ap.normalizeSignupIntent({}).accountType, 'consumer');
    });

    test('no org on self-hosted is rejected — there is no consumer account there', () => {
        process.env.DEPLOYMENT_MODE = 'self-hosted';
        assert.throws(() => ap.normalizeSignupIntent({}), (e) => e.code === 'ORG_REQUIRED' && e.status === 400);
    });
});

describe('slugifyOrgId', () => {
    for (const [input, expected] of [
        ['Acme B.V.', 'acme-b-v'],
        ['  Leading & trailing  ', 'leading-trailing'],
        ['ALLCAPS', 'allcaps'],
        ['a--b', 'a-b'],
    ]) {
        test(`${JSON.stringify(input)} → ${expected}`, () => {
            assert.equal(ap.slugifyOrgId(input), expected);
        });
    }

    test('a long name is capped, and two long names are still two organisations', () => {
        // An org id is concatenated into Postgres identifiers, config keys and
        // cache keys, and Postgres truncates every identifier to 63 bytes —
        // quoted or not. Two ids sharing a long prefix then address the SAME
        // schema, the same config row, the same cache entry.
        const shared = 'Stichting Vrienden van het Nederlands Openluchtmuseum Locatie';
        const a = ap.slugifyOrgId(`${shared} Noord`);
        const b = ap.slugifyOrgId(`${shared} Zuid`);
        assert.ok(a.length <= ap.MAX_ORG_ID_LENGTH, `${a} is ${a.length}`);
        assert.ok(b.length <= ap.MAX_ORG_ID_LENGTH, `${b} is ${b.length}`);
        assert.notEqual(a, b, 'a plain truncation would merge these two into one organisation');
        assert.match(a, /^[a-z0-9-]+$/, 'the slug rule itself is unchanged');
    });

    test('the cap is stable — the same name always mints the same id', () => {
        // The suffix is derived from the WHOLE slug, so signing up twice with
        // the same long name still collides (which ORG_NAME_TAKEN is for)
        // instead of quietly minting a second organisation.
        const name = 'A very long organisation name that runs well past the forty-eight character cap';
        assert.equal(ap.slugifyOrgId(name), ap.slugifyOrgId(name));
    });

    test('a name at the cap is left exactly as the old rule produced it', () => {
        // Existing org ids depend on the slug rule verbatim; the cap may only
        // change ids that were already too long to be safe.
        const short = 'x'.repeat(ap.MAX_ORG_ID_LENGTH);
        assert.equal(ap.slugifyOrgId(short), short);
    });
});

describe('assertDomainAvailable', () => {
    test('a free email domain can never be taken', async () => {
        stubs.orgs = [{ id: 'x', email: 'someone@gmail.com' }];
        await ap.assertDomainAvailable('founder@gmail.com'); // must not throw
    });

    test('a corporate domain already used as an org contact is refused', async () => {
        stubs.orgs = [{ id: 'x', email: 'info@acme.com' }];
        await assert.rejects(() => ap.assertDomainAvailable('founder@acme.com'),
            (e) => e.code === 'ORG_DOMAIN_TAKEN' && e.status === 400);
    });

    test('a domain claimed via allowedDomains is refused', async () => {
        stubs.orgs = [{ id: 'x', email: '', allowedDomains: ['acme.com'] }];
        await assert.rejects(() => ap.assertDomainAvailable('founder@acme.com'),
            (e) => e.code === 'ORG_DOMAIN_TAKEN');
    });

    test('an unclaimed corporate domain passes', async () => {
        stubs.orgs = [{ id: 'x', email: 'info@other.com' }];
        await ap.assertDomainAvailable('founder@acme.com');
    });

    // M-04: the refusal used to answer anonymous callers with
    // 'An organization with the domain "acme.com" already exists', which let
    // anyone probe arbitrary company domains for Bee Flow customers.
    test('the refusal never names the domain or confirms anything exists', async () => {
        stubs.orgs = [{ id: 'acme-bv', name: 'Acme BV', email: 'info@acme.com' }];
        await assert.rejects(() => ap.assertDomainAvailable('founder@acme.com'), (e) => {
            assert.ok(!/acme/i.test(e.message), `message leaks the domain/org: ${e.message}`);
            assert.ok(!/already exists/i.test(e.message), `message confirms existence: ${e.message}`);
            return true;
        });
    });

    test('the org identity travels on the error object, never in the HTTP body', async () => {
        stubs.orgs = [{ id: 'acme-bv', name: 'Acme BV', email: 'info@acme.com' }];
        await assert.rejects(() => ap.assertDomainAvailable('founder@acme.com'), (e) => {
            // The route needs these to send the "you already have an org" mail…
            assert.equal(e.existingOrganizationId, 'acme-bv');
            assert.equal(e.domain, 'acme.com');
            // …and toResponse() is what reaches the caller, so it must be clean.
            const body = JSON.stringify(e.toResponse());
            assert.ok(!/acme/i.test(body), `response body leaks the org: ${body}`);
            return true;
        });
    });
});

describe('assertRegistrationNumbersValid', () => {
    // The pentest submitted KvK 12345678 and VAT NL123456789B01 and both were
    // accepted, because neither field was ever checked.
    test('an 8-digit run is not a KvK number', () => {
        assert.throws(() => ap.assertRegistrationNumbersValid({ kvk: '12345678' }), (e) => e.code === 'ORG_REGISTRATION_INVALID');
        assert.throws(() => ap.assertRegistrationNumbersValid({ kvk: '11111111' }), (e) => e.code === 'ORG_REGISTRATION_INVALID');
    });

    test('a KvK number must be exactly 8 digits', () => {
        assert.throws(() => ap.assertRegistrationNumbersValid({ kvk: '1234567' }), (e) => e.code === 'ORG_REGISTRATION_INVALID');
        assert.throws(() => ap.assertRegistrationNumbersValid({ kvk: 'KVK12345678' }), (e) => e.code === 'ORG_REGISTRATION_INVALID');
        ap.assertRegistrationNumbersValid({ kvk: '69599084' });   // must not throw
        ap.assertRegistrationNumbersValid({ kvk: '695 990 84' }); // spaces tolerated
    });

    test('a Dutch VAT number must match NL + 9 digits + B + 2', () => {
        ap.assertRegistrationNumbersValid({ vat: 'NL857912345B01' });
        assert.throws(() => ap.assertRegistrationNumbersValid({ vat: 'NL1234B01' }), (e) => e.code === 'ORG_REGISTRATION_INVALID');
        assert.throws(() => ap.assertRegistrationNumbersValid({ vat: '123456789' }), (e) => e.code === 'ORG_REGISTRATION_INVALID');
    });

    test('non-Dutch VAT numbers are only shape-checked — other member states have other layouts', () => {
        ap.assertRegistrationNumbersValid({ vat: 'BE0123456789' });
        ap.assertRegistrationNumbersValid({ vat: 'DE123456789' });
        assert.throws(() => ap.assertRegistrationNumbersValid({ vat: '!!' }), (e) => e.code === 'ORG_REGISTRATION_INVALID');
    });

    test('empty values are allowed — the fields are optional outside the Netherlands', () => {
        ap.assertRegistrationNumbersValid({});
        ap.assertRegistrationNumbersValid({ kvk: '', vat: '' });
        ap.assertRegistrationNumbersValid({ kvk: null, vat: undefined });
    });
});

describe('prepareAccountPlacement — organisation', () => {
    const intent = () => ap.normalizeSignupIntent({ newOrgName: 'Acme', email: 'f@acme.com' });

    test('the founder lands as org_admin of the slugified org', async () => {
        const p = await ap.prepareAccountPlacement(intent(), { req: REQ });
        assert.equal(p.organizationId, 'acme');
        assert.equal(p.orgRole, 'org_admin');
        assert.equal(p.status, 'active');
        assert.equal(p.orgCreated, true);
    });

    test('signup_org_enabled=false is enforced — this is the check the OAuth path used to skip', async () => {
        stubs.config.set('signup_org_enabled', false);
        await assert.rejects(() => ap.prepareAccountPlacement(intent(), { req: REQ }),
            (e) => e.code === 'ORG_SIGNUPS_DISABLED' && e.status === 403);
    });

    test('a taken org name throws instead of warning — the founder is never left org-less', async () => {
        stubs.createOrganizationResult = false;
        await assert.rejects(() => ap.prepareAccountPlacement(intent(), { req: REQ }),
            (e) => e.code === 'ORG_NAME_TAKEN' && e.status === 400);
    });

    test('the trial is suppressed in the store so finalizeAccount can own it', async () => {
        await ap.prepareAccountPlacement(intent(), { req: REQ });
        assert.equal(stubs.createdOrgs[0].opts.autoGrantTrial, false);
    });

    test('the module never assigns a subscription plan — createOrganization owns that', async () => {
        await ap.prepareAccountPlacement(intent(), { req: REQ });
        assert.equal(stubs.setOrgSubscriptionCalls.length, 0);
    });

    test('founders bypass the waitlist', async () => {
        stubs.config.set('signup_waitlist_enabled', true);
        const p = await ap.prepareAccountPlacement(intent(), { req: REQ });
        assert.equal(p.status, 'active');
    });
});

describe('prepareAccountPlacement — consumer', () => {
    const intent = () => ap.normalizeSignupIntent({});

    test('lands with no organisation at all', async () => {
        const p = await ap.prepareAccountPlacement(intent(), { req: REQ });
        assert.equal(p.organizationId, null);
        assert.equal(p.status, 'active');
        assert.equal(p.orgCreated, false);
        assert.deepEqual(p.groups, []);
    });

    test('signup_consumer_enabled=false is enforced', async () => {
        stubs.config.set('signup_consumer_enabled', false);
        await assert.rejects(() => ap.prepareAccountPlacement(intent(), { req: REQ }),
            (e) => e.code === 'CONSUMER_SIGNUPS_DISABLED' && e.status === 403);
    });

    test('consumer signups are gated by the waitlist', async () => {
        stubs.config.set('signup_waitlist_enabled', true);
        const p = await ap.prepareAccountPlacement(intent(), { req: REQ });
        assert.equal(p.status, 'waitlist');
    });
});

describe('prepareAccountPlacement — join existing', () => {
    beforeEach(() => { stubs.orgs = [{ id: 'acme', name: 'Acme', allowSignup: false, defaultGroups: ['g1'] }]; });

    test('an unknown org is refused', async () => {
        const i = ap.normalizeSignupIntent({ organizationId: 'nope' });
        await assert.rejects(() => ap.prepareAccountPlacement(i, { req: REQ }),
            (e) => e.code === 'ORG_NOT_FOUND');
    });

    test('self-signup into an org that does not allow it lands pending, with no groups', async () => {
        const i = ap.normalizeSignupIntent({ organizationId: 'acme' });
        const p = await ap.prepareAccountPlacement(i, { req: REQ });
        assert.equal(p.status, 'pending');
        assert.deepEqual(p.groups, []);
    });

    test('an invited user is active, gets the default groups and the invited role', async () => {
        const i = ap.normalizeSignupIntent({}, {
            inviteData: { organization_id: 'acme', role: 'org_admin' }, inviteToken: 'tok',
        });
        const p = await ap.prepareAccountPlacement(i, { req: REQ });
        assert.equal(p.status, 'active');
        assert.equal(p.orgRole, 'org_admin');
        assert.deepEqual(p.groups, ['g1']);
    });

    test('invited users bypass the waitlist', async () => {
        stubs.config.set('signup_waitlist_enabled', true);
        const i = ap.normalizeSignupIntent({}, { inviteData: { organization_id: 'acme' }, inviteToken: 't' });
        assert.equal((await ap.prepareAccountPlacement(i, { req: REQ })).status, 'active');
    });
});

describe('shared guards', () => {
    test('ALLOW_SIGNUPS=false blocks every account type', async () => {
        process.env.ALLOW_SIGNUPS = 'false';
        for (const source of [{ newOrgName: 'Acme' }, {}]) {
            await assert.rejects(() => ap.prepareAccountPlacement(ap.normalizeSignupIntent(source), { req: REQ }),
                (e) => e.code === 'SIGNUPS_DISABLED' && e.status === 403);
        }
    });

    test('the connector-only gate propagates its status and code', async () => {
        stubs.webSignupGate = { ok: false, status: 403, error: 'nope', code: 'CONNECTOR_ONLY' };
        const e = await ap.prepareAccountPlacement(ap.normalizeSignupIntent({}), { req: REQ }).catch(x => x);
        assert.equal(e.code, 'CONNECTOR_ONLY');
        assert.equal(e.oauthCode, 'signup_connector_only');
        assert.deepEqual(e.toResponse(), { error: 'nope', code: 'CONNECTOR_ONLY' });
    });

    test('an invited user bypasses the connector-only gate', async () => {
        stubs.webSignupGate = { ok: false, status: 403, error: 'nope', code: 'CONNECTOR_ONLY' };
        stubs.orgs = [{ id: 'acme', allowSignup: true, defaultGroups: [] }];
        const i = ap.normalizeSignupIntent({}, { inviteData: { organization_id: 'acme' }, inviteToken: 't' });
        assert.equal((await ap.prepareAccountPlacement(i, { req: REQ })).status, 'active');
    });

});

describe('finalizeAccount', () => {
    const run = async (source, placementOverrides = {}) => {
        const intent = ap.normalizeSignupIntent(source);
        const placement = { ...await ap.prepareAccountPlacement(intent, { req: REQ }), ...placementOverrides };
        const req = { headers: {}, session: {} };
        await ap.finalizeAccount({ userId: 'u1', email: 'u@x.com', displayName: 'U', intent, placement, req });
        return { intent, placement, req };
    };

    test('an org founder gets exactly one org trial and no consumer trial', async () => {
        await run({ newOrgName: 'Acme', email: 'f@acme.com' });
        await new Promise(r => setImmediate(r));
        assert.deepEqual(stubs.trialCalls, [{ org: 'acme' }]);
    });

    test('a consumer gets exactly one consumer trial', async () => {
        await run({});
        await new Promise(r => setImmediate(r));
        assert.deepEqual(stubs.trialCalls, [{ user: 'u1' }]);
    });

    test('a member joining an existing org gets no trial — the org already has one', async () => {
        stubs.orgs = [{ id: 'acme', allowSignup: true, defaultGroups: [] }];
        await run({ organizationId: 'acme' });
        await new Promise(r => setImmediate(r));
        assert.deepEqual(stubs.trialCalls, []);
    });

    test('an org founder gets an org-scoped shield key', async () => {
        await run({ newOrgName: 'Acme', email: 'f@acme.com' });
        assert.ok(stubs.setConfigCalls.some(c => c.key === 'org_privacy_shield_acme'));
    });

    test('a consumer gets a user-scoped shield key', async () => {
        await run({});
        assert.ok(stubs.setConfigCalls.some(c => c.key === 'user_privacy_shield_u1'));
    });

    test('a member joining an existing org gets no shield of their own', async () => {
        stubs.orgs = [{ id: 'acme', allowSignup: true, defaultGroups: [] }];
        await run({ organizationId: 'acme' });
        assert.ok(!stubs.setConfigCalls.some(c => c.key.includes('privacy_shield')));
    });

    test('no parallel onboarding record is written — OnboardingTour owns that state', async () => {
        await run({});
        assert.ok(!stubs.setConfigCalls.some(c => c.key.startsWith('user_onboarding_')));
    });

    test('a plan chosen during signup is stashed for post-login checkout', async () => {
        const { req } = await run({ selectedPlanId: 'plan_pro' });
        assert.equal(req.session.pendingCheckoutPlanId, 'plan_pro');
    });

    test('no plan chosen leaves nothing stashed', async () => {
        const { req } = await run({});
        assert.equal(req.session.pendingCheckoutPlanId, undefined);
    });
});

describe('finalizeAccount — the verification email audit', () => {
    // The send is not awaited by the signup; one macrotask lets it settle.
    const settle = () => new Promise(r => setImmediate(r));
    const verificationAudits = () => stubs.audits.filter(a => a.action.startsWith('user.email_verification'));
    const run = async () => {
        stubs.config.set('signup_email_verification_enabled', true);
        const intent = ap.normalizeSignupIntent({ email: 'u@x.com' });
        const placement = await ap.prepareAccountPlacement(intent, { req: REQ });
        assert.equal(placement.needsVerification, true);
        await ap.finalizeAccount({ userId: 'u1', email: 'u@x.com', displayName: 'U', intent, placement, req: { headers: {}, session: {} } });
        await settle();
    };

    test('"sent" is written only after the send reports success', async () => {
        let deliver;
        stubs.verificationSend = () => new Promise(r => { deliver = r; });
        await run();
        assert.deepEqual(verificationAudits(), [], 'nothing is audited while the send is in flight');
        deliver({ success: true });
        await settle();
        assert.deepEqual(verificationAudits(), [{ action: 'user.email_verification_sent', details: { email: 'u@x.com' } }]);
    });

    test('a send that resolves unsuccessfully is audited as a failure, not as sent', async () => {
        stubs.verificationSend = async () => ({ success: false, error: 'Service email is not connected.' });
        await run();
        assert.deepEqual(verificationAudits(), [{
            action: 'user.email_verification_failed',
            details: { email: 'u@x.com', error: 'Service email is not connected.' },
        }]);
    });

    test('a send that throws is audited as a failure and never fails the signup', async () => {
        stubs.verificationSend = async () => { throw new Error('template render failed'); };
        await run();
        assert.deepEqual(verificationAudits(), [{
            action: 'user.email_verification_failed',
            details: { email: 'u@x.com', error: 'template render failed' },
        }]);
    });
});

describe('assertUserCreated', () => {
    test('a duplicate id maps to the historical 400', () => {
        assert.throws(() => ap.assertUserCreated({ created: null, reason: 'duplicate_id' }),
            (e) => e.status === 400 && e.message === 'Username already taken');
    });

    test('any other failure surfaces the store error', () => {
        assert.throws(() => ap.assertUserCreated({ created: null, error: 'boom' }),
            (e) => e.status === 400 && e.message === 'boom');
    });

    test('success returns the created user', () => {
        assert.deepEqual(ap.assertUserCreated({ created: { id: 'u1' } }), { id: 'u1' });
    });
});

describe('isConsumerAccount', () => {
    test('no organisation in cloud mode is a consumer', () => {
        assert.equal(ap.isConsumerAccount({ organizationId: '' }), true);
    });
    test('having an organisation is not', () => {
        assert.equal(ap.isConsumerAccount({ organizationId: 'acme' }), false);
    });
    test('the noOrganization screen is not a consumer account', () => {
        assert.equal(ap.isConsumerAccount({ organizationId: '' }, { noOrganization: true }), false);
    });
    test('self-hosted has no consumer accounts', () => {
        process.env.DEPLOYMENT_MODE = 'self-hosted';
        assert.equal(ap.isConsumerAccount({ organizationId: '' }), false);
    });
});

describe('SIGNUP_ERRORS contract', () => {
    test('every code has a status and an oauth slug', () => {
        for (const [code, spec] of Object.entries(ap.SIGNUP_ERRORS)) {
            assert.ok(spec.status >= 400 && spec.status < 500, `${code} status`);
            assert.match(spec.oauthCode, /^[a-z_]+$/, `${code} oauthCode`);
        }
    });

    test('the slugs the SPA already handles keep their historical values', () => {
        assert.equal(ap.SIGNUP_ERRORS.CONNECTOR_ONLY.oauthCode, 'signup_connector_only');
        assert.equal(ap.SIGNUP_ERRORS.GEO_BLOCKED.oauthCode, 'signup_geo_blocked');
        assert.equal(ap.SIGNUP_ERRORS.SEAT_CAP_EXCEEDED.oauthCode, 'seat_cap_exceeded');
        assert.equal(ap.SIGNUP_ERRORS.DUPLICATE_ID.oauthCode, 'signup_failed');
    });
});
