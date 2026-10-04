/**
 * formPickSources — the registry behind an `app_pick` form question.
 *
 * The properties under test are the ones a picker's safety rests on: every
 * source names only READ tools, the mappers survive whatever shape a tool
 * actually returns, and nothing a caller types can widen a search.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const ps = require('./formPickSources');

test('every source can be resolved by the id it advertises', () => {
    for (const row of ps.catalog()) {
        const source = ps.getSource(row.id);
        assert.ok(source, `${row.id} is in the catalog but cannot be resolved`);
        assert.strictEqual(source.id, row.id);
        assert.ok(source.app, `${row.id} has no app name to show a person`);
    }
    assert.strictEqual(ps.getSource('does_not_exist'), null);
    assert.strictEqual(ps.getSource(undefined), null);
});

test('a source names only read-only tools — never a send, write or delete', () => {
    // The picker runs these as the person filling the form in, so a source
    // that named a writing tool would be a way to make somebody send an email
    // by answering a question.
    const FORBIDDEN = /(send|compose|create|update|delete|move|trash|archive|save|upload|modify|set_|add_)/;
    for (const row of ps.catalog()) {
        for (const tool of ps.toolsFor(ps.getSource(row.id))) {
            assert.ok(!FORBIDDEN.test(tool), `${row.id} names a tool that is not read-only: ${tool}`);
        }
    }
});

test('a tool source names both a search and a fetch tool; an internal one names none', () => {
    for (const row of ps.catalog()) {
        const source = ps.getSource(row.id);
        const tools = ps.toolsFor(source);
        if (row.internal) {
            assert.deepStrictEqual(tools, [], `${row.id} is internal and must dispatch no tool`);
        } else {
            assert.strictEqual(tools.length, 2, `${row.id} must name exactly a search and a fetch tool`);
            assert.ok(typeof source.searchArgs === 'function');
            assert.ok(typeof source.mapResults === 'function');
            assert.ok(typeof source.fetchArgs === 'function');
            assert.ok(typeof source.mapRecord === 'function');
        }
    }
});

test('a caller cannot widen a search: limit and query are clamped, not trusted', () => {
    assert.strictEqual(ps.clampLimit(9999), ps.MAX_RESULTS);
    assert.strictEqual(ps.clampLimit(0), 1);
    assert.strictEqual(ps.clampLimit(-5), 1);
    assert.strictEqual(ps.clampLimit('nonsense'), ps.DEFAULT_RESULTS);
    assert.strictEqual(ps.clampLimit(undefined), ps.DEFAULT_RESULTS);

    assert.strictEqual(ps.clampQuery('  offerte  '), 'offerte');
    assert.strictEqual(ps.clampQuery('x'.repeat(5000)).length, ps.MAX_QUERY_LEN);
    assert.strictEqual(ps.clampQuery({ evil: true }), '');
    assert.strictEqual(ps.clampQuery(null), '');
});

test('maxItems is clamped to the picker ceiling', () => {
    assert.strictEqual(ps.clampMaxItems(99), ps.MAX_PICKS);
    assert.strictEqual(ps.clampMaxItems(0), 1);
    assert.strictEqual(ps.clampMaxItems(undefined), ps.DEFAULT_MAX_PICKS);
    assert.strictEqual(ps.clampMaxItems('3'), 3);
});

test("Drive's operator language is built here, and a typed quote cannot escape it", () => {
    // A person types words; Drive's `q` is an expression. A raw apostrophe
    // ("O'Brien offerte") would otherwise end the literal and make the whole
    // query a syntax error.
    assert.strictEqual(ps.driveQuery('offerte'), "name contains 'offerte' and trashed = false");
    assert.ok(ps.driveQuery("O'Brien").includes("O\\'Brien"));
    assert.strictEqual(ps.driveQuery(''), 'trashed = false');
});

test('usableResults drops rows with no id, de-duplicates, and bounds the page', () => {
    const rows = [
        { id: 'a', title: 'First' },
        { id: '', title: 'No id — unpickable' },
        { id: 'a', title: 'The same record again' },
        { id: 'b', title: '', subtitle: 'x'.repeat(1000) },
    ];
    const out = ps.usableResults(rows);
    assert.deepStrictEqual(out.map(r => r.id), ['a', 'b']);
    // A row with no title still has to be clickable, so it falls back to its id.
    assert.strictEqual(out[1].title, 'b');
    assert.ok(out[1].subtitle.length <= 300);
    assert.deepStrictEqual(ps.usableResults(null), []);
    assert.deepStrictEqual(ps.usableResults('not a list'), []);
});

test('Fireflies results map to a pickable row, and its transcript flattens to speaker-prefixed text', () => {
    const source = ps.getSource('fireflies_transcript');
    const rows = source.mapResults({
        results: [{ id: 'tr_1', title: 'Kickoff', date: '2026-09-01T10:00:00Z', duration: '45 min', organizer: 'a@b.nl' }],
    });
    assert.strictEqual(rows[0].id, 'tr_1');
    assert.strictEqual(rows[0].title, 'Kickoff');
    assert.ok(rows[0].subtitle.includes('2026-09-01'));

    const record = source.mapRecord({
        title: 'Kickoff',
        truncated: true,
        sentences: [{ speaker: 'Tom', text: 'Welkom.' }, { speaker: 'Ans', text: 'Dank je.' }],
    });
    assert.strictEqual(record.text, 'Tom: Welkom.\nAns: Dank je.');
    // The tool stops at 500 sentences and says so; that has to survive the map,
    // or a clipped call presents itself as a whole one.
    assert.strictEqual(record.partial, true);
});

test('a mapper survives a tool answering with the wrong shape', () => {
    for (const row of ps.catalog()) {
        const source = ps.getSource(row.id);
        if (row.internal) continue;
        for (const junk of [null, undefined, {}, { results: 'not a list' }, [], 'a string']) {
            assert.deepStrictEqual(source.mapResults(junk), [], `${row.id} choked on ${JSON.stringify(junk)}`);
        }
        // A record read that came back empty must not throw either.
        assert.doesNotThrow(() => source.mapRecord(null));
        assert.doesNotThrow(() => source.mapRecord({}));
    }
});

test('an email flattens to its headers plus the body, in that order', () => {
    const gmail = ps.getSource('gmail_message');
    const text = gmail.mapRecord({ from: 'a@b.nl', to: 'c@d.nl', subject: 'Offerte', date: 'Mon, 1 Sep 2026', body: 'Beste,' }).text;
    assert.ok(text.startsWith('From: a@b.nl\nTo: c@d.nl'));
    assert.ok(text.endsWith('\n\nBeste,'));

    // Outlook's read returns `body`, its search only `bodyPreview`; both have
    // to yield the same descriptor rather than an empty one.
    const outlook = ps.getSource('outlook_message');
    assert.ok(outlook.mapRecord({ subject: 'Hoi', bodyPreview: 'kort' }).text.endsWith('kort'));
    // A message with no headers at all is still its body, not a blank line.
    assert.strictEqual(outlook.mapRecord({ body: 'alleen tekst' }).text, 'alleen tekst');
});

// ── Structured output ─────────────────────────────────────────────────────

/**
 * The fullest record each tool can hand back, as its own executor builds one.
 * Used to check that `sampleData` promises only keys the mapper really
 * produces — a sample that advertises a key the runtime never writes creates a
 * binding in the builder that resolves to undefined forever.
 */
const FULL_RECORDS = {
    fireflies_transcript: {
        id: 'tr_1', title: 'Kickoff', date: '2026-09-01T10:00:00Z', duration: '45 min',
        organizer: 'anne@klant.nl', participants: ['anne@klant.nl'], speakers: ['Anne'],
        sentenceCount: 412, sentences: [{ speaker: 'Anne', text: 'Hoi' }], url: 'https://ff/tr_1',
    },
    gmail_message: {
        id: 'm1', threadId: 'thr_123', from: 'anne@klant.nl', to: 'tom@bedrijf.nl',
        subject: 'Offerte Q4', date: 'Mon, 1 Sep 2026 10:00:00 +0200', body: 'Beste',
        attachments: [{ filename: 'offerte.pdf' }],
    },
    outlook_message: {
        id: 'm1', from: 'anne@klant.nl', to: 'tom@bedrijf.nl', subject: 'Offerte Q4',
        date: '2026-09-01T08:00:00Z', body: 'Beste', attachments: [],
    },
    drive_file: {
        id: 'f1', name: 'Offerte Q4.docx', mimeType: 'application/vnd.google-apps.document',
        modifiedTime: '2026-09-01T08:00:00Z', webViewLink: 'https://docs.google.com/document/d/abc',
        content: 'De offerte.',
    },
};

test('every source advertises a data sample, and promises no key it cannot produce', () => {
    for (const row of ps.catalog()) {
        assert.ok(Object.keys(row.sampleData).length > 0, `${row.id} has no sampleData for the builder to show`);
        const raw = FULL_RECORDS[row.id];
        if (!raw) continue;   // the internal source is pinned in formPickRecord.test.js
        const produced = new Set(Object.keys(ps.getSource(row.id).mapRecord(raw).data || {}));
        for (const key of Object.keys(row.sampleData)) {
            assert.ok(produced.has(key), `${row.id}.sampleData promises "${key}", which mapRecord never writes`);
        }
    }
});

test('data carries the record\'s own fields, typed — not a second copy of its text', () => {
    const call = ps.getSource('fireflies_transcript').mapRecord(FULL_RECORDS.fireflies_transcript);
    assert.strictEqual(call.data.durationMinutes, 45, '"45 min" has to become a number a condition can compare');
    assert.strictEqual(call.data.date, '2026-09-01T10:00:00.000Z', 'a date has to be an ISO stamp, not the source\'s own formatting');
    assert.deepStrictEqual(call.data.speakers, ['Anne']);
    // The body lives in `.text` and nowhere else — duplicating it into `data`
    // would double every transcript riding through a run.
    assert.ok(!JSON.stringify(call.data).includes('Hoi'));

    const mail = ps.getSource('gmail_message').mapRecord(FULL_RECORDS.gmail_message);
    assert.strictEqual(mail.data.hasAttachments, true);
    assert.deepStrictEqual(mail.data.attachmentNames, ['offerte.pdf']);
    assert.ok(!('body' in mail.data));
});

test('an empty structured field is dropped, never carried as ""', () => {
    // An automation branching on data.organizer must be able to tell "no organizer"
    // from "this source does not report one"; an empty string says neither.
    const sparse = ps.getSource('fireflies_transcript').mapRecord({ title: 'Kort', sentences: [] });
    assert.ok(!('organizer' in sparse.data));
    assert.ok(!('participants' in sparse.data));
    assert.deepStrictEqual(ps.compact({ a: '', b: null, c: [], d: 0, e: false, f: 'x' }), { d: 0, e: false, f: 'x' });
});

test('minutes and isoDate refuse what they cannot read, instead of guessing', () => {
    assert.strictEqual(ps.minutes('45 min'), 45);
    assert.strictEqual(ps.minutes(45), 45);
    assert.strictEqual(ps.minutes('unknown'), null);
    assert.strictEqual(ps.minutes(0), null);
    assert.strictEqual(ps.isoDate('not a date'), '');
    assert.strictEqual(ps.isoDate(null), '');
});

test('a data list is bounded, and reads names out of the objects a tool returns', () => {
    assert.strictEqual(ps.strList(Array.from({ length: 500 }, (_, i) => `x${i}`), 25).length, 25);
    assert.deepStrictEqual(ps.strList([{ filename: 'a.pdf' }, { name: 'b' }, { title: 'c' }, {}, '']), ['a.pdf', 'b', 'c']);
    assert.deepStrictEqual(ps.strList('not a list'), []);
});
