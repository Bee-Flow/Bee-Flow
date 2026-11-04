'use strict';

/**
 * PATCH /api/transcriptions/:id — routes/transcriptions/noteActions.js.
 *
 * What this route may write, and in what shape (M3). Three things are pinned:
 *
 *  1. `actionItems` is VALIDATED. It used to reach the JSONB column raw, which
 *     is why routes/transcriptions/tags.js:54-60 names this route as the reason
 *     the tag list defends itself in SQL. A body this server cannot understand
 *     is a 400 — never a silently emptied or half-shaped column.
 *  2. `decisions` and `questions` are accepted at all. The store could write
 *     them since the artifacts landed; only this route could not say so, so a
 *     corrected decision had no way home short of a full regenerate.
 *  3. What comes back is the CLEANED list, so the client's optimistic copy
 *     (items it minted itself, with no id) converges on the server's.
 *
 * Drives the REAL sub-router with require-cache-stubbed collaborators and the
 * same stubbed req/res dispatch harness as transcriptions.regenerate.test.js —
 * no HTTP listener, no DB. core/meetingNotes/actionItems.js is deliberately NOT
 * stubbed: the validation rules themselves are what is being asserted.
 *
 * Run: cd server && node --test --test-force-exit routes/transcriptions/noteActions.patch.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

/** Every updateTranscription the route makes: { id, userId, updates }. */
const updateCalls = [];
/** false models "not your note" — the store's WHERE user_id clause answering 0 rows. */
let updateWrites = true;

/** What getTranscription returns (null = unreadable). */
let storedNote = null;
/** Tags handed to the knowledge-source re-arm. */
const armed = [];
stub('../../stores/transcriptionStore', {
    updateTranscription: async (id, userId, updates) => {
        updateCalls.push({ id, userId, updates });
        return updateWrites;
    },
    getTranscription: async () => storedNote,
    deleteTranscription: async () => true,
    setPublished: async () => true,
});
stub('../../stores/kbSources', { armMeetingSourcesForRemoval: async (tags) => { armed.push(tags); return 1; } });
stub('../../stores/projectTaskStore', { dropLinksTo: async () => 0 });
stub('../../core/llm/llmClient', { chat: async () => ({ content: '' }) });
stub('../../auth/permissions', {
    requireAuth: (req, res, next) => (req.session?.user?.id ? next() : res.status(401).json({ error: 'Authentication required' })),
});
stub('./shared', {
    resolveAccessContext: async () => ({ orgIds: [], userGroupIds: [], isSuperAdmin: false }),
    resolveUserOrgFromReq: async () => 'org-1',
});
stub('../../core/meetingNotes/summaryHelpers', {
    resolveSmartModel: async () => 'model',
    extractMeetingArtifacts: async () => ({ actionItems: [], decisions: [], questions: [], tags: [] }),
    generateChapters: async () => [],
    generateSpeakerSummaries: async () => ({}),
    applySpeakerSummaries: (s) => s,
    SUMMARY_MAX_TOKENS: 8192,
});
stub('../../stores/summaryTemplateStore', { getById: async () => null });

const router = require('./noteActions');

const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method = 'PATCH', url = '/t-1', user = 'owner-1', body }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, query: {}, headers: {},
            session: user ? { isAuthenticated: true, user: { id: user } } : null,
            get(name) { return this.headers[String(name).toLowerCase()]; },
            setTimeout() {},
        };
        if (body !== undefined) req.body = body;
        const res = {
            statusCode: 200, headers: {}, body: undefined,
            set(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
            setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
            setTimeout() {},
        };
        // `next(err)` is not a fall-through: a request schema refuses by
        // handing the error to the terminal handler (core/http/validate), so
        // that handler sits behind the router here exactly as in index.js.
        // Without it a refused request would read as a thrown test.
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through router: ${method} ${url}`));
            return terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => {
    updateCalls.length = 0;
    updateWrites = true;
    storedNote = null;
    armed.length = 0;
});

const lastUpdates = () => updateCalls[updateCalls.length - 1].updates;

// ── Nothing to do ───────────────────────────────────────────────────

test('an empty body is a 400 and never a write', async () => {
    const res = await dispatch({ body: {} });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(updateCalls.length, 0);
});

test('a title-only rename still works', async () => {
    const res = await dispatch({ body: { title: 'Weekstart' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(lastUpdates(), { title: 'Weekstart' });
});

// ── actionItems are validated ───────────────────────────────────────

test('a non-array actionItems is refused and NOTHING is written', async () => {
    const res = await dispatch({ body: { actionItems: 'urgent' } });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /actionItems must be an array/);
    assert.strictEqual(updateCalls.length, 0, 'a bad body must not reach the column');
});

test('an item with no text is refused, with the index that is wrong', async () => {
    const res = await dispatch({ body: { actionItems: [{ text: 'ok' }, { assignee: 'Tom' }] } });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /actionItems\[1\]\.text/);
    assert.strictEqual(updateCalls.length, 0);
});

test('an unknown destination kind is refused — no chip the UI cannot resolve', async () => {
    const res = await dispatch({
        body: { actionItems: [{ text: 'Taak', destination: { kind: 'cowork_task', ref: 't-1' } }] },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /destination\.kind/);
    assert.strictEqual(updateCalls.length, 0);
});

test('a valid destination is stored allow-listed, with a server stamp', async () => {
    const res = await dispatch({
        body: {
            actionItems: [{
                id: 'u-1', source: 'user', text: 'Weging draaien', done: false,
                destination: { kind: 'automation', ref: 'aut-7', label: 'Weging', runId: 'run-9' },
            }],
        },
    });
    assert.strictEqual(res.statusCode, 200);
    const [item] = lastUpdates().actionItems;
    assert.deepStrictEqual(Object.keys(item.destination).sort(), ['at', 'kind', 'label', 'ref']);
    assert.strictEqual(item.destination.kind, 'automation');
    assert.strictEqual(item.destination.ref, 'aut-7');
    assert.ok(Number.isFinite(Date.parse(item.destination.at)));
});

test('an item from a client that sends no id gets one, and is marked as the user\'s', async () => {
    // The Android client PATCHes the whole array with no `id` on the items.
    const res = await dispatch({ body: { actionItems: [{ text: 'Bel de klant', done: true }] } });
    assert.strictEqual(res.statusCode, 200);
    const [item] = lastUpdates().actionItems;
    assert.ok(item.id);
    assert.strictEqual(item.source, 'user');
    assert.strictEqual(item.done, true);
});

test('unknown keys on an item never reach the column', async () => {
    await dispatch({ body: { actionItems: [{ id: 'ai-0', source: 'ai', text: 'Punt', secret: 'x' }] } });
    assert.deepStrictEqual(Object.keys(lastUpdates().actionItems[0]).sort(), ['done', 'id', 'source', 'text']);
});

// ── decisions and questions ─────────────────────────────────────────

test('decisions and questions are accepted, not ignored', async () => {
    const res = await dispatch({
        body: {
            decisions: [{ id: 'd-0', text: 'Plan A goedgekeurd', timestamp: '00:10' }],
            questions: [{ id: 'q-0', text: 'Wie regelt de licentie?' }],
        },
    });
    assert.strictEqual(res.statusCode, 200);
    const updates = lastUpdates();
    // `source` joined the shape in M4, derived from the extractor's `d-<n>` /
    // `q-<n>` namespace rather than defaulted — it is what keeps a decision a
    // person picked off a transcript line out of the next regenerate's way.
    assert.deepStrictEqual(updates.decisions, [{ id: 'd-0', text: 'Plan A goedgekeurd', source: 'ai', timestamp: '00:10' }]);
    assert.strictEqual(updates.questions[0].open, true, 'a question with no `open` is open');
    assert.strictEqual(updates.questions[0].source, 'ai');
});

test('a decision the transcript popover wrote keeps its line and its provenance', async () => {
    // What the per-line "Besluit" sends: no id (the server mints one outside
    // the extractor namespace), marked as the person's, anchored to a line.
    const res = await dispatch({
        body: { decisions: [{ text: 'We gaan met leverancier B verder', source: 'user', segmentIndex: 12, timestamp: '12:34' }] },
    });
    assert.strictEqual(res.statusCode, 200);
    const [decision] = lastUpdates().decisions;
    assert.strictEqual(decision.source, 'user');
    assert.strictEqual(decision.segmentIndex, 12);
    assert.ok(!/^d-\d+$/.test(decision.id), 'and never wears an id the next regenerate would delete');
    // The client's optimistic copy has no id yet; the answer carries the
    // cleaned list so it does not render one it minted itself.
    assert.strictEqual(res.body.decisions[0].id, decision.id);
});

test('a malformed decision is a 400, like an action item', async () => {
    const res = await dispatch({ body: { decisions: [{ timestamp: '00:10' }] } });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /decisions\[0\]\.text/);
    assert.strictEqual(updateCalls.length, 0);
});

// ── tags ────────────────────────────────────────────────────────────

test('tags are cleaned to strings and deduplicated', async () => {
    await dispatch({ body: { tags: ['sales', ' sales ', { evil: 1 }, '', 'weging'] } });
    assert.deepStrictEqual(lastUpdates().tags, ['sales', 'weging']);
});

test('a non-array tags is refused', async () => {
    const res = await dispatch({ body: { tags: 'sales' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(updateCalls.length, 0);
});

// ── ownership + the answer ──────────────────────────────────────────

test('a note the caller does not own answers 404 — the store\'s WHERE decides', async () => {
    updateWrites = false;
    const res = await dispatch({ body: { title: 'Van iemand anders' } });
    assert.strictEqual(res.statusCode, 404);
});

test('an anonymous request never reaches the handler', async () => {
    const res = await dispatch({ user: null, body: { title: 'x' } });
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(updateCalls.length, 0);
});

test('the answer carries the cleaned lists back for the client to adopt', async () => {
    const res = await dispatch({ body: { actionItems: [{ text: 'Bel de klant' }] } });
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.actionItems.length, 1);
    assert.ok(res.body.actionItems[0].id, 'the id the server minted, so the client stops using its own');
});


// ── Export, delete, publish ─────────────────────────────────────────

test('export: an action item without an assignee has no "(undefined)", and any title is a valid file name', async () => {
    storedNote = {
        id: 't-1', title: 'Overleg – Q3 🚀', durationSeconds: 60, speakers: [],
        summary: 'S', transcript: 'T',
        actionItems: [
            { text: 'Send the quote', done: false, timestamp: '00:12' },
            { text: 'Book the room', assignee: 'Tom', done: true },
        ],
    };
    const http = require('http');
    for (const format of ['md', 'txt']) {
        const req = { method: 'GET', url: `/t-1/export?format=${format}` };
        const res = await new Promise((resolve, reject) => {
            const r = {
                statusCode: 200, headers: {}, body: undefined,
                setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
                status(c) { this.statusCode = c; return this; },
                json(b) { this.body = b; resolve(this); return this; },
                send(b) { this.body = b; resolve(this); return this; },
            };
            router({ ...req, query: { format }, headers: {}, session: { isAuthenticated: true, user: { id: 'owner-1' } }, get() { return undefined; } }, r, (e) => reject(e || new Error('fell through')));
        });
        assert.strictEqual(res.statusCode, 200);
        assert.doesNotMatch(res.body, /undefined/);
        assert.match(res.body, /Send the quote/);
        assert.match(res.body, /Book the room \(Tom\)/);
        assert.doesNotThrow(() => http.validateHeaderValue('Content-Disposition', res.headers['content-disposition']));
        assert.match(res.headers['content-disposition'], new RegExp(`filename\\*=UTF-8''Overleg%20%E2%80%93%20Q3%20%F0%9F%9A%80\\.${format}$`));
    }
});

test('delete: the knowledge sources that collected the meeting by tag are armed to drop it', async () => {
    storedNote = { id: 't-1', isOwner: true, tags: ['sales', 'q3'] };
    const req = { method: 'DELETE', url: '/t-1?confirm=true', query: { confirm: 'true' }, headers: {}, session: { isAuthenticated: true, user: { id: 'owner-1' } }, get() { return undefined; } };
    const res = await new Promise((resolve, reject) => {
        const r = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; resolve(this); return this; }, setHeader() {} };
        router(req, r, (e) => reject(e || new Error('fell through')));
    });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(armed, [['sales', 'q3']]);
});

test('a removed tag arms the sources of that tag; an added one does not', async () => {
    storedNote = { id: 't-1', isOwner: true, tags: ['sales', 'intern'] };
    const res = await dispatch({ body: { tags: ['intern', 'planning'] } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(armed, [['sales']]);
});

test('unpublishing arms the sources of the note\'s tags', async () => {
    storedNote = { id: 't-1', isOwner: true, isPublished: true, organizationId: 'org-1', tags: ['sales'] };
    const res = await dispatch({ method: 'PATCH', url: '/t-1/publish', body: { isPublished: false } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(armed, [['sales']]);
});
