'use strict';

/**
 * W1/FIX1 — a schedule routine that LOSES its cron must not keep a stale
 * next_run_at.
 *
 * The bug: PUT /:id recomputed next_run_at only when
 * `triggerType === 'schedule' && scheduleCron`, and cleared it only when the
 * request explicitly sent a triggerType that was not 'schedule'. A routine
 * that stayed a schedule trigger but lost its cron hit neither branch —
 * triggerColumnsFromDefinition maps a missing `trigger.schedule.cron` to null,
 * so schedule_cron went NULL while trigger_type stayed 'schedule' and
 * next_run_at kept its old, now-past value. claimDueAutomations
 * (stores/automationStore/automations.js) claims exactly that shape, and the
 * runner's post-run advance is gated on `automation.scheduleCron` — which was
 * now null. Net effect on an ACTIVE routine: it re-ran, with live side
 * effects, every scheduler tick (~60s) forever.
 *
 * Route handler invoked directly — same harness as crud.subscriptionResync.js.
 * cron is NOT mocked here: next_run_at arithmetic is part of what we assert.
 *
 * Run: node --test routes/automation/crud.scheduleClear.test.js
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
let lastUpdate = null;

mock(path.join(SERVER, 'stores/automationStore'), {
    getAutomation: async (id) => AUTOMATIONS[id] || null,
    updateAutomation: async (id, updates) => {
        lastUpdate = updates;
        AUTOMATIONS[id] = { ...AUTOMATIONS[id], ...updates };
        return AUTOMATIONS[id];
    },
    getSubscriptionsForAutomation: async () => [],
    deleteSubscriptionsForAutomation: async () => {},
    createSubscription: async (o) => ({ id: 'sub-1', ...o }),
    updateSubscription: async () => true,
});
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

const putHandler = findHandler(crudRouter, 'put', '/:id');

// An ACTIVE, armed daily-at-09:00 routine whose next_run_at is already in the
// past — i.e. the row the scheduler is about to claim.
const PAST = '2020-01-01T08:00:00.000Z';
function seed(overrides = {}) {
    AUTOMATIONS = {
        auto1: {
            id: 'auto1', userId: 'user1', isActive: true, isDraft: false,
            title: 'Daily digest',
            triggerType: 'schedule', scheduleCron: '0 9 * * *', scheduleTz: 'Europe/Amsterdam',
            nextRunAt: PAST,
            definition: { trigger: { id: 'trg', kind: 'schedule', schedule: { cron: '0 9 * * *', tz: 'Europe/Amsterdam' } }, steps: [], edges: [] },
            ...overrides,
        },
    };
    lastUpdate = null;
}

async function put(body) {
    const req = { params: { id: 'auto1' }, session: { user: { id: 'user1' } }, body };
    const res = makeRes();
    await putHandler(req, res);
    return res;
}

// ── The runaway ─────────────────────────────────────────────────────────

test('a schedule trigger that loses its cron entirely clears next_run_at', async () => {
    seed();
    // Trigger stays kind:'schedule' but the schedule block is gone — the shape
    // triggerColumnsFromDefinition turns into scheduleCron:null.
    const res = await put({ definition: { trigger: { id: 'trg', kind: 'schedule' }, steps: [], edges: [] } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(lastUpdate.triggerType, 'schedule', 'trigger columns are still derived (BFSF-318)');
    assert.strictEqual(lastUpdate.scheduleCron, null);
    assert.ok('nextRunAt' in lastUpdate, 'next_run_at must be touched');
    assert.strictEqual(lastUpdate.nextRunAt, null,
        'a schedule row with no cron and a past next_run_at is claimed by claimDueAutomations every tick');
});

test('emptying the custom pattern is rejected instead of saved as a firing loop', async () => {
    seed();
    const res = await put({
        definition: { trigger: { id: 'trg', kind: 'schedule', schedule: { cron: '', tz: 'Europe/Amsterdam' } }, steps: [], edges: [] },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /no schedule/i);
    assert.strictEqual(lastUpdate, null, 'nothing is written on a rejected save');
    assert.strictEqual(AUTOMATIONS.auto1.nextRunAt, PAST, 'the row is untouched');
});

test('clearing the cron via the denormalised column is rejected too', async () => {
    seed();
    const res = await put({ scheduleCron: '' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(lastUpdate, null);

    seed();
    const res2 = await put({ scheduleCron: null });
    assert.strictEqual(res2.statusCode, 400);
    assert.strictEqual(lastUpdate, null);
});

test('switching to a schedule trigger with no cron anywhere is rejected', async () => {
    seed({ triggerType: 'manual', scheduleCron: null, nextRunAt: null });
    const res = await put({ triggerType: 'schedule' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(lastUpdate, null);
});

// ── Everything that must KEEP working ───────────────────────────────────

test('a freshly dropped, not-yet-configured schedule node still saves', async () => {
    // The palette drops `{ kind:'schedule' }` with no schedule block and the
    // canvas PUTs immediately; blocking that would make the node undroppable.
    seed({ triggerType: 'manual', scheduleCron: null, nextRunAt: null, isActive: false, isDraft: true });
    const res = await put({ definition: { trigger: { id: 'trg', kind: 'schedule' }, steps: [], edges: [] } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(lastUpdate.nextRunAt, null, 'unarmed, so nothing for the scheduler to claim');
});

test('a definition-only PUT with a real schedule still derives the columns and arms it (BFSF-318)', async () => {
    seed({ triggerType: 'manual', scheduleCron: null, scheduleTz: null, nextRunAt: null });
    const res = await put({
        definition: { trigger: { id: 'trg', kind: 'schedule', schedule: { cron: '0 7 * * 1', tz: 'Europe/Amsterdam' } }, steps: [], edges: [] },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(lastUpdate.triggerType, 'schedule');
    assert.strictEqual(lastUpdate.scheduleCron, '0 7 * * 1');
    assert.strictEqual(lastUpdate.scheduleTz, 'Europe/Amsterdam');
    assert.ok(Date.parse(lastUpdate.nextRunAt) > Date.now(), 'armed with a future next_run_at');
});

test('switching AWAY from a schedule clears next_run_at (unchanged)', async () => {
    seed();
    const res = await put({ definition: { trigger: { id: 'trg', kind: 'manual' }, steps: [], edges: [] } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(lastUpdate.triggerType, 'manual');
    assert.strictEqual(lastUpdate.nextRunAt, null);
});

test('a PUT that has nothing to do with scheduling neither 400s nor touches next_run_at', async () => {
    seed();
    const res = await put({ title: 'Renamed' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(lastUpdate, { title: 'Renamed' });
    assert.strictEqual(AUTOMATIONS.auto1.nextRunAt, PAST, 'still armed on its original schedule');
});

test('a bad cron is still a 400 and an unreachable one still reports no upcoming run', async () => {
    seed();
    const bad = await put({ scheduleCron: 'not a cron' });
    assert.strictEqual(bad.statusCode, 400);
    assert.match(bad.body.error, /Bad cron/);

    seed();
    const unreachable = await put({ scheduleCron: '0 0 31 2 *' });
    assert.strictEqual(unreachable.statusCode, 400);
    assert.match(unreachable.body.error, /no upcoming run time/);
});

// ── runPolicy is a setting: its timeout reaches the reaper's column on save ──

test('a runPolicy save keeps run_timeout_ms in step, also on a live routine', async () => {
    seed({ liveVersion: 3 });
    const res = await put({
        definition: {
            trigger: { id: 'trg', kind: 'schedule', schedule: { cron: '0 9 * * *', tz: 'Europe/Amsterdam' } },
            steps: [], edges: [],
            runPolicy: { maxDurationMin: 30 },
        },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(lastUpdate.runTimeoutMs, 30 * 60_000,
        'the stuck-run reaper reads the column, so it must not wait for the next publish');
});

test('a definition without a runPolicy leaves run_timeout_ms alone', async () => {
    seed();
    const res = await put({ definition: { trigger: { id: 'trg', kind: 'manual' }, steps: [], edges: [] } });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(!('runTimeoutMs' in lastUpdate));
});
