/**
 * The datatable executor, driven against stubbed stores.
 *
 * Five of these are the reasons the module exists in the shape it does:
 *   - it never guesses an organisation;
 *   - it never widens an unresolved filter to "every row" — reads included;
 *   - it re-resolves the grade on every run, so a revoked grant stops working;
 *   - it never writes a credential into a row;
 *   - it never overwrites a column with a binding that resolved to nothing.
 *
 * The stubs are installed through require.cache before the module under test is
 * loaded, the same technique the App Studio RLS suites use.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const HERE = __dirname;
const SERVER = path.join(HERE, '..', '..');

// ── stub the two stores and the engine before the executor loads ────────────

const state = {
    table: null,
    grants: [],
    meta: null,
    queryRows: [],
    // pgAppEngine.exec ALWAYS answers { changes: rowCount } — 0 included, which
    // is what a statement the access filter scoped away returns.
    execResult: { changes: 1 },
    execCalls: [],
    bumps: [],
    // What the tenant is consuming, as datatableStore.scopeUsage answers it.
    // Empty by default so no test trips the envelope unless it means to.
    usage: { tables: 1, rows: 0, bytes: 0 },
};

function stub(absPath, exports) {
    const resolved = require.resolve(absPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
}

// ── a store stub that HONOURS the SQL it is handed ──────────────────────────
//
// The stub used to be `query: async () => ({ rows: state.queryRows })`: it
// answered rows whatever the statement said, so an upsert probe whose access
// filter compiled to `1=0` still "found" the row it was built to miss. That is
// the only reason an upsert which appended a duplicate on every run shipped
// green under a test called 'save_row updates the matching row instead of
// inserting a second one'.
//
// The evaluator below is small on purpose and STRICT on purpose: every clause
// it does not understand throws. A test double that guesses always guesses in
// the direction that makes the test pass.

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Postgres LIKE/ILIKE with the compiler's `ESCAPE '\'`, as a regex. */
function likeMatch(value, pattern, insensitive) {
    if (value === null || value === undefined) return false;
    let re = '';
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === '\\') { re += escapeRe(pattern[++i] ?? ''); continue; }
        if (ch === '%') { re += '[\\s\\S]*'; continue; }
        if (ch === '_') { re += '[\\s\\S]'; continue; }
        re += escapeRe(ch);
    }
    return new RegExp('^' + re + '$', insensitive ? 'i' : '').test(String(value));
}

/** True when the opening paren at index 0 closes on the last character. */
function wrapsWhole(s) {
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '(') depth++;
        else if (s[i] === ')' && --depth === 0) return i === s.length - 1;
    }
    return false;
}

/**
 * Split on ` AND ` / ` OR ` at paren depth 0 — a BETWEEN's AND is always
 * parenthesised, and so is the OR group `match:'any'` compiles to.
 */
function splitOn(s, word) {
    const parts = [];
    const re = new RegExp(`^\\s${word}\\s`, 'i');
    const span = word.length + 2;
    let depth = 0;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        else if (depth === 0 && re.test(s.slice(i, i + span))) {
            parts.push(s.slice(start, i));
            i += span - 1;
            start = i + 1;
        }
    }
    parts.push(s.slice(start));
    return parts.map(p => p.trim()).filter(Boolean);
}

function evalAtom(atom, ctx) {
    const take = () => ctx.params[ctx.i++];
    const s = atom.startsWith('(') && wrapsWhole(atom) ? atom.slice(1, -1).trim() : atom;
    if (/^1\s*=\s*1$/.test(s) || /^TRUE$/i.test(s)) return true;
    if (/^1\s*=\s*0$/.test(s) || /^FALSE$/i.test(s)) return false;

    let m;
    if ((m = s.match(/^"([^"]+)"\s+IS\s+NOT\s+NULL$/i))) return ctx.row[m[1]] !== null && ctx.row[m[1]] !== undefined;
    if ((m = s.match(/^"([^"]+)"\s+IS\s+NULL$/i))) return ctx.row[m[1]] === null || ctx.row[m[1]] === undefined;
    if ((m = s.match(/^"([^"]+)"\s+BETWEEN\s+\?\s+AND\s+\?$/i))) {
        const lo = take(); const hi = take();
        const v = ctx.row[m[1]];
        return v >= lo && v <= hi;
    }
    if ((m = s.match(/^"([^"]+)"\s+(NOT\s+)?IN\s*\(([^)]*)\)$/i))) {
        const wanted = ((m[3].match(/\?/g) || [])).map(() => take());
        const hit = wanted.includes(ctx.row[m[1]]);
        return m[2] ? !hit : hit;
    }
    if ((m = s.match(/^NOT\s+\((.+)\)$/i))) return !evalClause(m[1], ctx);
    // The keyset cursor: a ROW-VALUE comparison, which is what makes page 2
    // exact under concurrent writes where an OFFSET both skips and repeats.
    if ((m = s.match(/^\("([^"]+)", "([^"]+)"\) ([<>]) \(\?, \?\)$/))) {
        const v = take();
        const i2 = take();
        const a = [ctx.row[m[1]], ctx.row[m[2]]];
        const b = [v, i2];
        const cmp = a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : (a[0] < b[0] ? -1 : 1);
        return m[3] === '<' ? cmp < 0 : cmp > 0;
    }
    if ((m = s.match(/^"([^"]+)"\s+(ILIKE|LIKE)\s+\?\s+ESCAPE\s+'\\'$/i))) {
        return likeMatch(ctx.row[m[1]], take(), m[2].toUpperCase() === 'ILIKE');
    }
    if ((m = s.match(/^"([^"]+)"\s*(>=|<=|!=|=|>|<)\s*\?$/))) {
        const want = take();
        const got = ctx.row[m[1]];
        switch (m[2]) {
            case '=': return got === want;
            case '!=': return got !== want;
            case '>': return got > want;
            case '>=': return got >= want;
            case '<': return got < want;
            case '<=': return got <= want;
            default: break;
        }
    }
    throw new Error(`the datatable store stub cannot evaluate \`${s}\` — teach it rather than let it answer "matches"`);
}

function evalClause(text, ctx) {
    let s = text.trim();
    // Never unwrap into a BETWEEN: its ` AND ` belongs to the operator.
    while (s.startsWith('(') && wrapsWhole(s) && !/^\(\s*"[^"]+"\s+BETWEEN\b/i.test(s)) s = s.slice(1, -1).trim();
    // AND binds tighter than OR in the compiler's output — every OR it emits is
    // inside its own parentheses — so splitting on AND first is enough.
    const ands = splitOn(s, 'AND');
    if (ands.length > 1) {
        // Every branch is evaluated even after a false one, so the parameter
        // cursor stays aligned with the placeholders.
        let ok = true;
        for (const p of ands) { const r = evalClause(p, ctx); ok = ok && r; }
        return ok;
    }
    const ors = splitOn(s, 'OR');
    if (ors.length > 1) {
        let any = false;
        for (const p of ors) { const r = evalClause(p, ctx); any = any || r; }
        return any;
    }
    return evalAtom(s, ctx);
}

/** pgAppEngine.toDollarParams asserts exactly this before it binds anything. */
function assertPlaceholders(sql, params) {
    const n = (sql.match(/\?/g) || []).length;
    assert.strictEqual(n, params.length,
        `compiled SQL has ${n} placeholders but ${params.length} params — a bind one position off:\n${sql}`);
}

function runSelect(sql, params, rows) {
    assertPlaceholders(sql, params);
    const wm = sql.match(/\sWHERE\s([\s\S]*?)(?:\s+ORDER\s+BY\s|\s+LIMIT\s|\s+GROUP\s+BY\s|$)/i);
    // queryCompiler.assertAccessFilter refuses to compile without one, so an
    // unscoped SELECT reaching the store is a compiler regression, not a case
    // the stub should quietly serve.
    if (!wm) throw new Error(`an unscoped SELECT reached the store:\n${sql}`);
    const matched = rows.filter(row => evalClause(wm[1], { params, i: 0, row }));
    // count_rows compiles to an aggregate over the SAME access-filtered WHERE.
    // Answering it from `matched` is what makes "a count never reports rows the
    // routine may not read" a real assertion rather than a stub's opinion.
    const cm = sql.match(/^SELECT\s+COUNT\(\*\)\s+AS\s+"([^"]+)"/i);
    if (cm) return [{ [cm[1]]: matched.length }];
    // The ORDER BY is honoured, because the keyset cursor is only correct
    // ALONGSIDE it: a stub that returned rows in insertion order would let a
    // cursor test pass against a compiler that ordered by nothing.
    const om = sql.match(/\sORDER\s+BY\s+"([^"]+)"\s+(ASC|DESC),\s*"([^"]+)"\s+(ASC|DESC)/i);
    let ordered = matched;
    if (om) {
        const sign = om[2].toUpperCase() === 'DESC' ? -1 : 1;
        ordered = [...matched].sort((a, b) => {
            const pa = a[om[1]]; const pb = b[om[1]];
            if (pa !== pb) return (pa < pb ? -1 : 1) * sign;
            const ia = a[om[3]]; const ib = b[om[3]];
            return ia === ib ? 0 : (ia < ib ? -1 : 1) * sign;
        });
    }
    // compileRecordList always closes with `LIMIT ?` (limit + 1, the cursor
    // probe) — honouring it is what makes the "trims the probe row" test real.
    if (/\sLIMIT\s+\?\s*$/i.test(sql)) {
        const limit = Number(params[params.length - 1]);
        return Number.isFinite(limit) ? ordered.slice(0, limit) : ordered;
    }
    return ordered;
}

stub(path.join(SERVER, 'stores', 'datatableStore.js'), {
    orgScope: (id) => ({ kind: 'org', id }),
    userScope: (id) => ({ kind: 'user', id }),
    // HONOURS the scope it is handed. A stub that answered the same table for
    // every scope would make "the executor looks in the right tenant" untestable
    // — and that is the one thing this module refuses to get wrong.
    getDatatable: async (_id, scope) => (
        state.table && state.table.scope_kind === scope.kind && state.table.scope_id === scope.id
            ? state.table : null),
    listGrants: async () => state.grants,
    getTableMeta: async () => state.meta,
    scopeUsage: async () => state.usage,
    bumpAfterWrite: async (id, scope, delta) => { state.bumps.push({ id, scope, delta }); },
});
stub(path.join(SERVER, 'stores', 'datatableDbStore.js'), {
    scopeKey: (scope) => `${scope.kind}:${scope.id}`,
    query: async (_o, _e, sql, params) => {
        state.execCalls.push({ kind: 'query', sql, params });
        return { rows: runSelect(sql, params, state.queryRows) };
    },
    exec: async (_o, _e, sql, params) => {
        state.execCalls.push({ kind: 'exec', sql, params });
        assertPlaceholders(sql, params);
        return state.execResult;
    },
    // ONE transaction per call, like pgAppEngine.batch — and it refuses more
    // than the engine's 500 statements, because that ceiling is exactly what
    // the chunking under test exists to respect.
    batch: async (_o, _e, statements) => {
        if (!Array.isArray(statements) || !statements.length) throw new Error('batch() requires a non-empty statements array');
        if (statements.length > 500) throw new Error('batch() supports at most 500 statements per call');
        state.execCalls.push({ kind: 'batch', size: statements.length, statements });
        return statements.map((s) => {
            assertPlaceholders(s.sql, s.params);
            return state.execResult;
        });
    },
});

const { execDatatable } = require('./execDatatable');

const TABLE = {
    id: 'tbl_aaaaaa', scope_kind: 'org', scope_id: 'org-a',
    organizationId: 'org-a', organization_id: 'org-a',
    owner_user_id: 'u-owner', ownerUserId: 'u-owner', name: 'Customers',
    is_published: false, shared_groups: [], write_mode: 'grants', row_scope: 'all',
    rowCount: 0,
};
const META = {
    id: 'tbl_aaaaaa', key: 'customers',
    fields: [
        { id: 'f1', key: 'email', type: 'text' },
        { id: 'f2', key: 'status', type: 'text' },
    ],
};
const CTX = {
    userId: 'u-owner', orgId: 'org-a', userHomeOrgId: 'org-a',
    orgRole: 'member', userGroupIds: [],
};
const RUN = { trigger: { output: { email: 'a@b.c' } }, steps: {} };

function reset() {
    state.table = { ...TABLE };
    state.grants = [];
    state.meta = { ...META };
    state.queryRows = [];
    state.execResult = { changes: 1 };
    state.execCalls = [];
    state.bumps = [];
    state.usage = { tables: 1, rows: 0, bytes: 0 };
}

// ── 1. never guess a tenant ─────────────────────────────────────────────────

test('a run with neither an organisation nor an account fails loudly', async () => {
    reset();
    await assert.rejects(
        () => execDatatable({ id: 's1', type: 'datatable', op: 'find_rows', datatableId: 'tbl_aaaaaa' },
            { ...CTX, orgId: null, userId: null }, RUN, 'live'),
        (e) => e.errorClass === 'datatable_no_org',
        'guessing a tenant would put rows in the wrong one',
    );
});

test('a run with no organisation cannot reach an ORG table through its personal scope', async () => {
    reset();
    await assert.rejects(
        () => execDatatable({ id: 's1', type: 'datatable', op: 'find_rows', datatableId: 'tbl_aaaaaa' },
            { ...CTX, orgId: null }, RUN, 'live'),
        (e) => e.errorClass === 'datatable_not_found',
        'the personal scope must not be a back door into an organisation\'s tables',
    );
});

test('a PERSONAL table is reachable by its own account and by nobody else', async () => {
    reset();
    state.table = {
        ...TABLE, scope_kind: 'user', scope_id: 'u-owner',
        organizationId: null, organization_id: null,
    };
    const ctx = { ...CTX, orgId: null, userHomeOrgId: null };
    const mine = await execDatatable(
        { id: 's1', type: 'datatable', op: 'find_rows', datatableId: 'tbl_aaaaaa' }, ctx, RUN, 'live');
    assert.deepStrictEqual(mine.output.rows, []);
    // The engine is addressed by the personal scope key, never by an org id.
    assert.ok(state.execCalls.length > 0);

    // A colleague's run — even an org admin's — reaches nothing: the scope
    // lookup never offers them this table, and RULE 0 would refuse anyway.
    await assert.rejects(
        () => execDatatable({ id: 's1', type: 'datatable', op: 'find_rows', datatableId: 'tbl_aaaaaa' },
            { ...CTX, userId: 'u-admin', orgRole: 'org_admin' }, RUN, 'live'),
        (e) => e.errorClass === 'datatable_not_found',
    );
});

test('an identity outage fails as such, never as an authorisation refusal', async () => {
    // orgRole and the group list decide an ORG grade. Unread, they degrade to
    // "not an admin, in no group" — so the step used to report
    // `datatable_forbidden` on a routine that worked yesterday, and nothing
    // anywhere said a lookup had failed.
    reset();
    await assert.rejects(
        () => execDatatable({ id: 's1', type: 'datatable', op: 'find_rows', datatableId: 'tbl_aaaaaa' },
            { ...CTX, identityError: 'users read timed out' }, RUN, 'live'),
        (e) => e.errorClass === 'datatable_identity_unavailable' && /users read timed out/.test(e.message),
    );
});

test('a PERSONAL table is NOT held back by an identity outage', async () => {
    // Its rule is "you are the account", which needs neither orgRole nor groups.
    reset();
    state.table = {
        ...TABLE, scope_kind: 'user', scope_id: 'u-owner',
        organizationId: null, organization_id: null,
    };
    const res = await execDatatable({ id: 's1', type: 'datatable', op: 'find_rows', datatableId: 'tbl_aaaaaa' },
        { ...CTX, orgId: null, identityError: 'users read timed out' }, RUN, 'live');
    assert.deepStrictEqual(res.output.rows, []);
});

test('a table from another organisation is not found', async () => {
    reset();
    state.table = null;   // the store scopes by tenant, so a cross-org id returns nothing
    await assert.rejects(
        () => execDatatable({ id: 's1', type: 'datatable', op: 'find_rows', datatableId: 'tbl_other' }, CTX, RUN, 'live'),
        (e) => e.errorClass === 'datatable_not_found',
    );
});

// ── 2. the grade is re-resolved every run ───────────────────────────────────

test('a revoked grant stops the step, loudly, on the next run', async () => {
    reset();
    state.table = { ...TABLE, owner_user_id: 'someone-else', ownerUserId: 'someone-else' };
    state.grants = [];   // the grant this routine used to hold is gone
    await assert.rejects(
        () => execDatatable({ id: 's1', type: 'datatable', op: 'find_rows', datatableId: 'tbl_aaaaaa' }, CTX, RUN, 'live'),
        (e) => e.errorClass === 'datatable_forbidden',
    );
});

test('a viewer may read but not write', async () => {
    reset();
    state.table = { ...TABLE, owner_user_id: 'someone-else', ownerUserId: 'someone-else', is_published: true };
    const read = await execDatatable({ id: 's1', type: 'datatable', op: 'find_rows', datatableId: 'tbl_aaaaaa' }, CTX, RUN, 'live');
    assert.ok(read.output, 'a published table is readable org-wide');
    await assert.rejects(
        () => execDatatable({ id: 's1', type: 'datatable', op: 'add_row', datatableId: 'tbl_aaaaaa', values: { email: 'x' } }, CTX, RUN, 'live'),
        (e) => e.errorClass === 'datatable_forbidden',
        'published means readable, never writable',
    );
});

// ── 3. never widen an unresolved filter ─────────────────────────────────────

test('delete_rows SKIPS when its condition resolves to nothing', async () => {
    reset();
    const res = await execDatatable({
        id: 's1', type: 'datatable', op: 'delete_rows', datatableId: 'tbl_aaaaaa',
        where: [{ field: 'email', op: 'eq', value: { kind: 'ref', path: 'steps.missing.output.email' } }],
    }, CTX, RUN, 'live');
    assert.strictEqual(res.skippedReason, 'datatable_filter_unresolved');
    assert.strictEqual(state.execCalls.length, 0, 'nothing may reach the database');
    assert.match(res.output.skipped, /every row/);
});

test('update_rows skips the same way', async () => {
    reset();
    const res = await execDatatable({
        id: 's1', type: 'datatable', op: 'update_rows', datatableId: 'tbl_aaaaaa',
        values: { status: { kind: 'literal', value: 'done' } },
        where: [{ field: 'email', op: 'eq', value: { kind: 'ref', path: 'steps.nope.output.x' } }],
    }, CTX, RUN, 'live');
    assert.strictEqual(res.skippedReason, 'datatable_filter_unresolved');
    assert.strictEqual(state.execCalls.length, 0);
});

test('find_rows SKIPS too — a read that cannot bind its condition is a disclosure', async () => {
    reset();
    state.queryRows = [{ id: '1' }, { id: '2' }];   // what "list the whole table" would have returned
    const res = await execDatatable({
        id: 's1', type: 'datatable', op: 'find_rows', datatableId: 'tbl_aaaaaa',
        where: [{ field: 'email', op: 'eq', value: { kind: 'ref', path: 'steps.form.output.email' } }],
    }, CTX, RUN, 'live');
    assert.strictEqual(res.skippedReason, 'datatable_filter_unresolved');
    assert.strictEqual(state.execCalls.length, 0, 'the widened read must never reach the database');
    assert.deepStrictEqual(res.output.rows, [], 'somebody else\'s rows must not flow into the next step as "the match"');
    assert.strictEqual(res.output.found, false);
    assert.match(res.output.skipped, /"email"/, 'the amber has to name the column');
});

test('an empty template binding counts as unresolved, not as an empty-string match', async () => {
    reset();
    const res = await execDatatable({
        id: 's1', type: 'datatable', op: 'find_rows', datatableId: 'tbl_aaaaaa',
        where: [{ field: 'email', op: 'eq', value: { kind: 'template', value: '{{steps.form.output.email}}' } }],
    }, CTX, RUN, 'live');
    assert.strictEqual(res.skippedReason, 'datatable_filter_unresolved');
});

test('a condition on a system column compiles — resolveColumn allows them', async () => {
    reset();
    // Rejecting created_at here reported "the column no longer exists" about a
    // column that does, while a SORT on the same name compiled fine.
    const res = await execDatatable({
        id: 's1', type: 'datatable', op: 'find_rows', datatableId: 'tbl_aaaaaa',
        where: [{ field: 'created_at', op: 'gt', value: { kind: 'literal', value: '2026-01-01' } }],
    }, CTX, RUN, 'live');
    assert.strictEqual(res.skippedReason, undefined);
    assert.match(state.execCalls[0].sql, /"created_at" >/);
});

test('a column that no longer exists skips rather than erroring the run', async () => {
    reset();
    const res = await execDatatable({
        id: 's1', type: 'datatable', op: 'find_rows', datatableId: 'tbl_aaaaaa',
        where: [{ field: 'deleted_column', op: 'eq', value: { kind: 'literal', value: 'x' } }],
    }, CTX, RUN, 'live');
    assert.strictEqual(res.skippedReason, 'datatable_column_unknown');
    assert.match(res.output.skipped, /deleted_column/);
});

// ── 4. never write a credential ─────────────────────────────────────────────

test('a value containing a secret is refused', async () => {
    reset();
    const ctx = { ...CTX, secretValues: () => ['s3cr3t-token'] };
    await assert.rejects(
        () => execDatatable({
            id: 's1', type: 'datatable', op: 'add_row', datatableId: 'tbl_aaaaaa',
            values: { email: { kind: 'literal', value: 'bearer s3cr3t-token' } },
        }, ctx, RUN, 'live'),
        (e) => e.errorClass === 'datatable_secret_refused',
        'rows bypass redactForPersistence by design, so this is the one place that path closes',
    );
});

// ── reads ───────────────────────────────────────────────────────────────────

test('find_rows trims the cursor probe row and reports hasMore', async () => {
    reset();
    // compileRecordList asks for limit+1; the extra row must never be returned.
    state.queryRows = [{ id: '1' }, { id: '2' }, { id: '3' }];
    const res = await execDatatable({
        id: 's1', type: 'datatable', op: 'find_rows', datatableId: 'tbl_aaaaaa', limit: 2,
    }, CTX, RUN, 'live');
    assert.strictEqual(res.output.rows.length, 2);
    assert.strictEqual(res.output.hasMore, true);
    assert.strictEqual(res.output.count, 2);
    assert.strictEqual(res.output.found, true);
});

test('find_rows on an empty table reports found:false rather than failing', async () => {
    reset();
    const res = await execDatatable({ id: 's1', type: 'datatable', op: 'find_rows', datatableId: 'tbl_aaaaaa' }, CTX, RUN, 'live');
    assert.deepStrictEqual(res.output.rows, []);
    assert.strictEqual(res.output.found, false);
});

test('the compiled read carries the access predicate', async () => {
    reset();
    await execDatatable({ id: 's1', type: 'datatable', op: 'find_rows', datatableId: 'tbl_aaaaaa' }, CTX, RUN, 'live');
    const q = state.execCalls.find(c => c.kind === 'query');
    assert.ok(q, 'a query must have been compiled');
    assert.match(q.sql, /WHERE/, 'the compiler refuses to run without an access filter');
});

test('the read is compiled for Postgres, not the App Studio process default', async () => {
    reset();
    await execDatatable({
        id: 's1', type: 'datatable', op: 'find_rows', datatableId: 'tbl_aaaaaa',
        where: [{ field: 'email', op: 'contains', value: { kind: 'literal', value: 'a' } }],
    }, CTX, RUN, 'live');
    const q = state.execCalls.find(c => c.kind === 'query');
    assert.match(q.sql, /ILIKE/, 'a sqlite-dialect LIKE would silently match fewer rows');
});

// ── writes ──────────────────────────────────────────────────────────────────

test('add_row inserts and moves the row counter', async () => {
    reset();
    const res = await execDatatable({
        id: 's1', type: 'datatable', op: 'add_row', datatableId: 'tbl_aaaaaa',
        values: { email: { kind: 'ref', path: 'trigger.output.email' } },
    }, CTX, RUN, 'live');
    assert.strictEqual(res.output.created, true);
    const ins = state.execCalls.find(c => c.kind === 'exec');
    assert.match(ins.sql, /INSERT INTO/);
    assert.ok(ins.params.includes('a@b.c'), 'the binding must be resolved and BOUND, never interpolated');
    assert.deepStrictEqual(state.bumps, [{ id: 'tbl_aaaaaa', scope: { kind: 'org', id: 'org-a' }, delta: 1 }]);
});

test('save_row updates the matching row instead of inserting a second one', async () => {
    reset();
    state.queryRows = [{ id: 'row-1', email: 'a@b.c' }];
    const res = await execDatatable({
        id: 's1', type: 'datatable', op: 'save_row', datatableId: 'tbl_aaaaaa', matchColumn: 'email',
        values: { email: { kind: 'literal', value: 'a@b.c' }, status: { kind: 'literal', value: 'seen' } },
    }, CTX, RUN, 'live');
    assert.strictEqual(res.output.created, false);
    assert.strictEqual(res.output.updated, 1);
    assert.ok(state.execCalls.some(c => c.kind === 'exec' && /UPDATE/.test(c.sql)));
    assert.ok(!state.execCalls.some(c => c.kind === 'exec' && /INSERT/.test(c.sql)));
});

test('save_row inserts when nothing matches', async () => {
    reset();
    state.queryRows = [];
    const res = await execDatatable({
        id: 's1', type: 'datatable', op: 'save_row', datatableId: 'tbl_aaaaaa', matchColumn: 'email',
        values: { email: { kind: 'literal', value: 'new@b.c' } },
    }, CTX, RUN, 'live');
    assert.strictEqual(res.output.created, true);
    assert.ok(state.execCalls.some(c => c.kind === 'exec' && /INSERT INTO/.test(c.sql)));
});

test('the save_row probe carries a READ filter, never the deny-all create filter', async () => {
    reset();
    state.queryRows = [{ id: 'row-1', email: 'a@b.c' }];
    await execDatatable({
        id: 's1', type: 'datatable', op: 'save_row', datatableId: 'tbl_aaaaaa', matchColumn: 'email',
        values: { email: { kind: 'literal', value: 'a@b.c' }, status: { kind: 'literal', value: 'seen' } },
    }, CTX, RUN, 'live');
    const probe = state.execCalls.find(c => c.kind === 'query');
    assert.doesNotMatch(probe.sql, /1\s*=\s*0/,
        'a create filter compiles to 1=0 for EVERY grade — the probe then matches nothing and every upsert appends');
    assert.ok(state.execCalls.some(c => c.kind === 'exec' && /UPDATE/.test(c.sql)));
});

test('save_row run twice leaves ONE row', async () => {
    reset();
    const step = {
        id: 's1', type: 'datatable', op: 'save_row', datatableId: 'tbl_aaaaaa', matchColumn: 'email',
        values: { email: { kind: 'literal', value: 'a@b.c' }, status: { kind: 'literal', value: 'seen' } },
    };
    const first = await execDatatable(step, CTX, RUN, 'live');
    assert.strictEqual(first.output.created, true);
    assert.ok(first.output.id, 'the insert must report the id it minted, or the next run cannot find it');

    // The row the INSERT left behind is what the second run's probe finds.
    state.queryRows = [{ id: first.output.id, email: 'a@b.c' }];
    state.execCalls = [];
    const second = await execDatatable(step, CTX, RUN, 'live');
    assert.strictEqual(second.output.created, false);
    assert.strictEqual(second.output.id, first.output.id);
    assert.ok(!state.execCalls.some(c => c.kind === 'exec' && /INSERT/.test(c.sql)),
        'a nightly routine keyed on an e-mail address grew one duplicate per run');
});

test('on an own-scoped table the probe only matches the caller\'s OWN row', async () => {
    reset();
    // Editor grade on a row_scope:'own' table → synthesizeAccess gives read
    // scope 'own', so the probe's access predicate is `"created_by" = ?`. A
    // colleague's row with the same e-mail must NOT be taken as the match, or
    // the upsert rewrites somebody else's record. Only a stub that runs the
    // compiled WHERE can tell these two cases apart.
    state.table = { ...TABLE, owner_user_id: 'someone-else', ownerUserId: 'someone-else', row_scope: 'own' };
    state.grants = [{ grantee_type: 'user', grantee_id: 'u-owner', grade: 'editor' }];
    state.queryRows = [{ id: 'row-theirs', email: 'a@b.c', created_by: 'someone-else' }];
    const step = {
        id: 's1', type: 'datatable', op: 'save_row', datatableId: 'tbl_aaaaaa', matchColumn: 'email',
        values: { email: { kind: 'literal', value: 'a@b.c' } },
    };
    const mine = await execDatatable(step, CTX, RUN, 'live');
    assert.strictEqual(mine.output.created, true, 'a row created by a colleague is out of scope, so this is an insert');

    reset();
    state.table = { ...TABLE, owner_user_id: 'someone-else', ownerUserId: 'someone-else', row_scope: 'own' };
    state.grants = [{ grantee_type: 'user', grantee_id: 'u-owner', grade: 'editor' }];
    state.queryRows = [{ id: 'row-mine', email: 'a@b.c', created_by: 'u-owner' }];
    const again = await execDatatable(step, CTX, RUN, 'live');
    assert.strictEqual(again.output.created, false);
    assert.strictEqual(again.output.id, 'row-mine');
});

test('add_row returns the id compileInsert minted, in the same shape save_row returns', async () => {
    reset();
    const res = await execDatatable({
        id: 's1', type: 'datatable', op: 'add_row', datatableId: 'tbl_aaaaaa',
        values: { email: { kind: 'literal', value: 'a@b.c' } },
    }, CTX, RUN, 'live');
    // The variable picker has always advertised steps.<id>.output.row.id.
    assert.ok(res.output.id, 'the minted id was compiled into the INSERT and thrown away');
    assert.strictEqual(res.output.row.id, res.output.id);
    assert.deepStrictEqual(Object.keys(res.output).sort(), ['created', 'id', 'row', 'updated']);
});

test('an insert at the row cap fails with the errorClass an on_error branch can catch', async () => {
    reset();
    const { DATA_LIMITS } = require('../dataEngine/dataModel/vocabulary');
    state.table = { ...TABLE, rowCount: DATA_LIMITS.MAX_ROWS_PER_TABLE };
    await assert.rejects(
        () => execDatatable({
            id: 's1', type: 'datatable', op: 'add_row', datatableId: 'tbl_aaaaaa',
            values: { email: { kind: 'literal', value: 'a@b.c' } },
        }, CTX, RUN, 'live'),
        (e) => e.errorClass === 'datatable_quota',
        'validate/constants.js promises authors a datatable step fails on a quota',
    );
    assert.strictEqual(state.execCalls.length, 0);
});

// ── an unresolved WRITE value never overwrites ──────────────────────────────

test('update_rows DROPS a value whose binding resolved to nothing', async () => {
    reset();
    // The row has to carry the column the step filters on: the store stub runs
    // the compiled WHERE, so a fixture that cannot satisfy its own condition
    // reaches no UPDATE at all and the assertion below would pass on nothing.
    state.queryRows = [{ id: 'row-1', email: 'a@b.c' }];
    const res = await execDatatable({
        id: 's1', type: 'datatable', op: 'update_rows', datatableId: 'tbl_aaaaaa',
        values: {
            status: { kind: 'literal', value: 'done' },
            email: { kind: 'ref', path: 'steps.missing.output.email' },
        },
        where: [{ field: 'email', op: 'eq', value: { kind: 'literal', value: 'a@b.c' } }],
    }, CTX, RUN, 'live');
    assert.strictEqual(res.output.updated, 1);
    // update_rows writes through one BATCHED transaction per chunk, not one
    // exec per row, so the compiled UPDATE arrives as a batch statement.
    const upd = state.execCalls.find(c => c.kind === 'batch').statements[0];
    assert.match(upd.sql, /"status" = \?/);
    assert.doesNotMatch(upd.sql, /"email" = \?/,
        'an unresolved ref becomes NULL through coerceValue and blanks the column on every matched row');
});

test('an explicit literal null still writes NULL — that IS the author\'s choice', async () => {
    reset();
    state.queryRows = [{ id: 'row-1', email: 'a@b.c' }];
    await execDatatable({
        id: 's1', type: 'datatable', op: 'update_rows', datatableId: 'tbl_aaaaaa',
        values: { status: { kind: 'literal', value: null } },
        where: [{ field: 'email', op: 'eq', value: { kind: 'literal', value: 'a@b.c' } }],
    }, CTX, RUN, 'live');
    const upd = state.execCalls.find(c => c.kind === 'batch').statements[0];
    assert.match(upd.sql, /"status" = \?/);
    assert.ok(upd.params.includes(null));
});

test('an INSERT keeps its empties — a new row\'s blank is a blank', async () => {
    reset();
    await execDatatable({
        id: 's1', type: 'datatable', op: 'add_row', datatableId: 'tbl_aaaaaa',
        values: {
            email: { kind: 'literal', value: 'a@b.c' },
            status: { kind: 'ref', path: 'steps.missing.output.x' },
        },
    }, CTX, RUN, 'live');
    const ins = state.execCalls.find(c => c.kind === 'exec');
    assert.match(ins.sql, /"status"/, 'nothing is being overwritten, so there is nothing to protect');
});

test('an update whose every value came out empty SKIPS instead of blanking the rows', async () => {
    reset();
    state.queryRows = [{ id: 'row-1' }];
    const res = await execDatatable({
        id: 's1', type: 'datatable', op: 'update_rows', datatableId: 'tbl_aaaaaa',
        values: { status: { kind: 'ref', path: 'steps.missing.output.status' } },
        where: [{ field: 'email', op: 'eq', value: { kind: 'literal', value: 'a@b.c' } }],
    }, CTX, RUN, 'live');
    assert.strictEqual(res.skippedReason, 'datatable_values_unresolved');
    assert.strictEqual(res.output.updated, 0);
    assert.strictEqual(state.execCalls.length, 0);
});

// ── honest counts ───────────────────────────────────────────────────────────

test('a statement that changed nothing is reported as nothing', async () => {
    reset();
    state.queryRows = [{ id: 'row-1', email: 'a@b.c' }, { id: 'row-2', email: 'a@b.c' }];
    state.execResult = { changes: 0 };   // e.g. rows the UPDATE's access filter scoped away
    const res = await execDatatable({
        id: 's1', type: 'datatable', op: 'update_rows', datatableId: 'tbl_aaaaaa',
        values: { status: { kind: 'literal', value: 'done' } },
        where: [{ field: 'email', op: 'eq', value: { kind: 'literal', value: 'a@b.c' } }],
    }, CTX, RUN, 'live');
    assert.strictEqual(res.output.updated, 0, 'the old `changes ? … : 1` fallback counted a 0-row statement as 1');
});

test('a delete that removed nothing does not move the row counter', async () => {
    reset();
    state.queryRows = [{ id: 'row-1', email: 'a@b.c' }];
    state.execResult = { changes: 0 };
    const res = await execDatatable({
        id: 's1', type: 'datatable', op: 'delete_rows', datatableId: 'tbl_aaaaaa',
        where: [{ field: 'email', op: 'eq', value: { kind: 'literal', value: 'a@b.c' } }],
    }, CTX, RUN, 'live');
    assert.strictEqual(res.output.deleted, 0);
    assert.deepStrictEqual(state.bumps, [{ id: 'tbl_aaaaaa', scope: { kind: 'org', id: 'org-a' }, delta: 0 }],
        'bumpAfterWrite would otherwise subtract deletions that never happened');
});

test('save_row reports the real changes on its update branch', async () => {
    reset();
    state.queryRows = [{ id: 'row-1', email: 'a@b.c' }];
    state.execResult = { changes: 0 };
    const res = await execDatatable({
        id: 's1', type: 'datatable', op: 'save_row', datatableId: 'tbl_aaaaaa', matchColumn: 'email',
        values: { email: { kind: 'literal', value: 'a@b.c' } },
    }, CTX, RUN, 'live');
    assert.strictEqual(res.output.updated, 0, 'it used to return a hard-coded updated:1');
});

test('a renamed match column takes the amber skip, not a raw compiler error', async () => {
    reset();
    const res = await execDatatable({
        id: 's1', type: 'datatable', op: 'save_row', datatableId: 'tbl_aaaaaa', matchColumn: 'customer_ref',
        values: { email: { kind: 'literal', value: 'a@b.c' } },
    }, CTX, RUN, 'live');
    assert.strictEqual(res.skippedReason, 'datatable_column_unknown');
    assert.match(res.output.skipped, /customer_ref/);
    assert.strictEqual(state.execCalls.length, 0);
});

test('a write to a column that no longer exists skips rather than erroring', async () => {
    reset();
    const res = await execDatatable({
        id: 's1', type: 'datatable', op: 'add_row', datatableId: 'tbl_aaaaaa',
        values: { gone: { kind: 'literal', value: 'x' } },
    }, CTX, RUN, 'live');
    assert.strictEqual(res.skippedReason, 'datatable_column_unknown');
    assert.strictEqual(state.execCalls.length, 0);
});

// ── dry run ─────────────────────────────────────────────────────────────────

test('a dry run synthesises every write and touches nothing', async () => {
    reset();
    for (const op of ['add_row', 'save_row', 'update_rows', 'delete_rows']) {
        state.execCalls = [];
        const res = await execDatatable({
            id: 's1', type: 'datatable', op, datatableId: 'tbl_aaaaaa', matchColumn: 'email',
            values: { email: { kind: 'literal', value: 'a@b.c' } },
            where: [{ field: 'email', op: 'eq', value: { kind: 'literal', value: 'a@b.c' } }],
        }, CTX, RUN, 'dry_run');
        assert.ok(res.output._dryRunSynthesised, `${op} must be synthesised in a preview`);
        assert.strictEqual(state.execCalls.length, 0, `${op} must not reach the database in a preview`);
    }
});

test('a dry run synthesises the shape the LIVE path returns, not a shape of its own', async () => {
    reset();
    const base = {
        id: 's1', type: 'datatable', datatableId: 'tbl_aaaaaa', matchColumn: 'email',
        values: { email: { kind: 'literal', value: 'a@b.c' } },
        where: [{ field: 'email', op: 'eq', value: { kind: 'literal', value: 'a@b.c' } }],
    };
    const del = await execDatatable({ ...base, op: 'delete_rows' }, CTX, RUN, 'dry_run');
    assert.deepStrictEqual(Object.keys(del.output).sort(), ['_dryRunSynthesised', 'deleted'],
        'a delete preview must not advertise created:true');
    const upd = await execDatatable({ ...base, op: 'update_rows' }, CTX, RUN, 'dry_run');
    assert.deepStrictEqual(Object.keys(upd.output).sort(), ['_dryRunSynthesised', 'updated']);
    const add = await execDatatable({ ...base, op: 'add_row' }, CTX, RUN, 'dry_run');
    assert.deepStrictEqual(Object.keys(add.output).sort(),
        ['_dryRunSynthesised', 'created', 'id', 'row', 'updated']);
});

test('a dry run checks the write permission BEFORE synthesising a happy preview', async () => {
    reset();
    // A viewer never gets this far (the grade check fails first), so the case
    // that matters is a grade the table's own access descriptor refuses.
    state.table = { ...TABLE, row_scope: 'own' };
    const res = await execDatatable({
        id: 's1', type: 'datatable', op: 'add_row', datatableId: 'tbl_aaaaaa',
        values: { email: { kind: 'literal', value: 'a@b.c' } },
    }, CTX, RUN, 'dry_run');
    assert.ok(res.output._dryRunSynthesised, 'an owner may create on an own-scoped table');
    assert.strictEqual(state.execCalls.length, 0);
});

test('a dry run of find_rows reads for real — it is access-filtered, and a fake would hide the answer', async () => {
    reset();
    state.queryRows = [{ id: '1', email: 'a@b.c' }];
    const res = await execDatatable({ id: 's1', type: 'datatable', op: 'find_rows', datatableId: 'tbl_aaaaaa' }, CTX, RUN, 'dry_run');
    assert.strictEqual(res.output.rows.length, 1);
    assert.ok(!res.output._dryRunSynthesised);
});

// ── paging, counting and one combinator ─────────────────────────────────────

/**
 * `n` rows that all satisfy `email = 'a@b.c'`. `created_at` is real because the
 * keyset cursor is built from it — a fixture without one produces a null cursor
 * and "page 2 is reachable" would pass against a route that never built one.
 */
const manyRows = (n) => Array.from({ length: n }, (_, i) => ({
    id: `row-${String(i).padStart(4, '0')}`,
    email: 'a@b.c',
    status: 'new',
    created_at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
}));

test('find_rows reports `returned` — the page, not the match — and keeps `count` as an alias', async () => {
    // `count` was rows.length CLAMPED BY THE PAGE SIZE, so a condition on
    // `count > 100` after a default page of 50 could never fire. The name now
    // says what it is; the old one survives one release so existing routines
    // keep working.
    reset();
    state.queryRows = manyRows(80);
    const res = await execDatatable({
        id: 's1', type: 'datatable', op: 'find_rows', datatableId: 'tbl_aaaaaa', limit: 50,
    }, CTX, RUN, 'live');
    assert.strictEqual(res.output.returned, 50);
    assert.strictEqual(res.output.count, 50, 'the deprecated alias still answers');
    assert.strictEqual(res.output.hasMore, true);
    assert.ok(res.output.nextCursor, 'and page 2 is reachable');
});

test('a cursor from one page reaches the next with no overlap', async () => {
    reset();
    state.queryRows = manyRows(80);
    const first = await execDatatable({
        id: 's1', type: 'datatable', op: 'find_rows', datatableId: 'tbl_aaaaaa', limit: 50,
    }, CTX, RUN, 'live');
    // The cursor is a BINDING like every other field, so this is exactly what
    // {{steps.s1.output.nextCursor}} resolves to on the next node.
    const second = await execDatatable({
        id: 's2', type: 'datatable', op: 'find_rows', datatableId: 'tbl_aaaaaa', limit: 50,
        cursor: { kind: 'literal', value: first.output.nextCursor },
    }, CTX, RUN, 'live');
    const page2 = state.execCalls[state.execCalls.length - 1];
    assert.match(page2.sql, /AND \("created_at", "id"\) < \(\?, \?\)/,
        'the second page is a keyset comparison, not an OFFSET — OFFSET on a table under concurrent writes both skips and repeats');
    assert.strictEqual(second.output.returned, 30);
    assert.strictEqual(second.output.hasMore, false);
    const ids = [...first.output.rows, ...second.output.rows].map(r => r.id);
    assert.strictEqual(new Set(ids).size, 80, 'no row appears twice and none is missed');
});

test('a cursor that resolved to nothing is page 1, never "every row"', async () => {
    reset();
    state.queryRows = manyRows(3);
    const res = await execDatatable({
        id: 's1', type: 'datatable', op: 'find_rows', datatableId: 'tbl_aaaaaa',
        cursor: { kind: 'ref', path: 'steps.missing.output.nextCursor' },
    }, CTX, RUN, 'live');
    assert.strictEqual(res.output.returned, 3);
    assert.doesNotMatch(state.execCalls[0].sql, /"created_at", "id"\) </);
});

test('count_rows counts past the page size, access-filtered', async () => {
    reset();
    state.queryRows = manyRows(1234);
    const res = await execDatatable({
        id: 's1', type: 'datatable', op: 'count_rows', datatableId: 'tbl_aaaaaa',
        where: [{ field: 'email', op: 'eq', value: { kind: 'literal', value: 'a@b.c' } }],
    }, CTX, RUN, 'live');
    assert.strictEqual(res.output.count, 1234, 'the whole point: a total a page size cannot cap');
    assert.strictEqual(res.output.found, true);
    const q = state.execCalls[0];
    assert.match(q.sql, /^SELECT COUNT\(\*\) AS "total" FROM "customers" WHERE \(1=1\) AND "email" = \?/,
        'the access predicate is in the WHERE that FEEDS the aggregate');
});

test('count_rows is a READ — it never asks for write permission', async () => {
    reset();
    state.table = { ...TABLE, owner_user_id: 'someone-else', ownerUserId: 'someone-else', is_published: true };
    const res = await execDatatable({
        id: 's1', type: 'datatable', op: 'count_rows', datatableId: 'tbl_aaaaaa',
    }, CTX, RUN, 'live');
    assert.strictEqual(res.output.count, 0);
});

test("match:'any' ORs the conditions while the access predicate stays ANDed outside", async () => {
    reset();
    state.queryRows = [
        { id: 'row-1', email: 'a@b.c', status: 'new' },
        { id: 'row-2', email: 'a@b.c', status: 'retry' },
        { id: 'row-3', email: 'a@b.c', status: 'done' },
    ];
    const res = await execDatatable({
        id: 's1', type: 'datatable', op: 'find_rows', datatableId: 'tbl_aaaaaa', match: 'any',
        where: [
            { field: 'status', op: 'eq', value: { kind: 'literal', value: 'new' } },
            { field: 'status', op: 'eq', value: { kind: 'literal', value: 'retry' } },
        ],
    }, CTX, RUN, 'live');
    assert.deepStrictEqual(res.output.rows.map(r => r.id).sort(), ['row-1', 'row-2']);
    // `access OR status = ?` would hand every row of the table to anybody who
    // asked for the right status.
    assert.match(state.execCalls[0].sql,
        /WHERE \(1=1\) AND \("status" = \? OR "status" = \?\)/);
});

test('the new negation ops compile, and `in` with a non-array is refused', async () => {
    reset();
    state.queryRows = [
        { id: 'row-1', email: 'a@b.c', status: 'new' },
        { id: 'row-2', email: 'x@y.z', status: 'done' },
    ];
    const res = await execDatatable({
        id: 's1', type: 'datatable', op: 'find_rows', datatableId: 'tbl_aaaaaa',
        where: [{ field: 'status', op: 'notIn', value: { kind: 'literal', value: ['done'] } }],
    }, CTX, RUN, 'live');
    assert.deepStrictEqual(res.output.rows.map(r => r.id), ['row-1']);

    // A binding that produced 'a,b' instead of ['a','b'] used to compile to a
    // literal FALSE: zero rows, for ever, reported as a successful read.
    reset();
    state.queryRows = manyRows(2);
    await assert.rejects(
        () => execDatatable({
            id: 's1', type: 'datatable', op: 'find_rows', datatableId: 'tbl_aaaaaa',
            where: [{ field: 'status', op: 'in', value: { kind: 'literal', value: 'new,retry' } }],
        }, CTX, RUN, 'live'),
        (e) => /needs a list of values/.test(e.message),
    );
});

// ── batched bulk writes ─────────────────────────────────────────────────────

test('update_rows writes in batched transactions, not one exec per row', async () => {
    reset();
    state.queryRows = manyRows(1200);
    const res = await execDatatable({
        id: 's1', type: 'datatable', op: 'update_rows', datatableId: 'tbl_aaaaaa',
        values: { status: { kind: 'literal', value: 'done' } },
        where: [{ field: 'email', op: 'eq', value: { kind: 'literal', value: 'a@b.c' } }],
    }, CTX, RUN, 'live');

    const batches = state.execCalls.filter(c => c.kind === 'batch');
    assert.deepStrictEqual(batches.map(b => b.size), [500, 500],
        'DATATABLE_MAX_LIMIT rows in chunks of 500 — it used to be 1000 separate transactions');
    assert.strictEqual(state.execCalls.filter(c => c.kind === 'exec').length, 0);
    assert.strictEqual(res.output.updated, 1000);
    // Never silent: 1200 matched and 1000 were changed.
    assert.strictEqual(res.output.truncated, true);
    assert.match(res.output.warning, /1000/);
});

test('delete_rows REFUSES a match larger than it can finish, rather than reporting success', async () => {
    // `{deleted: 1000}` on a 5,000-row match is worse than a failed step:
    // nobody re-runs a green delete, so the rest sit there believed gone.
    reset();
    state.queryRows = manyRows(1200);
    await assert.rejects(
        () => execDatatable({
            id: 's1', type: 'datatable', op: 'delete_rows', datatableId: 'tbl_aaaaaa',
            where: [{ field: 'email', op: 'eq', value: { kind: 'literal', value: 'a@b.c' } }],
        }, CTX, RUN, 'live'),
        (e) => e.errorClass === 'datatable_too_many_rows' && /1000/.test(e.message),
    );
    assert.strictEqual(state.execCalls.filter(c => c.kind === 'batch').length, 0,
        'and it refuses BEFORE deleting the first thousand');
    assert.deepStrictEqual(state.bumps, []);
});

test('a delete that fits runs batched and moves row_count by what each chunk really removed', async () => {
    reset();
    state.queryRows = manyRows(700);
    const res = await execDatatable({
        id: 's1', type: 'datatable', op: 'delete_rows', datatableId: 'tbl_aaaaaa',
        where: [{ field: 'email', op: 'eq', value: { kind: 'literal', value: 'a@b.c' } }],
    }, CTX, RUN, 'live');
    assert.deepStrictEqual(state.execCalls.filter(c => c.kind === 'batch').map(b => b.size), [500, 200]);
    assert.strictEqual(res.output.deleted, 700);
    assert.strictEqual(res.output.truncated, false);
    assert.deepStrictEqual(state.bumps.map(b => b.delta), [-500, -200],
        'the counter follows each COMMITTED chunk, so a later failure cannot leave it describing a table that no longer exists that way');
});

test('a failure mid-batch leaves that chunk unapplied and row_count consistent with what landed', async () => {
    reset();
    state.queryRows = manyRows(700);
    let calls = 0;
    const realBatch = require('../../stores/datatableDbStore').batch;
    require('../../stores/datatableDbStore').batch = async (...args) => {
        calls += 1;
        if (calls === 2) throw new Error('deadlock detected');
        return realBatch(...args);
    };
    try {
        await assert.rejects(() => execDatatable({
            id: 's1', type: 'datatable', op: 'delete_rows', datatableId: 'tbl_aaaaaa',
            where: [{ field: 'email', op: 'eq', value: { kind: 'literal', value: 'a@b.c' } }],
        }, CTX, RUN, 'live'), /deadlock detected/);
    } finally {
        require('../../stores/datatableDbStore').batch = realBatch;
    }
    // The chunk is one transaction, so nothing from it landed — and the counter
    // was already moved for the chunk that DID commit. The old per-row loop
    // bumped nothing at all until every row was done.
    assert.deepStrictEqual(state.bumps.map(b => b.delta), [-500]);
});

// ── the storage envelope ────────────────────────────────────────────────────

test('the runner refuses the 100,001st row with the errorClass an on_error branch catches', async () => {
    reset();
    state.table = { ...TABLE, rowCount: 100_000 };
    await assert.rejects(
        () => execDatatable({
            id: 's1', type: 'datatable', op: 'add_row', datatableId: 'tbl_aaaaaa',
            values: { email: { kind: 'literal', value: 'a@b.c' } },
        }, CTX, RUN, 'live'),
        (e) => e.errorClass === 'datatable_quota' && /full/.test(e.message),
    );
    assert.strictEqual(state.execCalls.length, 0, 'and nothing is written');
});

test('a write is refused when the SCOPE is over its byte ceiling', async () => {
    // MAX_DB_BYTES was declared and inert and `size_bytes` was mirrored and read
    // by nobody: one organisation could grow the shared beeflow_core volume
    // without bound.
    reset();
    state.usage = { tables: 3, rows: 10, bytes: 256 * 1024 * 1024 };
    await assert.rejects(
        () => execDatatable({
            id: 's1', type: 'datatable', op: 'add_row', datatableId: 'tbl_aaaaaa',
            values: { email: { kind: 'literal', value: 'a@b.c' } },
        }, CTX, RUN, 'live'),
        (e) => e.errorClass === 'datatable_quota' && /storage limit/.test(e.message),
    );
    assert.strictEqual(state.execCalls.length, 0);
});

test('a write is refused when the SCOPE is over its row ceiling, even on an empty table', async () => {
    reset();
    state.usage = { tables: 40, rows: 500_000, bytes: 0 };
    await assert.rejects(
        () => execDatatable({
            id: 's1', type: 'datatable', op: 'add_row', datatableId: 'tbl_aaaaaa',
            values: { email: { kind: 'literal', value: 'a@b.c' } },
        }, CTX, RUN, 'live'),
        (e) => e.errorClass === 'datatable_quota' && /500000/.test(e.message),
    );
});

test('a delete is NEVER refused by the byte ceiling — it is how you get back under it', async () => {
    reset();
    state.usage = { tables: 3, rows: 10, bytes: 512 * 1024 * 1024 };
    state.queryRows = manyRows(2);
    const res = await execDatatable({
        id: 's1', type: 'datatable', op: 'delete_rows', datatableId: 'tbl_aaaaaa',
        where: [{ field: 'email', op: 'eq', value: { kind: 'literal', value: 'a@b.c' } }],
    }, CTX, RUN, 'live');
    assert.strictEqual(res.output.deleted, 2);
});
