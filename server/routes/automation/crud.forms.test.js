'use strict';

/**
 * The org-wide forms surface: GET /forms, and the provisioning that keeps it
 * populated now that the builder no longer mints links.
 *
 * The public link used to be created as a side effect of an author opening the
 * panel that displayed it. That panel is hidden (Forms owns the link now), so
 * the page has to be provisioned when a form trigger is SAVED or no form would
 * ever be published again.
 *
 * Route handlers invoked directly (no supertest) — same technique as
 * routes/automation/crud.multiTrigger.test.js.
 *
 * Run: node --test routes/automation/crud.forms.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

const SERVER = path.resolve(__dirname, '..', '..');
function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

let AUTOMATIONS = {};
let ORG_FORMS = [];
let ensured = [];
let ensureThrows = false;
let scopeCalls = [];

let audienceWrites = [];
let groupsOf = {};
let orgGroups = ['g-fin', 'g-sales'];
let orgUsers = { user1: 'org1', pat: 'org1', sam: 'org1', out: 'org2' };

// The visitor gate's group read, and the validators a PUT /audience runs —
// lazily required by crud.js, so these stubs are what it gets.
mock(path.join(SERVER, 'auth/audience'), {
    resolveUserGroups: async (userId) => groupsOf[userId] || [],
    // auth/datatableAccess builds the principal from this; the session is
    // the whole truth here (no DB behind it).
    resolveAudienceContext: async (req) => ({
        userId: req?.session?.user?.id || null,
        orgIds: req?.session?.user?.organizationId ? new Set([req.session.user.organizationId]) : new Set(),
        userGroups: groupsOf[req?.session?.user?.id] || [],
    }),
    canSeePublished: () => false,
});
mock(path.join(SERVER, 'auth/permissions'), {
    validateSharedGroupsForOrg: async (orgId, ids) => {
        if (ids === undefined || ids === null) return undefined;
        const bad = ids.filter(id => !orgGroups.includes(id));
        if (bad.length) throw Object.assign(new Error(`Unknown groups: ${bad.join(', ')}`), { status: 400 });
        return Array.from(new Set(ids));
    },
});
mock(path.join(SERVER, 'stores/userStore'), {
    getUser: async (id) => (orgUsers[id] ? { id, organizationId: orgUsers[id] } : null),
});

mock(path.join(SERVER, 'stores/automationStore'), {
    getAutomation: async (id) => AUTOMATIONS[id] || null,
    setFormPageAudience: async (id, automationId, wanted) => {
        audienceWrites.push({ id, automationId, ...wanted });
        return { id, automationId, triggerStepId: null, submissions: 0, audience: wanted.audience, sharedGroups: wanted.sharedGroups, sharedUserIds: wanted.sharedUserIds };
    },
    updateAutomation: async (id, updates) => { AUTOMATIONS[id] = { ...AUTOMATIONS[id], ...updates }; return AUTOMATIONS[id]; },
    createAutomation: async (opts) => { const row = { id: 'new1', ...opts }; AUTOMATIONS[row.id] = row; return row; },
    listFormPagesForOrg: async (orgId, userId) => { scopeCalls.push({ orgId, userId }); return ORG_FORMS; },
    ensureFormPage: async (automationId, triggerStepId) => {
        if (ensureThrows) throw new Error('db is down');
        ensured.push({ automationId, triggerStepId });
        return { id: 'tok', automationId, triggerStepId };
    },
    getSubscriptionsForAutomation: async () => [],
    deleteSubscriptionsForAutomation: async () => {},
    createSubscription: async () => ({}),
});
mock(path.join(SERVER, 'automation/cron'), { nextRunAt: () => null });
mock(path.join(SERVER, 'automation/validate'), { validateDefinition: () => ({ ok: true, warnings: [] }) });
mock(path.join(SERVER, 'automation/summarise'), { summariseDefinition: () => ({ summary: '' }) });
mock(path.join(SERVER, 'automation/deliverableEvents'), { getDeliverableEvents: () => [] });
mock(path.join(SERVER, 'automation/toolRegistry'), { TOOL_REGISTRY: [], loadTools: () => [] });
mock(path.join(SERVER, 'automation/triggerBus'), {
    getPublicBaseUrl: () => null,
    loadSession: async () => null,
    revokeSubscription: async () => {},
    fetchLatestGmailMatch: async () => null,
    dispatchEvent: async () => [],
});
mock(path.join(SERVER, 'utils/perUserRateLimit'), { perUserRateLimit: () => (req, res, next) => next() });
// Loaded for real BEFORE the mock replaces the cache entry: activate reads the
// definition's pinned nodes through collectPinnedNodes, and a stub of that
// reader would test the stub. It is a pure module, so this costs nothing.
const realPortability = require(path.join(SERVER, 'automation/portability'));
mock(path.join(SERVER, 'automation/portability'), {
    buildExport: () => ({}),
    sanitizeImport: () => ({ automation: null, errors: ['not used'] }),
    rekeyDefinition: (d) => ({ definition: d }),
    collectPinnedNodes: realPortability.collectPinnedNodes,
});
mock(path.join(SERVER, 'core/integrations/integrationTools'), { getUserPermittedApps: async () => new Set() });

const crudRouter = require('./crud');

function findHandler(router, method, routePath) {
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
            return layer.route.stack[layer.route.stack.length - 1].handle;
        }
    }
    throw new Error(`route not found: ${method} ${routePath}`);
}

function makeRes() {
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
}

/**
 * A route's WHOLE stack, not only its handler: `validate` sits in front of
 * several of these now, and a schema refusal leaves as an error rather than
 * as a response — so the terminal handler has to be here too, or a 400 reads
 * as a crashed test.
 */
function findRoute(router, method, routePath) {
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
            return layer.route.stack.map(l => l.handle);
        }
    }
    throw new Error(`route not found: ${method} ${routePath}`);
}

async function runRoute(handles, req, res) {
    for (const handle of handles) {
        const step = await new Promise((resolve, reject) => {
            let settled = false;
            const done = (v) => { if (!settled) { settled = true; resolve(v); } };
            try {
                Promise.resolve(handle(req, res, (err) => done({ passed: true, err })))
                    .then(() => done({ passed: false }), reject);
            } catch (e) { reject(e); }
        });
        if (!step.passed) return res;
        if (step.err) {
            require(path.join(SERVER, 'core/http/terminalErrorHandler')).terminalErrorHandler(step.err, req, res, () => {});
            return res;
        }
    }
    return res;
}

const listFormsHandler = findHandler(crudRouter, 'get', '/forms');
const audienceRoute = findRoute(crudRouter, 'put', '/forms/:automationId/audience');
const audienceHandler = (req, res) => runRoute(audienceRoute, req, res);
const putHandler = findHandler(crudRouter, 'put', '/:id');
const postHandler = findHandler(crudRouter, 'post', '/');

const reqFor = (user = { id: 'user1', organizationId: 'org1' }) => ({ params: {}, query: {}, session: { user } });

const formRow = (over = {}) => ({
    id: 'a'.repeat(48),
    automationId: 'auto1',
    triggerStepId: null,
    submissions: 3,
    lastSeenAt: null,
    createdAt: '2026-08-01T00:00:00Z',
    title: 'Routine title',
    description: 'Routine description',
    isActive: true,
    isDraft: false,
    userId: 'user1',
    definition: { trigger: { id: 'trg', kind: 'form', form: { title: 'Intake', description: 'Fill this in' } } },
    ...over,
});

// ── GET /forms ───────────────────────────────────────────────────────

test('lists a published form with the address a visitor would use', async () => {
    ORG_FORMS = [formRow()];
    const res = makeRes();
    await listFormsHandler(reqFor(), res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.forms.length, 1);
    const f = res.body.forms[0];
    assert.strictEqual(f.url, `/f/${'a'.repeat(48)}`);
    // The FORM's own heading wins over the routine's title: that is what the
    // person filling it in sees.
    assert.strictEqual(f.title, 'Intake');
    assert.strictEqual(f.description, 'Fill this in');
    assert.strictEqual(f.live, true);
    assert.strictEqual(f.submissions, 3);
});

test('falls back to the routine title when the form has no heading of its own', async () => {
    ORG_FORMS = [formRow({ definition: { trigger: { id: 'trg', kind: 'form' } } })];
    const res = makeRes();
    await listFormsHandler(reqFor(), res);
    assert.strictEqual(res.body.forms[0].title, 'Routine title');
});

test('a paused or draft routine is listed, but not as live', async () => {
    // Its link answers 404 (formPublic.js's loadForm), so handing it out
    // silently would be worse than saying so.
    // Two different routines — same automationId would be a duplicate page,
    // which the dedupe above collapses to one.
    ORG_FORMS = [
        formRow({ isActive: false }),
        formRow({ id: 'b'.repeat(48), automationId: 'auto2', isDraft: true }),
    ];
    const res = makeRes();
    await listFormsHandler(reqFor(), res);
    assert.strictEqual(res.body.forms.length, 2);
    assert.deepStrictEqual(res.body.forms.map(f => f.live), [false, false]);
});

test('drops a page whose trigger is no longer a form', async () => {
    // The row outlives the trigger on purpose (so the old address can be
    // reinstated), and loadForm already refuses to serve it.
    ORG_FORMS = [formRow({ definition: { trigger: { id: 'trg', kind: 'schedule' } } })];
    const res = makeRes();
    await listFormsHandler(reqFor(), res);
    assert.deepStrictEqual(res.body.forms, []);
});

test('resolves a page bound to an additional trigger, not just the primary one', async () => {
    ORG_FORMS = [formRow({
        triggerStepId: 'trg2',
        definition: {
            trigger: { id: 'trg1', kind: 'schedule' },
            triggers: [{ id: 'trg2', kind: 'form', form: { title: 'Second door' } }],
        },
    })];
    const res = makeRes();
    await listFormsHandler(reqFor(), res);
    assert.strictEqual(res.body.forms[0].title, 'Second door');
});

test('says whether the caller owns the routine — the builder link is per-user', async () => {
    ORG_FORMS = [formRow({ userId: 'someone-else' })];
    const res = makeRes();
    await listFormsHandler(reqFor(), res);
    assert.strictEqual(res.body.forms[0].mine, false, 'a colleague\'s form still lists, but without an edit link');
});

test('says whether the caller may FILL IT IN — the visitor gate\'s own rule — and shows the audience only to the owner', async () => {
    groupsOf = { sam: ['g-fin'] };
    ORG_FORMS = [
        formRow({ automationId: 'org-wide', userId: 'someone-else', audience: 'org', sharedGroups: [], sharedUserIds: [] }),
        formRow({ id: 'b'.repeat(48), automationId: 'listed', userId: 'someone-else', audience: 'restricted', sharedGroups: [], sharedUserIds: ['user1'] }),
        formRow({ id: 'c'.repeat(48), automationId: 'by-group', userId: 'someone-else', audience: 'restricted', sharedGroups: ['g-fin'], sharedUserIds: [] }),
        formRow({ id: 'd'.repeat(48), automationId: 'not-me', userId: 'someone-else', audience: 'restricted', sharedGroups: ['g-sales'], sharedUserIds: ['pat'] }),
        formRow({ id: 'e'.repeat(48), automationId: 'own', userId: 'user1', audience: 'restricted', sharedGroups: ['g-fin'], sharedUserIds: ['pat'] }),
        // a row from before the column reads as org-wide
        formRow({ id: 'f'.repeat(48), automationId: 'old', userId: 'someone-else' }),
    ];
    const res = makeRes();
    await listFormsHandler(reqFor(), res);
    const byId = Object.fromEntries(res.body.forms.map(f => [f.automationId, f]));
    assert.strictEqual(byId['org-wide'].canOpen, true);
    assert.strictEqual(byId.listed.canOpen, true);
    assert.strictEqual(byId['by-group'].canOpen, false, 'user1 is in no group');
    assert.strictEqual(byId['not-me'].canOpen, false);
    assert.strictEqual(byId.own.canOpen, true, 'the owner always');
    assert.strictEqual(byId.old.canOpen, true);
    // the lists are the owner's to see
    assert.deepStrictEqual(byId['not-me'].audience, { mode: 'restricted' });
    assert.deepStrictEqual(byId.own.audience, { mode: 'restricted', groups: ['g-fin'], users: ['pat'] });
    assert.deepStrictEqual(byId['org-wide'].audience, { mode: 'org' });

    // a group member
    const sam = makeRes();
    await listFormsHandler(reqFor({ id: 'sam', organizationId: 'org1' }), sam);
    assert.strictEqual(sam.body.forms.find(f => f.automationId === 'by-group').canOpen, true);
});

test('PUT /forms/:id/audience: owner only, validated against the organisation, written on the primary page', async () => {
    audienceWrites = [];
    ensured = [];
    AUTOMATIONS = { auto1: { id: 'auto1', userId: 'user1', organizationId: 'org1', definition: { trigger: { id: 'trg', kind: 'form', form: { title: 'Intake', fields: [] } } } } };
    const req = (body, user) => ({ ...reqFor(user), params: { automationId: 'auto1' }, body });

    let res = makeRes();
    await audienceHandler(req({ audience: 'restricted' }, { id: 'pat', organizationId: 'org1' }), res);
    assert.strictEqual(res.statusCode, 403);

    res = makeRes();
    await audienceHandler(req({ audience: 'everyone' }), res);
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some(d => d.path === 'body.audience'), 'the 400 names the field');

    res = makeRes();
    await audienceHandler(req({ audience: 'restricted', sharedGroups: ['g-other-org'] }), res);
    assert.strictEqual(res.statusCode, 400, 'a group the organisation does not have is refused, never dropped');

    res = makeRes();
    await audienceHandler(req({ audience: 'restricted', sharedUserIds: ['out'] }), res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'audience_user_unknown');
    assert.strictEqual(audienceWrites.length, 0, 'nothing written on a refusal');

    res = makeRes();
    await audienceHandler(req({ audience: 'restricted', sharedGroups: ['g-fin', 'g-fin'], sharedUserIds: ['pat', 'sam'] }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.audience, { mode: 'restricted', groups: ['g-fin'], users: ['pat', 'sam'] });
    assert.deepStrictEqual(ensured, [{ automationId: 'auto1', triggerStepId: null }], 'the primary page, made if missing');
    assert.deepStrictEqual(audienceWrites, [{ id: 'tok', automationId: 'auto1', audience: 'restricted', sharedGroups: ['g-fin'], sharedUserIds: ['pat', 'sam'] }]);

    res = makeRes();
    await audienceHandler(req({ audience: 'org' }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.audience, { mode: 'org', groups: [], users: [] });
});

test('shows one entry per form when a routine has duplicate page rows', async () => {
    // The old builder panel could mint a second page for the same trigger, and
    // installs have such pairs. Both links work; the busiest is the one people
    // are holding, so that is the one to show.
    ORG_FORMS = [
        formRow({ id: 'n'.repeat(48), submissions: 0 }),
        formRow({ id: 'o'.repeat(48), submissions: 14 }),
    ];
    const res = makeRes();
    await listFormsHandler(reqFor(), res);
    assert.strictEqual(res.body.forms.length, 1);
    assert.strictEqual(res.body.forms[0].url, `/f/${'o'.repeat(48)}`);
    assert.strictEqual(res.body.forms[0].submissions, 14);
});

test('keeps two DIFFERENT forms on the same routine apart', async () => {
    // Same automation, different triggers — two real forms, not a duplicate.
    ORG_FORMS = [
        formRow({ id: 'p'.repeat(48), triggerStepId: null }),
        formRow({
            id: 'q'.repeat(48),
            triggerStepId: 'trg2',
            definition: {
                trigger: { id: 'trg', kind: 'form', form: { title: 'Intake' } },
                triggers: [{ id: 'trg2', kind: 'form', form: { title: 'Second door' } }],
            },
        }),
    ];
    const res = makeRes();
    await listFormsHandler(reqFor(), res);
    assert.strictEqual(res.body.forms.length, 2);
    assert.deepStrictEqual(res.body.forms.map(f => f.title).sort(), ['Intake', 'Second door']);
});

test('hands the store BOTH the org and the caller', async () => {
    scopeCalls = [];
    // The store needs both: automations.organization_id is never written, so
    // the org comes from the owner's user record — and a caller with no org at
    // all is narrowed to their own forms rather than sharing a null bucket
    // with every other orgless user on the install.
    ORG_FORMS = [formRow()];
    const res = makeRes();
    await listFormsHandler(reqFor({ id: 'user9', organizationId: null }), res);
    assert.deepStrictEqual(res.body.forms.length, 1);
    assert.deepStrictEqual(scopeCalls, [{ orgId: null, userId: 'user9' }]);
});

// ── provisioning ─────────────────────────────────────────────────────

test('saving a form trigger provisions its public page', async () => {
    ensured = [];
    AUTOMATIONS.auto1 = { id: 'auto1', userId: 'user1', isActive: false, isDraft: true, definition: {} };
    const req = {
        params: { id: 'auto1' },
        session: { user: { id: 'user1', organizationId: 'org1' } },
        body: { definition: { trigger: { id: 'trg', kind: 'form' }, steps: [], edges: [] } },
    };
    await putHandler(req, makeRes());
    // NULL triggerStepId for the primary trigger — the convention loadForm reads.
    assert.deepStrictEqual(ensured, [{ automationId: 'auto1', triggerStepId: null }]);
});

test('provisions one page per form trigger, primary and additional alike', async () => {
    ensured = [];
    AUTOMATIONS.auto1 = { id: 'auto1', userId: 'user1', isActive: false, isDraft: true, definition: {} };
    const req = {
        params: { id: 'auto1' },
        session: { user: { id: 'user1', organizationId: 'org1' } },
        body: {
            definition: {
                trigger: { id: 'trg1', kind: 'form' },
                triggers: [{ id: 'trg2', kind: 'form' }, { id: 'trg3', kind: 'webhook' }],
                steps: [], edges: [],
            },
        },
    };
    await putHandler(req, makeRes());
    assert.deepStrictEqual(ensured, [
        { automationId: 'auto1', triggerStepId: null },
        { automationId: 'auto1', triggerStepId: 'trg2' },
    ]);
});

test('a routine without a form trigger provisions nothing', async () => {
    ensured = [];
    AUTOMATIONS.auto1 = { id: 'auto1', userId: 'user1', isActive: false, isDraft: true, definition: {} };
    const req = {
        params: { id: 'auto1' },
        session: { user: { id: 'user1', organizationId: 'org1' } },
        body: { definition: { trigger: { id: 'trg', kind: 'manual' }, steps: [], edges: [] } },
    };
    await putHandler(req, makeRes());
    assert.deepStrictEqual(ensured, []);
});

test('creating a routine with a form trigger provisions it too', async () => {
    ensured = [];
    const req = {
        params: {},
        session: { user: { id: 'user1', organizationId: 'org1' } },
        body: { title: 'New', definition: { trigger: { id: 'trg', kind: 'form' }, steps: [], edges: [] } },
    };
    const res = makeRes();
    await postHandler(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(ensured, [{ automationId: 'new1', triggerStepId: null }]);
});

test('a link that cannot be minted does not fail the save', async () => {
    // Losing the address is recoverable — the next save mints it. Losing the
    // author's edit is not.
    ensureThrows = true;
    try {
        AUTOMATIONS.auto1 = { id: 'auto1', userId: 'user1', isActive: false, isDraft: true, definition: {} };
        const req = {
            params: { id: 'auto1' },
            session: { user: { id: 'user1', organizationId: 'org1' } },
            body: { definition: { trigger: { id: 'trg', kind: 'form' }, steps: [], edges: [] } },
        };
        const res = makeRes();
        await putHandler(req, res);
        assert.strictEqual(res.statusCode, 200);
    } finally {
        ensureThrows = false;
    }
});
