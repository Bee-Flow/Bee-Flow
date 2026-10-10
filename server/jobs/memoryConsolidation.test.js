'use strict';

/**
 * Nightly consolidation with injected dependencies (no module mocks).
 *
 * Run: cd server && node --test jobs/memoryConsolidation.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createConsolidation, MERGE_AT, FIRST_RUN_DELAY_MS, parseReview, REVIEW_SYSTEM_PROMPT } = require('./memoryConsolidation');

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const NOW = Date.parse('2026-10-10T00:00:00Z');
const day = 86400000;

function world(rows, sims = {}, lexical = {}, opts = {}) {
    const state = { rows: rows.map((r) => ({ status: 'active', type: 'fact', origin: 'inferred', project_id: null, agent_id: null, importance: 0.7, ...r })), cursor: '', archivedCalls: [] };
    const active = () => state.rows.filter((r) => r.status === 'active');
    const deps = {
        log: silent,
        now: () => NOW,
        listUsers: async (after, limit) => [...new Set(active().filter((r) => r.origin === 'inferred' && r.user_id > (after || '')).map((r) => r.user_id))].sort().slice(0, limit),
        listActiveInferred: async (u) => active().filter((r) => r.user_id === u && r.origin === 'inferred' && r.type !== 'instruction').sort((a, b) => b.created_at - a.created_at),
        listForQuality: async (u) => (opts.quality ? active().filter((r) => r.user_id === u && r.origin === 'inferred').sort((a, b) => b.created_at - a.created_at) : []),
        findStaleIds: async (u, cutoff) => active().filter((r) => r.user_id === u && r.origin === 'inferred' && r.type !== 'instruction' && r.importance < 0.5 && (r.last_used_at ?? r.created_at) < cutoff.getTime()).map((r) => r.id),
        findSimilarMemories: async (u, content) => {
            const me = state.rows.find((r) => r.content === content);
            return active().filter((r) => r.user_id === u && r.id !== me.id).map((r) => {
                const key = [me.id, r.id].sort().join('|');
                const cosine = sims[key] ?? 0.1;
                const lex = lexical[key] ?? 0;
                return { ...r, similarity: Math.max(cosine, lex), cosine: key in sims ? cosine : (lex ? null : 0.1), lexical: lex };
            });
        },
        supersede: async (o, n) => { const r = state.rows.find((x) => x.id === o); if (r.status !== 'active') return 0; r.status = 'superseded'; r.superseded_by = n; return 1; },
        archive: async (ids) => { state.archivedCalls.push(ids); for (const id of ids) state.rows.find((x) => x.id === id).status = 'archived'; return ids.length; },
        reviewContext: async () => ({ allowed: false }),
        listForReview: async () => [],
        getCursor: async () => state.cursor,
        setCursor: async (v) => { state.cursor = v; },
    };
    return { state, run: (opts) => createConsolidation(deps).runOnce(opts), deps };
}

const R = (id, over) => ({ id, user_id: 'u1', content: `text ${id}`, created_at: NOW - 10 * day, ...over });
const statusOf = (w, id) => w.state.rows.find((r) => r.id === id).status;

test('near-duplicates merge: the older row is superseded by the newer', async () => {
    const w = world([R('old', { created_at: NOW - 30 * day }), R('new')], { 'new|old': 0.97 });
    const out = await w.run();
    assert.equal(out.merged, 1);
    assert.equal(statusOf(w, 'old'), 'superseded');
    assert.equal(w.state.rows.find((r) => r.id === 'old').superseded_by, 'new');
    assert.equal(statusOf(w, 'new'), 'active');
});

test('a high LEXICAL score alone never merges (opposite meaning, same words)', async () => {
    const w = world([
        R('old', { content: 'Prefers Python over Java', created_at: NOW - 30 * day }),
        R('new', { content: 'Prefers Java over Python' }),
    ], {}, { 'new|old': 1 });
    const out = await w.run();
    assert.equal(out.merged, 0);
    assert.equal(statusOf(w, 'old'), 'active');
});

test('identical normalised text merges even without a vector', async () => {
    const w = world([
        R('old', { content: 'Likes  tea', created_at: NOW - 30 * day }),
        R('new', { content: 'likes tea' }),
    ], {}, { 'new|old': 1 });
    assert.equal((await w.run()).merged, 1);
});

test('below the threshold, another type or another scope: no merge', async () => {
    const w = world([
        R('a', { created_at: NOW - 30 * day }), R('b'),
        R('c', { type: 'preference', created_at: NOW - 20 * day }),
        R('d', { project_id: 'p1', created_at: NOW - 25 * day }),
    ], { 'a|b': MERGE_AT - 0.01, 'b|c': 0.99, 'b|d': 0.99, 'a|c': 0.99, 'a|d': 0.99, 'c|d': 0.99 });
    const out = await w.run();
    assert.equal(out.merged, 0);
});

test('a chain of three collapses into the newest without double work', async () => {
    const w = world([R('x1', { created_at: NOW - 30 * day }), R('x2', { created_at: NOW - 20 * day }), R('x3')],
        { 'x1|x2': 0.97, 'x2|x3': 0.97, 'x1|x3': 0.97 });
    await w.run();
    assert.deepEqual(['x1', 'x2', 'x3'].map((id) => statusOf(w, id)), ['superseded', 'superseded', 'active']);
});

test('stale, unimportant inferred rows are archived; important or recent ones stay', async () => {
    const w = world([
        R('stale', { importance: 0.3, created_at: NOW - 400 * day }),
        R('stale-but-used', { importance: 0.3, created_at: NOW - 400 * day, last_used_at: NOW - 5 * day }),
        R('stale-important', { importance: 0.8, created_at: NOW - 400 * day }),
        R('recent', { importance: 0.3 }),
    ]);
    const out = await w.run();
    assert.equal(out.archived, 1);
    assert.equal(statusOf(w, 'stale'), 'archived');
    for (const id of ['stale-but-used', 'stale-important', 'recent']) assert.equal(statusOf(w, id), 'active');
});

test('explicit rows and instructions are never touched', async () => {
    const w = world([
        R('e', { origin: 'explicit', importance: 0.1, created_at: NOW - 900 * day }),
        R('i', { type: 'instruction', importance: 0.1, created_at: NOW - 900 * day }),
        R('e2', { origin: 'explicit', content: 'text e2' }),
    ], { 'e|e2': 0.99 });
    await w.run();
    assert.deepEqual(['e', 'i', 'e2'].map((id) => statusOf(w, id)), ['active', 'active', 'active']);
});

test('a second run changes nothing', async () => {
    const w = world([R('old', { created_at: NOW - 30 * day }), R('new'), R('stale', { importance: 0.2, created_at: NOW - 500 * day })], { 'new|old': 0.97 });
    await w.run();
    const snapshot = JSON.stringify(w.state.rows);
    const out = await w.run();
    assert.deepEqual([out.merged, out.archived], [0, 0]);
    assert.equal(JSON.stringify(w.state.rows), snapshot);
});

test('the budget stops the run and the cursor resumes it', async () => {
    const rows = ['u1', 'u2', 'u3'].map((u) => R(`r-${u}`, { user_id: u }));
    const w = world(rows);
    let clock = NOW;
    let seen = [];
    w.deps.now = () => clock;
    const base = w.deps.findStaleIds;
    w.deps.findStaleIds = async (u, c) => { seen.push(u); clock += 1000; return base(u, c); };
    const c = createConsolidation(w.deps);
    const first = await c.runOnce({ budgetMs: 1500 });
    assert.equal(first.wrapped, false);
    assert.deepEqual(seen, ['u1', 'u2']);
    assert.equal(w.state.cursor, 'u2');
    seen = [];
    const second = await c.runOnce({ budgetMs: 100000 });
    assert.deepEqual(seen, ['u3']);
    assert.equal(second.wrapped, true);
    assert.equal(w.state.cursor, '', 'a finished lap starts over next night');
});

test('one failing user does not stop the others', async () => {
    const w = world([R('a', { user_id: 'u1' }), R('b', { user_id: 'u2' })]);
    let first = true;
    const base = w.deps.findStaleIds;
    w.deps.findStaleIds = async (...a) => { if (first) { first = false; throw new Error('boom'); } return base(...a); };
    const out = await createConsolidation(w.deps).runOnce();
    assert.equal(out.users, 2);
});

// ── Quality pass ─────────────────────────────────────────────────────────────

test('quality pass archives junk and exact duplicates, keeps real facts', async () => {
    const junk = [
        'Include:', 'ik zie het nog niet', 'Kan je een powerpoint maken in nextcloud met 1 slide.',
        'Can you creat a great seo blog about the use of ai and data complaince', 'final',
    ];
    const keep = [
        'User communicates in Dutch and expects responses in Dutch',
        'Het e-mailadres van de gebruiker is jan@example.nl',
        'User enjoys being surprised with creative, entertaining builds',
    ];
    const rows = [
        ...junk.map((content, i) => R(`j${i}`, { content })),
        ...keep.map((content, i) => R(`k${i}`, { content })),
        R('dupOld', { content: 'AI App Designer', created_at: NOW - 20 * day }),
        R('dupNew', { content: 'ai  app designer', created_at: NOW - 2 * day }),
        R('explicit', { content: 'final', origin: 'explicit' }),
        R('instr', { content: 'Include:', type: 'instruction' }),
        R('instrFrag', { content: 'Ik zie het nog niet', type: 'instruction' }),
        R('instrShort', { content: 'Be brief', type: 'instruction' }),
        R('instrOk', { content: 'Write shorter answers and use bullet points', type: 'instruction' }),
        R('instrExplicit', { content: 'Include:', type: 'instruction', origin: 'explicit' }),
    ];
    const w = world(rows, {}, {}, { quality: true });
    const out = await w.run();
    assert.equal(out.cleaned, 9);
    for (let i = 0; i < junk.length; i++) assert.equal(statusOf(w, `j${i}`), 'archived', junk[i]);
    assert.equal(statusOf(w, 'dupOld'), 'archived');
    assert.equal(statusOf(w, 'dupNew'), 'active', 'the newest duplicate stays');
    for (let i = 0; i < keep.length; i++) assert.equal(statusOf(w, `k${i}`), 'active', keep[i]);
    assert.equal(statusOf(w, 'explicit'), 'active');
    // Inferred instructions: strict junk rules only (the imperative task-verb rule would hit good ones).
    for (const id of ['instr', 'instrFrag', 'instrShort']) assert.equal(statusOf(w, id), 'archived', id);
    assert.equal(statusOf(w, 'instrOk'), 'active');
    assert.equal(statusOf(w, 'instrExplicit'), 'active');
    const again = await w.run();
    assert.equal(again.cleaned, 0, 'idempotent');
});

test('the same text in another scope is not a duplicate', async () => {
    const w = world([
        R('a', { content: 'AI App Designer', project_id: 'p1' }),
        R('b', { content: 'AI App Designer', project_id: 'p2' }),
    ], {}, {}, { quality: true });
    const out = await w.run();
    assert.equal(out.cleaned, 0);
});

test('the first pass is scheduled about a minute after boot, not ten', () => {
    assert.equal(FIRST_RUN_DELAY_MS, 60 * 1000);
});

// ── LLM review pass ──────────────────────────────────────────────────────────

const JUNK = [
    'Hier word een datatable g gemaakt', 'Vervolgens word er een automations g gemaakt', 'Dan wordt de app g gemaakt',
    'Playbook', 'AI App Designer',
    'Om hem direct in Nextcloud te openen (zodat je hem in Nextcloud Office kunt bewerken), moet ik een extra stap zetten.',
    'Bee Flow + Tom & Ewoud, manual vs automated process',
];
const REAL = [
    'User communicates in Dutch and expects responses in Dutch',
    'User enjoys being surprised with creative, entertaining builds rather than straightforward solutions',
    'Het e-mailadres van de gebruiker is tom@example.com', 'My name is tom',
];

/** A world with the review deps wired to in-memory rows and a fake judge. */
function reviewWorld(rows, o = {}) {
    const w = world(rows);
    const calls = { judge: [], scrub: [], marked: [] };
    const junk = new Set(o.junk || JUNK);
    const all = () => w.state.rows;
    Object.assign(w.deps, {
        reviewContext: async (u) => (o.ctx ? o.ctx(u) : { allowed: true, orgId: 'o1', shield: { enabled: true }, scrub: false }),
        listForReview: async (u, limit) => all().filter((r) => r.user_id === u && r.status === 'active' && r.origin === 'inferred' && !r.reviewed_at).slice(0, limit),
        markReviewed: async (ids) => { calls.marked.push(ids); for (const id of ids) all().find((r) => r.id === id).reviewed_at = NOW; return ids.length; },
        scrubText: async (t) => { calls.scrub.push(t); return t.replace(/\S+@\S+/g, '[email]'); },
        judgeBatch: async ({ items }) => {
            calls.judge.push(items);
            if (o.judge) return o.judge(items);
            return JSON.stringify({ results: items.map((i) => ({ id: i.id, keep: !junk.has(i.content) })) });
        },
    });
    return { w, calls, run: (opts) => createConsolidation(w.deps).runOnce(opts) };
}
const mk = (texts, over = {}) => texts.map((t, i) => R(`r${i}`, { content: t, ...over }));

test('review: the junk examples are archived, the real memories kept', async () => {
    const rows = [...JUNK, ...REAL].map((t, i) => R(`r${i}`, { content: t }));
    const rw = reviewWorld(rows);
    const out = await rw.run();
    assert.equal(out.reviewArchived, JUNK.length);
    for (const r of rw.w.state.rows) assert.equal(r.status, JUNK.includes(r.content) ? 'archived' : 'active', r.content);
    assert.ok(rw.w.state.rows.every((r) => r.reviewed_at), 'every judged row is stamped');
    for (const item of rw.calls.judge.flat()) assert.deepEqual(Object.keys(item).sort(), ['content', 'id', 'type']);
});

test('review: a failed or garbage judge call leaves the rows unreviewed', async () => {
    for (const judge of [async () => { throw new Error('boom'); }, async () => 'not json', async () => '{"results":"x"}']) {
        const rw = reviewWorld(mk(['a', 'b']), { judge });
        const out = await rw.run();
        assert.equal(out.reviewArchived, 0);
        assert.ok(rw.w.state.rows.every((r) => !r.reviewed_at && r.status === 'active'));
    }
});

test('review: rows missing from the answer stay unreviewed', async () => {
    const rw = reviewWorld(mk(['Playbook', 'AI App Designer']), {
        judge: async (items) => JSON.stringify({ results: [{ id: items[0].id, keep: false }] }),
    });
    await rw.run();
    assert.equal(statusOf(rw.w, 'r0'), 'archived');
    assert.ok(rw.w.state.rows[0].reviewed_at);
    assert.equal(statusOf(rw.w, 'r1'), 'active');
    assert.ok(!rw.w.state.rows[1].reviewed_at);
});

test('review: explicit, imported, tool and already-reviewed rows are never sent', async () => {
    const rows = [
        R('inf', { content: 'Playbook' }),
        R('exp', { content: 'Playbook exp', origin: 'explicit' }),
        R('imp', { content: 'Playbook imp', origin: 'imported' }),
        R('tool', { content: 'Playbook tool', origin: 'tool' }),
        R('done', { content: 'Playbook done', reviewed_at: NOW }),
        R('sealed', { content: '{"_bfenc":"x"}' }),
    ];
    const rw = reviewWorld(rows);
    // a store that lists too much must still be filtered by the job
    rw.w.deps.listForReview = async () => rw.w.state.rows;
    await rw.run();
    const sent = rw.calls.judge.flat().map((i) => i.id);
    assert.deepEqual(sent, ['inf']);
    for (const id of ['exp', 'imp', 'tool', 'done']) assert.equal(statusOf(rw.w, id), 'active');
});

test('review: parseReview ignores unknown ids, non-boolean verdicts and repeats', () => {
    const m = parseReview(JSON.stringify({ results: [
        { id: 'a', keep: false }, { id: 'zzz', keep: false }, { id: 'b', keep: 'no' }, { id: 'a', keep: true }, { id: 'c', keep: true },
    ] }), new Set(['a', 'b', 'c']));
    assert.deepEqual([...m], [['a', false], ['c', true]]);
    assert.equal(parseReview('', new Set(['a'])), null);
});

test('review: batches hold at most 25, a user at most 200, a run at most 400', async () => {
    const rw = reviewWorld(mk(Array.from({ length: 60 }, (_, i) => `memory number ${i}`)));
    await rw.run();
    assert.deepEqual(rw.calls.judge.map((b) => b.length), [25, 25, 10]);

    const many = reviewWorld(Array.from({ length: 450 }, (_, i) => R(`m${i}`, { content: `fact ${i}`, user_id: `u${i % 3}` })));
    const out = await many.run();
    assert.equal(out.reviewed, 400);
    for (const u of ['u0', 'u1', 'u2']) {
        assert.ok(many.w.state.rows.filter((r) => r.user_id === u && r.reviewed_at).length <= 200);
    }
    const one = reviewWorld(Array.from({ length: 300 }, (_, i) => R(`x${i}`, { content: `fact ${i}` })));
    assert.equal((await one.run()).reviewed, 200);
});

test('review: text is scrubbed before sending when the shield is on', async () => {
    const on = reviewWorld(mk(['Het e-mailadres is tom@example.com']), { ctx: async () => ({ allowed: true, orgId: 'o1', shield: {}, scrub: true }) });
    await on.run();
    assert.equal(on.calls.scrub.length, 1);
    assert.equal(on.calls.judge[0][0].content, 'Het e-mailadres is [email]');
    const off = reviewWorld(mk(['Het e-mailadres is tom@example.com']));
    await off.run();
    assert.equal(off.calls.scrub.length, 0);
    assert.match(off.calls.judge[0][0].content, /tom@example\.com/);
});

test('review: a user or org with memory disabled is skipped', async () => {
    const rw = reviewWorld([...mk(['Playbook']), R('o', { user_id: 'u2', content: 'Playbook' })], {
        ctx: async (u) => (u === 'u1' ? { allowed: false } : { allowed: true, orgId: 'o1', shield: null, scrub: false }),
    });
    await rw.run();
    assert.equal(statusOf(rw.w, 'r0'), 'active');
    assert.ok(!rw.w.state.rows[0].reviewed_at);
    assert.equal(statusOf(rw.w, 'o'), 'archived');
});

test('review: the prompt asks for ids only and defaults to KEEP', () => {
    assert.match(REVIEW_SYSTEM_PROMPT, /When unsure: KEEP/);
    assert.match(REVIEW_SYSTEM_PROMPT, /Never repeat or quote/);
});
