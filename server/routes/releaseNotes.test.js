/**
 * Release notes routes — auth gates, ingest routing, and the publish boundary.
 *
 * Run: node --test routes/releaseNotes.test.js
 *
 * The store, the drafter and the admin gate are stubbed out of require.cache;
 * requests go over real HTTP against an ephemeral express listener. No DB, no
 * model call.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

// ── Stubs ──────────────────────────────────────────────────────────────
let calls = [];
let entries = [];

const storePath = require.resolve('../stores/releaseNotesStore');
require.cache[storePath] = {
    id: storePath, filename: storePath, loaded: true,
    exports: {
        upsertUnreleased: async (a) => { calls.push(['upsertUnreleased', a]); return { id: 'u1', ...a }; },
        finaliseRelease: async (a) => { calls.push(['finaliseRelease', a]); return { id: 'r1', ...a }; },
        listAll: async () => { calls.push(['listAll']); return entries; },
        listPublished: async () => {
            calls.push(['listPublished']);
            return entries.filter(e => e.status === 'published');
        },
        updateEntry: async (id, f) => { calls.push(['updateEntry', id, f]); return { id, ...f }; },
        publishEntry: async (id) => { calls.push(['publishEntry', id]); return { id, status: 'published' }; },
        unpublishEntry: async (id) => { calls.push(['unpublishEntry', id]); return { id, status: 'draft' }; },
        deleteEntry: async (id) => { calls.push(['deleteEntry', id]); return true; },
        STATUS_DRAFT: 'draft', STATUS_PUBLISHED: 'published',
    },
};

const drafterPath = require.resolve('../core/releaseNotesDrafter');
require.cache[drafterPath] = {
    id: drafterPath, filename: drafterPath, loaded: true,
    exports: {
        draftReleaseNotes: async (m) => {
            calls.push(['draft', m]);
            return { title: 'Drafted', lead: 'Lead', items: [{ kind: 'fix', title: 'A', body: 'B' }] };
        },
    },
};

let isAdmin = true;
const sharedPath = require.resolve('./cmsShared');
require.cache[sharedPath] = {
    id: sharedPath, filename: sharedPath, loaded: true,
    exports: {
        requireAdmin: (req, res, next) => (isAdmin ? next() : res.status(403).json({ error: 'Admin access required' })),
    },
};

const TOKEN = 'release-notes-test-token';
process.env.RELEASE_NOTES_TOKEN = TOKEN;

let server, base;

before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/release-notes', require('./releaseNotes'));
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}/api/release-notes`;
});

after(() => new Promise((r) => server.close(r)));

function reset() {
    calls = [];
    entries = [];
    isAdmin = true;
    require('./releaseNotes').invalidatePublicCache();
}

const post = (p, { token, body } = {}) => fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {}),
});

// ── The ingest token gate ──────────────────────────────────────────────

test('ingest without a token is rejected and writes nothing', async () => {
    reset();
    const res = await post('/ingest', { body: { channel: 'dev' } });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(calls.length, 0, 'a rejected call must not reach the store or the model');
});

test('ingest with a wrong token is rejected', async () => {
    reset();
    assert.strictEqual((await post('/ingest', { token: 'nope', body: {} })).status, 401);
});

test('a token of a different LENGTH is rejected, not crashed on', async () => {
    reset();
    // timingSafeEqual throws on a length mismatch; the length check must come
    // first or this is a 500 (and an oracle) instead of a clean 401.
    assert.strictEqual((await post('/ingest', { token: 'x', body: {} })).status, 401);
});

test('with no token configured, ingest is OFF rather than open', async () => {
    reset();
    const saved = process.env.RELEASE_NOTES_TOKEN;
    delete process.env.RELEASE_NOTES_TOKEN;
    try {
        const res = await post('/ingest', { body: { channel: 'dev' } });
        assert.strictEqual(res.status, 503);
    } finally {
        process.env.RELEASE_NOTES_TOKEN = saved;
    }
});

// ── Ingest routing: dev rolls, prod freezes ────────────────────────────

test('channel=dev refreshes the rolling Unreleased entry', async () => {
    reset();
    const res = await post('/ingest', {
        token: TOKEN,
        body: { channel: 'dev', commitSubjects: ['feat: x'], services: 'server' },
    });
    assert.strictEqual(res.status, 200);
    const names = calls.map(c => c[0]);
    assert.ok(names.includes('upsertUnreleased'), 'dev must upsert the rolling entry');
    assert.ok(!names.includes('finaliseRelease'), 'dev must not freeze a version');
});

test('channel=prod freezes the entry under its version', async () => {
    reset();
    const res = await post('/ingest', {
        token: TOKEN, body: { channel: 'prod', version: 'prod-2026.08.11-1', commitSubjects: ['feat: x'] },
    });
    assert.strictEqual(res.status, 200);
    const names = calls.map(c => c[0]);
    assert.ok(names.includes('finaliseRelease'));
    assert.ok(!names.includes('upsertUnreleased'));
});

test('prod without a version is a 400, not a nameless release', async () => {
    reset();
    const res = await post('/ingest', { token: TOKEN, body: { channel: 'prod' } });
    assert.strictEqual(res.status, 400);
});

test('an unknown channel is rejected', async () => {
    reset();
    assert.strictEqual((await post('/ingest', { token: TOKEN, body: { channel: 'staging' } })).status, 400);
});

// ── CI-drafted entries ─────────────────────────────────────────────────
// The workflow drafts with Claude when it has a key, so the notes exist in
// time for the GitHub Release body. The server then stores instead of drafting.

test('a supplied entry is stored as-is and costs no model call', async () => {
    reset();
    const res = await post('/ingest', {
        token: TOKEN,
        body: {
            channel: 'dev',
            commitSubjects: ['feat: x'],
            entry: { title: 'From CI', lead: 'Drafted on the runner.', items: [{ kind: 'feature', title: 'A', body: 'B' }] },
        },
    });

    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.draftedBy, 'ci');
    assert.ok(!calls.some(c => c[0] === 'draft'), 'a supplied entry must not trigger a model call');

    const upsert = calls.find(c => c[0] === 'upsertUnreleased');
    assert.strictEqual(upsert[1].title, 'From CI');
    assert.deepStrictEqual(upsert[1].items, [{ kind: 'feature', title: 'A', body: 'B' }]);
});

test('WITHOUT an entry the server still drafts — the fallback must not rot', async () => {
    reset();
    const res = await post('/ingest', {
        token: TOKEN, body: { channel: 'dev', commitSubjects: ['feat: x'] },
    });
    assert.strictEqual((await res.json()).draftedBy, 'server');
    assert.ok(calls.some(c => c[0] === 'draft'), 'no entry means the server drafts');
});

test('A SUPPLIED ENTRY IS NOT TRUSTED — it is re-coerced like model output', async () => {
    reset();
    await post('/ingest', {
        token: TOKEN,
        body: {
            channel: 'dev',
            entry: {
                title: 'T'.repeat(400),
                items: [
                    { kind: 'sneaky', title: 'A', body: 'B' },
                    { kind: 'fix', status: 'published', title: 'C', body: 'D' },
                ],
            },
        },
    });

    const stored = calls.find(c => c[0] === 'upsertUnreleased')[1];
    assert.strictEqual(stored.title.length, 120, 'an unbounded title must be capped');
    assert.strictEqual(stored.items[0].kind, 'improvement', 'an unknown kind is filed, not honoured');
    // A token holder must not be able to smuggle fields past the human gate.
    assert.deepStrictEqual(Object.keys(stored.items[1]).sort(), ['body', 'kind', 'title']);
});

test('an empty CI draft is stored as empty, not treated as "no entry"', async () => {
    reset();
    // The runner writes notes.json with no items when the range has nothing
    // user-visible. That is an answer, not a gap — re-drafting it server-side
    // would spend a model call to be told the same thing.
    const res = await post('/ingest', {
        token: TOKEN,
        body: { channel: 'dev', commitSubjects: ['chore: bump'], entry: { title: '', lead: '', items: [] } },
    });
    assert.strictEqual((await res.json()).itemCount, 0);
    assert.ok(!calls.some(c => c[0] === 'draft'));
});

// ── THE PUBLISH BOUNDARY ───────────────────────────────────────────────

test('AN INGESTED ENTRY IS NOT PUBLIC — the whole point of the human gate', async () => {
    reset();
    await post('/ingest', { token: TOKEN, body: { channel: 'dev', commitSubjects: ['feat: x'] } });
    // The stub records what ingest asked for; nothing set status='published'.
    const upsert = calls.find(c => c[0] === 'upsertUnreleased');
    assert.ok(upsert, 'ingest should have written a draft');
    assert.notStrictEqual(upsert[1].status, 'published');

    // And the public endpoint returns nothing, because listPublished filters.
    const got = await (await fetch(`${base}/public`)).json();
    assert.deepStrictEqual(got.entries, []);
});

test('/public serves published entries and hides build metadata', async () => {
    reset();
    entries = [{
        id: 'e1', version: 'v1', status: 'published', title: 'T', lead: 'L', items: [],
        publishedAt: '2026-08-11T00:00:00.000Z',
        fromSha: 'aaa', toSha: 'bbb', services: 'server,agent-hub',
    }];
    const got = await (await fetch(`${base}/public`)).json();
    assert.strictEqual(got.entries.length, 1);
    assert.strictEqual(got.entries[0].title, 'T');
    for (const leaked of ['fromSha', 'toSha', 'services']) {
        assert.ok(!(leaked in got.entries[0]), `${leaked} is build metadata and must not be public`);
    }
});

test('/public reads through listPublished, never listAll', async () => {
    reset();
    await fetch(`${base}/public`);
    const names = calls.map(c => c[0]);
    assert.ok(names.includes('listPublished'));
    assert.ok(!names.includes('listAll'), 'the public path must never touch the unfiltered list');
});

test('/public is cached — a second hit does not re-query', async () => {
    reset();
    await fetch(`${base}/public`);
    await fetch(`${base}/public`);
    assert.strictEqual(calls.filter(c => c[0] === 'listPublished').length, 1);
});

test('publishing invalidates the public cache', async () => {
    reset();
    await fetch(`${base}/public`);
    await post('/admin/e1/publish', {});
    await fetch(`${base}/public`);
    assert.strictEqual(calls.filter(c => c[0] === 'listPublished').length, 2);
});

// ── Admin gate ─────────────────────────────────────────────────────────

test('admin routes are closed to non-admins', async () => {
    reset();
    isAdmin = false;
    assert.strictEqual((await fetch(`${base}/admin`)).status, 403);
    assert.strictEqual((await post('/admin/e1/publish', {})).status, 403);
});

test('publish moves an entry and reports it', async () => {
    reset();
    const res = await post('/admin/e1/publish', {});
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.entry.status, 'published');
});

test('a non-array items payload is rejected', async () => {
    reset();
    const res = await fetch(`${base}/admin/e1`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: 'nope' }),
    });
    assert.strictEqual(res.status, 400);
});
