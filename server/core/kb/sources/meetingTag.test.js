/**
 * Meetings carrying a tag, as a knowledge source.
 *
 * ── THE PROPERTY THAT MATTERS ───────────────────────────────────────
 * This source WIDENS who can read a meeting summary. A note has its own
 * audience — its owner, whoever it was shared with, maybe an organisation or
 * a group. Putting it in a knowledge base moves it into THAT thing's audience,
 * which may be larger.
 *
 * So the line is drawn where it cannot be argued with: `enumerate` reads the
 * meetings as the KNOWLEDGE BASE'S OWNER, through the same read ACL a person
 * opening one note gets. A source can only ever contain meetings its owner
 * could already open. Not the person pressing refresh — a scheduled pass has
 * nobody pressing anything, and keying it on whoever last touched the source
 * would make the document set depend on who that happened to be.
 *
 * Run: cd server && node --test --test-force-exit core/kb/sources/meetingTag.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const adapter = require('./meetingTag');

function meeting(over = {}) {
    return {
        id: 'm1',
        title: 'Salesoverleg',
        summary: 'We bespraken de kortingsstructuur voor Van Dijk.',
        decisions: [{ text: 'Korting van 12% tot eind Q3.' }],
        questions: [{ text: 'Geldt dit ook voor de servicecontracten?' }],
        actionItems: [{ text: 'Tom stuurt de offerte donderdag.' }],
        tags: ['sales'],
        createdAt: '2026-07-22T09:00:00.000Z',
        updatedAt: '2026-07-22T11:00:00.000Z',
        ...over,
    };
}

function deps(meetings, calls = []) {
    return {
        transcriptionStore: {
            listByTag: async (tag, reader, opts) => { calls.push({ tag, reader, opts }); return meetings; },
        },
    };
}

const ctx = (over = {}) => ({
    kb: { id: 'kb1', tenant_id: 'owner1' },
    kbId: 'kb1',
    source: { id: 's1', kind: 'meeting_tag', config: { tag: 'sales' } },
    ...over,
});

const source = (config = { tag: 'sales' }) => ({ id: 's1', kind: 'meeting_tag', config });

// ── Who the reader is ───────────────────────────────────────────────

test('the meetings are read as the KNOWLEDGE BASE owner', async () => {
    // Not the caller. This is the whole access story: a source cannot become
    // a way to read past a note's own sharing.
    const calls = [];
    await adapter.enumerate(source(), ctx(), deps([meeting()], calls));
    assert.strictEqual(calls[0].reader, 'owner1');
    assert.strictEqual(calls[0].tag, 'sales');
});

test('a source with no tag enumerates nothing, and asks nothing', async () => {
    const calls = [];
    assert.deepStrictEqual(await adapter.enumerate(source({}), ctx(), deps([], calls)), []);
    assert.deepStrictEqual(await adapter.enumerate(source({ tag: '   ' }), ctx(), deps([], calls)), []);
    assert.strictEqual(calls.length, 0);
});

test('a knowledge base with no owner enumerates nothing', async () => {
    // There is nobody to evaluate the read ACL as, and "everyone" is not the
    // fallback.
    const calls = [];
    const out = await adapter.enumerate(source(), ctx({ kb: { id: 'kb1' } }), deps([meeting()], calls));
    assert.deepStrictEqual(out, []);
    assert.strictEqual(calls.length, 0);
});

test('an item carries the note`s own last edit, which is what drives a re-ingest', async () => {
    const [item] = await adapter.enumerate(source(), ctx(), deps([meeting()]));
    assert.strictEqual(item.externalId, 'm1');
    assert.strictEqual(item.sourceModifiedAt, '2026-07-22T11:00:00.000Z');
});

// ── What goes in the document ───────────────────────────────────────

test('the document is the summary and the decisions, not the transcript', async () => {
    // A transcript is the raw record of who said what: long, and full of
    // asides nobody meant to publish.
    const [item] = await adapter.enumerate(source(), ctx(), deps([meeting()]));
    const doc = await adapter.fetch(item, null, ctx(), deps([]));
    assert.match(doc.content, /kortingsstructuur voor Van Dijk/);
    assert.match(doc.content, /Besluiten:/);
    assert.match(doc.content, /- Korting van 12% tot eind Q3\./);
    assert.doesNotMatch(doc.content, /Open vragen/, 'not asked for by default');
    assert.doesNotMatch(doc.content, /Acties/);
});

test('the fields a source asks for are the fields it gets', async () => {
    const c = ctx({ source: source({ tag: 'sales', fields: ['summary', 'questions'] }) });
    const [item] = await adapter.enumerate(c.source, c, deps([meeting()]));
    const doc = await adapter.fetch(item, null, c, deps([]));
    assert.match(doc.content, /Open vragen:/);
    assert.doesNotMatch(doc.content, /Besluiten:/);
});

test('summary is never dropped, even when the config leaves it out', async () => {
    // A document of decisions with no context is a list of sentences
    // beginning "we agreed to" about nothing.
    assert.deepStrictEqual(adapter.fieldsOf({ config: { fields: ['decisions'] } }), ['summary', 'decisions']);
    assert.deepStrictEqual(adapter.fieldsOf({ config: { fields: [] } }), ['summary', 'decisions']);
    assert.deepStrictEqual(adapter.fieldsOf({}), ['summary', 'decisions']);
    assert.deepStrictEqual(adapter.fieldsOf({ config: { fields: ['nonsense'] } }), ['summary', 'decisions']);
});

test('a meeting with nothing to say produces NO document', async () => {
    // A row with a title and no content is a search result that wastes
    // somebody's click.
    const empty = meeting({ summary: '', decisions: [], questions: [], actionItems: [] });
    const [item] = await adapter.enumerate(source(), ctx(), deps([empty]));
    assert.strictEqual(await adapter.fetch(item, null, ctx(), deps([])), null);
});

test('the date travels with the document, for the chip', async () => {
    // "Salesoverleg · 22 jul". Re-deriving it from created_at would give the
    // date we INGESTED it, not the date of the meeting.
    const [item] = await adapter.enumerate(source(), ctx(), deps([meeting()]));
    const doc = await adapter.fetch(item, null, ctx(), deps([]));
    assert.strictEqual(doc.metadata.meetingDate, '2026-07-22T09:00:00.000Z');
    assert.strictEqual(doc.metadata.meetingId, 'm1');
    assert.strictEqual(doc.sourceUri, 'meeting:m1');
    assert.strictEqual(doc.sourceType, 'meeting');
});

test('a decision reads the same whether it is an object or a bare string', async () => {
    // The shape changed and old notes were never rewritten. Both look
    // identical to a person, so both are accepted.
    assert.deepStrictEqual(adapter.textsOf(['Een besluit', { text: 'Nog een' }, { title: 'Derde' }]),
        ['Een besluit', 'Nog een', 'Derde']);
    assert.deepStrictEqual(adapter.textsOf([null, '', { }, '  ']), []);
    assert.deepStrictEqual(adapter.textsOf(null), []);
});

// ── When work is skipped ────────────────────────────────────────────

test('a note nobody has touched is unchanged, and costs no rebuild', async () => {
    const [item] = await adapter.enumerate(source(), ctx(), deps([meeting()]));
    assert.strictEqual(adapter.isUnchanged(item, { source_modified_at: '2026-07-22T11:00:00.000Z' }), true);
});

test('a regenerated summary is a change', async () => {
    // `updated_at` moves when a summary is regenerated, a decision edited, or
    // a tag changed — every reason the document would differ.
    const [item] = await adapter.enumerate(source(), ctx(), deps([meeting()]));
    assert.strictEqual(adapter.isUnchanged(item, { source_modified_at: '2026-07-22T09:30:00.000Z' }), false);
});

test('a document we have never seen is never "unchanged"', async () => {
    const [item] = await adapter.enumerate(source(), ctx(), deps([meeting()]));
    assert.strictEqual(adapter.isUnchanged(item, null), false);
    assert.strictEqual(adapter.isUnchanged(item, { source_modified_at: null }), false);
});

test('the kind refreshes after a meeting by default', async () => {
    // "After every meeting" is the phrase on the card, and a nightly schedule
    // would make a note searchable a day after it was written.
    assert.strictEqual(adapter.defaultMode, 'after_meeting');
    assert.ok(adapter.supportsModes.includes('after_meeting'));
    assert.ok(adapter.supportsModes.includes('manual'));
});

test('it is registered, or the engine stands down on every refresh', async () => {
    const { supportedKinds } = require('./index');
    assert.ok(supportedKinds().includes('meeting_tag'));
});

// ── A tag larger than one read ──────────────────────────────────────

/** `count` meetings, m0000 the oldest, each created one minute after the last. */
function manyMeetings(count) {
    return Array.from({ length: count }, (_, i) => {
        const at = new Date(Date.UTC(2025, 0, 1) + i * 60_000).toISOString();
        return meeting({ id: `m${String(i).padStart(4, '0')}`, title: `Overleg ${i}`, createdAt: at, updatedAt: at });
    });
}

/**
 * listByTag as the SQL does it: `order: 'created'` is newest-created first with
 * a `(created_at, id)` keyset cursor; anything else is `updated_at DESC` and
 * ignores the cursor. `honoursCursor: false` is a store that predates it.
 */
function pagedStore(all, { honoursCursor = true, calls = [] } = {}) {
    const byCreated = [...all].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const byUpdated = [...all].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
        calls,
        listByTag: async (tag, reader, opts) => {
            calls.push(opts);
            const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 1000);
            if (!honoursCursor || opts.order !== 'created') return byUpdated.slice(0, limit);
            const after = opts.after;
            const rows = after
                ? byCreated.filter(m => m.createdAt < after.createdAt || (m.createdAt === after.createdAt && m.id < after.id))
                : byCreated;
            return rows.slice(0, limit);
        },
    };
}

/** The engine's deps, with the knowledge base already holding one document per meeting. */
function engineDeps(store, storedMeetings, extraStored = []) {
    const stored = [
        ...storedMeetings.map(m => ({ id: `d_${m.id}`, external_id: m.id, status: 'processed', source_modified_at: m.updatedAt })),
        ...extraStored,
    ];
    const deleted = [];
    return {
        deleted,
        deps: {
            transcriptionStore: store,
            kbStore: {
                getKB: async () => ({ id: 'kb1', tenant_id: 'owner1' }),
                listDocuments: async (kbId, { limit, offset = 0 }) => stored.slice(offset, offset + limit),
                bumpKBVersion: async () => {},
            },
            kbSourcesStore: { isCancelRequested: async () => false },
            helpers: {
                ingestDocument: async () => { throw new Error('nothing is new'); },
                reingestDocument: async () => { throw new Error('nothing changed'); },
                deleteDocumentChunks: async (kbId, docId) => { deleted.push(docId); },
            },
        },
    };
}

const SOURCE_ROW = { id: 's1', knowledgeBaseId: 'kb1', kind: 'meeting_tag', config: { tag: 'sales' } };

test('a tag with more meetings than one read is read to the end, oldest included', async () => {
    const all = manyMeetings(1200);
    const store = pagedStore(all);
    const c = ctx();
    const items = await adapter.enumerate(source(), c, { transcriptionStore: store });
    assert.strictEqual(items.length, 1200);
    assert.ok(items.some(i => i.externalId === 'm0000'), 'the oldest meeting is part of the source');
    assert.strictEqual(c.partial, undefined, 'a list read to the end is complete');
    assert.ok(store.calls.every(o => o.order === 'created'), 'paged in creation order, which never moves');
});

test('a tag with more than 500 meetings keeps the knowledge-base documents of the oldest ones', async () => {
    // The pass used to read the newest 500, call itself complete, and delete
    // the documents of every older meeting as "gone".
    const { syncSource } = require('./index');
    const all = manyMeetings(520);
    const { deps, deleted } = engineDeps(pagedStore(all), all);
    const r = await syncSource(SOURCE_ROW, { deps });
    assert.deepStrictEqual(deleted, []);
    assert.strictEqual(r.removed, 0);
    assert.strictEqual(r.unchanged, 520);
    assert.strictEqual(r.truncated, false, 'a complete read is not a truncated pass, so the source keeps its schedule');
});

test('a meeting that left the tag is still removed when the tag spans several reads', async () => {
    // Untagged, deleted, or no longer readable by the owner: its summary must
    // leave the knowledge base, however large the tag is.
    const { syncSource } = require('./index');
    const all = manyMeetings(520);
    const gone = { id: 'd_untagged', external_id: 'm_untagged', status: 'processed', source_modified_at: null };
    const { deps, deleted } = engineDeps(pagedStore(all), all, [gone]);
    const r = await syncSource(SOURCE_ROW, { deps });
    assert.deepStrictEqual(deleted, ['d_untagged']);
    assert.strictEqual(r.removed, 1);
});

test('a store that does not move the cursor leaves the list partial, and nothing is removed', async () => {
    const { syncSource } = require('./index');
    const all = manyMeetings(520);
    const { deps, deleted } = engineDeps(pagedStore(all, { honoursCursor: false }), all);
    const r = await syncSource(SOURCE_ROW, { deps });
    assert.deepStrictEqual(deleted, [], 'meetings that were never looked at are not gone');
    assert.strictEqual(r.truncated, false, 'running again at once would read the same list');
});

test('past the cap the list is partial, never silently complete', async () => {
    const all = manyMeetings(adapter.MAX_MEETINGS + 1);
    const c = ctx();
    const items = await adapter.enumerate(source(), c, { transcriptionStore: pagedStore(all) });
    assert.strictEqual(items.length, adapter.MAX_MEETINGS);
    assert.strictEqual(c.partial, true);
});
