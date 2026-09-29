/**
 * kb-sources-backfill: the shape of the sources it invents, and the three
 * properties that make it safe to run on a live install (idempotent, dry-run
 * writes nothing, the automation scan never widens more than it names).
 *
 * The database is a recording fake: every query is answered by pattern, and
 * every write is recorded, so a dry run can be PROVEN to write nothing rather
 * than assumed to.
 *
 * Run: cd server && node --test --test-force-exit migrations/kb-sources-backfill.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { up, planSourcesForKb } = require('./kb-sources-backfill');

// ── A KB with one document of every source_type ─────────────────────
const FIXTURE_DOCS = [
    { id: 'd-up-1', title: 'Handbook.pdf', source_type: 'upload', source_uri: 'Handbook.pdf' },
    { id: 'd-up-2', title: 'Prices.xlsx', source_type: 'upload', source_uri: 'Prices.xlsx' },
    { id: 'd-txt-1', title: 'Opening hours', source_type: 'text', source_uri: null },
    { id: 'd-txt-2', title: 'Return policy', source_type: 'text', source_uri: null },
    { id: 'd-web-1', title: 'Home', source_type: 'web', source_uri: 'https://example.com/' },
    { id: 'd-web-2', title: 'Pricing', source_type: 'web', source_uri: 'https://example.com/pricing' },
    { id: 'd-web-3', title: 'Docs', source_type: 'web', source_uri: 'https://example.com/docs' },
    { id: 'd-web-solo', title: 'Partner page', source_type: 'web', source_uri: 'https://partner.test/about' },
    { id: 'd-n8n-1', title: 'n8n Output', source_type: 'n8n', source_uri: 'n8n://workflow/7/definition' },
    { id: 'd-tick-1', title: 'How to reset', source_type: 'support_ticket', source_uri: 'support://ticket/42' },
    { id: 'd-nb-1', title: 'Notebook source', source_type: 'notebook_source', source_uri: 'src-1' },
    { id: 'd-wp-1', title: 'Webpage source', source_type: 'webpage_source', source_uri: 'src-2' },
];

function planByKind(plan) {
    const out = {};
    for (const entry of plan) {
        out[entry.kind] = out[entry.kind] || [];
        out[entry.kind].push(entry);
    }
    return out;
}

test('every source_type lands on a source, and every document is claimed exactly once', () => {
    const plan = planSourcesForKb(FIXTURE_DOCS);
    const claimed = plan.flatMap(p => p.documentIds);
    assert.strictEqual(claimed.length, FIXTURE_DOCS.length, 'no document left behind');
    assert.strictEqual(new Set(claimed).size, FIXTURE_DOCS.length, 'no document on two sources');
    for (const entry of plan) {
        assert.ok(entry.name && entry.name.length > 0, `source of kind ${entry.kind} has a name`);
        assert.ok(entry.config && typeof entry.config === 'object');
        assert.ok(entry.configMatch && typeof entry.configMatch === 'object');
    }
});

test('uploads collapse into ONE upload source per KB', () => {
    const byKind = planByKind(planSourcesForKb(FIXTURE_DOCS));
    assert.strictEqual(byKind.upload.length, 1);
    assert.strictEqual(byKind.upload[0].name, 'Uploaded files');
    assert.deepStrictEqual(byKind.upload[0].documentIds.sort(), ['d-up-1', 'd-up-2']);
});

test('a pasted text gets its OWN source, named after the document', () => {
    const byKind = planByKind(planSourcesForKb(FIXTURE_DOCS));
    assert.strictEqual(byKind.text.length, 2);
    const names = byKind.text.map(t => t.name).sort();
    assert.deepStrictEqual(names, ['Opening hours', 'Return policy']);
    // Keyed on the document so a re-run finds the same row, while the title in
    // config is what routes/knowledgeBases/ingest.js matches on (jsonb
    // containment makes `{title}` match `{title, documentId}`).
    assert.deepStrictEqual(byKind.text[0].configMatch, { documentId: byKind.text[0].documentIds[0] });
    assert.ok(byKind.text[0].config.title);
});

test('several pages of one origin bundle into one crawl source; a lone page keeps its own URL', () => {
    const byKind = planByKind(planSourcesForKb(FIXTURE_DOCS));
    assert.strictEqual(byKind.webpage.length, 2);

    const bundled = byKind.webpage.find(w => w.documentIds.length === 3);
    assert.ok(bundled, 'the three example.com pages share one source');
    assert.strictEqual(bundled.config.url, 'https://example.com');
    assert.deepStrictEqual(bundled.config.crawl, { maxPages: 3 });
    assert.strictEqual(bundled.name, 'example.com');

    const solo = byKind.webpage.find(w => w.documentIds.length === 1);
    assert.strictEqual(solo.config.url, 'https://partner.test/about', 'a single page keeps its exact address');
    assert.strictEqual(solo.config.crawl, undefined);
});

test('n8n, support tickets, notebook and webpage sources become one legacy source per kind', () => {
    const byKind = planByKind(planSourcesForKb(FIXTURE_DOCS));
    const types = byKind.legacy.map(l => l.config.sourceType).sort();
    assert.deepStrictEqual(types, ['n8n', 'notebook_source', 'support_ticket', 'webpage_source']);
    for (const entry of byKind.legacy) {
        assert.deepStrictEqual(entry.configMatch, { sourceType: entry.config.sourceType });
    }
});

test('an unknown future source_type still gets a legacy source instead of being dropped', () => {
    const plan = planSourcesForKb([{ id: 'x1', title: 'From Mars', source_type: 'mars_probe', source_uri: null }]);
    assert.strictEqual(plan.length, 1);
    assert.strictEqual(plan[0].kind, 'legacy');
    assert.deepStrictEqual(plan[0].config, { sourceType: 'mars_probe' });
    assert.deepStrictEqual(plan[0].documentIds, ['x1']);
});

// ── The migration against a recording fake database ─────────────────

function makeDb({ existingSources = [], automationKbIds = ['11111111-2222-3333-4444-555555555555'] } = {}) {
    const writes = [];
    let nextId = 1;
    const created = [];
    const db = {
        writes, created,
        getOne: async (sql, params = []) => {
            if (/information_schema\.columns/.test(sql)) return { ok: 1 };
            if (/to_regclass/.test(sql)) return { t: 'kb_sources' };
            if (/SELECT id FROM kb_sources/.test(sql)) {
                const [kbId, kind, cfg] = params;
                const match = JSON.parse(cfg);
                const hit = existingSources.find(s => s.kbId === kbId && s.kind === kind
                    && Object.entries(match).every(([k, v]) => JSON.stringify(s.config[k]) === JSON.stringify(v)));
                return hit ? { id: hit.id } : null;
            }
            if (/INSERT INTO kb_sources/.test(sql)) {
                writes.push({ sql, params });
                const id = `src-${nextId++}`;
                created.push({ id, kbId: params[0], kind: params[1], name: params[2], config: JSON.parse(params[3]) });
                return { id };
            }
            if (/COUNT\(\*\)::int AS n/.test(sql)) return { n: 3 };
            return null;
        },
        getAll: async (sql, _params = []) => {
            if (/GROUP BY d\.knowledge_base_id/.test(sql)) {
                return [{ kb_id: 'kb-1', pending: FIXTURE_DOCS.length, tenant_id: 'u-owner' }];
            }
            if (/FROM documents/.test(sql) && /source_id IS NULL/.test(sql)) return FIXTURE_DOCS;
            if (/jsonb_path_query/.test(sql)) return automationKbIds.map(id => ({ kb_id: id }));
            return [];
        },
        run: async (sql, params = []) => {
            writes.push({ sql, params });
            return { rowCount: 1 };
        },
    };
    return db;
}

test('--dry-run writes NOTHING and still reports the full plan', async () => {
    const db = makeDb();
    const logs = [];
    const stats = await up({ dryRun: true, db, log: (m) => logs.push(m) });

    assert.strictEqual(db.writes.length, 0, 'a dry run must not issue a single write');
    assert.strictEqual(stats.knowledgeBases, 1);
    assert.strictEqual(stats.sourcesCreated, 9, '1 upload + 2 text + 2 webpage + 4 legacy');
    assert.strictEqual(stats.documentsAssigned, FIXTURE_DOCS.length);
    assert.ok(logs.some(l => /KB kb-1/.test(l)), 'it logs per knowledge base');
});

test('a live run creates the sources, assigns the documents and fixes both columns', async () => {
    const db = makeDb();
    const stats = await up({ db, log: () => {} });

    assert.strictEqual(db.created.length, 9);
    const kinds = db.created.map(c => c.kind).sort();
    assert.deepStrictEqual(kinds, ['legacy', 'legacy', 'legacy', 'legacy', 'text', 'text', 'upload', 'webpage', 'webpage']);
    const inserts = db.writes.filter(w => /INSERT INTO kb_sources/.test(w.sql));
    assert.ok(inserts.every(w => w.params[4] === 'u-owner'), 'created_by = the KB tenant');
    assert.ok(db.writes.some(w => /SET status = 'duplicate'/.test(w.sql)), 'rows with duplicate_of are marked');
    assert.ok(db.writes.some(w => /SET created_by = tenant_id/.test(w.sql)), 'created_by is backfilled');
    assert.ok(stats.documentsAssigned > 0);
});

test('re-running finds the existing sources instead of creating a second set', async () => {
    // Same KB, but the sources this migration would create already exist.
    const existingSources = [
        { id: 's-up', kbId: 'kb-1', kind: 'upload', config: {} },
        { id: 's-txt-1', kbId: 'kb-1', kind: 'text', config: { documentId: 'd-txt-1', title: 'Opening hours' } },
        { id: 's-txt-2', kbId: 'kb-1', kind: 'text', config: { documentId: 'd-txt-2', title: 'Return policy' } },
        { id: 's-web-1', kbId: 'kb-1', kind: 'webpage', config: { url: 'https://example.com', crawl: { maxPages: 3 } } },
        { id: 's-web-2', kbId: 'kb-1', kind: 'webpage', config: { url: 'https://partner.test/about' } },
        { id: 's-n8n', kbId: 'kb-1', kind: 'legacy', config: { sourceType: 'n8n' } },
        { id: 's-tick', kbId: 'kb-1', kind: 'legacy', config: { sourceType: 'support_ticket' } },
        { id: 's-nb', kbId: 'kb-1', kind: 'legacy', config: { sourceType: 'notebook_source' } },
        { id: 's-wp', kbId: 'kb-1', kind: 'legacy', config: { sourceType: 'webpage_source' } },
    ];
    const db = makeDb({ existingSources });
    const stats = await up({ db, log: () => {} });

    assert.strictEqual(stats.sourcesCreated, 0, 'nothing new on a second pass');
    assert.strictEqual(stats.sourcesReused, 9);
    assert.strictEqual(db.created.length, 0);
});

test("the wrapper routes' find keys match this migration's config", () => {
    // routes/knowledgeBases/ingest.js looks the text source up by { title } and
    // the webpage source by { url }; both must find what this wrote, or the
    // next ingest silently starts a second source next to the migrated one.
    const plan = planSourcesForKb(FIXTURE_DOCS);
    const text = plan.find(p => p.kind === 'text');
    assert.ok(Object.prototype.hasOwnProperty.call(text.config, 'title'),
        'a { title } containment match must hit the migrated text source');
    const web = plan.find(p => p.kind === 'webpage' && p.documentIds.length === 1);
    assert.ok(Object.prototype.hasOwnProperty.call(web.config, 'url'));
});

test("only KBs the automations actually name are widened, and they are logged", async () => {
    const ids = ['11111111-2222-3333-4444-555555555555', 'not-a-uuid'];
    const db = makeDb({ automationKbIds: ids });
    const logs = [];
    const stats = await up({ db, log: (m) => logs.push(m) });

    assert.deepStrictEqual(stats.automationKbIds, ['11111111-2222-3333-4444-555555555555'],
        'a non-uuid value from a definition never reaches the UPDATE');
    const widened = db.writes.filter(w => /\|\| '\["ai_step"\]'::jsonb/.test(w.sql));
    assert.strictEqual(widened.length, 2, 'one pass for agent-context KBs, one for the automation ids');
    assert.ok(logs.some(l => /automations reference 1 knowledge base/.test(l)));
});

test('a missing kb_sources table stops the migration instead of half-applying it', async () => {
    const db = makeDb();
    db.getOne = async (sql) => (/to_regclass/.test(sql) ? { t: null } : { ok: 1 });
    const logs = [];
    const stats = await up({ db, log: (m) => logs.push(m) });
    assert.strictEqual(db.writes.length, 0);
    assert.strictEqual(stats.knowledgeBases, 0);
    assert.ok(logs.some(l => /not present yet/.test(l)));
});
