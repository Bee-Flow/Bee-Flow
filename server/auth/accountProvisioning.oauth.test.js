/**
 * The OAuth-specific contract of the shared provisioning path.
 *
 * Before the merge, the OAuth callback created the user row FIRST and then tried
 * to create the organisation, logging a warning and carrying on when the name or
 * domain was taken — leaving a founder signed in with no organisation. It also
 * skipped the signup_org_enabled flag the password route enforced, and wrote an
 * `isConsumer` field that updateUser silently discards.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

const stubs = {
    config: new Map(),
    orgs: [],
    createOrganizationResult: true,
    updatedUsers: [],
    setConfigCalls: [],
    welcomeClaims: [],
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
                createOrganization: async () => stubs.createOrganizationResult,
                updateUser: async (id, u) => { stubs.updatedUsers.push({ id, updates: u }); return true; },
                claimNotification: async (...a) => { stubs.welcomeClaims.push(a); return false; },
                logAccessAudit: async () => {},
            };
        case './consentGuards':
            return { validateConsent: () => ({ ok: true }), recordConsent: async () => {} };
        case './signupGuards':
            return { checkWebSignupAllowed: async () => ({ ok: true }), resolveSignupLocale: async () => 'en' };
        case '../utils/freeEmailDomains':
            return { isFreeEmailDomain: (d, l) => l.includes(d), getEffectiveFreeEmailDomains: async () => ['gmail.com'] };
        case '../services/trialService':
            return { maybeAutoGrantOrgTrial: () => {}, maybeAutoGrantConsumerTrial: () => {} };
        case '../core/privacy/signupShield':
            return { buildSignupShieldConfig: () => ({ piiDetectionCategories: [], piiDetectionAction: 'block' }) };
        case '../core/privacy/userShieldDefaults':
            return { buildUserShieldConfig: () => ({ enabled: true, piiDetectionAction: 'tokenize', piiDetectionCategories: [] }) };
        case '../utils/emailService':
            return { getServiceEmailConfig: async () => ({ configured: true }), sendWelcomeEmail: async () => {}, sendVerificationEmail: async () => {} };
        case '../stores/invitationStore':
            return { markAccepted: async () => true };
        default:
            return originalLoad(request, parent, isMain);
    }
};
const ap = require('./accountProvisioning');

const REQ = { headers: {}, session: {} };

/** Exactly what the OAuth callback builds from req.session.pendingSignup. */
const oauthIntent = (pendingSignup, email) =>
    ap.normalizeSignupIntent({ ...pendingSignup, email }, { provider: 'google', channel: 'oauth' });

beforeEach(() => {
    stubs.config = new Map([['signup_org_enabled', true], ['signup_consumer_enabled', true]]);
    stubs.orgs = [];
    stubs.createOrganizationResult = true;
    stubs.updatedUsers = [];
    stubs.setConfigCalls = [];
    process.env.DEPLOYMENT_MODE = 'cloud';
    delete process.env.ALLOW_SIGNUPS;
});

describe('OAuth org signup', () => {
    const pending = { newOrgName: 'Acme', orgDetails: { email: 'info@acme.com' }, consent: { accepted: true, accountType: 'org_admin' } };

    test('the org feature flag is now enforced — the OAuth path used to skip it', async () => {
        stubs.config.set('signup_org_enabled', false);
        const e = await ap.prepareAccountPlacement(oauthIntent(pending, 'f@acme.com'), { req: REQ }).catch(x => x);
        assert.equal(e.code, 'ORG_SIGNUPS_DISABLED');
        // The callback redirects with this slug rather than silently continuing.
        assert.equal(e.oauthCode, 'signup_org_disabled');
    });

    test('a taken org name is a hard failure, not a warning', async () => {
        stubs.createOrganizationResult = false;
        const e = await ap.prepareAccountPlacement(oauthIntent(pending, 'f@acme.com'), { req: REQ }).catch(x => x);
        assert.equal(e.code, 'ORG_NAME_TAKEN');
        assert.equal(e.oauthCode, 'org_name_taken');
    });

    test('a taken domain is a hard failure, not a warning', async () => {
        stubs.orgs = [{ id: 'other', email: 'hello@acme.com' }];
        const e = await ap.prepareAccountPlacement(oauthIntent(pending, 'f@acme.com'), { req: REQ }).catch(x => x);
        assert.equal(e.code, 'ORG_DOMAIN_TAKEN');
    });

    test('the founder is org_admin of the new org', async () => {
        const p = await ap.prepareAccountPlacement(oauthIntent(pending, 'f@acme.com'), { req: REQ });
        assert.deepEqual(
            { organizationId: p.organizationId, orgRole: p.orgRole, status: p.status },
            { organizationId: 'acme', orgRole: 'org_admin', status: 'active' },
        );
    });
});

describe('OAuth consumer signup', () => {
    const pending = { signupType: 'consumer', privacyShield: null, consent: { accepted: true, accountType: 'consumer' } };

    test('lands with no organisation', async () => {
        const p = await ap.prepareAccountPlacement(oauthIntent(pending, 'me@gmail.com'), { req: REQ });
        assert.equal(p.organizationId, null);
        assert.equal(p.orgCreated, false);
    });

    test('the intent is typed consumer, which is what keeps the callback out of domain-matching', async () => {
        assert.equal(oauthIntent(pending, 'me@gmail.com').accountType, 'consumer');
    });

    test('no isConsumer field is ever written — updateUser has no such column', async () => {
        const intent = oauthIntent(pending, 'me@gmail.com');
        const placement = await ap.prepareAccountPlacement(intent, { req: REQ });
        await ap.finalizeAccount({ userId: 'u1', email: 'me@gmail.com', displayName: 'Me', intent, placement, req: { headers: {}, session: {} } });
        for (const { updates } of stubs.updatedUsers) {
            assert.ok(!('isConsumer' in updates), `isConsumer leaked into updateUser: ${JSON.stringify(updates)}`);
        }
    });

    test('the waitlist still applies to consumer OAuth signups', async () => {
        stubs.config.set('signup_waitlist_enabled', true);
        const p = await ap.prepareAccountPlacement(oauthIntent(pending, 'me@gmail.com'), { req: REQ });
        assert.equal(p.status, 'waitlist');
    });
});

describe('SSO accounts skip email verification', () => {
    test('an oauth signup is never left unverified — the IdP already proved the address', async () => {
        stubs.config.set('signup_email_verification_enabled', true);
        const p = await ap.prepareAccountPlacement(
            oauthIntent({ signupType: 'consumer', consent: { accepted: true } }, 'me@gmail.com'), { req: REQ });
        assert.equal(p.needsVerification, false);
        assert.equal(p.status, 'active');
    });

    test('but a password signup with the same setting does require it', async () => {
        stubs.config.set('signup_email_verification_enabled', true);
        const intent = ap.normalizeSignupIntent({ email: 'me@gmail.com', consent: { accepted: true } }, { channel: 'password' });
        const p = await ap.prepareAccountPlacement(intent, { req: REQ });
        assert.equal(p.needsVerification, true);
        assert.equal(p.status, 'unverified');
    });
});

describe('welcome email gating', () => {
    const finalizeAndFlush = async (source) => {
        stubs.welcomeClaims = [];
        const intent = ap.normalizeSignupIntent({ ...source, consent: { accepted: true } });
        const placement = await ap.prepareAccountPlacement(intent, { req: REQ });
        await ap.finalizeAccount({
            userId: 'u1', email: 'u@x.com', displayName: 'U', intent, placement,
            req: { headers: {}, session: {} },
        });
        await new Promise(r => setImmediate(r)); // the send is deferred off the request
        return placement;
    };

    test('an active account gets a welcome email', async () => {
        const p = await finalizeAndFlush({ email: 'u@x.com' });
        assert.equal(p.status, 'active');
        assert.deepEqual(stubs.welcomeClaims, [['user', 'u1', 'welcome_email', 'u@x.com']]);
    });

    test('a waitlisted account is not told "welcome, you are in"', async () => {
        stubs.config.set('signup_waitlist_enabled', true);
        const p = await finalizeAndFlush({ email: 'u@x.com' });
        assert.equal(p.status, 'waitlist');
        assert.deepEqual(stubs.welcomeClaims, []);
    });

    test('an account awaiting email verification gets its welcome at verify time instead', async () => {
        stubs.config.set('signup_email_verification_enabled', true);
        const p = await finalizeAndFlush({ email: 'u@x.com' });
        assert.equal(p.needsVerification, true);
        assert.deepEqual(stubs.welcomeClaims, []);
    });
});
