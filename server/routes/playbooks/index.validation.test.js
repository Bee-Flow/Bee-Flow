'use strict';

/**
 * What /api/playbooks accepts, and what it says when it refuses
 * (routes/playbooks/, all six route groups through the one router).
 *
 * This router answers in its OWN envelope — `{ error, code, … }` — and the
 * Studio reads the code, so the schemas are PARSED (contract.js `check`)
 * rather than mounted as core/http/validate. What this file pins is that the
 * refusal keeps that code AND now names the field, for five fall-backs that
 * each answered 200 or 201:
 *
 *   - `expectedVersion: 'abc'` skipped the optimistic lock ENTIRELY: the
 *     phase was skipped or retried over whatever somebody else had just
 *     written, because the conflict check ran only `if (Number.isInteger(…))`;
 *   - `tableMode: 'exsting'` became **new**, so a second table was created
 *     beside the one the person had picked;
 *   - `tier: 'thinkin'` became **fast** on the call that writes the whole
 *     playbook document;
 *   - `locale: 'nederlands'` became **en** — the language a playbook is built
 *     in has been wrong twice for exactly that reason;
 *   - a misspelled option key (`aproverGroupId`) was dropped, so the playbook
 *     was created without the thing it was asked for.
 *
 * Run: cd server && node --test routes/playbooks/index.validation.test.js
 */

process.env.NODE_ENV = 'test';

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

const pass = (req, res, next) => next();
mock(path.join(SERVER, 'auth/permissions'), {
    requireAuth: pass,
    requirePermission: () => pass,
    Permissions: { MANAGE_APPS: 'manage_apps', MANAGE_DATATABLES: 'manage_datatables' },
    hasPermission: async () => true,
});
mock(path.join(SERVER, 'utils/perUserRateLimit'), { perUserRateLimit: () => pass });

const { createPlaybooksRouter } = require('./index');

// Every store write lands in `touched`. A refused request must leave it empty.
const touched = [];
const note = (what) => async (...args) => { touched.push({ what, args }); return true; };

const PLAYBOOK = {
    id: 'pb1', userId: 'me', organizationId: 'org1', version: 3, status: 'active',
    title: 'Invoices', options: { locale: 'en' },
    phases: [
        { key: 'table', kind: 'table', status: 'ready' },
        { key: 'app', kind: 'app', status: 'pending', artifacts: { appId: 'app1' } },
        { key: 'access', kind: 'access', status: 'ready', artifacts: { appId: 'app1' } },
    ],
};

const RECIPE = {
    RECIPE_ID: 'invoice_tracker', title: 'Invoices', description: 'invoices', hasTable: true, inputs: [],
    phasesFor: () => [{ key: 'table', kind: 'table', status: 'ready' }],
    phaseSpec: () => null,
};

const deps = {
    playbookStore: {
        listPlaybooksForUser: async () => [],
        getPlaybook: async () => ({ ...PLAYBOOK }),
        createPlaybook: note('createPlaybook'),
        savePhases: note('savePhases'),
        deletePlaybook: note('deletePlaybook'),
    },
    recipes: { listRecipes: (locale) => { touched.push({ what: 'listRecipes', args: [locale] }); return []; }, getRecipe: (id) => (id === 'invoice_tracker' ? RECIPE : null) },
    recipeDoc: { normaliseRecipeDoc: (d) => d, validateRecipeDoc: () => ({ ok: true }), fromDocument: () => RECIPE },
    composeRecipe: async (args) => { touched.push({ what: 'composeRecipe', args: [args] }); return { ok: true, recipe: {}, warnings: [] }; },
    userStore: { getAllGroups: async () => [], getAllUsers: async () => [] },
    studioAppStore: { getStudioApp: async () => ({ id: 'app1', userId: 'me', name: 'App' }) },
    studioAppDataStore: { getDataModel: async () => null },
    automationStore: { getAutomation: async () => null },
    datatableStore: { updateDatatableMeta: note('updateDatatableMeta') },
    datatableAccessPlan: { resolveDatatablePrincipalForUser: async () => ({}) },
    datatableRuntime: { resolveForPrincipal: async () => ({}), aggregateRows: async () => ({ rows: [] }), readRows: async () => ({ rows: [] }) },
    planAccess: async (args) => { touched.push({ what: 'planAccess', args: [args] }); return { ok: true, plan: {} }; },
    rlsGateway: { validateRowFilter: () => ({ ok: true }) },
    entitlements: { hasCapability: async () => true },
    permissions: { hasPermission: async () => true, Permissions: {} },
    now: () => Date.parse('2026-09-22T10:00:00Z'),
};
// The router reaches for these lazily; anything it touches in a REFUSED
// request would be a bug this file is here to catch.
const d = new Proxy(deps, {
    get(target, key) {
        if (key in target) return target[key];
        return new Proxy({}, { get: () => { throw new Error(`unexpected dep: ${String(key)}`); } });
    },
});

const router = createPlaybooksRouter(d);

function dispatch({ method, url, body }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method, url, originalUrl: url, path: pathname, query, body, headers: {},
            session: { user: { id: 'me', organizationId: 'org1' } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200,
            set() { return this; }, setHeader() {},
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(req, res, (err) => reject(err || new Error(`fell through: ${method} ${url}`)));
    });
}

test.beforeEach(() => { touched.length = 0; });

/** Assert: 400, this router's own code, the field named, nothing written. */
async function refuses(request, code, field) {
    const res = await dispatch(request);
    const what = `${request.method} ${request.url} ${JSON.stringify(request.body)}`;
    assert.strictEqual(res.statusCode, 400, `${what} -> ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, code, `${what} -> ${JSON.stringify(res.body)}`);
    assert.ok(res.body.errors.some((e) => e.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.errors)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
    return res;
}

// ═══ The catalogue ══════════════════════════════════════════════════

test('a locale that is not a language code is refused, not quietly read as English', async () => {
    const res = await refuses({ method: 'GET', url: '/recipes?locale=nederlands' }, 'bad_options', 'query.locale');
    assert.strictEqual(res.body.error, 'locale is a language code, like "nl" or "en".');
});

test('the locale the dialog sends still reaches the catalogue', async () => {
    const res = await dispatch({ method: 'GET', url: '/recipes?locale=nl' });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(touched.find((t) => t.what === 'listRecipes').args, ['nl']);
});

test('a tier one letter off is refused instead of composing on the cheapest model', async () => {
    const res = await refuses({
        method: 'POST', url: '/recipes/compose',
        body: { description: 'a supplier intake', tier: 'thinkin' },
    }, 'description_required', 'body.tier');
    assert.ok(res.body.error.startsWith('tier is one of:'), res.body.error);
});

test('a description left out keeps the code the dialog reads', async () => {
    const res = await refuses({ method: 'POST', url: '/recipes/compose', body: {} }, 'description_required', 'body.description');
    assert.strictEqual(res.body.error, 'Describe what the playbook should build.');
});

// ═══ Creating a playbook ════════════════════════════════════════════

test('a table mode one letter off is refused, not read as "make a new table"', async () => {
    await refuses({
        method: 'POST', url: '/',
        body: { recipeId: 'invoice_tracker', options: { tableMode: 'exsting', datatableId: 'dt1' } },
    }, 'bad_options', 'body.options.tableMode');
});

test('a misspelled option is refused rather than creating the playbook without it', async () => {
    const res = await refuses({
        method: 'POST', url: '/',
        body: { recipeId: 'invoice_tracker', options: { aproverGroupId: 'g1' } },
    }, 'bad_options', 'body.options');
    // The dialog shows a bad_options sentence as it is, so it is one.
    assert.strictEqual(res.body.error, 'options does not take "aproverGroupId". It takes: locale, tier, tableMode, datatableId, tableTitle, folderPath, approverGroupId, ask, inputs.');
});

// ═══ Skip and retry: the optimistic lock ════════════════════════════

test('an expectedVersion that is not a number is refused, not read as "no lock at all"', async () => {
    // `Number('abc')` is NaN, `Number.isInteger(NaN)` is false, and the
    // conflict check ran only inside that `if` — so the phase was skipped on
    // top of whatever somebody else had written.
    const res = await refuses({
        method: 'POST', url: '/pb1/phases/app/skip',
        body: { expectedVersion: 'abc' },
    }, 'bad_patch', 'body.expectedVersion');
    assert.strictEqual(res.body.error, 'expectedVersion is the version this playbook had when you read it.');
});

test('a stale expectedVersion still answers version_conflict, with the current row', async () => {
    const res = await dispatch({ method: 'POST', url: '/pb1/phases/app/skip', body: { expectedVersion: 2 } });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'version_conflict');
    assert.strictEqual(res.body.currentVersion, 3);
    assert.deepStrictEqual(touched, [], 'and nothing is written');
});

// The skip/retry lock was `z.coerce.number()`: `Number([3])` is 3,
// `Number(true)` is 1 and `Number('3')` is 3, so an array, a boolean or a
// string passed the lock whenever it coerced to the version (PATCH closed
// this already, with its own schema). Every client sends the number it read:
// usePlaybook / phaseMachine and scripts/drive-playbook.js pass
// `playbook.version` from the JSON, and mobile has no playbooks.
for (const [what, expectedVersion] of [['[3]', [3]], ['true', true], ['"3"', '3'], ['3.5', 3.5], ['null', null]]) {
    for (const verb of ['skip', 'retry']) {
        test(`a ${verb} with expectedVersion ${what} is refused: the lock is a whole number, not whatever coerces to one`, async () => {
            const res = await refuses({ method: 'POST', url: `/pb1/phases/app/${verb}`, body: { expectedVersion } }, 'bad_patch', 'body.expectedVersion');
            assert.strictEqual(res.body.error, 'expectedVersion is the version this playbook had when you read it.');
        });
    }
}

test('the number the Studio sends still reaches the lock', async () => {
    const res = await dispatch({ method: 'POST', url: '/pb1/phases/app/skip', body: { expectedVersion: 2 } });
    assert.strictEqual(res.statusCode, 409, 'a stale number is a conflict, not a shape error');
});

// `.strict()` without a message answered with zod's own words: "Unrecognized
// key(s) in object: 'force'". A body names what it does not take, in a
// sentence, and says what it does.
test('a key a body does not take is named in a sentence, with what the request does take', async () => {
    const skip = await refuses({ method: 'POST', url: '/pb1/phases/app/skip', body: { expectedVersion: 3, force: true } }, 'bad_patch', 'body');
    assert.strictEqual(skip.body.error, 'This request does not take "force". It takes: expectedVersion.');
    const retry = await refuses({ method: 'POST', url: '/pb1/phases/app/retry', body: { expectedVersion: 3, reset: true, brief: 'x' } }, 'bad_patch', 'body');
    assert.strictEqual(retry.body.error, 'This request does not take "reset" or "brief". It takes: expectedVersion, resetBrief.');
    const access = await refuses({ method: 'POST', url: '/pb1/phases/access/access-plan', body: { mesage: 'the sales team' } }, 'message_required', 'body');
    assert.strictEqual(access.body.error, 'This request does not take "mesage". It takes: message.');
});

test('a body with a pile of unknown keys names a few, not all of them', async () => {
    const body = { expectedVersion: 3 };
    for (let i = 0; i < 50; i++) body[`k${i}_${'x'.repeat(80)}`] = 1;
    const res = await refuses({ method: 'POST', url: '/pb1/phases/app/skip', body }, 'bad_patch', 'body');
    assert.ok(res.body.error.length < 300, res.body.error);
    assert.match(res.body.error, /and 47 more\. It takes: expectedVersion\.$/);
});

test('a resetBrief that is a word is refused by name', async () => {
    await refuses({
        method: 'POST', url: '/pb1/phases/app/retry',
        body: { expectedVersion: 3, resetBrief: 'yes' },
    }, 'bad_patch', 'body.resetBrief');
});

// ═══ The phases the server runs ═════════════════════════════════════

test('the compliance phase\'s "read it again" still gets through the run body', async () => {
    // One route serves four phase kinds, and `recheck` belongs to the
    // compliance one (complianceReview.js reads it). A `.strict()` that did
    // not name it here would have 400'd that button.
    const res = await dispatch({ method: 'POST', url: '/pb1/phases/app/run', body: { recheck: true } });
    assert.strictEqual(res.statusCode, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'illegal_transition', 'refused for its KIND, not for its shape');
});

test('a misspelled feedback key is refused, not read as "run it again from scratch"', async () => {
    await refuses({
        method: 'POST', url: '/pb1/phases/app/run',
        body: { feedbak: 'fewer screens' },
    }, 'bad_patch', 'body');
});

// ═══ The access phase ═══════════════════════════════════════════════

test('a misspelled message key keeps message_required, and now names the field', async () => {
    await refuses({
        method: 'POST', url: '/pb1/phases/access/access-plan',
        body: { mesage: 'the sales team' },
    }, 'message_required', 'body');
});

// ═══ PATCH: the envelope around the transitions ═════════════════════

test('a misspelled status is refused, not answered with the playbook it did not stop', async () => {
    await refuses({ method: 'PATCH', url: '/pb1', body: { expectedVersion: 3, stauts: 'stopped' } }, 'bad_patch', 'body');
});

test('phases sent as one object instead of a list is refused, not read as "no entries"', async () => {
    await refuses({
        method: 'PATCH', url: '/pb1',
        body: { expectedVersion: 3, phases: { key: 'table', status: 'done' } },
    }, 'bad_patch', 'body.phases');
});

test('an entry with a misspelled status is refused, not read as an entry with nothing to do', async () => {
    await refuses({
        method: 'PATCH', url: '/pb1',
        body: { expectedVersion: 3, phases: [{ key: 'app', staus: 'done' }] },
    }, 'bad_patch', 'body.phases.0');
});

test('an expectedVersion that only COERCES to the version no longer passes the lock', async () => {
    // `Number([3])` is 3 and `Number(true)` is 1: both passed the lock.
    const res = await refuses({ method: 'PATCH', url: '/pb1', body: { expectedVersion: [3] } }, 'version_required', 'body.expectedVersion');
    assert.strictEqual(res.body.error, 'expectedVersion is the version this playbook had when you read it.');
});

test('what the Studio sends to stop a playbook still gets through', async () => {
    const saved = deps.playbookStore.savePhases;
    deps.playbookStore.savePhases = async (id, uid, patch) => {
        touched.push({ what: 'savePhases', args: [patch] });
        return { ok: true, playbook: { ...PLAYBOOK, ...patch, version: 4 } };
    };
    try {
        const res = await dispatch({ method: 'PATCH', url: '/pb1', body: { expectedVersion: 3, status: 'stopped' } });
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.strictEqual(touched.at(-1).args[0].status, 'stopped');
    } finally {
        deps.playbookStore.savePhases = saved;
    }
});

// ═══ The compliance phase's register ════════════════════════════════

const COMPLIANCE_PB = {
    ...PLAYBOOK,
    phases: [
        { key: 'table', kind: 'table', status: 'done', artifacts: { datatableId: 'dt1', datatableScope: 'org', fields: [{ key: 'datum', name: 'Datum' }, { key: 'naam', name: 'Naam' }] } },
        { key: 'compliance', kind: 'compliance', status: 'awaiting', artifacts: { findings: [], frameworks: ['GDPR'] } },
    ],
};

async function withCompliancePlaybook(fn) {
    const saved = { getPlaybook: deps.playbookStore.getPlaybook, savePhases: deps.playbookStore.savePhases };
    deps.playbookStore.getPlaybook = async () => ({ ...COMPLIANCE_PB });
    deps.playbookStore.savePhases = async () => ({ ok: true, playbook: { ...COMPLIANCE_PB } });
    deps.complianceStore = { addEvidence: note('addEvidence') };
    try { return await fn(); } finally {
        Object.assign(deps.playbookStore, saved);
        delete deps.complianceStore;
    }
}

test('a misspelled registration key is refused, not skipped while the evidence says "registered"', async () => {
    await withCompliancePlaybook(() => refuses({
        method: 'POST', url: '/pb1/phases/compliance/register',
        body: { registration: { lawfullBasis: 'contract' }, risks: [] },
    }, 'bad_patch', 'body.registration'));
});

test('retentionDays true is refused, not registered as one day', async () => {
    // `Number(true)` is 1, and a one-day retention lets the clean-up delete
    // every row older than yesterday.
    await withCompliancePlaybook(() => refuses({
        method: 'POST', url: '/pb1/phases/compliance/register',
        body: { registration: { lawfulBasis: 'contract', retentionDays: true, retentionField: 'datum' }, risks: [] },
    }, 'bad_patch', 'body.registration.retentionDays'));
});

test('a refused legal basis is on the evidence as NOT registered', async () => {
    await withCompliancePlaybook(async () => {
        const res = await dispatch({
            method: 'POST', url: '/pb1/phases/compliance/register',
            body: { registration: { lawfulBasis: 'because we felt like it' }, risks: [] },
        });
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.deepStrictEqual(res.body.written, ['evidence']);
        const payload = touched.find((t) => t.what === 'addEvidence').args[0].payload;
        assert.deepStrictEqual(payload.registered, { table: 'dt1' }, 'nothing was registered, so nothing is claimed');
        assert.strictEqual(payload.not_registered.requested.lawfulBasis, 'because we felt like it');
        assert.match(payload.not_registered.reason, /not one of the six legal bases/);
    });
});

test('a retention preview for "true" days is refused, not previewed as one day', async () => {
    await withCompliancePlaybook(() => refuses({
        method: 'POST', url: '/pb1/phases/compliance/retention-preview',
        body: { retentionField: 'datum', retentionDays: true },
    }, 'bad_retention_field', 'body.retentionDays'));
});

test('design feedback longer than the Studio box is refused, not cut off mid-sentence', async () => {
    await refuses({
        method: 'POST', url: '/pb1/phases/app/run',
        body: { feedback: 'x'.repeat(801) },
    }, 'bad_patch', 'body.feedback');
});
