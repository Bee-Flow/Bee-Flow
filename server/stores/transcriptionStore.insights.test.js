/**
 * transcriptionStore — the SQL added for meeting insights.
 *
 * These are the mechanically riskiest edits of the feature: a hand-numbered
 * 29-column INSERT, a conditional tags UPDATE, and a hand-built ACL query for
 * the recurring-series card. A fake `db` module is injected into require.cache
 * so every query's text + params are captured instead of hitting Postgres.
 *
 * Run: cd server && node --test stores/transcriptionStore.insights.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const state = { calls: [], runResult: { rowCount: 1, rows: [] }, oneRow: null, allRows: [] };

const dbPath = require.resolve('../db');
require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
        exec: async (sql) => { state.calls.push({ fn: 'exec', sql }); },
        run: async (sql, params) => { state.calls.push({ fn: 'run', sql, params }); return state.runResult; },
        getOne: async (sql, params) => { state.calls.push({ fn: 'getOne', sql, params }); return state.oneRow; },
        getAll: async (sql, params) => { state.calls.push({ fn: 'getAll', sql, params }); return state.allRows; },
    },
};

const store = require('./transcriptionStore');

beforeEach(() => {
    state.calls = [];
    state.runResult = { rowCount: 1, rows: [] };
    state.oneRow = null;
    state.allRows = [];
});

const lastOfKind = (re) => [...state.calls].reverse().find((c) => re.test(c.sql || ''));

test('createTranscription: placeholders, columns and values stay aligned', async () => {
    await store.createTranscription({
        userId: 'u1', title: 'T', fileName: 'a.mp3',
        actionItems: [{ id: 'ai-0' }],
        decisions: [{ id: 'd-0', text: 'Besluit' }],
        questions: [{ id: 'q-0', text: 'Vraag', open: true }],
        tags: ['planning'],
    });

    const insert = lastOfKind(/INSERT INTO transcriptions/);
    assert.ok(insert, 'an INSERT was issued');

    const columns = insert.sql.match(/INSERT INTO transcriptions \(([^)]+)\)/)[1].split(',').map((c) => c.trim());
    const placeholders = insert.sql.match(/VALUES \(([^)]+)\)/)[1].split(',').map((p) => p.trim());

    // The three counts must agree, or values silently land in the wrong column.
    assert.strictEqual(columns.length, placeholders.length, 'column count === placeholder count');
    assert.strictEqual(columns.length, insert.params.length, 'column count === value count');
    // Placeholders must be $1..$N in order, with no gaps or repeats.
    assert.deepStrictEqual(placeholders, columns.map((_, i) => `$${i + 1}`));

    // The new columns carry the new values.
    const valueOf = (col) => insert.params[columns.indexOf(col)];
    assert.deepStrictEqual(JSON.parse(valueOf('decisions')), [{ id: 'd-0', text: 'Besluit' }]);
    assert.deepStrictEqual(JSON.parse(valueOf('questions')), [{ id: 'q-0', text: 'Vraag', open: true }]);
    assert.deepStrictEqual(JSON.parse(valueOf('tags')), ['planning']);
    assert.deepStrictEqual(JSON.parse(valueOf('action_items')), [{ id: 'ai-0' }]);
});

test('createTranscription: omitted artifacts default to empty JSON arrays', async () => {
    await store.createTranscription({ userId: 'u1', title: 'T', fileName: 'a.mp3' });
    const insert = lastOfKind(/INSERT INTO transcriptions/);
    const columns = insert.sql.match(/INSERT INTO transcriptions \(([^)]+)\)/)[1].split(',').map((c) => c.trim());
    for (const col of ['decisions', 'questions', 'tags']) {
        assert.strictEqual(insert.params[columns.indexOf(col)], '[]', `${col} defaults to []`);
    }
});

/**
 * De SET-expressie van één kolom, op balans van haakjes uitgeknipt.
 *
 * Een regex met `[\s\S]*` lóópt door tot in de volgende kolom en bewijst
 * daarmee niets: `decisions = (SELECT … jsonb_array_elements($n::jsonb)` matcht
 * dan ook als die `$n` de parameter van QUESTIONS is. Dat weegt zwaarder sinds
 * de placeholder niet meer inline meeloopt (`decisions = $${idx++}`, triviaal
 * correct) maar door de helper `artifactColumnSql()` wordt geregen — precies
 * de plek waar een verkeerde parameter een reële vergissing is.
 */
function setExpression(sql, column) {
    const at = sql.indexOf(`${column} = `);
    assert.ok(at >= 0, `${column} komt niet in de SET voor`);
    const start = sql.indexOf('(', at);
    let depth = 0;
    for (let i = start; i < sql.length; i += 1) {
        if (sql[i] === '(') depth += 1;
        else if (sql[i] === ')') { depth -= 1; if (depth === 0) return sql.slice(start, i + 1); }
    }
    throw new Error(`ongebalanceerde haakjes in de expressie van ${column}`);
}

/** De verschillende `$n` die BINNEN die ene expressie voorkomen. */
function placeholdersIn(expr) {
    return [...new Set([...expr.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
}

test('updateTranscription: decisions/questions persist as JSONB with aligned params', async () => {
    await store.updateTranscription('t-1', 'u1', {
        summary: 'S',
        actionItems: [{ id: 'ai-0', text: 'C' }],
        decisions: [{ id: 'd-0', text: 'A' }],
        questions: [{ id: 'q-0', text: 'B', open: false }],
    });
    const upd = lastOfKind(/UPDATE transcriptions SET/);
    // De drie artefactkolommen worden niet meer kaal toegekend: de SET-expressie
    // stempelt elke rij met de databaseklok (en houdt, mét `artifactsSince`,
    // vast wat er tijdens een lopende run bijkwam — zie
    // transcriptionStore.artifactWindow.pg.test.js). Wat hier telt is dat elke
    // kolom nog steeds UITSLUITEND uit ZIJN EIGEN parameter leest.
    const expected = {
        action_items: JSON.stringify([{ id: 'ai-0', text: 'C' }]),
        decisions: JSON.stringify([{ id: 'd-0', text: 'A' }]),
        questions: JSON.stringify([{ id: 'q-0', text: 'B', open: false }]),
    };
    for (const [column, json] of Object.entries(expected)) {
        const expr = setExpression(upd.sql, column);
        const used = placeholdersIn(expr);
        assert.strictEqual(used.length, 1, `${column} leest uit precies één parameter (geen artifactsSince hier)`);
        assert.strictEqual(upd.params[used[0] - 1], json, `${column} leest zijn EIGEN parameter`);
        assert.match(expr, /jsonb_array_elements\(\$\d+::jsonb\)/);
    }

    // Every $n in the statement must have a value behind it.
    const maxParam = Math.max(...[...upd.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    assert.strictEqual(maxParam, upd.params.length, 'no dangling placeholders');
    // id + userId are always the last two params (owner-scoped WHERE).
    assert.deepStrictEqual(upd.params.slice(-2), ['t-1', 'u1']);
});

test('updateTranscription: `artifactsSince` is ÉÉN parameter voor alle drie de kolommen', async () => {
    // Eén vertrekpunt, uit één read — drie kolommen die er los van elkaar op
    // vergelijken zouden aan de randen van het venster uit elkaar lopen.
    await store.updateTranscription('t-1', 'u1', {
        actionItems: [{ id: 'ai-0', text: 'C' }],
        decisions: [{ id: 'd-0', text: 'A' }],
        questions: [{ id: 'q-0', text: 'B', open: false }],
        artifactsSince: '2026-07-01T09:00:00.000Z',
    });
    const upd = lastOfKind(/UPDATE transcriptions SET/);
    const sinceIdx = upd.params.indexOf('2026-07-01T09:00:00.000Z') + 1;
    assert.ok(sinceIdx > 0, 'het vertrekpunt is een gebonden parameter, geen tekst in het SQL');

    for (const column of ['action_items', 'decisions', 'questions']) {
        const used = placeholdersIn(setExpression(upd.sql, column));
        assert.strictEqual(used.length, 2, `${column}: eigen waarde + het gedeelde vertrekpunt`);
        assert.ok(used.includes(sinceIdx), `${column} vergelijkt tegen hetzelfde vertrekpunt`);
        const valueIdx = used.find((n) => n !== sinceIdx);
        assert.strictEqual(typeof upd.params[valueIdx - 1], 'string');
        assert.ok(upd.params[valueIdx - 1].startsWith('['), `${column} leest een JSON-array-parameter`);
    }
});

test('updateTranscription: tagsIfEmpty only fills an empty column, tags overwrites', async () => {
    await store.updateTranscription('t-1', 'u1', { tagsIfEmpty: ['auto'] });
    const conditional = lastOfKind(/UPDATE transcriptions SET/);
    // The CASE guard is what stops auto-tags from clobbering user tags.
    assert.match(conditional.sql, /tags = CASE WHEN tags IS NULL OR tags = '\[\]'::jsonb THEN \$\d+::jsonb ELSE tags END/);
    assert.ok(conditional.params.includes(JSON.stringify(['auto'])));

    state.calls = [];
    await store.updateTranscription('t-1', 'u1', { tags: ['manual'] });
    const plain = lastOfKind(/UPDATE transcriptions SET/);
    assert.match(plain.sql, /tags = \$\d+/);
    assert.ok(!/CASE WHEN/.test(plain.sql), 'the explicit tags update is unconditional');
});

test('getTranscription: decisions/questions are parsed from JSONB text or objects', async () => {
    state.oneRow = {
        id: 't-1', user_id: 'u1', title: 'T',
        decisions: '[{"id":"d-0","text":"Besluit"}]',            // driver returned text
        questions: [{ id: 'q-0', text: 'Vraag', open: true }],   // driver returned objects
        segments: [], speakers: [], action_items: [], chapters: [], tags: [], attendees: [],
    };
    const note = await store.getTranscription('t-1', 'u1', { isSuperAdmin: true });
    assert.deepStrictEqual(note.decisions, [{ id: 'd-0', text: 'Besluit' }]);
    assert.deepStrictEqual(note.questions, [{ id: 'q-0', text: 'Vraag', open: true }]);
});

test('getTranscription: notes stored before the columns existed read as empty lists', async () => {
    state.oneRow = { id: 't-1', user_id: 'u1', title: 'T', segments: [], speakers: [] };
    const note = await store.getTranscription('t-1', 'u1', { isSuperAdmin: true });
    assert.deepStrictEqual(note.decisions, []);
    assert.deepStrictEqual(note.questions, []);
});

test('getTranscriptions: the list payload carries tags on BOTH query branches', async () => {
    // The library's tag chips and filters read `tags` off list rows, so both
    // the super-admin and the normal-user SELECT must include the column —
    // mapping alone leaves it undefined.
    for (const opts of [{ isSuperAdmin: true }, { orgIds: ['org-1'], userGroupIds: ['g1'] }]) {
        state.calls = [];
        state.allRows = [{ id: 't-1', user_id: 'u1', title: 'T', tags: '["planning"]', full_text_snippet: '' }];
        const [row] = await store.getTranscriptions('u1', opts);
        assert.deepStrictEqual(row.tags, ['planning']);
        assert.match(lastOfKind(/FROM transcriptions/).sql, /\btags\b/, `tags selected for ${JSON.stringify(opts)}`);
    }
});

test('getTranscriptions: a summary PREFIX travels on both branches, never the whole summary', async () => {
    // The sidebar's recently-edited panel says what a meeting was about, which
    // means the list needs some of the summary. A prefix, not the column: a
    // library of 50 notes would otherwise ship 50 full summaries to draw five
    // menu rows. Same technique the transcript snippet already uses.
    for (const opts of [{ isSuperAdmin: true }, { orgIds: ['org-1'], userGroupIds: ['g1'] }]) {
        state.calls = [];
        state.allRows = [{ id: 't-1', user_id: 'u1', title: 'T', summary_snippet: '## Samenvatting\n\nWe spraken over Azure.' }];
        const [row] = await store.getTranscriptions('u1', opts);
        assert.strictEqual(row.summarySnippet, '## Samenvatting\n\nWe spraken over Azure.');
        const { sql } = lastOfKind(/FROM transcriptions/);
        assert.match(sql, /LEFT\(COALESCE\(summary, ''\), \d+\) AS summary_snippet/, `summary prefix selected for ${JSON.stringify(opts)}`);
        // The bare column would defeat the point of the prefix.
        assert.doesNotMatch(sql, /,\s*summary\s*,/, `full summary column must not be selected for ${JSON.stringify(opts)}`);
    }
});

test('getTranscriptions: a note with no summary yet reports an empty snippet, not undefined', async () => {
    // Processing notes have summary = '' — the row must still carry the key so
    // the client can tell "no summary" from "this payload predates the field".
    state.allRows = [{ id: 't-1', user_id: 'u1', title: 'T', summary_snippet: '' }];
    const [row] = await store.getTranscriptions('u1', { isSuperAdmin: true });
    assert.strictEqual(row.summarySnippet, '');
});

test('getSeriesPrevious: series + ACL params are numbered in the order they appear', async () => {
    state.oneRow = {
        id: 'prev', title: 'Vorige', created_at: new Date('2026-07-01T09:00:00Z'),
        summary: 'S', action_items: [{ id: 'ai-0', text: 'Open taak', done: false }, { id: 'ai-1', text: 'Klaar', done: true }],
    };
    const prev = await store.getSeriesPrevious({
        meetMeetingCode: 'abc-defg-hij',
        beforeCreatedAt: '2026-07-08T09:00:00.000Z',
        excludeId: 't-2',
        userId: 'u1',
        orgIds: ['org-1'],
        userGroupIds: ['g1'],
    });

    const q = lastOfKind(/FROM transcriptions/);
    // Every placeholder must resolve to a value, in first-appearance order.
    const order = [...q.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    assert.deepStrictEqual(order.filter((n, i) => order.indexOf(n) === i), [1, 2, 3, 4, 5, 6, 7]);
    assert.strictEqual(q.params.length, 7);
    assert.deepStrictEqual(q.params.slice(0, 4), ['abc-defg-hij', '2026-07-08T09:00:00.000Z', 't-2', 'u1']);
    assert.deepStrictEqual(q.params[4], JSON.stringify(['u1']));
    assert.deepStrictEqual(q.params.slice(5), [['org-1'], ['g1']]);

    // Only earlier, completed notes from the same series, newest first.
    assert.match(q.sql, /meet_meeting_code = \$1/);
    assert.match(q.sql, /status = 'completed'/);
    assert.match(q.sql, /created_at < \$2/);
    assert.match(q.sql, /id <> \$3/);
    assert.match(q.sql, /ORDER BY created_at DESC LIMIT 1/);
    // ACL parity with getTranscription: owner OR legacy share OR org-published.
    assert.match(q.sql, /user_id = \$4/);
    assert.match(q.sql, /shared_with @> \$5::jsonb/);
    assert.match(q.sql, /is_published = true AND organization_id = ANY\(\$6::text\[\]\)/);
    assert.match(q.sql, /shared_groups \?\| \$7::text\[\]/);

    // Only the UNFINISHED action items reach the card.
    assert.deepStrictEqual(prev.openActionItems, [{ id: 'ai-0', text: 'Open taak', done: false }]);
    assert.strictEqual(prev.createdAt, '2026-07-01T09:00:00.000Z');
});

test('getSeriesPrevious: talk rooms, super admins and no-series notes', async () => {
    state.oneRow = { id: 'prev', title: 'V', created_at: new Date(), summary: '', action_items: [] };
    await store.getSeriesPrevious({ talkRoomToken: 'tok123', beforeCreatedAt: 'x', excludeId: 't', userId: 'u1' });
    const talkQ = lastOfKind(/FROM transcriptions/);
    assert.match(talkQ.sql, /talk_room_token = \$1/);
    // No orgIds → no org clause at all (an empty ANY('{}') is a known pg trap).
    assert.ok(!/organization_id = ANY/.test(talkQ.sql));

    state.calls = [];
    await store.getSeriesPrevious({ meetMeetingCode: 'code', beforeCreatedAt: 'x', excludeId: 't', userId: 'u1', isSuperAdmin: true });
    const adminQ = lastOfKind(/FROM transcriptions/);
    assert.ok(!/user_id = \$/.test(adminQ.sql), 'super admin bypasses the ACL clause');

    // A note with no series link never queries at all.
    state.calls = [];
    assert.strictEqual(await store.getSeriesPrevious({ beforeCreatedAt: 'x', excludeId: 't', userId: 'u1' }), null);
    assert.strictEqual(state.calls.filter((c) => c.fn === 'getOne').length, 0);
});
