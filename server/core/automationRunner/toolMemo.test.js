/**
 * The run-scoped memo, and — more importantly — its KEY.
 *
 * Every separation asserted below is a leak or a wrong answer if it is missing.
 * The identity ones are not hypothetical: connection lending makes stepUserId
 * differ from ctx.userId, and keying on the latter would serve one user's inbox
 * to another the moment the flag is on.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
    createToolMemo, memoKey, memoKeyParts, MAX_ENTRIES, MAX_TOTAL_BYTES,
} = require('./toolMemo');
const { isMemoisable, NEVER_MEMO, READ_ONLY } = require('../../automation/sideEffectMap');

const BASE = {
    toolName: 'gmail_search',
    stepUserId: 'u1', stepOrgId: 'org-a',
    connectionId: 'conn-1', grantId: null,
    integrationServer: null, destination: 'external',
    policyAction: 'off', policyScope: 'external',
    args: { q: 'invoice', limit: 10 },
};

// ── the key ─────────────────────────────────────────────────────────────────

test('argument order does not change the key', () => {
    const a = memoKey({ ...BASE, args: { q: 'invoice', limit: 10 } });
    const b = memoKey({ ...BASE, args: { limit: 10, q: 'invoice' } });
    assert.strictEqual(a, b);
});

test('argument ORDER inside an array does change it — filter order is meaningful', () => {
    const a = memoKey({ ...BASE, args: { f: [1, 2] } });
    const b = memoKey({ ...BASE, args: { f: [2, 1] } });
    assert.notStrictEqual(a, b);
});

test('every identity component separates', () => {
    const base = memoKey(BASE);
    const variants = {
        'a different effective user': { stepUserId: 'u2' },
        'a different organisation': { stepOrgId: 'org-b' },
        'a different connection': { connectionId: 'conn-2' },
        'a revoked and re-granted lend': { grantId: 'grant-9' },
        'a per-user integration host': { integrationServer: 'https://nc.example.com' },
        'an internal vs external destination': { destination: 'internal' },
        'a different privacy action': { policyAction: 'tokenize' },
        'a different privacy scope': { policyScope: 'internal' },
        'a different tool': { toolName: 'gmail_read' },
        'different arguments': { args: { q: 'receipt' } },
    };
    for (const [why, over] of Object.entries(variants)) {
        assert.notStrictEqual(memoKey({ ...BASE, ...over }), base, `${why} must not share a memo entry`);
    }
});

test('the key is a digest — the arguments are never recoverable from it', () => {
    const k = memoKey({ ...BASE, args: { token: 'super-secret-value' } });
    assert.match(k, /^[a-f0-9]{64}$/);
    assert.ok(!k.includes('secret'));
});

// ── store and peek ──────────────────────────────────────────────────────────

test('a miss returns undefined and a hit returns the value', () => {
    const m = createToolMemo();
    const k = memoKey(BASE);
    assert.strictEqual(m.peek(k), undefined);
    m.store(k, { rows: [1, 2] });
    assert.deepStrictEqual(m.peek(k), { rows: [1, 2] });
    assert.deepStrictEqual(m.stats(), { hits: 1, misses: 1, durableHits: 0, refused: 0, entries: 1, bytes: m.stats().bytes });
});

test('every hand-back is a deep clone, so a caller cannot corrupt the entry', () => {
    const m = createToolMemo();
    const k = memoKey(BASE);
    m.store(k, { rows: [{ id: 1 }] });
    const first = m.peek(k);
    first.rows.push({ id: 2 });
    first.rows[0].id = 99;
    assert.deepStrictEqual(m.peek(k), { rows: [{ id: 1 }] });
});

test('an entry expires', () => {
    let now = 1_000;
    const m = createToolMemo({ ttlMs: 500, now: () => now });
    const k = memoKey(BASE);
    m.store(k, { v: 1 });
    assert.deepStrictEqual(m.peek(k), { v: 1 });
    now += 501;
    assert.strictEqual(m.peek(k), undefined);
});

test('a per-step ttl overrides the default', () => {
    let now = 1_000;
    const m = createToolMemo({ ttlMs: 300_000, now: () => now });
    const k = memoKey(BASE);
    m.store(k, { v: 1 }, 1_000);
    now += 1_001;
    assert.strictEqual(m.peek(k), undefined, 'the shorter per-step ttl must win');
});

test('an oversized answer is refused rather than truncated', () => {
    const m = createToolMemo({ maxEntryBytes: 100 });
    const k = memoKey(BASE);
    assert.strictEqual(m.store(k, { big: 'x'.repeat(500) }), false);
    assert.strictEqual(m.peek(k), undefined,
        'a truncated payload replayed as whole is the BFSF-360 failure');
    // Counted, and that counter is what the run summary prints: a refusal that
    // reports nothing makes "the reuse did nothing" look exactly like "nobody
    // asked for any reuse".
    assert.strictEqual(m.stats().refused, 1);
});

test('a refusal is only a REFUSAL — an ineligible call is not one', () => {
    const m = createToolMemo();
    assert.strictEqual(m.store(null, { v: 1 }), false);
    assert.strictEqual(m.stats().refused, 0,
        'a step that never ticked the box must not report reuse doing nothing');
});

test('an eviction under the caps counts as a refusal too', () => {
    // Nothing was kept, so the next identical call asks again. From the
    // author's chair that is the same disappointment as an oversized answer.
    const m = createToolMemo({ maxEntries: 1, maxTotalBytes: 20, maxEntryBytes: 1000 });
    m.store(memoKey({ ...BASE, args: { i: 1 } }), { pad: 'y'.repeat(60) });
    assert.strictEqual(m.stats().refused, 1);
});

test('refusals survive a Wait — the entries go, what the run did does not', () => {
    const m = createToolMemo({ maxEntryBytes: 100 });
    m.store(memoKey(BASE), { big: 'x'.repeat(500) });
    m.clear();
    assert.strictEqual(m.stats().refused, 1);
});

test('the entry cap evicts oldest-first rather than growing without limit', () => {
    const m = createToolMemo({ maxEntries: 3 });
    for (let i = 0; i < 5; i++) m.store(memoKey({ ...BASE, args: { i } }), { i });
    assert.strictEqual(m.stats().entries, 3);
    assert.strictEqual(m.peek(memoKey({ ...BASE, args: { i: 0 } })), undefined, 'the oldest went first');
    assert.deepStrictEqual(m.peek(memoKey({ ...BASE, args: { i: 4 } })), { i: 4 });
});

test('the byte cap is enforced too', () => {
    const m = createToolMemo({ maxTotalBytes: 200, maxEntryBytes: 150 });
    for (let i = 0; i < 6; i++) m.store(memoKey({ ...BASE, args: { i } }), { pad: 'y'.repeat(60) });
    assert.ok(m.stats().bytes <= 200, `bytes grew to ${m.stats().bytes}`);
});

test('clear() empties it — a Wait must not answer from before the sleep', () => {
    const m = createToolMemo();
    const k = memoKey(BASE);
    m.store(k, { v: 1 });
    m.clear();
    assert.strictEqual(m.peek(k), undefined);
    assert.strictEqual(m.stats().entries, 0);
    assert.strictEqual(m.stats().bytes, 0);
});

test('stats never leak a key or a value', () => {
    // An exact key set, not a subset check: the run summary prints these, so a
    // field added here reaches a user-visible string, and the point of the
    // assertion is that nobody adds one without noticing that.
    const m = createToolMemo();
    m.store(memoKey({ ...BASE, args: { token: 'secret' } }), { body: 'secret' });
    assert.deepStrictEqual(Object.keys(m.stats()).sort(),
        ['bytes', 'durableHits', 'entries', 'hits', 'misses', 'refused']);
});

test('a durable hit is counted apart from a run-memo hit', () => {
    // They are different sentences to a person reading a finished run: one says
    // "we asked once instead of two hundred times", the other says "we did not
    // contact this app at all today" — and only the second explains a run that
    // produced yesterday's data.
    const m = createToolMemo();
    const k = memoKey(BASE);
    m.store(k, { v: 1 });
    m.peek(k);
    m.recordDurableHit();
    assert.strictEqual(m.stats().hits, 1);
    assert.strictEqual(m.stats().durableHits, 1);
});

test('clear() marks the run as having slept, which gates the DURABLE tier too', () => {
    // Emptying the entries is only half of what a Wait needs. Without this flag
    // the next look-up falls through to the cross-run cache and is handed the
    // very answer the clear was meant to discard — its TTL is up to an hour,
    // and a Wait is usually far shorter, so the stale answer would outlive the
    // sleep that was supposed to invalidate it. execAi reads hasSlept().
    const m = createToolMemo();
    assert.strictEqual(m.hasSlept(), false);
    m.clear();
    assert.strictEqual(m.hasSlept(), true);
});

test('a memo built for a RESUME starts already slept', () => {
    // A resume is the far side of a pause, and a pause waits on a PERSON — an
    // approval sits for a week, a form page until somebody answers it. A
    // 30-second Wait closed the durable tier for the rest of the run while
    // that seven-day gap reopened it, because a resume arrives with a brand
    // new memo. execution.js passes startSlept for every resumed leg.
    assert.strictEqual(createToolMemo({ startSlept: true }).hasSlept(), true);
    assert.strictEqual(createToolMemo({ startSlept: false }).hasSlept(), false);
    assert.strictEqual(createToolMemo().hasSlept(), false, 'a fresh run is not asleep');
});

test('starting slept still leaves the RUN memo working', () => {
    // The flag gates the durable cross-run tier only. Collapsing 200 identical
    // look-ups inside the resumed leg is still exactly what askOnce is for.
    const m = createToolMemo({ startSlept: true });
    const k = memoKey(BASE);
    m.store(k, { v: 1 });
    assert.deepStrictEqual(m.peek(k), { v: 1 });
    assert.strictEqual(m.hasSlept(), true);
});

test('having slept is permanent for the run — a later step cannot un-sleep it', () => {
    const m = createToolMemo();
    m.clear();
    m.store(memoKey(BASE), { v: 1 });
    assert.deepStrictEqual(m.peek(memoKey(BASE)), { v: 1 }, 'the run memo works again');
    assert.strictEqual(m.hasSlept(), true, 'but the durable tier stays shut');
});

test('clear() does not reset the counters — a Wait is not a new run', () => {
    const m = createToolMemo();
    const k = memoKey(BASE);
    m.store(k, { v: 1 });
    m.peek(k);
    m.recordDurableHit();
    m.clear();
    assert.strictEqual(m.stats().entries, 0, 'the ENTRIES go');
    assert.strictEqual(m.stats().hits, 1, 'what the run actually did does not');
    assert.strictEqual(m.stats().durableHits, 1);
});

// ── eligibility ─────────────────────────────────────────────────────────────

test('a write is never memoisable', () => {
    for (const t of ['gmail_compose', 'nextcloud_upload_file', 'gcal_create_event']) {
        assert.strictEqual(isMemoisable(t), false, `${t} changes something`);
    }
});

test('an unclassifiable tool is never memoisable — fail closed', () => {
    for (const t of ['mcp_whatever', 'cint_custom_thing', 'n8n_dynamic', '', null, undefined]) {
        assert.strictEqual(isMemoisable(t), false);
    }
});

test('an ordinary read is memoisable', () => {
    for (const t of ['gmail_search', 'gmail_read', 'gmail_list_labels']) {
        assert.strictEqual(isMemoisable(t), true, `${t} should be reusable within a run`);
    }
});

test('every NEVER_MEMO entry is genuinely read-only', () => {
    // An entry that is NOT read-only would be dead weight hiding a real bug:
    // isSideEffect already refuses it, so the listing would never be consulted.
    const notReadOnly = [...NEVER_MEMO].filter(t => !READ_ONLY.has(t));
    assert.deepStrictEqual(notReadOnly, []);
});

test('time-varying reads are excluded', () => {
    for (const t of ['nextcloud_status_get', 'n8n_execution_get']) {
        assert.strictEqual(isMemoisable(t), false, `${t} changes by the minute — asking again is the point`);
    }
});

test('every nextcloud read is excluded, by prefix', () => {
    // Their dispatch is where ncScopeGuard.checkToolCall runs, and that is a
    // DENY gate whose own memo is 15s because scopes change. A 5-minute memo
    // would widen an authorisation decision's staleness twentyfold.
    const ncReads = [...READ_ONLY].filter(t => t.startsWith('nextcloud_'));
    assert.ok(ncReads.length > 20, 'sanity: there should be plenty of them');
    for (const t of ncReads) {
        assert.strictEqual(isMemoisable(t), false, `${t} must not be memoised`);
    }
});

// ── the per-entry ceiling, and the caps it forced open ──────────────────────
//
// http_request's own response cap is 1 MiB while this module's default is
// 256 KiB. Without a per-call override, a 400 KiB catalogue in a 200-row loop
// is silently refused two hundred times and the author sees a step that
// ignores its own tick.

test('a per-call maxBytes raises the ceiling for that entry only', () => {
    const m = createToolMemo({ maxEntryBytes: 100 });
    const big = { pad: 'x'.repeat(500) };
    assert.strictEqual(m.store(memoKey({ ...BASE, args: { i: 1 } }), big), false, 'the default still refuses it');
    assert.strictEqual(m.store(memoKey({ ...BASE, args: { i: 2 } }), big, undefined, 10_000), true);
    assert.deepStrictEqual(m.peek(memoKey({ ...BASE, args: { i: 2 } })), big);
});

test('a per-call maxBytes only ever RAISES — it cannot smuggle past the byte budget', () => {
    const m = createToolMemo({ maxEntryBytes: 100, maxTotalBytes: 200 });
    m.store(memoKey({ ...BASE, args: { i: 1 } }), { pad: 'x'.repeat(500) }, undefined, 10_000);
    assert.ok(m.stats().bytes <= 200, `bytes grew to ${m.stats().bytes}`);
});

test('an invalid maxBytes falls back to the default rather than to no limit', () => {
    const m = createToolMemo({ maxEntryBytes: 100 });
    for (const bad of [0, -1, NaN, 'lots', null]) {
        assert.strictEqual(m.store(memoKey({ ...BASE, args: { bad } }), { pad: 'x'.repeat(500) }, undefined, bad),
            false, JSON.stringify(bad));
    }
});

test('the caps are a byte budget with an entry count that cannot be the binding one', () => {
    // 64 slots against 16 MiB: at the 1 MiB the http path may store, the BYTES
    // run out first. A 200-slot count against that budget would be a cap that
    // never caps.
    assert.strictEqual(MAX_ENTRIES, 64);
    assert.strictEqual(MAX_TOTAL_BYTES, 16 << 20);
    assert.ok(MAX_TOTAL_BYTES / (1024 * 1024) < MAX_ENTRIES,
        'the byte budget must run out before the slot count does');
});

test('the key prefix is still v1 — shipping the http cache must invalidate no stored answer', () => {
    // toolName already namespaces the key, so an http row can never collide
    // with a catalog-tool row. Bumping the version would drop every durable
    // answer on deploy for zero correctness gain.
    const identity = memoKeyParts({ toolName: 'http_request', args: {} });
    assert.strictEqual(identity.split('\0')[0], 'v1');
});
