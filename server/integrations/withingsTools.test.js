/**
 * Withings tools — normalisation and request shaping.
 *
 * The whole point of this module is that nothing downstream should ever see
 * Withings' wire format: scaled integers, numeric type codes, durations in
 * seconds, and a 200-means-maybe envelope. These tests pin the flattening,
 * because a regression here is invisible — the rows still arrive, they are just
 * wrong by a factor of ten.
 *
 * Run: cd server && node --test integrations/withingsTools.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const fx = {
    auth: { accessToken: 'AT' },
    fetchImpl: async () => { throw new Error('fetch not stubbed'); },
    calls: [],
};

const MOCKS = {
    '../auth/routineAuth': {
        getProviderAuth: async () => fx.auth,
        // The real unwrapper is pure; re-implementing it in the stub would let
        // the two drift, so mirror only what the tools depend on.
        readWithingsBody: (data, label) => {
            if (Number(data?.status) === 0 && data.body) return data.body;
            const err = new Error(`Withings ${label} refused (status ${data?.status}): ${data?.error || ''}`);
            if (Number(data?.status) === 401) err.reauthRequired = true;
            throw err;
        },
    },
    '../auth/permissions': {
        OAUTH_PROVIDERS: { withings: { apiBase: 'https://wbsapi.withings.net' } },
    },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:withingsTools:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /integrations[\\/]withingsTools\.js$/.test(parent.filename) && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const realFetch = global.fetch;
global.fetch = async (url, opts) => {
    fx.calls.push({ url, params: new URLSearchParams(opts.body), headers: opts.headers });
    return fx.fetchImpl(url, opts);
};

const withings = require('./withingsTools');

test.after(() => {
    global.fetch = realFetch;
    Module._resolveFilename = originalResolve;
});

function ok(body) {
    return { ok: true, status: 200, json: async () => ({ status: 0, body }), text: async () => '' };
}
function lastCall() { return fx.calls[fx.calls.length - 1]; }
function reset() { fx.calls = []; fx.auth = { accessToken: 'AT' }; }

// ── Value scaling ────────────────────────────────────────────────────

test('scaleMeasure applies value × 10^unit without float noise', () => {
    // The naive 813 * 1e-1 is 81.30000000000001, which then renders in a table
    // as a 16-digit weight. Division + fixed decimals is what the app shows.
    assert.strictEqual(withings.scaleMeasure(813, -1), 81.3);
    assert.strictEqual(withings.scaleMeasure(7005, -2), 70.05);
    assert.strictEqual(withings.scaleMeasure(120, 0), 120);
    assert.strictEqual(withings.scaleMeasure(12, 1), 120);
    assert.strictEqual(withings.scaleMeasure(1234567, -6), 1.234567);
    assert.strictEqual(withings.scaleMeasure('nope', -1), null);
});

// ── Measure groups ───────────────────────────────────────────────────

const MEAS_FIXTURE = [{
    grpid: 900, date: 1_700_000_000, modified: 1_700_000_050, created: 1_700_000_010,
    category: 1, attrib: 0, deviceid: 'dev-1', comment: 'morning',
    measures: [
        { value: 813, unit: -1, type: 1 },    // weight 81.3 kg
        { value: 1855, unit: -2, type: 6 },   // fat ratio 18.55 %
    ],
}, {
    grpid: 901, date: 1_700_003_000, modified: 1_700_003_000,
    category: 1, attrib: 2,
    measures: [
        { value: 128, unit: 0, type: 10 },    // systolic
        { value: 81, unit: 0, type: 9 },      // diastolic
        { value: 4242, unit: 0, type: 9999 }, // unknown device type
    ],
}];

test('measure groups flatten to one row per measure with real values and units', () => {
    const rows = withings.normalizeMeasureGroups(MEAS_FIXTURE, 100);
    assert.strictEqual(rows.length, 5);

    const weight = rows[0];
    assert.strictEqual(weight.type, 'weight');
    assert.strictEqual(weight.value, 81.3);
    assert.strictEqual(weight.unit, 'kg');
    assert.strictEqual(weight.label, 'Weight');
    assert.strictEqual(weight.measured_at, new Date(1_700_000_000_000).toISOString());
    assert.strictEqual(weight.device_id, 'dev-1');
    assert.strictEqual(weight.category, 'real');
    assert.strictEqual(weight.attrib, 'device_confirmed');
    assert.strictEqual(weight.comment, 'morning');

    assert.strictEqual(rows[1].type, 'fat_ratio');
    assert.strictEqual(rows[1].value, 18.55);
    assert.strictEqual(rows[2].type, 'systolic_bp');
    assert.strictEqual(rows[3].type, 'diastolic_bp');
    assert.strictEqual(rows[4].attrib, 'manual');
});

test('an unknown measure type still produces a row (a new device must not vanish)', () => {
    const rows = withings.normalizeMeasureGroups(MEAS_FIXTURE, 100);
    const unknown = rows.find((r) => r.type_id === 9999);
    assert.ok(unknown, 'unknown type dropped');
    assert.strictEqual(unknown.type, 'type_9999');
    assert.strictEqual(unknown.value, 4242);
    assert.strictEqual(unknown.unit, '');
});

test('measurement_key is stable per (group, type) so a re-sync upserts', () => {
    const a = withings.normalizeMeasureGroups(MEAS_FIXTURE, 100);
    const b = withings.normalizeMeasureGroups(MEAS_FIXTURE, 100);
    assert.deepStrictEqual(a.map((r) => r.measurement_key), b.map((r) => r.measurement_key));
    assert.strictEqual(a[0].measurement_key, 'withings:meas:900:1');
    assert.strictEqual(new Set(a.map((r) => r.measurement_key)).size, a.length);
});

test('every row carries `modified` (epoch seconds) as the incremental watermark', () => {
    const rows = withings.normalizeMeasureGroups(MEAS_FIXTURE, 100);
    assert.ok(rows.every((r) => Number.isFinite(r.modified)));
    assert.strictEqual(rows[0].modified, 1_700_000_050);
});

test('the limit truncates mid-group rather than overshooting it', () => {
    const rows = withings.normalizeMeasureGroups(MEAS_FIXTURE, 3);
    assert.strictEqual(rows.length, 3);
});

test('a user objective is labelled, not silently mixed into real readings', () => {
    const rows = withings.normalizeMeasureGroups(
        [{ grpid: 1, date: 1_700_000_000, category: 2, measures: [{ value: 750, unit: -1, type: 1 }] }],
        10,
    );
    assert.strictEqual(rows[0].category, 'objective');
});

// ── Sleep ────────────────────────────────────────────────────────────

test('sleep durations convert from seconds to minutes and totals are derived', () => {
    const rows = withings.normalizeSleepSeries([{
        id: 77, date: '2026-08-19', startdate: 1_700_000_000, enddate: 1_700_028_800,
        modified: 1_700_030_000, timezone: 'Europe/Amsterdam',
        data: {
            lightsleepduration: 12_000, deepsleepduration: 6_000, remsleepduration: 3_600,
            wakeupduration: 900, wakeupcount: 2, hr_average: 54, sleep_score: 81,
        },
    }], 10);

    const r = rows[0];
    assert.strictEqual(r.measurement_key, 'withings:sleep:77');
    assert.strictEqual(r.light_sleep_minutes, 200);
    assert.strictEqual(r.deep_sleep_minutes, 100);
    assert.strictEqual(r.rem_sleep_minutes, 60);
    assert.strictEqual(r.awake_minutes, 15);
    assert.strictEqual(r.wake_up_count, 2);
    assert.strictEqual(r.heart_rate_average, 54);
    assert.strictEqual(r.sleep_score, 81);
    // Withings omits total_sleep_time on some plans; deriving it keeps the
    // column from being half-populated across a history.
    assert.strictEqual(r.total_sleep_minutes, 360);
    assert.strictEqual(r.start_at, new Date(1_700_000_000_000).toISOString());
    assert.strictEqual(r.timezone, 'Europe/Amsterdam');
});

test('a provided total_sleep_time wins over the derived sum', () => {
    const rows = withings.normalizeSleepSeries([{
        id: 78, date: '2026-08-19', startdate: 1_700_000_000, enddate: 1_700_028_800,
        data: { lightsleepduration: 60, deepsleepduration: 60, total_sleep_time: 6_000 },
    }], 10);
    assert.strictEqual(rows[0].total_sleep_minutes, 100);
});

// ── Activity ─────────────────────────────────────────────────────────

test('activity days flatten with one key per date', () => {
    const rows = withings.normalizeActivities([
        { date: '2026-08-19', timezone: 'Europe/Amsterdam', steps: 9123, distance: 6800.5, calories: 410, totalcalories: 2310, hr_average: 71 },
    ], 10);
    const r = rows[0];
    assert.strictEqual(r.measurement_key, 'withings:activity:2026-08-19');
    assert.strictEqual(r.steps, 9123);
    assert.strictEqual(r.distance_meters, 6800.5);
    assert.strictEqual(r.active_calories, 410);
    assert.strictEqual(r.total_calories, 2310);
    assert.strictEqual(r.heart_rate_average, 71);
    assert.strictEqual(r.measured_at, '2026-08-19T00:00:00.000Z');
});

// ── Request shaping ──────────────────────────────────────────────────

test('withings_get_measures posts an action-dispatched form with a bearer token', async () => {
    reset();
    fx.fetchImpl = async () => ok({ measuregrps: MEAS_FIXTURE, updatetime: 1_700_009_999, timezone: 'Europe/Amsterdam' });
    const out = await withings.executeWithingsTool('withings_get_measures', { types: ['weight', 'systolic_bp'] }, 'u1');

    const call = lastCall();
    assert.strictEqual(call.url, 'https://wbsapi.withings.net/measure');
    assert.strictEqual(call.params.get('action'), 'getmeas');
    assert.strictEqual(call.params.get('meastypes'), '1,10');
    assert.strictEqual(call.params.get('category'), '1');
    assert.strictEqual(call.headers.Authorization, 'Bearer AT');
    // The value to store as the next sync's lastupdate — deriving one from the
    // rows would re-fetch (or skip) the boundary row forever.
    assert.strictEqual(out.updatetime, 1_700_009_999);
    assert.strictEqual(out.rowCount, 5);
});

test('type slugs and raw numeric codes both resolve', async () => {
    reset();
    fx.fetchImpl = async () => ok({ measuregrps: [] });
    await withings.executeWithingsTool('withings_get_measures', { types: ['weight', 11, '54', 'nonsense'] }, 'u1');
    assert.strictEqual(lastCall().params.get('meastypes'), '1,11,54');
});

test('lastupdate wins over a date window — an incremental sync must not be narrowed', async () => {
    reset();
    fx.fetchImpl = async () => ok({ measuregrps: [] });
    await withings.executeWithingsTool('withings_get_measures', {
        lastupdate: 1_700_000_000, startDate: '2020-01-01', endDate: '2020-02-01',
    }, 'u1');

    const p = lastCall().params;
    assert.strictEqual(p.get('lastupdate'), '1700000000');
    assert.strictEqual(p.get('startdate'), null);
    assert.strictEqual(p.get('enddate'), null);
});

test('a date window converts to epoch seconds when no lastupdate is given', async () => {
    reset();
    fx.fetchImpl = async () => ok({ measuregrps: [] });
    await withings.executeWithingsTool('withings_get_measures', { startDate: '2026-08-01', endDate: '2026-08-19' }, 'u1');
    const p = lastCall().params;
    assert.strictEqual(p.get('startdate'), String(Date.parse('2026-08-01') / 1000));
    assert.strictEqual(p.get('enddate'), String(Date.parse('2026-08-19') / 1000));
});

test('a millisecond timestamp passed as lastupdate is tolerated, not sent as-is', async () => {
    reset();
    fx.fetchImpl = async () => ok({ measuregrps: [] });
    await withings.executeWithingsTool('withings_get_measures', { lastupdate: 1_700_000_000_000 }, 'u1');
    assert.strictEqual(lastCall().params.get('lastupdate'), '1700000000');
});

test('sleep defaults to a 30-night window rather than letting Withings reject a bare call', async () => {
    reset();
    fx.fetchImpl = async () => ok({ series: [] });
    await withings.executeWithingsTool('withings_get_sleep_summary', {}, 'u1');
    const p = lastCall().params;
    assert.strictEqual(lastCall().url, 'https://wbsapi.withings.net/v2/sleep');
    assert.strictEqual(p.get('action'), 'getsummary');
    assert.match(p.get('startdateymd'), /^\d{4}-\d{2}-\d{2}$/);
    assert.match(p.get('enddateymd'), /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(p.get('data_fields').includes('deepsleepduration'));
});

test('activity posts to the v2 measure endpoint with getactivity', async () => {
    reset();
    fx.fetchImpl = async () => ok({ activities: [] });
    await withings.executeWithingsTool('withings_get_activity', { startDate: '2026-08-01', endDate: '2026-08-19' }, 'u1');
    const call = lastCall();
    assert.strictEqual(call.url, 'https://wbsapi.withings.net/v2/measure');
    assert.strictEqual(call.params.get('action'), 'getactivity');
    assert.strictEqual(call.params.get('startdateymd'), '2026-08-01');
    assert.strictEqual(call.params.get('enddateymd'), '2026-08-19');
});

test('the row limit is clamped to the module ceiling', async () => {
    reset();
    const many = Array.from({ length: 700 }, (_, i) => ({
        grpid: i, date: 1_700_000_000 + i, measures: [{ value: 800 + i, unit: -1, type: 1 }],
    }));
    fx.fetchImpl = async () => ok({ measuregrps: many });
    const out = await withings.executeWithingsTool('withings_get_measures', { limit: 5000 }, 'u1');
    assert.strictEqual(out.rowCount, 500);
    assert.strictEqual(out.truncated, true);
});

// ── Failure surfaces ─────────────────────────────────────────────────

test('a disconnected user gets a readable instruction, not a 401 stack', async () => {
    reset();
    fx.auth = null;
    const out = await withings.executeWithingsTool('withings_get_measures', {}, 'u1');
    assert.match(out.error, /not connected/i);
});

test('a refused envelope surfaces as an error result rather than throwing', async () => {
    reset();
    fx.fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ status: 401, error: 'invalid_token' }), text: async () => '' });
    const out = await withings.executeWithingsTool('withings_get_measures', {}, 'u1');
    assert.match(out.error, /status 401/);
});

test('tools refuse to run without a user id', async () => {
    const out = await withings.executeWithingsTool('withings_get_measures', {}, null);
    assert.match(out.error, /signed-in user/i);
});

test('an unknown tool name is reported, not silently ignored', async () => {
    const out = await withings.executeWithingsTool('withings_write_weight', {}, 'u1');
    assert.match(out.error, /Unknown Withings tool/);
});

// ── Catalog shape ────────────────────────────────────────────────────

test('every tool declares lastupdate as an integer so sync detects the request tier', () => {
    for (const t of withings.WITHINGS_TOOLS) {
        const p = t.function.parameters.properties.lastupdate;
        assert.ok(p, `${t.function.name} is missing lastupdate`);
        assert.strictEqual(p.type, 'integer');
    }
});

test('the toolset is read-only — no tool writes back to a medical account', () => {
    for (const t of withings.WITHINGS_TOOLS) {
        assert.match(t.function.name, /^withings_get_/);
    }
});

test('isWithingsTool matches the prefix the tool map registers', () => {
    assert.strictEqual(withings.isWithingsTool('withings_get_measures'), true);
    assert.strictEqual(withings.isWithingsTool('gamma_create'), false);
    assert.strictEqual(withings.isWithingsTool(null), false);
});
