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
