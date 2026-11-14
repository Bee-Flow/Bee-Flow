'use strict';

/**
 * auth/login/signupIntakeRoutes.js: the public organisation directory, and
 * the slow-down on one source naming many organisations.
 *
 *   - the directory is listed only where it is public: as configured, else
 *     only on a self-hosted install; where it is not, the answer is an empty
 *     list and the organisations are not read
 *   - a listed organisation shows its id, name, logo and description, and
 *     only organisations that allow sign-up are listed
 *   - a sign-up that names an organisation waits exactly the delay the
 *     throttle asks for, and not at all when it asks for none
 *
 * Run: cd server && node --require ./testUtils/registerFeatures.js --test auth/login/signupIntakeRoutes.directory.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSwaps } = require('../../testUtils/swaps');

/** @type {Map<string, unknown>} */
const config = new Map();
let organisationReads = 0;
let fanOutDelay = 0;
/** @type {number[]} */
const waits = [];
const ORGS = [
    { id: 'open', name: 'Open', allowSignup: true, logo: 'open.png', description: 'Everyone welcome', billingEmail: 'billing@open.example' },
    { id: 'plain', name: 'Plain', allowSignup: true },
    { id: 'closed', name: 'Closed', allowSignup: false },
];

const { swap, restore } = makeSwaps();
swap(require('../../stores/userStore'), 'getAllOrganizations', async () => { organisationReads++; return ORGS; });
swap(require('../../stores/configStore'), 'getConfig', async (/** @type {string} */ key) => config.get(key) ?? null);
swap(require('../signupGuards'), 'checkWebSignupAllowed', async () => ({ ok: true }));
swap(require('../signupCaptcha'), 'verifyCaptcha', async () => ({ ok: true }));
const loginThrottle = require('../loginThrottle');
swap(loginThrottle, 'recordFanOut', async () => ({ delayMs: fanOutDelay }));
swap(loginThrottle, 'sleep', async (/** @type {number} */ ms) => { waits.push(ms); });

const router = require('./signupIntakeRoutes');
const { dispatcher } = require('../../testUtils/routeHarness');
const dispatch = dispatcher(router);

const savedMode = process.env.DEPLOYMENT_MODE;
test.beforeEach(() => { config.clear(); organisationReads = 0; fanOutDelay = 0; waits.length = 0; delete process.env.DEPLOYMENT_MODE; });
test.after(() => {
    restore();
    if (savedMode === undefined) delete process.env.DEPLOYMENT_MODE; else process.env.DEPLOYMENT_MODE = savedMode;
});

const directory = async () => (await dispatch({ method: 'GET', url: '/organizations/public' })).body;

test('a directory that is not public answers an empty list and reads no organisation', async () => {
    config.set('signup_org_directory_public', false);
    process.env.DEPLOYMENT_MODE = 'self-hosted';
    assert.deepEqual(await directory(), []);
    assert.equal(organisationReads, 0);
});

test('a public directory lists the organisations that allow sign-up, with nothing but their card', async () => {
    config.set('signup_org_directory_public', true);
    assert.deepEqual(await directory(), [
        { id: 'open', name: 'Open', logo: 'open.png', description: 'Everyone welcome' },
        { id: 'plain', name: 'Plain', logo: null, description: '' },
    ]);
});

test('without a setting the directory is public on a self-hosted install only', async () => {
    assert.deepEqual(await directory(), [], 'cloud is the default mode');
    process.env.DEPLOYMENT_MODE = 'cloud';
    assert.deepEqual(await directory(), []);
    process.env.DEPLOYMENT_MODE = 'self-hosted';
    assert.equal((await directory()).length, 2);
});

test('a sign-up that names an organisation waits the delay the throttle asks for, and not at all without one', async () => {
    const signup = () => dispatch({ method: 'POST', url: '/pending-signup', body: { newOrgName: 'Acme' }, session: { save(/** @type {Function} */ cb) { cb(); } } });
    await signup();
    assert.deepEqual(waits, [], 'no delay asked, none taken');
    fanOutDelay = 750;
    await signup();
    assert.deepEqual(waits, [750]);
});
