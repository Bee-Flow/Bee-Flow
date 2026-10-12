'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const discovery = require('./discovery');

const EMAIL = 'person@example.org';
const REQ = { id: 11, subject_email: EMAIL };

function fakeDeps(over = {}) {
    const state = { audits: [], dtQueries: [], kbQueries: [] };
    const tables = over.tables || [];
    const deps = {
        db: {
            getOne: async (sql, params) => {
                if (/FROM dsr_requests/.test(sql)) { state.priorParams = params; return { n: 2 }; }
                return null;
            },
            withTransaction: async (fn) => fn({
                query: async (sql, params) => {
                    state.kbQueries.push({ sql, params });
                    if (/SET LOCAL statement_timeout/.test(sql)) return { rows: [] };
                    if (/FROM knowledge_bases/.test(sql)) return { rows: [{ id: 'kb1', name: 'Handbook' }] };
                    if (/FROM kb_chunks/.test(sql)) {
                        if (over.kbThrows) { const e = new Error('canceling statement due to statement timeout'); e.code = '57014'; throw e; }
                        return { rows: [{ knowledge_base_id: 'kb1', document_id: 'doc9', n: 3 }] };
                    }
                    return { rows: [] };
                },
            }),
        },
        userStore: {
            // Org-pinned by contract: the double answers only for a member of the
            // organisation that is scanning. `person@example.org` belongs to
            // org_a; the same address asked for by org_b resolves to nobody.
            findOrgMemberIdByEmail: async (orgId, e) => (
                orgId === 'org_a' && e === EMAIL ? 'u_1' : null
            ),
            logAccessAudit: async (...args) => { state.audits.push(args); },
        },
        memoryStore: { countActiveMemoriesForUser: async (uid) => (uid === 'u_1' ? 4 : 0) },
        // Pinned like the rest: the count is asked for the scanning org only.
        projectChatStore: {
            countMessagesByAuthor: async (uid, { organizationId }) => (uid === 'u_1' && organizationId === 'org_a' ? 7 : 0),
        },
        datatableStore: {
            listDatatablesForScope: async () => tables,
            getModel: async () => ({
                model: {
                    tables: tables.map(t => ({
                        id: t.id, key: t.key || `t_${t.id}`,
                        fields: t.fields || [{ key: 'name', type: 'text' }, { key: 'notes', type: 'richtext' }, { key: 'age', type: 'number' }],
                    })),
                },
            }),
        },
        datatableDbStore: {
            scopeKey: (s) => `${s.kind}:${s.id}`,
            query: async (owner, entity, sql, params) => {
                state.dtQueries.push({ owner, entity, sql, params });
                const id = sql.match(/FROM "t_([^"]+)"/)?.[1];
                const t = tables.find(x => String(x.id) === id);
                if (t?.hang) return new Promise(() => {}); // never resolves → timeout
                return { rows: [{ n: t?.hits ?? 0 }] };
            },
        },
    };
    return { deps, state };
}

test.beforeEach(() => discovery._resetMemo());

test('output names every source, counts only, never the address', async () => {
    const { deps, state } = fakeDeps({
        tables: [
            { id: 'a', name: 'Customers', hits: 2, lawfulBasis: 'contract', retentionDays: 365 },
            { id: 'b', name: 'Invoices', hits: 1, lawfulBasis: 'legal_obligation', retentionDays: 2555 },
            { id: 'f', name: 'Form answers', hits: 5, managedKind: 'form_answers', source: { automationId: 'auto_1' } },
            { id: 'g', name: 'Form answers 2', hits: 1, managedKind: 'form_answers', source: { automationId: 'auto_1' } },
            { id: 'z', name: 'Silent', hits: 0 },
        ],
    });
    const out = await discovery.run('org_a', REQ, { actorId: 'admin_1', deps });

    assert.deepStrictEqual(out.subject, { email_masked: 'p***@example.org', user_id: 'u_1' });
    const byKind = Object.fromEntries(out.sources.map(s => [s.kind, s]));
    assert.strictEqual(byKind.user_account.count, 1);
    assert.strictEqual(byKind.memories.count, 4);
    assert.strictEqual(byKind.team_chat_messages.count, 7);
    assert.strictEqual(byKind.datatable_rows.count, 3);
    assert.deepStrictEqual(byKind.datatable_rows.items.map(i => i.id), ['a', 'b']);
    assert.strictEqual(byKind.datatable_rows.items[1].retention_note, 'legal_obligation');
    assert.strictEqual(byKind.form_answers.count, 6);
    assert.strictEqual(byKind.form_answers.items.length, 1, 'form answers grouped by automation');
    assert.strictEqual(byKind.form_answers.items[0].automation_id, 'auto_1');
    assert.strictEqual(byKind.kb_chunks.count, 3);
    assert.strictEqual(byKind.kb_chunks.items[0].document_id, 'doc9');
    assert.strictEqual(byKind.prior_dsrs.count, 2);
    assert.deepStrictEqual(out.not_scanned, ['conversations', 'team_chats', 'project_comments', 'co_edited_documents']);
    assert.strictEqual(out.partial, false);
    assert.ok(out.retention_notes.some(n => n.id === 'b' && n.note === 'legal_obligation'));
    for (const s of out.sources) assert.ok(typeof s.label_key === 'string' && s.label_key.startsWith('compliance.dsr_discovery_'));

    const json = JSON.stringify(out);
    assert.ok(!json.includes(EMAIL), 'the address must not appear anywhere in the output');
    assert.ok(!json.includes('Person Example'));

    // Scanning is by ILIKE with the pattern characters escaped, on text columns only.
    const q = state.dtQueries[0];
    assert.match(q.sql, /^SELECT COUNT\(\*\)::int AS n FROM "t_a" WHERE "name" ILIKE \? OR "notes" ILIKE \?$/);
    assert.ok(!q.sql.includes('"age"'));
    assert.deepStrictEqual(q.params, [`%${EMAIL}%`, `%${EMAIL}%`]);
    assert.strictEqual(q.owner, 'org:org_a');
    // Prior DSRs exclude the request itself.
    assert.deepStrictEqual(state.priorParams, ['org_a', EMAIL, 11]);
    // The KB scan runs under the statement timeout, inside the same transaction.
    assert.match(state.kbQueries[0].sql, /SET LOCAL statement_timeout = 5000/);

    // Access audit: who scanned, which request — no address.
    assert.strictEqual(state.audits.length, 1);
    const [action, targetType, targetId, actor, , newValues, orgId] = state.audits[0];
    assert.strictEqual(action, 'dsr.discovery_run');
    assert.strictEqual(targetType, 'dsr_request');
    assert.strictEqual(targetId, '11');
    assert.strictEqual(actor, 'admin_1');
    assert.strictEqual(orgId, 'org_a');
    assert.ok(!JSON.stringify(newValues).includes(EMAIL));
});

test('respects the 200-table cap and marks the scan partial', async () => {
    const tables = Array.from({ length: 205 }, (_, i) => ({ id: `t${i}`, name: `T${i}`, hits: 1 }));
    const { deps, state } = fakeDeps({ tables });
    const out = await discovery.run('org_a', REQ, { deps });
    assert.strictEqual(state.dtQueries.length, discovery.TABLE_CAP);
    assert.strictEqual(out.partial, true);
    assert.strictEqual(out.sources.find(s => s.kind === 'datatable_rows').count, 200);
});

test('a table that does not answer within the per-table budget is skipped and the scan is partial', async () => {
    const { deps } = fakeDeps({ tables: [{ id: 'slow', name: 'Slow', hang: true }, { id: 'ok', name: 'Ok', hits: 1 }] });
    assert.strictEqual(discovery.PER_TABLE_TIMEOUT_MS, 2000);
    const t0 = Date.now();
    const out = await discovery.run('org_a', REQ, { deps, now: t0, perTableTimeoutMs: 40 });
    assert.ok(Date.now() - t0 < 1500, 'the hung table must not block the scan beyond its budget');
    assert.strictEqual(out.partial, true);
    assert.ok(out.errors.some(e => /discovery_timeout/.test(e)));
    const dt = out.sources.find(s => s.kind === 'datatable_rows');
    assert.deepStrictEqual(dt.items.map(i => i.id), ['ok']);
});

test('a KB statement timeout yields partial:true instead of an error', async () => {
    const { deps } = fakeDeps({ kbThrows: true });
    const out = await discovery.run('org_a', REQ, { deps });
    assert.strictEqual(out.partial, true);
    assert.strictEqual(out.sources.find(s => s.kind === 'kb_chunks').count, 0);
});

test('retention rule: legal_obligation or ≥ 7 years', () => {
    assert.strictEqual(discovery.retentionNoteFor({ lawfulBasis: 'legal_obligation', retentionDays: 30 }), 'legal_obligation');
    assert.strictEqual(discovery.retentionNoteFor({ lawfulBasis: 'contract', retentionDays: 2555 }), 'long_retention');
    assert.strictEqual(discovery.retentionNoteFor({ lawful_basis: 'consent', retention_days: 3650 }), 'long_retention');
    assert.strictEqual(discovery.retentionNoteFor({ lawfulBasis: 'contract', retentionDays: 2554 }), null);
    assert.strictEqual(discovery.retentionNoteFor({ lawfulBasis: 'consent', retentionDays: null }), null);
    assert.strictEqual(discovery.retentionNoteFor(null), null);
});

test('the 30 s memo answers a second call without scanning again; peek never scans', async () => {
    const { deps, state } = fakeDeps({ tables: [{ id: 'a', name: 'A', hits: 1 }] });
    const t0 = Date.now();
    assert.strictEqual(discovery.peek('org_a', 11), null);
    const first = await discovery.run('org_a', REQ, { deps, now: t0 });
    const second = await discovery.run('org_a', REQ, { deps, now: t0 + 10_000 });
    assert.strictEqual(second, first);
    assert.strictEqual(state.dtQueries.length, 1);
    assert.strictEqual(state.audits.length, 1);
    assert.strictEqual(discovery.peek('org_a', 11), first);
    // Another org's request with the same id is a different memo entry.
    assert.strictEqual(discovery.peek('org_b', 11), null);
    const third = await discovery.run('org_a', REQ, { deps, now: t0 + discovery.MEMO_TTL_MS + 1 });
    assert.notStrictEqual(third, first);
    assert.strictEqual(state.dtQueries.length, 2);
});

test('summarize keeps counts and flags only', async () => {
    const { deps } = fakeDeps({ tables: [{ id: 'a', name: 'A', hits: 2 }] });
    const out = await discovery.run('org_a', REQ, { deps });
    const s = discovery.summarize(out);
    assert.deepStrictEqual(Object.keys(s).sort(), ['counts', 'not_scanned', 'partial', 'scanned_at']);
    assert.strictEqual(s.counts.datatable_rows, 2);
    assert.ok(!JSON.stringify(s).includes('example.org'));
    assert.strictEqual(discovery.summarize(null), null);
});

test('likeNeedle escapes the LIKE metacharacters', () => {
    assert.strictEqual(discovery.likeNeedle('a_b%c\\d'), '%a\\_b\\%c\\\\d%');
});
test('the scan never reaches for a platform-wide user lookup', () => {
    // Genuinely textual, on purpose: a source-level guard, because the
    // behavioural tests above can only prove what the doubles in THIS file are
    // asked today. `getUserByEmail` is unscoped by design (it serves sign-in
    // and the public DSR intake, which have no caller org); the day it
    // reappears in discovery.js, nothing stops a future double here from
    // defining that method too (a copy-paste from another test's fixture would
    // do it) and answering it just as happily — at which point the tenant
    // boundary is gone again and every behavioural test above stays green.
    const src = fs.readFileSync(path.join(__dirname, 'discovery.js'), 'utf8')
        .split('\n').filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
    assert.ok(!/getUserByEmail/.test(src), 'use userStore.findOrgMemberIdByEmail(orgId, email) instead');
    assert.match(src, /findOrgMemberIdByEmail\(orgId, email\)/, 'and pass the scanning org, not a constant');
});

test('a subject who belongs to ANOTHER organisation is invisible — not an account oracle', async () => {
    // The admin types the address by hand (POST /requests/manual takes any valid
    // one), so an unpinned user lookup would let a tenant ask "does this person
    // have an account here" about every address on the instance, and get back an
    // internal user id plus a memory count for someone else's customer.
    //
    // org_b scans the same address, which belongs to org_a. It must read exactly
    // like an address with no account at all: no id, no counts, no tell.
    const { deps } = fakeDeps({ tables: [] });
    const foreign = await discovery.run('org_b', REQ, { deps });
    const unknown = await discovery.run('org_b', { id: 99, subject_email: 'nobody@example.org' }, { deps });

    assert.strictEqual(foreign.subject.user_id, null, 'no user id across the tenant boundary');
    const kindsOf = (out) => Object.fromEntries(out.sources.map(s => [s.kind, s.count]));
    assert.strictEqual(kindsOf(foreign).user_account, 0);
    assert.strictEqual(kindsOf(foreign).memories, 0);
    // Indistinguishable from "this address is unknown to us" — that is the point.
    assert.deepStrictEqual(kindsOf(foreign), kindsOf(unknown));
    assert.deepStrictEqual(foreign.subject, { ...unknown.subject, email_masked: foreign.subject.email_masked });
});

test('the memory count is never reached without an in-org user', async () => {
    const asked = [];
    const { deps } = fakeDeps({ tables: [] });
    deps.memoryStore = { countActiveMemoriesForUser: async (uid) => { asked.push(uid); return 4; } };
    await discovery.run('org_b', REQ, { deps });
    assert.deepStrictEqual(asked, [], 'a foreign subject must not be counted at all');
    await discovery.run('org_a', REQ, { deps, force: true });
    assert.deepStrictEqual(asked, ['u_1'], 'the org\'s own subject still is');
});


test('a missing store degrades to "unknown" (null count), never to a fake zero', async () => {
    const { deps } = fakeDeps();
    deps.memoryStore = null;
    deps.datatableStore = null;
    const out = await discovery.run('org_a', REQ, { deps });
    assert.strictEqual(out.sources.find(s => s.kind === 'memories').count, null);
    assert.ok(!out.sources.some(s => s.kind === 'datatable_rows'));
});

// ── One HTTP request, one budget (F6) ───────────────────────────────

/**
 * Tables whose count query resolves after `delayMs` (or never, with `hang`),
 * recording how many were in flight at once.
 */
function pacedDeps(tables, { delayMs = 30 } = {}) {
    const state = { dtQueries: [], inFlight: 0, maxInFlight: 0 };
    const { deps } = fakeDeps({ tables });
    deps.datatableDbStore = {
        scopeKey: (s) => `${s.kind}:${s.id}`,
        query: async (owner, entity, sql) => {
            state.dtQueries.push(sql);
            const id = sql.match(/FROM "t_([^"]+)"/)?.[1];
            const t = tables.find(x => String(x.id) === id);
            state.inFlight += 1;
            state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
            try {
                if (t?.hang) return await new Promise(() => {});
                await new Promise(r => setTimeout(r, delayMs));
                return { rows: [{ n: t?.hits ?? 0 }] };
            } finally { state.inFlight -= 1; }
        },
    };
    return { deps, state };
}

test('the independent per-table counts run concurrently, up to the bound', async () => {
    // 200 tables × 2 s one after another is 400 s of wall clock inside a single
    // HTTP request. They are independent COUNT queries: waiting for them
    // strictly in turn only burns the budget.
    const tables = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, name: `C${i}`, hits: 1 }));
    const { deps, state } = pacedDeps(tables, { delayMs: 40 });
    const t0 = Date.now();
    const out = await discovery.run('org_a', REQ, { deps });
    const elapsed = Date.now() - t0;

    assert.strictEqual(state.dtQueries.length, 12, 'every table is still scanned');
    assert.strictEqual(state.maxInFlight, discovery.TABLE_CONCURRENCY, 'and four at a time');
    assert.ok(elapsed < 12 * 40, `sequential would take ${12 * 40} ms; took ${elapsed} ms`);
    assert.strictEqual(out.partial, false);
    // Concurrency must not scramble the report: items stay in table order.
    assert.deepStrictEqual(
        out.sources.find(s => s.kind === 'datatable_rows').items.map(i => i.id),
        tables.map(t => t.id),
    );
});

test('the scan as a whole has a budget, and says what it did not reach', async () => {
    const tables = Array.from({ length: 30 }, (_, i) => ({ id: `h${i}`, name: `H${i}`, hang: true }));
    const { deps, state } = pacedDeps(tables);
    const t0 = Date.now();
    const out = await discovery.run('org_a', REQ, { deps, overallBudgetMs: 60 });
    const elapsed = Date.now() - t0;

    assert.ok(elapsed < 1500, `the whole scan must fit the budget, took ${elapsed} ms`);
    assert.ok(state.dtQueries.length < 30, 'the tables past the budget are not queried at all');
    assert.strictEqual(out.partial, true);
    assert.ok(out.errors.some(e => /budget/.test(e) && /not scanned/.test(e)), out.errors.join(' | '));
    assert.ok(out.not_scanned.includes('datatables'), 'reported, not silently truncated');
    assert.ok(out.not_scanned.includes('conversations'), 'the standing exclusion stays');
    // A per-table timeout may never overshoot the budget it is spending.
    assert.ok(discovery.OVERALL_BUDGET_MS > 0 && discovery.OVERALL_BUDGET_MS <= 30_000);
    assert.ok(!JSON.stringify(out).includes(EMAIL));
});

test('an exhausted budget leaves the knowledge bases UNKNOWN, never a false zero', async () => {
    const tables = Array.from({ length: 4 }, (_, i) => ({ id: `k${i}`, name: `K${i}`, hang: true }));
    const { deps } = pacedDeps(tables);
    const out = await discovery.run('org_a', REQ, { deps, overallBudgetMs: 40 });
    const kb = out.sources.find(s => s.kind === 'kb_chunks');
    assert.strictEqual(kb.count, null, 'a 0 would read as "nothing of this person in any KB"');
    assert.deepStrictEqual(kb.items, []);
    assert.ok(out.not_scanned.includes('knowledge_bases'));
    assert.strictEqual(out.partial, true);
});

test('a budget cut off by a timer that fires early still counts as spent', async (t) => {
    // Node's timers can fire a millisecond before Date.now() says the delay
    // is over. The clock here lags 10 ms once the budget is up, so the scan
    // sees "time left" after its hung tables were cut off by that budget.
    const tables = Array.from({ length: 4 }, (_, i) => ({ id: `e${i}`, name: `E${i}`, hang: true }));
    const { deps } = pacedDeps(tables);
    const realNow = Date.now;
    const deadline = realNow() + 40;
    t.mock.method(Date, 'now', () => { const r = realNow(); return r >= deadline ? r - 10 : r; });
    const out = await discovery.run('org_a', REQ, { deps, overallBudgetMs: 40 });
    const kb = out.sources.find(s => s.kind === 'kb_chunks');
    assert.strictEqual(kb.count, null);
    assert.ok(out.not_scanned.includes('knowledge_bases'));
});

test('the 200-table cap is reported too, not just flagged', async () => {
    const tables = Array.from({ length: 205 }, (_, i) => ({ id: `t${i}`, name: `T${i}`, hits: 0 }));
    const { deps } = fakeDeps({ tables });
    const out = await discovery.run('org_a', REQ, { deps });
    assert.strictEqual(out.partial, true);
    assert.ok(out.errors.some(e => /cap/.test(e) && /5 of 205/.test(e)), out.errors.join(' | '));
    assert.ok(out.not_scanned.includes('datatables'));
});

test('a broken tenant does not answer with a 200-line error list', async () => {
    const tables = Array.from({ length: 60 }, (_, i) => ({ id: `b${i}`, name: `B${i}`, hang: true }));
    const { deps } = pacedDeps(tables);
    const out = await discovery.run('org_a', REQ, { deps, perTableTimeoutMs: 1, overallBudgetMs: 5000 });
    assert.strictEqual(out.partial, true);
    assert.ok(out.errors.length <= discovery.MAX_ERRORS + 1, `errors: ${out.errors.length}`);
    assert.ok(out.errors.some(e => /suppressed/.test(e)));
});

// ── The memo is bounded, and stale is not "current" (F7) ────────────

test('peek respects the TTL: a stale scan can never be stamped as evidence', async () => {
    // POST /fulfil writes peek()'s summary into the append-only evidence chain
    // as the state of the tenant AT FULFILMENT. An hours-old scan written there
    // is a false record nothing downstream can tell from a true one.
    const { deps } = fakeDeps({ tables: [{ id: 'a', name: 'A', hits: 1 }] });
    const t0 = Date.now();
    const fresh = await discovery.run('org_a', REQ, { deps, now: t0 });
    assert.strictEqual(discovery.peek('org_a', 11, { now: t0 + 1000 }), fresh);
    assert.strictEqual(discovery.peek('org_a', 11, { now: t0 + discovery.MEMO_TTL_MS - 1 }), fresh);
    assert.strictEqual(discovery.peek('org_a', 11, { now: t0 + discovery.MEMO_TTL_MS }), null, 'past the TTL it is gone');
    assert.strictEqual(discovery._memoSize(), 0, 'and the expired entry is dropped, not kept');
    assert.strictEqual(discovery.peek('org_a', 11), null, 'peek never scans to fill the gap');
});

test('the memo is bounded — an unbounded Map would grow with every request scanned', async () => {
    const { deps } = fakeDeps({ tables: [] });
    const now = Date.now();
    for (let i = 1; i <= discovery.MEMO_MAX_ENTRIES + 10; i++) {
        await discovery.run('org_a', { id: i, subject_email: EMAIL }, { deps, now });
    }
    assert.ok(discovery._memoSize() <= discovery.MEMO_MAX_ENTRIES, `memo holds ${discovery._memoSize()}`);
    assert.strictEqual(discovery.peek('org_a', 1, { now }), null, 'the oldest entry went out first');
    assert.ok(discovery.peek('org_a', discovery.MEMO_MAX_ENTRIES + 10, { now }), 'the newest is still there');
});

test('team chat messages are counted by author, in the scanning organisation, and never without a user', async () => {
    const asked = [];
    const { deps } = fakeDeps({ tables: [] });
    deps.projectChatStore = {
        countMessagesByAuthor: async (uid, scope) => { asked.push([uid, scope]); return 3; },
    };
    const foreign = await discovery.run('org_b', REQ, { deps });
    assert.strictEqual(foreign.sources.find(s => s.kind === 'team_chat_messages').count, 0);
    assert.deepStrictEqual(asked, [], 'a subject outside the org is not counted at all');

    const own = await discovery.run('org_a', REQ, { deps, force: true });
    assert.strictEqual(own.sources.find(s => s.kind === 'team_chat_messages').count, 3);
    assert.deepStrictEqual(asked, [['u_1', { organizationId: 'org_a' }]]);

    deps.projectChatStore = { countMessagesByAuthor: async () => { throw new Error('relation does not exist'); } };
    const down = await discovery.run('org_a', REQ, { deps, force: true });
    assert.strictEqual(down.sources.find(s => s.kind === 'team_chat_messages').count, null, 'unknown, never a fake zero');
});

test('project participation is counted by user id in the scanning organisation, never opening content', async () => {
    // The real project DDL (and the few columns of the other tables the counts
    // name), so the shipped SQL runs where its columns exist.
    const { PGlite } = require('@electric-sql/pglite');
    const { applyProjectCheckSchema } = require('../projects/testSchema');
    const pg = new PGlite();
    try {
        await applyProjectCheckSchema(pg, { versions: false });
        await pg.exec(`
            INSERT INTO projects (id, name, owner_id, organization_id, kind) VALUES
                ('p1', 'One', 'u_1', 'org_a', 'workspace'), ('p2', 'Two', 'u_9', 'org_a', 'workspace'),
                ('px', 'Elsewhere', 'u_1', 'org_b', 'workspace');
            INSERT INTO project_shares (id, project_id, shared_with_type, shared_with_id) VALUES
                ('s1', 'p2', 'user', 'u_1'), ('s2', 'px', 'user', 'u_1');
            INSERT INTO direct_conversations (id, user_id, project_id, shared_scope) VALUES ('d1', 'u_1', 'p2', 'project'), ('d2', 'u_1', 'p2', 'private');
            INSERT INTO notebooks (id, user_id, project_id) VALUES ('n1', 'u_1', 'p1'), ('n2', 'u_1', NULL);
            INSERT INTO studio_documents (id, user_id, project_id) VALUES ('sd1', 'u_1', 'p2'), ('sd2', 'u_1', 'px');
            INSERT INTO project_comments (id, thread_id, project_id, author_user_id) VALUES
                ('c1', 't1', 'p2', 'u_1'), ('c2', 't1', 'p2', 'u_1'), ('c3', 't1', 'p2', 'u_9'), ('c4', 't2', 'px', 'u_1');
        `);
        const { deps } = fakeDeps({ tables: [] });
        const prior = deps.db.getOne;
        deps.db.getOne = async (sql, params) => (/project/.test(sql) && !/dsr_requests/.test(sql)
            ? (await pg.query(sql, params)).rows[0]
            : prior(sql, params));
        const out = await discovery.run('org_a', REQ, { deps, force: true });
        const participation = out.sources.find(s => s.kind === 'project_participation');
        assert.strictEqual(participation.label_key, 'compliance.dsr_discovery_project_participation');
        assert.deepStrictEqual(Object.fromEntries(participation.items.map(i => [i.kind, i.count])), {
            memberships: 1, owned_projects: 1, shared_chats: 1, project_notebooks: 1, project_documents: 1, project_comments: 2, document_suggestions: 0,
        }, 'org_b\'s project, the private chat and a colleague\'s comment are not counted');
        assert.strictEqual(participation.count, 7);
        assert.ok(!JSON.stringify(participation).includes(EMAIL));
    } finally {
        await pg.close();
    }
});

test('a project count that fails is unknown, never a fake zero; a missing table is a true zero', async () => {
    const { deps } = fakeDeps({ tables: [] });
    deps.db.getOne = async (sql) => {
        if (/FROM notebooks/.test(sql)) { const e = new Error('relation "notebooks" does not exist'); e.code = '42P01'; throw e; }
        if (/project_shares/.test(sql)) throw new Error('statement timeout');
        if (/dsr_requests/.test(sql)) return { n: 0 };
        return { n: 0 };
    };
    const out = await discovery.run('org_a', REQ, { deps, force: true });
    const participation = out.sources.find(s => s.kind === 'project_participation');
    assert.strictEqual(participation.count, null);
    assert.strictEqual(participation.items.find(i => i.kind === 'memberships').count, null);
    assert.strictEqual(participation.items.find(i => i.kind === 'project_notebooks').count, 0);
    const outsider = await discovery.run('org_b', REQ, { deps, force: true });
    assert.strictEqual(outsider.sources.find(s => s.kind === 'project_participation').count, 0, 'no member, nothing counted');
});

test('an outside data subject: sealed project bodies are reported as not scanned, never as searched and empty', async () => {
    // Team chats, comments and co-edited documents are sealed with the project
    // key; the scan counts by author id only. For a subject who is not a user
    // those counts are 0 while messages naming them were never looked at.
    const { deps } = fakeDeps();
    const out = await discovery.run('org_b', { id: 12, subject_email: 'outsider@example.net' }, { deps });
    const byKind = Object.fromEntries(out.sources.map(s => [s.kind, s]));
    assert.strictEqual(byKind.team_chat_messages.count, 0);
    for (const sealed of ['team_chats', 'project_comments', 'co_edited_documents']) {
        assert.ok(out.not_scanned.includes(sealed), `${sealed} must be listed as not scanned`);
    }
    assert.deepStrictEqual(discovery.summarize(out).not_scanned, out.not_scanned, 'the dossier summary carries them too');

    // Every entry has an explanation in the English catalogue.
    const { GUI_DEFAULTS } = require('../../i18n/defaults/en');
    for (const name of discovery.NEVER_SCANNED) {
        assert.ok(GUI_DEFAULTS[`compliance.dsr_discovery_not_scanned_${name}`], `no label for ${name}`);
    }
    assert.match(GUI_DEFAULTS['compliance.dsr_discovery_team_chat_messages'], /written by this person/);
});
