/**
 * `datatable_query` — a table as agent knowledge, read AS THE PERSON ASKING.
 *
 * The rules pinned here are the ones that would fail QUIETLY. A leak out of
 * this tool does not throw: it returns rows, and rows look like success. So
 * every test below breaks a specific way of returning too much (or of saying
 * "no rows" when the truth was "I could not check"), and the SQL it asserts on
 * is compiled by the real `queryCompiler` and the real `accessFilter` — a fake
 * predicate would prove only that the fake agrees with itself.
 *
 * Run: cd server && node --test --test-force-exit core/tools/datatableTools.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const T = require('./datatableTools');
const policy = require('../agentRuntime/toolPolicy');

const ASKER = 'user-asking';
const OWNER = 'user-agent-owner';

/** The descriptor `auth/datatableAccess.synthesizeAccess` builds, by hand. */
function accessFor(rowScope) {
    const s = rowScope === 'own' ? 'own' : 'all';
    return {
        default: 'none',
        roles: {
            viewer: { read: s, create: false, update: 'none', delete: 'none' },
            editor: { read: s, create: true, update: s, delete: s },
        },
    };
}

function tableMeta({ rowScope = 'all' } = {}) {
    return {
        key: 'tbl_products',
        access: accessFor(rowScope),
        fields: [
            { key: 'naam', type: 'text' },
            { key: 'prijs', type: 'number' },
            // Never granted in these fixtures — the column the owner kept back.
            { key: 'marge', type: 'number' },
            { key: 'notitie', type: 'text' },
            // Read-time computed: no physical column, so it cannot be queried.
            { key: 'label', type: 'computed', computed: { expr: 'x' } },
        ],
    };
}

function rows() {
    return [
        { id: 'r1', naam: 'Product XL', prijs: 12.5, marge: 0.4, notitie: '', created_by: ASKER, created_at: '2026-09-01' },
        { id: 'r2', naam: 'Product S', prijs: 3, marge: 0.9, notitie: 'let op', created_by: OWNER, created_at: '2026-09-02' },
    ];
}

/**
 * A harness whose only fakes are the two things that talk to a database and
 * the identity read. The policy, the compiler, the access filter and the row
 * renderer are the real ones.
 */
function harness(over = {}) {
    const calls = { resolve: [], query: [], getForRuntime: [], shield: [] };
    const deps = {
        agentStore: {
            getForRuntime: async (id) => {
                calls.getForRuntime.push(id);
                if (over.getForRuntime) return over.getForRuntime(id);
                return { id, owner_id: OWNER, config: { tools: { datatables: over.grants ?? { 'tbl-1': { scope: 'all', columns: ['naam', 'prijs'] } } } } };
            },
        },
        datatableDbStore: {
            query: async (a, b, sql, params) => {
                calls.query.push({ scopeA: a, scopeB: b, sql, params });
                if (over.query) return over.query(sql, params);
                return { rows: over.rows ?? rows() };
            },
        },
        resolveDatatableForStep: async (id, ctx, opts) => {
            calls.resolve.push({ id, ctx, opts });
            if (over.resolve) return over.resolve(id, ctx, opts);
            return {
                table: { id, name: 'Producten', description: 'De catalogus' },
                tableMeta: over.tableMeta || tableMeta(),
                grade: over.grade || 'viewer',
                scopeKey: 'org:acme', orgId: 'acme',
            };
        },
        askerContext: async () => (over.askerContext
            ? over.askerContext()
            : { orgIds: new Set(['acme']), userGroups: ['g1'] }),
        userStore: {
            getUser: async () => (over.getUser ? over.getUser() : { organizationId: 'acme', orgRole: null }),
        },
        // The Privacy Shield. Default: OFF — `piiStatus: 'none'` is what
        // applyShield answers for an org that never asked for scanning, and it
        // keeps every pre-existing test measuring what it was written to
        // measure. Tests that care pass `over.shield`.
        applyShield: async (arg) => {
            calls.shield.push(arg);
            return over.shield ? over.shield(arg) : { outcome: 'pass', text: arg.text, piiStatus: 'none', reason: null };
        },
        SHIELD_OUTCOME: { PASS: 'pass', REDACTED: 'redacted', SKIPPED: 'skipped' },
    };
    return { deps, calls };
}

const run = (args, over = {}, ctx = {}) => {
    const h = harness(over);
    return T.executeDatatableTool('datatable_query', args, {
        userId: ASKER, agentId: 'agent-1', deps: h.deps, ...ctx,
    }).then(result => ({ result, calls: h.calls }));
};

// ── As the asker ────────────────────────────────────────────────────

test('the query is compiled for the ASKER, never for the agent\'s owner', async () => {
    // The whole point of the feature: two colleagues asking the same agent the
    // same question get the rows THEY may see. Borrowing the owner's grade
    // would hand every colleague the owner's view of the table through a chat
    // box — and it would look like a working feature.
    //
    // A row_scope:'own' table, deliberately: that is the shape whose access
    // predicate BINDS an identity, so "which identity" is visible in the SQL
    // instead of collapsing to `1=1` where any answer looks the same.
    const { calls } = await run({ datatable_id: 'tbl-1' }, {
        tableMeta: tableMeta({ rowScope: 'own' }),
        grants: { 'tbl-1': { scope: 'all', columns: ['naam', 'prijs'] } },
    });

    assert.strictEqual(calls.resolve.length, 1);
    assert.strictEqual(calls.resolve[0].ctx.userId, ASKER);
    assert.strictEqual(calls.resolve[0].ctx.orgRole, null,
        'the asker\'s own standing, resolved fresh — never an assumed one');
    assert.strictEqual(calls.resolve[0].opts.needed, 'viewer', 'read-only: viewer is all it ever asks for');
    assert.ok(calls.query[0].params.includes(ASKER), 'the table\'s predicate is bound to the asker');
    assert.ok(!calls.query[0].params.includes(OWNER), 'and the owner\'s id never reaches the SQL');
});

test('scope "own" narrows on TOP of the table\'s own predicate, never instead of it', async () => {
    // Replacing the predicate would hand the asker rows they created in a
    // table they may not read at all. The grant is a second AND, outside.
    const { calls } = await run({ datatable_id: 'tbl-1' }, {
        grants: { 'tbl-1': { scope: 'own', columns: ['naam'] } },
        // row_scope 'own' AND grade viewer: the table's own predicate already
        // says created_by = viewer. Both have to be in the SQL.
        tableMeta: tableMeta({ rowScope: 'own' }),
    });

    const { sql, params } = calls.query[0];
    const matches = sql.match(/"created_by" = \?/g) || [];
    assert.strictEqual(matches.length, 2, 'the table\'s predicate AND the grant\'s narrowing');
    assert.strictEqual(params.filter(p => p === ASKER).length, 2, 'both bound to the asker');
});

test('scope "own" holds even at owner grade, where the table itself allows everything', async () => {
    // grade 'owner' compiles to `1=1`. If the grant's narrowing were folded
    // into the access filter rather than ANDed after it, this is where it
    // would vanish — for exactly the people who have the most rows to leak.
    const { calls } = await run({ datatable_id: 'tbl-1' }, {
        grants: { 'tbl-1': { scope: 'own', columns: '*' } },
        grade: 'owner',
    });
    assert.match(calls.query[0].sql, /"created_by" = \?/);
    assert.ok(calls.query[0].params.includes(ASKER));
});

test('an unreadable scope reads as "own", not as "all"', async () => {
    // The narrow side of an access question. `{scope:'everything'}` is a typo,
    // and reading a typo as "every row" is the one direction that cannot be
    // undone by the person who made it.
    const { calls } = await run({ datatable_id: 'tbl-1' }, {
        grants: { 'tbl-1': { scope: 'everything', columns: '*' } },
    });
    assert.match(calls.query[0].sql, /"created_by" = \?/);
});

// ── Which tables ────────────────────────────────────────────────────

test('a table the agent was not granted is refused BEFORE it is resolved', async () => {
    const { result, calls } = await run({ datatable_id: 'tbl-other' });
    assert.match(result.error, /not a table this assistant may read/);
    assert.deepStrictEqual(calls.resolve, [], 'no lookup, so not even its existence is confirmed');
});

test('the refusal does not enumerate the granted ids', async () => {
    // Some granted tables are ones THIS asker cannot read — buildDatatableTools
    // goes to the trouble of keeping those out of the tool description, and an
    // error that lists them all hands them over through the back door.
    const { result } = await run({ datatable_id: 'tbl-other' }, {
        grants: { 'tbl-1': { scope: 'own', columns: '*' }, 'tbl-hr-salaris': { scope: 'all', columns: '*' } },
    });
    assert.match(result.error, /not a table this assistant may read/);
    assert.ok(!result.error.includes('tbl-hr-salaris'), 'a table the asker may not read is not named back at them');
    assert.ok(!result.error.includes('tbl-1'));
});

test('the grants are re-read on every call, so a revoked table stops working mid-turn', async () => {
    // The tool DEFINITION is a snapshot taken at the top of the turn. If the
    // executor trusted it, a grant pulled while the model was thinking would
    // still serve rows for the rest of the conversation.
    const { result, calls } = await run({ datatable_id: 'tbl-1' }, { grants: {} });
    assert.match(result.error, /no data tables/);
    assert.deepStrictEqual(calls.getForRuntime, ['agent-1'], 'read from the published config, every call');
    assert.deepStrictEqual(calls.resolve, []);
});

test('a config handed in by the caller cannot widen the grants', async () => {
    // The dispatcher passes ids, not configuration — but a later caller adding
    // `agentConfig` "to save a read" is exactly how a stale, wider snapshot
    // would come back. The row is the only source of truth here.
    const { result, calls } = await run(
        { datatable_id: 'tbl-other' },
        { grants: { 'tbl-1': { scope: 'own', columns: ['naam'] } } },
        { agentConfig: { tools: { datatables: { 'tbl-other': { scope: 'all', columns: '*' } } } } },
    );
    assert.match(result.error, /not a table this assistant may read/);
    assert.deepStrictEqual(calls.resolve, []);
});

test('without an agent, or without a person, nothing is read', async () => {
    for (const ctx of [{ agentId: null }, { userId: null }]) {
        const { result, calls } = await run({ datatable_id: 'tbl-1' }, {}, ctx);
        assert.ok(result.error, JSON.stringify(ctx));
        assert.deepStrictEqual(calls.resolve, []);
        assert.deepStrictEqual(calls.query, []);
    }
});

// ── Which columns ───────────────────────────────────────────────────

test('only the granted columns come back', async () => {
    const { result } = await run({ datatable_id: 'tbl-1' });
    assert.deepStrictEqual(Object.keys(result.results[0]), ['row_id', 'naam', 'prijs']);
    assert.ok(!('marge' in result.results[0]), 'the column the owner kept back stays back');
    assert.ok(!('created_by' in result.results[0]), 'and a row\'s author is not knowledge');
});

test('a column outside the grant cannot be FILTERED on either', async () => {
    // The leak that returns nothing and tells you everything: `marge gt 0.5`
    // answers a question about a hidden column one call at a time, without it
    // ever appearing in a result.
    const { result, calls } = await run({
        datatable_id: 'tbl-1', filters: [{ field: 'marge', op: 'gt', value: 0.5 }],
    });
    assert.match(result.error, /not a column you may filter on/);
    assert.deepStrictEqual(calls.query, [], 'refused before any SQL runs');
});

test('created_by is refused as a filter — the compiler would have accepted it', async () => {
    // queryCompiler.resolveColumn passes every SYSTEM_COLUMN through whatever
    // the table declares, so handing the model's `field` straight to it turns
    // the tool into a "did this person write a row in here" oracle.
    const { result } = await run({
        datatable_id: 'tbl-1', filters: [{ field: 'created_by', op: 'eq', value: OWNER }],
    });
    assert.match(result.error, /not a column you may filter on/);

    const sortAttempt = await run({ datatable_id: 'tbl-1', sort: { field: 'created_by', dir: 'asc' } });
    assert.match(sortAttempt.result.error, /not a column you may sort on/);
});

test('created_at and updated_at may be sorted on, because ordering is not disclosure', async () => {
    const { calls } = await run({ datatable_id: 'tbl-1', sort: { field: 'created_at', dir: 'asc' } });
    assert.match(calls.query[0].sql, /ORDER BY "created_at" ASC/);
});

test('a search only ever looks inside the granted text columns', async () => {
    const { calls } = await run({ datatable_id: 'tbl-1', search: 'XL' }, {
        grants: { 'tbl-1': { scope: 'all', columns: ['naam', 'prijs'] } },
    });
    const { sql } = calls.query[0];
    assert.match(sql, /"naam" ILIKE/);
    assert.ok(!/"notitie" ILIKE/.test(sql), 'a column the grant left out is not searched');
    assert.ok(!/"marge" ILIKE/.test(sql));
});

test('a grant whose columns nobody can read serves nothing, loudly', async () => {
    // `{columns: 'naam'}` — one legacy client sending a bare string. The wide
    // reading ("everything") is exactly the accident this refuses.
    const { result, calls } = await run({ datatable_id: 'tbl-1' }, {
        grants: { 'tbl-1': { scope: 'all', columns: 'naam' } },
    });
    assert.match(result.error, /No columns of "Producten"/);
    assert.deepStrictEqual(calls.query, []);
});

test('grantedColumnsFor is narrow on its own, not only after the policy clamp', () => {
    // It is called with a NORMALISED grant today, so this is the belt to that
    // braces: the day something hands it a raw one, "I cannot read this list"
    // has to mean no columns, never every column. Absent is not "*" at this
    // layer either — `toolPolicy.datatableGrantsOf` is the one place that
    // decides an absent list means the whole table, and it says so explicitly.
    const meta = tableMeta();
    assert.deepStrictEqual(T.grantedColumnsFor({ columns: 'naam' }, meta), [], 'a bare string');
    assert.deepStrictEqual(T.grantedColumnsFor({ columns: 42 }, meta), [], 'a number');
    assert.deepStrictEqual(T.grantedColumnsFor({ columns: { naam: true } }, meta), [], 'an object');
    assert.deepStrictEqual(T.grantedColumnsFor({}, meta), [], 'and an absent list');
    assert.deepStrictEqual(T.grantedColumnsFor({ columns: '*' }, meta),
        ['naam', 'prijs', 'marge', 'notitie', 'label'], 'only an explicit "*" is the whole table');
});

test('a column the grant names but the table no longer declares narrows, it does not throw', async () => {
    const { result } = await run({ datatable_id: 'tbl-1' }, {
        grants: { 'tbl-1': { scope: 'all', columns: ['naam', 'kleur_die_weg_is'] } },
    });
    assert.deepStrictEqual(Object.keys(result.results[0]), ['row_id', 'naam']);
});

// ── Failures are refusals, not empty tables ─────────────────────────

test('a table that could not be resolved is a REFUSAL, never "no rows found"', async () => {
    // The reassuring sentence nobody verified. "There are no matching rows"
    // and "I could not find out" are different answers and the model relays
    // whichever it is given.
    const { result } = await run({ datatable_id: 'tbl-1' }, {
        resolve: () => { const e = new Error('This routine may not read the datatable "Producten".'); e.errorClass = 'datatable_forbidden'; throw e; },
    });
    assert.ok(result.error, 'an error, not an empty result set');
    assert.ok(!('results' in result));
    assert.match(result.error, /may not read/);
});

test('an unreadable identity is reported as an outage, not as the owner\'s fault', async () => {
    // An unresolved account degrades to "in no org, not an admin, in no
    // group", which is a refusal that looks like a configuration mistake on a
    // table that worked yesterday. resolveDatatableForStep turns that into
    // `datatable_identity_unavailable` — but only if it is TOLD.
    const { calls } = await run({ datatable_id: 'tbl-1' }, {
        getUser: () => { throw new Error('users table unreachable'); },
    });
    assert.ok(calls.resolve[0].ctx.identityError, 'the failed read travels with the principal');
    assert.match(calls.resolve[0].ctx.identityError, /account of the person asking/);
});

test('a failed query is a refusal too', async () => {
    const { result } = await run({ datatable_id: 'tbl-1' }, {
        query: () => { throw new Error('connection reset'); },
    });
    assert.match(result.error, /could not be run/);
    assert.ok(!('results' in result));
});

// ── Paging, shape and citations ─────────────────────────────────────

test('the cursor probe row never reaches the model', async () => {
    // compileRecordList asks for limit+1. stepDataSource.js records the run
    // where that extra row leaked into an AI prompt.
    const extra = [...rows(), { id: 'r3', naam: 'Probe', prijs: 1, created_by: ASKER }];
    const { result } = await run({ datatable_id: 'tbl-1', limit: 2 }, { rows: extra });
    assert.strictEqual(result.returned, 2);
    assert.strictEqual(result.has_more, true);
    assert.deepStrictEqual(result.results.map(r => r.row_id), ['r1', 'r2']);
});

test('the row limit is clamped to what a context window can carry', () => {
    assert.strictEqual(T.clampRowLimit(undefined), T.DEFAULT_ROW_LIMIT);
    assert.strictEqual(T.clampRowLimit(-5), T.DEFAULT_ROW_LIMIT, 'a negative limit is not a limit');
    assert.strictEqual(T.clampRowLimit('abc'), T.DEFAULT_ROW_LIMIT);
    assert.strictEqual(T.clampRowLimit(5000), T.MAX_ROW_LIMIT);
    assert.strictEqual(T.clampRowLimit(3), 3);
});

test('every row cites the table AND the row it came from', async () => {
    const { result } = await run({ datatable_id: 'tbl-1' });
    assert.strictEqual(result._action, 'kb_sources', 'the same source panel a kb_search draws');
    assert.strictEqual(result._sources.length, result.results.length, 'aligned by index — the dedup reads them that way');
    const [first] = result._sources;
    assert.strictEqual(first.kind, 'datatable_row');
    assert.strictEqual(first.datatableId, 'tbl-1');
    assert.strictEqual(first.rowId, 'r1');
    assert.strictEqual(first.documentId, null, 'there is no document behind a live row');
    assert.match(first.content, /naam: Product XL/, 'the row as a person reads it');
    assert.ok(!/marge/.test(first.content), 'the citation is not a way round the column grant');
});

test('match "any" ORs the model\'s conditions and never the access predicate', async () => {
    // The placement IS the security story: `access OR status='new'` hands the
    // whole table to anyone who asks for the right status. The compiler keeps
    // the predicate outside the OR group — and the grant's own narrowing rides
    // inside that predicate, so it is outside too.
    const { calls } = await run({
        datatable_id: 'tbl-1',
        match: 'any',
        filters: [{ field: 'naam', op: 'eq', value: 'A' }, { field: 'prijs', op: 'gt', value: 1 }],
    }, { grants: { 'tbl-1': { scope: 'own', columns: ['naam', 'prijs'] } } });

    const { sql } = calls.query[0];
    const orGroup = sql.slice(sql.indexOf('("naam"'));
    assert.ok(!/created_by/.test(orGroup), 'the narrowing is not one of the ORed alternatives');
    assert.match(sql, /"created_by" = \?\) AND \("naam" = \? OR "prijs" > \?\)/);
});

// ── Offering the tool ───────────────────────────────────────────────

test('a table the asker cannot read is not offered at all', async () => {
    const h = harness({
        grants: { 'tbl-1': { scope: 'all', columns: '*' }, 'tbl-2': { scope: 'all', columns: '*' } },
        resolve: (id) => {
            if (id === 'tbl-2') { const e = new Error('nope'); e.errorClass = 'datatable_forbidden'; throw e; }
            return { table: { id, name: 'Producten', description: '' }, tableMeta: tableMeta(), grade: 'viewer', scopeKey: 'org:acme', orgId: 'acme' };
        },
    });
    const [def] = await T.buildDatatableTools({
        userId: ASKER,
        agentConfig: { tools: { datatables: { 'tbl-1': { scope: 'all', columns: '*' }, 'tbl-2': { scope: 'all', columns: '*' } } } },
        deps: h.deps,
    });

    assert.deepStrictEqual(def.function.parameters.properties.datatable_id.enum, ['tbl-1'],
        'the model is never told about a table it would be refused on');
    assert.ok(!def.function.description.includes('tbl-2'));
});

test('no readable table means no tool, and no grants means no database work', async () => {
    const none = harness({ resolve: () => { throw new Error('nope'); } });
    assert.deepStrictEqual(
        await T.buildDatatableTools({ userId: ASKER, agentConfig: { tools: { datatables: { 'tbl-1': {} } } }, deps: none.deps }),
        [],
    );

    const ungranted = harness();
    assert.deepStrictEqual(await T.buildDatatableTools({ userId: ASKER, agentConfig: {}, deps: ungranted.deps }), []);
    assert.deepStrictEqual(ungranted.calls.resolve, [], 'an agent without tables pays nothing per turn');
});

test('offering the tool never throws — one tool must not cost the whole toolbelt', async () => {
    // buildDatatableTools runs inside getIntegrationTools. An exception there
    // is caught by toolStackAssembly, which then drops EVERY integration tool
    // for the turn: a store outage would take Gmail, Drive and Calendar with it.
    const broken = {
        agentStore: null,
        askerContext: async () => { throw new Error('boom'); },
        userStore: { getUser: async () => { throw new Error('boom'); } },
        resolveDatatableForStep: async () => { throw new Error('boom'); },
    };
    assert.deepStrictEqual(
        await T.buildDatatableTools({ userId: ASKER, agentConfig: { tools: { datatables: { t: {} } } }, deps: broken }),
        [],
    );
});

test('a table lost to an OUTAGE is counted, so the answer is not quietly sourceless', async () => {
    // A table dropped because the database blinked leaves the agent answering
    // from its own head with no sign a source went missing — the same
    // reassuring sentence, one layer up. It is still not offered (a table we
    // could not resolve is not one we can serve), but the model is told that
    // something was unreachable, without being told what.
    const h = harness({
        resolve: (id) => {
            if (id === 'tbl-2') throw new Error('connection reset');       // no errorClass ⇒ an outage
            if (id === 'tbl-3') { const e = new Error('nope'); e.errorClass = 'datatable_forbidden'; throw e; }
            return { table: { id, name: 'Producten', description: '' }, tableMeta: tableMeta(), grade: 'viewer', scopeKey: 'org:acme', orgId: 'acme' };
        },
    });
    const grants = { 'tbl-1': { scope: 'all', columns: '*' }, 'tbl-2': { scope: 'all', columns: '*' }, 'tbl-3': { scope: 'all', columns: '*' } };
    const [def] = await T.buildDatatableTools({ userId: ASKER, agentConfig: { tools: { datatables: grants } }, deps: h.deps });

    assert.deepStrictEqual(def.function.parameters.properties.datatable_id.enum, ['tbl-1']);
    assert.match(def.function.description, /1 further table\(s\).*could not be reached/s);
    assert.ok(!def.function.description.includes('tbl-2'), 'counted, never named');
    assert.match(def.function.description, /1 further/, 'ONE outage, not two — tbl-3 was an answer');

    // And a turn where the only failure is a plain refusal says nothing at all:
    // "you may not read this" is not an outage, and reporting it as one would
    // teach the model to hedge every answer.
    const refusedOnly = harness({
        resolve: (id) => {
            if (id === 'tbl-3') { const e = new Error('nope'); e.errorClass = 'datatable_forbidden'; throw e; }
            return { table: { id, name: 'Producten', description: '' }, tableMeta: tableMeta(), grade: 'viewer', scopeKey: 'org:acme', orgId: 'acme' };
        },
    });
    const [clean] = await T.buildDatatableTools({
        userId: ASKER,
        agentConfig: { tools: { datatables: { 'tbl-1': { scope: 'all', columns: '*' }, 'tbl-3': { scope: 'all', columns: '*' } } } },
        deps: refusedOnly.deps,
    });
    assert.ok(!/could not be reached/.test(clean.function.description));
});

// ── The grant section, end to end with the policy module ────────────

test('the policy module and this tool agree about an unreadable grant', async () => {
    // Both ends normalise, and they have to normalise the SAME way: the read
    // side quietly undoing the write side is how a refused limit comes back.
    const stored = policy.normaliseToolsConfig({ tools: { datatables: { t1: 'nonsense' } } }).tools;
    assert.deepStrictEqual(stored.datatables.t1, { scope: 'own', columns: [] });
    assert.deepStrictEqual(policy.datatableGrantsOf({ datatables: { t1: 'nonsense' } }).t1,
        { scope: 'own', columns: [] });

    const { result } = await run({ datatable_id: 't1' }, { grants: { t1: 'nonsense' } });
    assert.match(result.error, /No columns/, 'and the tool refuses rather than serving the table whole');
});

// ── The Privacy Shield, on the live path ────────────────────────────
//
// These rows go to a model. The SAME rows arriving through the knowledge-base
// route (K8) are scanned first — tokenised, or blocked. This path sent them
// raw, and the module header's careful reasoning about WHO may read a row never
// asked what leaves with it.
//
// The switch is the org's knowledge-base setting on purpose: same data, same
// table, same model. And unlike the ingest path it fails CLOSED — at ingest an
// unscanned document is stored and carries its mark, so somebody can still see
// it; here there is no row to mark and no later.

test('rows the shield tokenises reach the model as terms, not as people', async () => {
    const { result } = await run({ datatable_id: 'tbl-1' }, {
        shield: () => ({ outcome: 'redacted', text: 'naam: [PERSON_1]\nprijs: 12,50', piiStatus: 'redacted', reason: null }),
    });
    assert.ok(!result.error, 'a tokenised answer is still an answer');
    assert.ok(!JSON.stringify(result).includes('Jansen'), 'no raw name may survive anywhere in the payload');
    assert.match(result.results[0].redacted_rows, /\[PERSON_1\]/);
    assert.strictEqual(result._sources.length, result.results.length,
        'toolRoundExecutor reads both lists by the same index — they must stay the same length');
    assert.match(result.privacy, /placeholders/, 'and the model is told why the rows look like that');
});

test('a table the org blocks is not read at all', async () => {
    const { result } = await run({ datatable_id: 'tbl-1' }, {
        shield: () => ({ outcome: 'skipped', text: null, piiStatus: 'found', reason: 'personal data' }),
    });
    assert.match(result.error, /does not allow/);
    assert.ok(!result.results, 'a block returns no rows at all, not an empty list');
});

test('FAILS CLOSED: a shield that could not check refuses the rows', async () => {
    // `applyShield` answers PASS with piiStatus 'unscanned' when it could not
    // read the policy, could not reach the detector, or the detector threw. At
    // ingest that is survivable. Here it is the whole question.
    for (const reason of ['Privacy settings unavailable: db down', 'Personal-data detection is not installed', 'Privacy scan failed: timeout']) {
        const { result } = await run({ datatable_id: 'tbl-1' }, {
            shield: (arg) => ({ outcome: 'pass', text: arg.text, piiStatus: 'unscanned', reason }),
        });
        assert.match(result.error, /could not be checked/, `unscanned (${reason}) must refuse`);
        assert.ok(!result.results);
    }
});

test('…and a shield that throws refuses too, rather than reading on', async () => {
    const { result } = await run({ datatable_id: 'tbl-1' }, {
        shield: () => { throw new Error('guard exploded'); },
    });
    assert.match(result.error, /privacy check on this table could not run/);
    assert.ok(!result.results);
});

test('an org that never asked for scanning is untouched', async () => {
    // 'none' is what applyShield answers when the shield is off or knowledge
    // bases are excluded from it. Nothing was promised, so nothing changes —
    // and no latency is spent pretending otherwise.
    const { result } = await run({ datatable_id: 'tbl-1' }, {
        shield: (arg) => ({ outcome: 'pass', text: arg.text, piiStatus: 'none', reason: null }),
    });
    assert.ok(!result.error);
    assert.ok(result.results.length > 0);
    assert.ok(!result.privacy, 'no privacy note where no scan was promised');
});

test('the legacy "mark it, do not touch it" setting is honoured, not upgraded', async () => {
    // `piiStatus: 'found'` with outcome PASS is the org's explicit "just tell
    // me" choice. Redacting anyway would quietly overrule a setting somebody
    // deliberately made.
    const { result } = await run({ datatable_id: 'tbl-1' }, {
        shield: (arg) => ({ outcome: 'pass', text: arg.text, piiStatus: 'found', reason: null }),
    });
    assert.ok(!result.error);
    assert.ok(result.results.length > 0, 'the real rows still travel');
});

test('the policy asked for is the TABLE\'s organisation, not the asker\'s', async () => {
    // The shield belongs to whoever owns the data. An asker who belongs to two
    // organisations must not carry their own org's laxer policy into someone
    // else's table.
    const { calls } = await run({ datatable_id: 'tbl-1' });
    assert.strictEqual(calls.shield.length, 1, 'one scan per tool call, not one per row');
    assert.strictEqual(calls.shield[0].orgId, 'acme');
    assert.ok(calls.shield[0].text.length > 0, 'the rendered rows are what gets scanned');
});
