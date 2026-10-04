/**
 * The meeting-usage scans, against a REAL Postgres (@electric-sql/pglite,
 * in-process).
 *
 * ── WHY THIS EXISTS ALONGSIDE meetingUsage.test.js ──────────────────
 * The sibling suite proves the POLICY: a failed scan is partial and never
 * zero, the filter decision goes through the real dispatch matcher, tags are
 * compared exactly. It cannot prove the QUERIES are right, because its fake
 * `query()` never parses the SQL. A scan naming a column the table has not
 * got passes there and returns nothing in production — and here "nothing" is
 * not a wrong list, it is a delete guard that silently stops guarding.
 *
 * kbUsage.pg.test.js was written after five of eight scans turned out to name
 * columns that do not exist. These scans reach into four tables owned by
 * three other stores, plus a jsonpath expression, plus a column that is not
 * on this install yet. So they get the same treatment: create the tables as
 * production declares them, seed one consumer of each kind, and assert the
 * scan FINDS it.
 *
 * Run: cd server && node --test --test-force-exit core/meetingNotes/meetingUsage.pg.test.js
 */

'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert');

const { PGlite } = require('@electric-sql/pglite');
const pg = new PGlite();

function adapt(res, sql) {
    const r = Array.isArray(res) ? (res[res.length - 1] || {}) : (res || {});
    return { rows: r.rows || [], command: String(sql).trim().split(/\s+/)[0].toUpperCase() };
}
async function q(sql, params) {
    if (Array.isArray(params) && params.length > 0) return adapt(await pg.query(sql, params), sql);
    if (/;\s*\S/.test(String(sql).trim())) return adapt(await pg.exec(sql), sql);
    return adapt(await pg.query(sql), sql);
}
const db = { query: q };

const { usageForMeeting, filedTranscriptSources, MEETING_SOURCE_CONFIG_KEY } = require('./meetingUsage');

const MEETING_ID = '11111111-1111-1111-1111-111111111111';
const OWNER = 'owner-1';

/**
 * The four tables as their own stores declare them, trimmed to the columns
 * these scans read. Deliberately the REAL names — `knowledge_bases.tenant_id`
 * (not owner_id), `automations.title` (not name), `notebooks.name` (not
 * title) — because getting one of those wrong is precisely the bug this file
 * exists to catch.
 *
 * `notebook_sources.source_ref_id` is created here even though production
 * has not got it yet: this half proves the query is right for the day it
 * lands, and a separate test drops the column to prove the absent case.
 */
const SCHEMA = `
    CREATE TABLE knowledge_bases (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL
    );
    CREATE TABLE kb_sources (
        id TEXT PRIMARY KEY,
        knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        config JSONB NOT NULL DEFAULT '{}'::jsonb,
        refresh_mode TEXT NOT NULL DEFAULT 'manual',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE automations (
        id TEXT PRIMARY KEY, user_id TEXT, title TEXT,
        kind TEXT NOT NULL DEFAULT 'automation',
        definition_json JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE notebooks (
        id TEXT PRIMARY KEY, user_id TEXT, name TEXT
    );
    CREATE TABLE notebook_sources (
        id TEXT PRIMARY KEY,
        notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
        type TEXT NOT NULL DEFAULT 'text',
        name TEXT NOT NULL DEFAULT 'Untitled',
        source_ref_id TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
`;

const appEvent = (filter) => ({
    schemaVersion: 1,
    trigger: { id: 'trg', type: 'trigger', kind: 'app_event', appEvent: { provider: 'meeting-notes', event: 'meeting.processed', ...(filter ? { filter } : {}) } },
    steps: [{ id: 's1', type: 'ai', prompt: 'summarise' }],
});

before(async () => {
    await pg.exec(SCHEMA);

    await q(`INSERT INTO knowledge_bases (id, tenant_id, name) VALUES ($1,$2,$3),($4,$5,$6)`,
        ['kb-1', OWNER, 'Sales knowledge', 'kb-2', 'someone-else', 'Board minutes']);
    await q(`INSERT INTO kb_sources (id, knowledge_base_id, kind, config, refresh_mode) VALUES
              ('s1','kb-1','meeting_tag', $1::jsonb, 'after_meeting'),
              ('s2','kb-2','meeting_tag', $2::jsonb, 'schedule'),
              ('s3','kb-1','meeting_tag', $3::jsonb, 'after_meeting'),
              ('s4','kb-1','webpage',     $4::jsonb, 'manual')`,
        [
            JSON.stringify({ tag: 'sales', fields: ['summary'] }),
            // A 'schedule' source is NOT armed by the event but still ingests
            // this meeting on its next pass — the list must include it.
            JSON.stringify({ tag: 'sales' }),
            // Case matters: `Sales` is a different tag from `sales`.
            JSON.stringify({ tag: 'Sales' }),
            JSON.stringify({ url: 'https://example.test' }),
        ]);

    await q(`INSERT INTO automations (id, user_id, title, kind, definition_json) VALUES
              ('a-1',$1,'Post the notes','automation',$2::jsonb),
              ('a-2',$1,'Only tagged sales','automation',$3::jsonb),
              ('a-3',$1,'A reusable step','block',$2::jsonb),
              ('a-4','someone-else','Their automation','automation',$2::jsonb),
              ('a-5',$1,'Gmail automation','automation',$4::jsonb)`,
        [
            OWNER,
            JSON.stringify(appEvent(null)),
            JSON.stringify(appEvent({ expr: 'contains(trigger.tags,"sales")' })),
            JSON.stringify({ trigger: { id: 't', kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new' } }, steps: [] }),
        ]);

    await q(`INSERT INTO notebooks (id, user_id, name) VALUES ('nb-1',$1,'Q3 research')`, [OWNER]);
    await q(`INSERT INTO notebook_sources (id, notebook_id, type, name, source_ref_id) VALUES
              ('ns-1','nb-1','meeting','Meeting Note: Weekly sync',$1),
              ('ns-2','nb-1','text','Some pasted text',NULL)`, [MEETING_ID]);
});

const meeting = (over = {}) => ({ id: MEETING_ID, tags: ['sales'], ownerId: OWNER, organizationId: 'org-1', ...over });

test('every scan runs against real Postgres and finds its consumer', async () => {
    const { rows, partial } = await usageForMeeting(meeting(), { db });
    assert.deepStrictEqual(partial, [], 'no scan may fail on a live schema');

    const byKind = (k) => rows.filter(r => r.kind === k);

    // kb: BOTH meeting_tag sources on the exact tag, whatever their refresh
    // mode. Not the 'Sales' one — the comparison is case-sensitive, exactly
    // as armMeetingSources and listByTag are — and not the webpage source.
    assert.deepStrictEqual(
        byKind('kb').map(r => ({ id: r.id, title: r.title, siteLabel: r.siteLabel, ownerId: r.ownerId })).sort((a, b) => a.id.localeCompare(b.id)),
        [
            { id: 'kb-1', title: 'Sales knowledge', siteLabel: 'sales', ownerId: OWNER },
            { id: 'kb-2', title: 'Board minutes', siteLabel: 'sales', ownerId: 'someone-else' },
        ],
    );

    // automation: the owner's top-level automations whose filter actually fires.
    // Not the block, not the colleague's, not the Gmail one.
    assert.deepStrictEqual(byKind('automation').map(r => r.id).sort(), ['a-1', 'a-2']);
    assert.strictEqual(byKind('automation').find(r => r.id === 'a-1').unfiltered, true);
    assert.strictEqual(byKind('automation').find(r => r.id === 'a-2').siteLabel, 'contains(trigger.tags,"sales")');

    // notebook: the meeting source, joined to its notebook for the owner.
    assert.deepStrictEqual(byKind('notebook').map(r => ({ id: r.id, title: r.title, siteLabel: r.siteLabel, ownerId: r.ownerId })), [
        { id: 'nb-1', title: 'Q3 research', siteLabel: 'Meeting Note: Weekly sync', ownerId: OWNER },
    ]);
});

test('a tag that differs only in case finds nothing — the arming query’s rule', async () => {
    const { rows, partial } = await usageForMeeting(meeting({ tags: ['SALES'] }), { db });
    assert.deepStrictEqual(partial, []);
    assert.deepStrictEqual(rows.filter(r => r.kind === 'kb'), []);
});

test('a tag carrying a quote is a parameter, not SQL', async () => {
    // The tags column is written straight through by an unvalidated PATCH.
    const { rows, partial } = await usageForMeeting(meeting({ tags: ["O'Brien; DROP TABLE kb_sources--"] }), { db });
    assert.deepStrictEqual(partial, []);
    assert.deepStrictEqual(rows.filter(r => r.kind === 'kb'), []);
    const still = await q(`SELECT count(*)::int AS n FROM kb_sources`);
    assert.strictEqual(still.rows[0].n, 4, 'the table is still there');
});

test('a meeting with no tags still runs, and never sends an empty array', async () => {
    const { rows, partial } = await usageForMeeting(meeting({ tags: [] }), { db });
    assert.deepStrictEqual(partial, []);
    assert.deepStrictEqual(rows.filter(r => r.kind === 'kb'), [], 'no tag, no tag source');
    assert.ok(rows.some(r => r.kind === 'automation'), 'the other scans still ran');
});

test('the per-meeting `meeting` source kind is found the moment a row exists', async () => {
    // The kind is not in kb_sources' CHECK constraint yet, so this table has
    // no constraint and the row goes in — which is the point: the reader is
    // ready, and the config key it looks under is pinned.
    await q(`INSERT INTO kb_sources (id, knowledge_base_id, kind, config) VALUES ('s5','kb-1','meeting',$1::jsonb)`,
        [JSON.stringify({ [MEETING_SOURCE_CONFIG_KEY]: MEETING_ID })]);
    try {
        const { rows, partial } = await usageForMeeting(meeting({ tags: [] }), { db });
        assert.deepStrictEqual(partial, []);
        assert.deepStrictEqual(rows.filter(r => r.kind === 'kb').map(r => r.id), ['kb-1']);
        // A per-meeting source watches no tag, so it names none.
        assert.strictEqual(rows.find(r => r.kind === 'kb').siteLabel, undefined);
    } finally {
        await q(`DELETE FROM kb_sources WHERE id = 's5'`);
    }
});

test('an old notebook source with no ref keeps the kind partial', async () => {
    await q(`INSERT INTO notebook_sources (id, notebook_id, type, name, source_ref_id) VALUES ('ns-3','nb-1','meeting','Meeting Note: Old one',NULL)`);
    try {
        const { rows, partial } = await usageForMeeting(meeting(), { db });
        assert.ok(partial.includes('notebook'), 'an unmatchable row is not an answer');
        assert.strictEqual(rows.filter(r => r.kind === 'notebook').length, 1, 'the rows it CAN answer still come back');
    } finally {
        await q(`DELETE FROM notebook_sources WHERE id = 'ns-3'`);
    }
});

test('THE COLUMN PROBE IS REAL: without source_ref_id the kind is partial, not empty', async () => {
    // The state production is in today. The probe has to notice, or the
    // scan raises 42703, or — worse — a probe written against
    // information_schema answers about a different schema's table.
    await q(`ALTER TABLE notebook_sources DROP COLUMN source_ref_id`);
    try {
        const { rows, partial } = await usageForMeeting(meeting(), { db });
        assert.ok(partial.includes('notebook'));
        assert.deepStrictEqual(rows.filter(r => r.kind === 'notebook'), []);
        // And nothing else was collateral damage.
        assert.ok(!partial.includes('kb'));
        assert.ok(!partial.includes('automation'));
    } finally {
        await q(`ALTER TABLE notebook_sources ADD COLUMN source_ref_id TEXT`);
        await q(`UPDATE notebook_sources SET source_ref_id = $1 WHERE id = 'ns-1'`, [MEETING_ID]);
    }
});

test('a table this install has not got is partial, and the others still answer', async () => {
    await q(`ALTER TABLE automations RENAME TO automations_parked`);
    try {
        const { rows, partial } = await usageForMeeting(meeting(), { db });
        assert.deepStrictEqual(partial, ['automation']);
        assert.ok(rows.some(r => r.kind === 'kb'));
        assert.ok(rows.some(r => r.kind === 'notebook'));
    } finally {
        await q(`ALTER TABLE automations_parked RENAME TO automations`);
    }
});

test('a transcript line filed into a knowledge base is found through its stored metadata', async () => {
    // Byte-for-byte the config `POST /api/kb/:id/sources` writes for a
    // `kind:'text'` source that came from a transcript line: the title, the
    // size, and the two-field origin `shapeTextOrigin` allow-lists. The text
    // itself is NOT in the config (it lives in the document), which is why
    // the scan may only read `metadata`.
    const cfg = (segmentIndex, id = MEETING_ID) => JSON.stringify({
        title: 'Leveranciersoverleg', charCount: 42,
        metadata: { transcriptionId: id, segmentIndex },
    });
    await q(`INSERT INTO kb_sources (id, knowledge_base_id, kind, config) VALUES
              ('t1','kb-1','text',$1::jsonb),
              ('t2','kb-1','text',$2::jsonb),
              ('t3','kb-2','text',$3::jsonb),
              ('t4','kb-1','text',$4::jsonb),
              ('t5','kb-1','text','{"title":"Pasted","charCount":9}'::jsonb)`,
        [cfg(3), cfg(7), cfg(11), cfg(0, '99999999-9999-9999-9999-999999999999')]);
    try {
        const { rows, partial } = await usageForMeeting(meeting({ tags: [] }), { db });
        assert.deepStrictEqual(partial, []);
        const kb = rows.filter(r => r.kind === 'kb').sort((a, b) => a.id.localeCompare(b.id));
        assert.deepStrictEqual(kb.map(r => ({ id: r.id, lineCount: r.lineCount })), [
            // Two lines here, one there. NOT the line from another meeting,
            // and not the hand-pasted snippet that carries no origin at all —
            // if either got in, every text source in the install would count
            // as "pulled from this transcript".
            { id: 'kb-1', lineCount: 2 },
            { id: 'kb-2', lineCount: 1 },
        ]);
    } finally {
        await q(`DELETE FROM kb_sources WHERE id IN ('t1','t2','t3','t4','t5')`);
    }
});

test('segmentIndex 0 is a real anchor, and a filing without one still counts', async () => {
    // `Number(null) === 0` is the bug this pair exists for: the FIRST line of
    // a meeting must be findable, and a source whose origin lost its line is
    // still a piece of this transcript sitting in a knowledge base.
    await q(`INSERT INTO kb_sources (id, knowledge_base_id, kind, config) VALUES
              ('t6','kb-1','text',$1::jsonb),
              ('t7','kb-1','text',$2::jsonb)`,
        [
            JSON.stringify({ metadata: { transcriptionId: MEETING_ID, segmentIndex: 0 } }),
            JSON.stringify({ metadata: { transcriptionId: MEETING_ID } }),
        ]);
    try {
        const { rows } = await usageForMeeting(meeting({ tags: [] }), { db });
        assert.deepStrictEqual(rows.filter(r => r.kind === 'kb').map(r => r.lineCount), [2]);
    } finally {
        await q(`DELETE FROM kb_sources WHERE id IN ('t6','t7')`);
    }
});

// ── DE LIJST DIE HET VERWIJDEREN AANSTUURT ───────────────────────────
//
// `filedTranscriptSources` is het ENIGE pad in het product dat rijen weghaalt
// uit de kennisbank van een ANDERE tenant (`DELETE /api/transcriptions/:id/
// filed-lines`). Zijn SQL stond nergens getest: de nep-pool van
// routes/transcriptions.usage.test.js matcht op `/FROM kb_sources/` en geeft
// hetzelfde plan terug ongeacht de SQL-tekst en ongeacht de gebonden
// parameter, dus een predicaat dat naar `WHERE $1 IS NOT NULL` zou afdrijven
// bleef daar 17/17 groen — terwijl de route dan élke bron van de hele
// installatie zou verwijderen. Deze suite draait tegen echte Postgres en is
// de enige plek waar dat verschil zichtbaar is.

test('filedTranscriptSources levert precies de bronnen die DEZE vergadering claimen', async () => {
    const cfg = (id, segmentIndex) => JSON.stringify({
        title: 'Leveranciersoverleg', charCount: 42,
        metadata: { transcriptionId: id, ...(segmentIndex === undefined ? {} : { segmentIndex }) },
    });
    await q(`INSERT INTO kb_sources (id, knowledge_base_id, kind, config) VALUES
              ('f1','kb-1','text',$1::jsonb),
              ('f2','kb-2','text',$2::jsonb),
              ('f3','kb-1','text',$3::jsonb),
              ('f4','kb-1','text','{"title":"Pasted","charCount":9}'::jsonb),
              ('f5','kb-1','webpage',$4::jsonb),
              ('f6','kb-1','text',$5::jsonb)`,
        [
            cfg(MEETING_ID, 3),
            cfg(MEETING_ID, 7),
            cfg('99999999-9999-9999-9999-999999999999', 1),
            cfg(MEETING_ID, 2),                                   // wél dit id, maar kind 'webpage'
            // Een id dat ERMEE BEGINT maar het niet IS: dit moet een
            // gelijkheid zijn, geen LIKE — anders wist één opruimactie de
            // regels van een andere vergadering mee.
            JSON.stringify({ metadata: { transcriptionId: `${MEETING_ID}9` } }),
        ]);
    try {
        const filed = await filedTranscriptSources(MEETING_ID, db);
        assert.deepStrictEqual(
            filed.map(r => r.sourceId).sort(),
            ['f1', 'f2'],
            'alleen tekstbronnen die precies dit id noemen — uit welke kennisbank dan ook',
        );
        // En met wat een verwijdering nodig heeft: in welke kennisbank, van
        // welke tenant. Zonder tenantId gaan de chunks niet weg en blijven hun
        // embeddings doorzoekbaar.
        const mine = filed.find(r => r.sourceId === 'f1');
        assert.deepStrictEqual(mine, { sourceId: 'f1', kbId: 'kb-1', tenantId: OWNER });
        const theirs = filed.find(r => r.sourceId === 'f2');
        assert.deepStrictEqual(theirs, { sourceId: 'f2', kbId: 'kb-2', tenantId: 'someone-else' },
            'BEWUST ONGESCOPET: juist de rij in andermans kennisbank moet opruimbaar zijn');
    } finally {
        await q(`DELETE FROM kb_sources WHERE id IN ('f1','f2','f3','f4','f5','f6')`);
    }
});

test('filedTranscriptSources zonder id vraagt de database niets', async () => {
    // Een leeg id mag nooit "alles" betekenen op een pad dat verwijdert.
    let asked = 0;
    const counting = { query: async (...a) => { asked += 1; return q(...a); } };
    assert.deepStrictEqual(await filedTranscriptSources('', counting), []);
    assert.deepStrictEqual(await filedTranscriptSources(null, counting), []);
    assert.strictEqual(asked, 0);
});

test('een query die omvalt GOOIT — "ik kon niet kijken" is geen "er stond niets"', async () => {
    const broken = { query: async () => { throw new Error('kb_sources is weg'); } };
    await assert.rejects(() => filedTranscriptSources(MEETING_ID, broken), /kb_sources is weg/);
});
