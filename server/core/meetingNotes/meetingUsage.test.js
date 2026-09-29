/**
 * "What happens to this meeting?" — and what the answer must never say.
 *
 * This list feeds a delete guard, so the failure that matters is the one
 * where NOT KNOWING comes back as NOTHING: a scan that throws, a table that
 * is not installed, a column that has not landed. Every one of those has to
 * surface in `partial`, because an empty list is what the 409 reads as
 * permission to delete a meeting three things still use.
 *
 * The second class of failure is subtler and just as bad: a list that
 * disagrees with the dispatcher. A routine shown as "runs on this meeting"
 * that never fires is a promise the product does not keep, so the filter
 * decision here goes through the REAL matcher and these tests pin that it
 * still does.
 *
 * Run: node --test --test-force-exit core/meetingNotes/meetingUsage.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const {
    usageForMeeting, redactForeign, tagsOf, syntheticPayload, triggerFires, triggerLabel,
    meetingTriggersOf, MEETING_PROVIDER, MEETING_EVENT, MEETING_SOURCE_CONFIG_KEY,
} = require('./meetingUsage');

const ALL_TABLES = ['kb_sources', 'knowledge_bases', 'automations', 'notebook_sources', 'notebooks'];

/**
 * A fake pg client.
 *   tables    — what exists (anything else answers to_regclass NULL)
 *   columns   — `"table.column"` strings that exist
 *   kb/automation/notebook/legacy — rows the matching scan returns
 *   failOn    — scan names whose query throws
 */
function db({
    tables = ALL_TABLES,
    columns = ['notebook_sources.source_ref_id'],
    kb = [], automations = [], notebooks = [], legacyNotebookRows = false,
    failOn = [],
} = {}) {
    const queries = [];
    return {
        queries,
        sqlFor(fragment) { return queries.find(q => q.sql.includes(fragment)); },
        query: async (sql, params) => {
            if (/to_regclass\(\$1\) AS t/.test(sql)) {
                return { rows: [{ t: tables.includes(params[0]) ? params[0] : null }] };
            }
            if (/pg_attribute/.test(sql)) {
                const has = columns.includes(`${params[0]}.${params[1]}`);
                return { rows: has ? [{ '?column?': 1 }] : [] };
            }
            queries.push({ sql, params });
            if (/FROM kb_sources/.test(sql)) {
                if (failOn.includes('kb')) throw new Error('kb_sources is down');
                return { rows: kb };
            }
            if (/FROM automations/.test(sql)) {
                if (failOn.includes('automation')) throw new Error('automations is down');
                return { rows: automations };
            }
            if (/source_ref_id IS NULL/.test(sql)) {
                if (failOn.includes('legacy')) throw new Error('probe is down');
                return { rows: legacyNotebookRows ? [{ '?column?': 1 }] : [] };
            }
            if (/FROM notebook_sources/.test(sql)) {
                if (failOn.includes('notebook')) throw new Error('notebook_sources is down');
                return { rows: notebooks };
            }
            throw new Error(`unexpected query: ${sql}`);
        },
    };
}

const MEETING = { id: 'm-1', tags: ['sales', 'klant'], ownerId: 'owner-1', organizationId: 'org-1' };

/** An app_event trigger on the real provider/event pair. */
const trig = (filter, id = 'trg') => ({ id, type: 'trigger', kind: 'app_event', appEvent: { provider: MEETING_PROVIDER, event: MEETING_EVENT, filter } });
const automationRow = (over = {}) => ({
    id: 'a-1', title: 'Send notes to the team', owner_id: 'owner-1',
    last_at: '2026-09-01T00:00:00Z',
    definition_json: { trigger: trig(null), steps: [] },
    ...over,
});

// ── the happy path and the row contract ─────────────────────────────

test('finds all three kinds, in the Used-by row shape', async () => {
    const d = db({
        kb: [{ source_id: 's1', kind: 'meeting_tag', config: { tag: 'sales' }, last_at: '2026-08-01T00:00:00Z', kb_id: 'kb-1', kb_name: 'Sales', owner_id: 'owner-1' }],
        automations: [automationRow()],
        notebooks: [{ source_id: 'ns1', source_name: 'Meeting Note: Weekly', last_at: '2026-08-02T00:00:00Z', notebook_id: 'nb-1', notebook_name: 'Q3 research', owner_id: 'owner-1' }],
    });
    const { rows, partial } = await usageForMeeting(MEETING, { db: d });
    assert.deepStrictEqual(partial, []);
    assert.deepStrictEqual(rows, [
        { kind: 'kb', id: 'kb-1', title: 'Sales', role: 'contains', siteLabel: 'sales', lastAt: '2026-08-01T00:00:00Z', ownerId: 'owner-1' },
        { kind: 'automation', id: 'a-1', title: 'Send notes to the team', role: 'read', unfiltered: true, lastAt: '2026-09-01T00:00:00Z', ownerId: 'owner-1' },
        { kind: 'notebook', id: 'nb-1', title: 'Q3 research', role: 'contains', siteLabel: 'Meeting Note: Weekly', lastAt: '2026-08-02T00:00:00Z', ownerId: 'owner-1' },
    ]);
});

test('a meeting with no id answers nothing at all, and asks nothing', async () => {
    const d = db();
    assert.deepStrictEqual(await usageForMeeting(null, { db: d }), { rows: [], partial: [] });
    assert.deepStrictEqual(await usageForMeeting({ id: '' }, { db: d }), { rows: [], partial: [] });
    assert.strictEqual(d.queries.length, 0);
});

// ── NOT KNOWING IS NOT NOTHING ──────────────────────────────────────

test('every scan that throws lands in partial, and never as an empty answer', async () => {
    for (const kind of ['kb', 'automation', 'notebook']) {
        const d = db({ failOn: [kind] });
        const { rows, partial } = await usageForMeeting(MEETING, { db: d });
        assert.deepStrictEqual(rows, [], `${kind}: a failed scan must not invent rows`);
        assert.ok(partial.includes(kind), `${kind}: a failed scan must be partial`);
    }
});

test('a table this install does not have is partial, never zero', async () => {
    const d = db({ tables: ['automations'] });
    const { rows, partial } = await usageForMeeting(MEETING, { db: d });
    assert.deepStrictEqual(rows, []);
    assert.ok(partial.includes('kb'));
    assert.ok(partial.includes('notebook'));
    assert.ok(!partial.includes('automation'));
});

test('a meeting with no owner cannot be scoped, so routines are partial rather than none', async () => {
    // The fan-out is owner-only. With no owner there is nothing to scope to,
    // and an unscoped read would put every routine in the install in one
    // person's list — so the answer is "I do not know".
    const d = db({ automations: [automationRow()] });
    const { rows, partial } = await usageForMeeting({ ...MEETING, ownerId: null }, { db: d });
    assert.ok(partial.includes('automation'));
    assert.deepStrictEqual(rows.filter(r => r.kind === 'automation'), []);
    assert.ok(!d.sqlFor('FROM automations'), 'must not query automations unscoped');
});

test('the notebook link column being absent is partial, not "no notebook uses this"', async () => {
    // source_ref_id has not landed yet. Every meeting source is then a row
    // that MIGHT be this meeting with no way to tell.
    const d = db({ columns: [] });
    const { rows, partial } = await usageForMeeting(MEETING, { db: d });
    assert.deepStrictEqual(rows.filter(r => r.kind === 'notebook'), []);
    assert.ok(partial.includes('notebook'));
    assert.ok(!d.sqlFor('ns.source_ref_id = $1'), 'must not query a column that is not there');
});

test('old notebook rows with no ref keep the kind partial even when the exact scan answers', async () => {
    const d = db({
        notebooks: [{ source_id: 'ns1', source_name: 'Meeting Note: Weekly', last_at: null, notebook_id: 'nb-1', notebook_name: 'Q3', owner_id: 'owner-1' }],
        legacyNotebookRows: true,
    });
    const { rows, partial } = await usageForMeeting(MEETING, { db: d });
    assert.strictEqual(rows.filter(r => r.kind === 'notebook').length, 1);
    assert.ok(partial.includes('notebook'), 'unbackfillable rows are not an answer');
});

test('no legacy rows left → the notebook answer is complete', async () => {
    const d = db({ legacyNotebookRows: false });
    const { partial } = await usageForMeeting(MEETING, { db: d });
    assert.ok(!partial.includes('notebook'));
});

// ── the tag comparison must be the arming query's ───────────────────

test('tags are compared exactly: case and spaces are part of the tag', async () => {
    // Nothing normalises a meeting tag anywhere — not the PATCH, not the chip
    // editor, not armMeetingSources. Normalising here would claim a knowledge
    // base is fed by a meeting whose tag its own query never matches.
    assert.deepStrictEqual(tagsOf({ tags: ['Sales', 'sales', ' sales'] }), ['Sales', 'sales', ' sales']);
});

test('non-string and empty tags never reach the query', async () => {
    assert.deepStrictEqual(tagsOf({ tags: ['ok', '', null, 7, { tag: 'x' }, undefined] }), ['ok']);
    assert.deepStrictEqual(tagsOf({ tags: 'sales' }), []);
    assert.deepStrictEqual(tagsOf({}), []);
});

test('a meeting with no usable tags never sends an empty array to Postgres', async () => {
    const d = db({ kb: [] });
    await usageForMeeting({ ...MEETING, tags: ['', null] }, { db: d });
    const q = d.sqlFor('FROM kb_sources');
    assert.ok(q, 'the per-meeting branch still runs');
    assert.ok(!/ANY\(\$/.test(q.sql), 'no ANY() clause without tags');
    assert.ok(!q.params.some(p => Array.isArray(p) && p.length === 0));
});

test('the kb scan uses the arming query’s comparison, and does not narrow by refresh mode', async () => {
    const d = db();
    await usageForMeeting(MEETING, { db: d });
    const { sql, params } = d.sqlFor('FROM kb_sources');
    assert.match(sql, /s\.config->>'tag' = ANY\(\$1::text\[\]\)/);
    assert.deepStrictEqual(params[0], ['sales', 'klant']);
    // A meeting_tag source on 'schedule' is not armed by the event but still
    // ingests this meeting on its next pass — it belongs in the list.
    assert.ok(!/refresh_mode/.test(sql), 'refresh_mode must not narrow the list');
});

test('the per-meeting source kind is looked for under the key the creator will write', async () => {
    const d = db();
    await usageForMeeting(MEETING, { db: d });
    const { sql, params } = d.sqlFor('FROM kb_sources');
    assert.match(sql, /s\.kind = 'meeting' AND s\.config->>\$2 = \$3/);
    assert.strictEqual(params[1], MEETING_SOURCE_CONFIG_KEY);
    assert.strictEqual(params[2], 'm-1');
});

// ── the list and the dispatcher may not disagree ────────────────────

test('the filter decision runs through the REAL dispatch matcher', async () => {
    // Whatever the bus decides, this list says. Since M5 the bus HAS a
    // meeting-notes matcher: `tags` and `reprocessed` are answered there, an
    // empty tag list means every finished note, and any key the matcher does
    // not know falls back to the shallow `matchFilter` — which narrows.
    const payload = syntheticPayload(MEETING);   // tags: ['sales', 'klant']
    assert.strictEqual(triggerFires(trig(null), payload), true);
    assert.strictEqual(triggerFires(trig({}), payload), true);
    // A tag filter now really fires, so this list now really names it.
    assert.strictEqual(triggerFires(trig({ tags: 'sales' }), payload), true);
    assert.strictEqual(triggerFires(trig({ tags: ['inkoop'] }), payload), false);
    // A key the matcher does not know still narrows — it is not a free pass.
    assert.strictEqual(triggerFires(trig({ tagIncludes: 'sales' }), payload), false);
    // The DSL expression keeps working alongside it.
    assert.strictEqual(triggerFires(trig({ expr: 'contains(trigger.tags,"sales")' }), payload), true);
    assert.strictEqual(triggerFires(trig({ expr: 'contains(trigger.tags,"inkoop")' }), payload), false);
});

test('a routine whose filter does not fire is left out of the list', async () => {
    const d = db({ automations: [automationRow({ definition_json: { trigger: trig({ tags: ['inkoop'] }) } })] });
    const { rows, partial } = await usageForMeeting(MEETING, { db: d });
    assert.deepStrictEqual(rows.filter(r => r.kind === 'automation'), []);
    assert.ok(!partial.includes('automation'), 'a decided "no" is an answer, not a gap');
});

test('a routine whose tag filter DOES fire is listed, and says which tag', async () => {
    // The row that used to be invisible: before M5 a tag filter never matched,
    // so Used-by and the 409 on DELETE both stayed silent about it.
    const d = db({ automations: [automationRow({ definition_json: { trigger: trig({ tags: ['sales'] }) } })] });
    const { rows, partial } = await usageForMeeting(MEETING, { db: d });
    const auto = rows.filter(r => r.kind === 'automation');
    assert.strictEqual(auto.length, 1);
    assert.strictEqual(auto[0].siteLabel, 'sales', 'a row nobody can check is the row nobody trusts');
    assert.ok(!partial.includes('automation'));
});

test('a filter the matcher cannot judge is partial, not a silent "does not run"', async (t) => {
    const filters = require('../../automation/triggerBus/filters');
    const original = filters.pickMatcher;
    filters.pickMatcher = () => { throw new Error('matcher blew up'); };
    t.after(() => { filters.pickMatcher = original; });

    const d = db({ automations: [automationRow()] });
    const { rows, partial } = await usageForMeeting(MEETING, { db: d });
    assert.deepStrictEqual(rows.filter(r => r.kind === 'automation'), []);
    assert.ok(partial.includes('automation'));
});

test('the synthetic payload is the emitted payload, and carries no personal data', async () => {
    // BFSF-441: this object is handed to tenant-written filter expressions.
    // The keys must be the ones emitMeetingProcessed builds — no summary, no
    // title, no attendees — and `reprocessed` is absent because we are not
    // inventing a re-run that is not happening.
    assert.deepStrictEqual(
        Object.keys(syntheticPayload(MEETING)).sort(),
        ['orgId', 'tags', 'transcriptionId'],
    );
    assert.deepStrictEqual(syntheticPayload(MEETING), { transcriptionId: 'm-1', tags: ['sales', 'klant'], orgId: 'org-1' });
});

test('only the meeting provider counts, and the id is the hyphenated one', async () => {
    // `meeting_notes` is rejected by PROVIDER_ID_RE and never registered, so
    // a scan asking for it would be permanently empty.
    assert.strictEqual(MEETING_PROVIDER, 'meeting-notes');
    const def = {
        trigger: { kind: 'app_event', appEvent: { provider: 'meeting_notes', event: MEETING_EVENT } },
        triggers: [
            { kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new' } },
            trig(null, 'trg2'),
        ],
    };
    assert.deepStrictEqual(meetingTriggersOf(def).map(t => t.id), ['trg2']);
});

test('two meeting triggers on one routine are one row, not two', async () => {
    const d = db({ automations: [automationRow({ definition_json: { trigger: trig(null, 'a'), triggers: [trig(null, 'b')] } })] });
    const { rows } = await usageForMeeting(MEETING, { db: d });
    assert.strictEqual(rows.filter(r => r.kind === 'automation').length, 1);
});

test('the routine scan reads definitions, so a deactivated routine still guards the delete', async () => {
    // Subscription rows exist only while a routine is ACTIVE. Deleting a
    // meeting out from under a paused routine breaks it just the same.
    const d = db({ automations: [automationRow()] });
    await usageForMeeting(MEETING, { db: d });
    const q = d.sqlFor('FROM automations');
    assert.match(q.sql, /jsonb_path_exists/);
    assert.ok(!/automation_event_subscriptions/.test(q.sql));
    assert.match(q.sql, /user_id = \$1/);
    assert.deepStrictEqual(q.params, ['owner-1', MEETING_PROVIDER, MEETING_EVENT]);
});

test('a definition stored as text still parses', async () => {
    const d = db({ automations: [automationRow({ definition_json: JSON.stringify({ trigger: trig(null) }) })] });
    const { rows } = await usageForMeeting(MEETING, { db: d });
    assert.strictEqual(rows.filter(r => r.kind === 'automation').length, 1);
});

test('a definition that will not parse produces no row and no crash', async () => {
    const d = db({ automations: [automationRow({ definition_json: '{not json' })] });
    const { rows, partial } = await usageForMeeting(MEETING, { db: d });
    assert.deepStrictEqual(rows.filter(r => r.kind === 'automation'), []);
    assert.ok(!partial.includes('automation'));
});

test('triggerLabel says "unfiltered" as a flag, never as English', async () => {
    assert.deepStrictEqual(triggerLabel(trig(null)), { unfiltered: true });
    assert.deepStrictEqual(triggerLabel(trig({})), { unfiltered: true });
    assert.deepStrictEqual(triggerLabel(trig({ expr: 'contains(trigger.tags,"sales")' })), { siteLabel: 'contains(trigger.tags,"sales")' });
    assert.deepStrictEqual(triggerLabel(trig({ tagIncludes: 'sales' })), {});
    const long = triggerLabel(trig({ expr: 'x'.repeat(500) }));
    assert.strictEqual(long.siteLabel.length, 80);
});

// ── redaction ───────────────────────────────────────────────────────

test('somebody else’s row keeps its kind and role and loses its name', async () => {
    const rows = [
        { kind: 'kb', id: 'kb-1', title: 'Sales', role: 'contains', siteLabel: 'sales', ownerId: 'other' },
        { kind: 'automation', id: 'a-1', title: 'Mine', role: 'read', ownerId: 'me' },
        { kind: 'automation', id: 'a-2', title: 'Org wide', role: 'read', ownerId: null },
    ];
    assert.deepStrictEqual(redactForeign(rows, 'me'), [
        { kind: 'kb', id: 'kb-1', title: null, role: 'contains', siteLabel: undefined, ownerId: 'other', foreign: true },
        { kind: 'automation', id: 'a-1', title: 'Mine', role: 'read', ownerId: 'me' },
        { kind: 'automation', id: 'a-2', title: 'Org wide', role: 'read', ownerId: null },
    ]);
});

test('redaction survives a non-array and mixed ids', async () => {
    assert.deepStrictEqual(redactForeign(null, 'me'), []);
    const [row] = redactForeign([{ kind: 'kb', id: 'k', title: 'X', ownerId: 7 }], '7');
    assert.strictEqual(row.title, 'X', 'a numeric id must compare as a string, not stay foreign');
});

// ── de regels die iemand met de hand in een kennisbank zette (M4) ────
//
// Dit is de derde kb-predicaat. Wat hier fout kan gaan is niet "een rij te
// weinig" maar een TELLING die iets anders zegt dan het zijpaneel: één rij
// per gefileerde regel zou het paneel vijf keer dezelfde kennisbank laten
// noemen, en een `lineCount` die de tag-bron meetelt zou beweren dat er
// regels gefileerd zijn die niemand ooit heeft aangeklikt.

test('filed transcript lines collapse to ONE row per knowledge base, with a count', async () => {
    const d = db({
        kb: [
            { source_id: 'x1', kind: 'text', config: {}, last_at: '2026-08-01T00:00:00Z', kb_id: 'kb-1', kb_name: 'Sales', owner_id: 'owner-1' },
            { source_id: 'x2', kind: 'text', config: {}, last_at: '2026-08-09T00:00:00Z', kb_id: 'kb-1', kb_name: 'Sales', owner_id: 'owner-1' },
            { source_id: 'x3', kind: 'text', config: {}, last_at: '2026-08-03T00:00:00Z', kb_id: 'kb-2', kb_name: 'Board', owner_id: 'someone-else' },
        ],
    });
    const { rows, partial } = await usageForMeeting(MEETING, { db: d });
    assert.deepStrictEqual(partial, []);
    assert.deepStrictEqual(rows.filter(r => r.kind === 'kb'), [
        // The LATEST filing, not the first one the scan happened to see.
        { kind: 'kb', id: 'kb-1', title: 'Sales', role: 'contains', lineCount: 2, lastAt: '2026-08-09T00:00:00Z', ownerId: 'owner-1' },
        { kind: 'kb', id: 'kb-2', title: 'Board', role: 'contains', lineCount: 1, lastAt: '2026-08-03T00:00:00Z', ownerId: 'someone-else' },
    ]);
});

test('a tag source and a filed line in the SAME base stay two different facts', async () => {
    const d = db({
        kb: [
            { source_id: 's1', kind: 'meeting_tag', config: { tag: 'sales' }, last_at: '2026-08-01T00:00:00Z', kb_id: 'kb-1', kb_name: 'Sales', owner_id: 'owner-1' },
            { source_id: 'x1', kind: 'text', config: {}, last_at: '2026-08-02T00:00:00Z', kb_id: 'kb-1', kb_name: 'Sales', owner_id: 'owner-1' },
        ],
    });
    const { rows } = await usageForMeeting(MEETING, { db: d });
    const kb = rows.filter(r => r.kind === 'kb');
    // "collects everything tagged sales" and "holds one line somebody filed"
    // are different claims about the same base; folding them into one row
    // would make the count mean the first and read as the second.
    assert.strictEqual(kb.length, 2);
    assert.strictEqual(kb[0].siteLabel, 'sales');
    assert.strictEqual(kb[0].lineCount, undefined, 'a tag source has no filed lines to count');
    assert.strictEqual(kb[1].lineCount, 1);
    assert.strictEqual(kb[1].siteLabel, undefined, 'a filed line watches no tag');
});

test('the filed-lines predicate reads the allow-listed metadata pair, as a parameter', async () => {
    const d = db();
    await usageForMeeting(MEETING, { db: d });
    const { sql, params } = d.sqlFor('FROM kb_sources');
    assert.match(sql, /s\.kind = 'text' AND s\.config->'metadata'->>'transcriptionId' = \$4/);
    assert.strictEqual(params[3], 'm-1');
});

test('without tags the filed-lines predicate keeps its OWN parameter index', async () => {
    // The tag clause is the one that may be absent, and every later $n slides
    // up when it is. A hard-coded index here would read the config key as the
    // transcription id and quietly find nothing.
    const d = db();
    await usageForMeeting({ ...MEETING, tags: [] }, { db: d });
    const { sql, params } = d.sqlFor('FROM kb_sources');
    assert.match(sql, /s\.kind = 'text' AND s\.config->'metadata'->>'transcriptionId' = \$3/);
    assert.strictEqual(params[2], 'm-1');
    assert.ok(!/ANY\(\$/.test(sql), 'no tags, no tag clause');
});

test('an unreadable timestamp on a filing never invents one', async () => {
    const d = db({
        kb: [
            { source_id: 'x1', kind: 'text', config: {}, last_at: null, kb_id: 'kb-1', kb_name: 'Sales', owner_id: 'owner-1' },
            { source_id: 'x2', kind: 'text', config: {}, last_at: 'not a date', kb_id: 'kb-1', kb_name: 'Sales', owner_id: 'owner-1' },
        ],
    });
    const { rows } = await usageForMeeting({ ...MEETING, tags: [] }, { db: d });
    const [kb] = rows.filter(r => r.kind === 'kb');
    assert.strictEqual(kb.lineCount, 2, 'the lines are still counted');
    assert.strictEqual(kb.lastAt, null, 'an unparseable stamp is not a time');
});
