'use strict';

/**
 * GET /api/automation?triggerProvider=<id> (M2).
 *
 * The meeting-notes outputs bar asks "which of my automations run on this?" and
 * this is the narrowing it uses. Two failures are pinned here:
 *
 *  - AN UNKNOWN PROVIDER MUST BE A 400. `meeting_notes` with an underscore is
 *    the live example: PROVIDER_ID_RE rejects underscores, so that source was
 *    never registered and the spec's spelling matches nothing. A filter that
 *    fell back to the unfiltered list on a typo would hand a "automations on this
 *    meeting" panel every automation the caller owns — a wrong answer that looks
 *    like a right one.
 *  - THE FILTER MUST SEE EVERY app_event TRIGGER, primary and `triggers[]`.
 *    An automation whose meeting trigger is the second one is still an automation that
 *    fires.
 *
 * Route handler invoked directly — same technique as crud.multiTrigger.test.js.
 *
 * Run: cd server && node --test --test-force-exit routes/automation/crud.triggerProvider.test.js
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

let LIST = [];
mock(path.join(SERVER, 'stores/automationStore'), {
    getAutomationsForUser: async () => LIST,
});
mock(path.join(SERVER, 'automation/cron'), { nextRunAt: () => null });
mock(path.join(SERVER, 'automation/validate'), { validateDefinition: () => ({ ok: true, warnings: [] }) });
mock(path.join(SERVER, 'automation/summarise'), { summariseDefinition: () => ({ summary: '' }) });
mock(path.join(SERVER, 'automation/deliverableEvents'), { getDeliverableEvents: () => [] });
mock(path.join(SERVER, 'automation/toolRegistry'), { TOOL_REGISTRY: [], loadTools: () => [] });
mock(path.join(SERVER, 'automation/triggerBus'), { getPublicBaseUrl: () => null, dispatchEvent: async () => [] });
mock(path.join(SERVER, 'utils/perUserRateLimit'), { perUserRateLimit: () => (req, res, next) => next() });

// The trigger-source registry is used FOR REAL: the whole point of the check
// is that it answers over what this install actually declares, and stubbing it
// would test the stub. declared/meeting-notes.js is a static file, so this is
// a pure read.
const { getTriggerSource } = require(path.join(SERVER, 'automation/triggerSources'));

const router = require('./crud');

function dispatch({ url, user = 'u1' }) {
    return new Promise((resolve, reject) => {
        const [pathname, search] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search || '')) query[k] = v;
        const req = {
            method: 'GET', url, originalUrl: url, path: pathname, query, headers: {}, body: {},
            session: { isAuthenticated: true, user: { id: user } },
            get() {}, setTimeout() {},
        };
        const res = {
            statusCode: 200, body: undefined,
            set() { return this; }, setHeader() {},
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
            setTimeout() {},
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: GET ${url}`));
            // A schema refusal reaches the client as an error, so the harness
            // answers it the way index.js does.
            require('../../core/http/terminalErrorHandler').terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

const appEvent = (provider, event, id = 'trg') => ({ id, type: 'trigger', kind: 'app_event', appEvent: { provider, event } });
const auto = (id, definition) => ({ id, title: id, userId: 'u1', definition });

test('the provider actually registered is meeting-notes, with a hyphen', () => {
    // If this ever flips, the spec's `meeting_notes` becomes right and every
    // comment in M2 becomes wrong — better to find out here.
    assert.ok(getTriggerSource('meeting-notes'), 'meeting-notes must be a declared source');
    assert.strictEqual(getTriggerSource('meeting_notes'), null, 'the underscore form is not a provider');
});

test('no triggerProvider → the list is untouched', async () => {
    LIST = [auto('a1', { trigger: appEvent('gmail', 'mail.new') })];
    const res = await dispatch({ url: '/' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.automations.length, 1);
});

test('filters to the automations wired to that provider', async () => {
    LIST = [
        auto('meeting', { trigger: appEvent('meeting-notes', 'meeting.processed') }),
        auto('gmail', { trigger: appEvent('gmail', 'mail.new') }),
        auto('manual', { trigger: { id: 't', kind: 'manual' } }),
        auto('no-definition', undefined),
    ];
    const res = await dispatch({ url: '/?triggerProvider=meeting-notes' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.automations.map(a => a.id), ['meeting']);
});

test('a meeting trigger in triggers[] counts, not just the primary one', async () => {
    LIST = [auto('second', {
        trigger: appEvent('gmail', 'mail.new', 'a'),
        triggers: [appEvent('meeting-notes', 'meeting.processed', 'b')],
    })];
    const res = await dispatch({ url: '/?triggerProvider=meeting-notes' });
    assert.deepStrictEqual(res.body.automations.map(a => a.id), ['second']);
});

test('AN UNKNOWN PROVIDER IS 400 — never a quietly unfiltered list', async () => {
    LIST = [auto('a1', { trigger: appEvent('meeting-notes', 'meeting.processed') })];
    for (const bad of ['meeting_notes', 'nope', 'MEETING-NOTES']) {
        const res = await dispatch({ url: `/?triggerProvider=${encodeURIComponent(bad)}` });
        assert.strictEqual(res.statusCode, 400, bad);
        assert.ok(!res.body.automations, `${bad}: no list may come back`);
    }
});

test('an empty triggerProvider is 400, not "no filter"', async () => {
    LIST = [auto('a1', { trigger: appEvent('meeting-notes', 'meeting.processed') })];
    for (const url of ['/?triggerProvider=', '/?triggerProvider=%20']) {
        const res = await dispatch({ url });
        assert.strictEqual(res.statusCode, 400, url);
    }
});

test('triggerEvent narrows further, and an unknown event is 400', async () => {
    LIST = [
        auto('processed', { trigger: appEvent('meeting-notes', 'meeting.processed') }),
        auto('other', { trigger: appEvent('meeting-notes', 'meeting.something-else') }),
    ];
    const ok = await dispatch({ url: '/?triggerProvider=meeting-notes&triggerEvent=meeting.processed' });
    assert.deepStrictEqual(ok.body.automations.map(a => a.id), ['processed']);

    const bad = await dispatch({ url: '/?triggerProvider=meeting-notes&triggerEvent=meeting.invented' });
    assert.strictEqual(bad.statusCode, 400);
});

test('a repeated parameter (an array, not a string) is refused rather than coerced', async () => {
    // Express gives `?triggerProvider=a&triggerProvider=b` as an array. Naive
    // comparison against it is always false, which would look like "no
    // automations" instead of a bad request.
    LIST = [auto('a1', { trigger: appEvent('meeting-notes', 'meeting.processed') })];
    const res = await dispatch({ url: '/' });
    // The URLSearchParams harness collapses duplicates, so drive the shape
    // directly: an array must not reach the comparison.
    const direct = await new Promise((resolve) => {
        const req = {
            method: 'GET', url: '/', path: '/', query: { triggerProvider: ['meeting-notes', 'gmail'] },
            headers: {}, body: {}, session: { user: { id: 'u1' } }, get() {}, setTimeout() {},
        };
        const rs = {
            statusCode: 200, body: undefined, set() { return this; }, setHeader() {},
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; }, send() {}, end() {}, setTimeout() {},
        };
        router(req, rs, (err) => {
            if (err) require('../../core/http/terminalErrorHandler').terminalErrorHandler(err, req, rs, () => resolve(rs));
            else resolve(rs);
        });
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(direct.statusCode, 400);
});
