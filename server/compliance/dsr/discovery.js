/**
 * DSR discovery — a READ-ONLY scan of where a data subject's e-mail address
 * shows up inside Bee Flow, so an admin fulfilling an Art. 15 / Art. 17
 * request knows where to look. It never erases anything (owner decision:
 * no automated erasure) and its output is built from an allow-list so the
 * address itself is never in the response — only counts, ids, table names
 * and admin deep links.
 *
 * Sources (PLAN-BACKEND §2.12):
 *   1. user account       userStore.findOrgMemberIdByEmail(orgId, email) → user_id
 *   2. memories           memoryStore.countActiveMemoriesForUser(userId)
 *   3. org datatables     text/richtext columns ILIKE '%email%' — 200 tables,
 *                         2 s per table under ONE overall budget, four at a
 *                         time, partial:true on a timeout or an exhausted
 *                         budget; managed_kind 'form_answers' reported
 *                         separately, grouped by source.automationId
 *   4. knowledge bases    kb_chunks.content ILIKE under a 5 s statement_timeout
 *   5. prior DSRs         same e-mail, same org
 *   6. conversations      NOT scanned (bodies are per-org encrypted) → not_scanned
 *
 * EVERY source is pinned to the scanning organisation, source 1 and 2 included.
 * The admin supplies the address by hand, so an unpinned lookup would answer
 * "does this person exist on this instance" for any address at all.
 *
 * Retention note: a table whose lawful_basis is 'legal_obligation' or whose
 * retention is ≥ 7 years cannot simply be erased — the note tells the admin.
 *
 * Every run writes an access-audit row (dsr.discovery_run) and is memoised for
 * 30 s per request so a drawer that re-renders does not re-scan the tenant.
 *
 * The scan runs inside ONE HTTP request, so it is bounded twice over: each
 * table gets PER_TABLE_TIMEOUT_MS, and the scan as a whole gets
 * OVERALL_BUDGET_MS. Whatever the budget does not reach is REPORTED
 * (`partial: true`, a line in `errors`, an entry in `not_scanned`) — a scan
 * that quietly stopped early would tell an admin fulfilling an Art. 17 request
 * "nothing found" about tables nobody looked at.
 */

const { maskEmail } = require('./mask');
const { complianceSectionPath } = require('../../utils/appPaths');

const TABLE_CAP = 200;
const PER_TABLE_TIMEOUT_MS = 2000;
/**
 * The wall clock the whole scan may spend. 200 tables × 2 s sequentially is
 * 400 s — past every proxy in front of this endpoint, and the export route
 * runs the same scan again. 20 s is inside a default 30 s gateway timeout and
 * leaves room for the KB query underneath it.
 */
const OVERALL_BUDGET_MS = 20_000;
/** Independent per-table counts, so the budget buys more tables. */
const TABLE_CONCURRENCY = 4;
/** A 200-table failure must not return a 200-line error list. */
const MAX_ERRORS = 20;
const KB_TIMEOUT_MS = 5000;
const KB_ROW_CAP = 500;
const MEMO_TTL_MS = 30 * 1000;
/** Bounded like compliance/countsCache.js and evidence/writeFailures.js. */
const MEMO_MAX_ENTRIES = 200;
const RETENTION_LEGAL_HOLD_DAYS = 7 * 365; // 2555

const TEXT_TYPES = new Set(['text', 'richtext']);

const _memo = new Map(); // `${orgId}:${requestId}` → { ts, result }

/** Oldest out first, and a re-set counts as fresh (insertion order = recency). */
function _memoSet(key, ts, result) {
    _memo.delete(key);
    if (_memo.size >= MEMO_MAX_ENTRIES) {
        const oldest = _memo.keys().next().value;
        if (oldest !== undefined) _memo.delete(oldest);
    }
    _memo.set(key, { ts, result });
}

/** A hit inside the TTL, or null — an expired entry is dropped on the way out. */
function _memoGet(key, now) {
    const hit = _memo.get(key);
    if (!hit) return null;
    if (now - hit.ts >= MEMO_TTL_MS) { _memo.delete(key); return null; }
    return hit.result;
}

function _pushError(state, message) {
    if (state.errors.length < MAX_ERRORS) state.errors.push(message);
    else if (state.errors.length === MAX_ERRORS) state.errors.push(`… more errors suppressed (cap ${MAX_ERRORS})`);
}

/** Milliseconds left of the overall budget (Infinity when there is none). */
function _budgetLeft(state, now = Date.now()) {
    return state.deadlineAt == null ? Infinity : state.deadlineAt - now;
}

function _lazy(path) {
    try { return require(path); } catch { return null; }
}

/** ILIKE needle with the pattern characters neutralised. */
function likeNeedle(s) {
    return `%${String(s).replace(/[\\%_]/g, ch => `\\${ch}`)}%`;
}

function quoteIdent(name) {
    return `"${String(name).replace(/"/g, '""')}"`;
}

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const e = new Error(`${label} timed out after ${ms} ms`);
            e.code = 'discovery_timeout';
            reject(e);
        }, ms);
        // Deliberately NOT unref'd: a hung query must not let the process
        // exit before the budget expires and the scan reports partial.
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The retention rule, exported for the test. */
function retentionNoteFor(table) {
    if (!table) return null;
    const basis = table.lawfulBasis || table.lawful_basis || null;
    const days = table.retentionDays ?? table.retention_days ?? null;
    if (basis === 'legal_obligation') return 'legal_obligation';
    if (Number.isFinite(Number(days)) && Number(days) >= RETENTION_LEGAL_HOLD_DAYS) return 'long_retention';
    return null;
}

function _textFieldKeys(meta) {
    const fields = Array.isArray(meta?.fields) ? meta.fields : [];
    return fields
        .filter(f => f && typeof f.key === 'string' && TEXT_TYPES.has(f.type))
        .map(f => f.key);
}

// ───────────────────────── Sources ─────────────────────────

/**
 * The subject's account — IN THIS ORGANISATION ONLY.
 *
 * A platform-wide `getUserByEmail` here would answer a question this endpoint
 * has no business answering. The caller is an admin of ONE tenant who typed the
 * address themselves (`POST /requests/manual` accepts any syntactically valid
 * one), so an unpinned lookup turns the scan into an account-existence oracle
 * over every address on the instance, and hands back an internal user id and a
 * memory count for somebody else's customer.
 *
 * An address outside the org therefore answers exactly as an address with no
 * account does: no id, no sources, nothing to distinguish the two.
 */
async function _scanUser(orgId, email, deps) {
    const userStore = deps.userStore;
    if (!userStore?.findOrgMemberIdByEmail) return null;
    try {
        return (await userStore.findOrgMemberIdByEmail(orgId, email)) || null;
    } catch { return null; }
}

async function _scanMemories(userId, deps) {
    if (!userId) return { count: 0 };
    const memoryStore = deps.memoryStore;
    if (!memoryStore?.countActiveMemoriesForUser) return { count: null, unavailable: true };
    try {
        return { count: await memoryStore.countActiveMemoriesForUser(userId) };
    } catch { return { count: null, unavailable: true }; }
}

/**
 * Count rows in one datatable whose text/richtext columns contain the needle.
 * Runs against the tenant's physical schema through datatableDbStore.query
 * (`?` placeholders, like the query compiler emits).
 */
async function countRowsContaining(meta, needle, scopeKey, deps, { timeoutMs = PER_TABLE_TIMEOUT_MS } = {}) {
    const keys = _textFieldKeys(meta);
    if (!keys.length) return 0;
    const where = keys.map(k => `${quoteIdent(k)} ILIKE ?`).join(' OR ');
    const params = keys.map(() => needle);
    const sql = `SELECT COUNT(*)::int AS n FROM ${quoteIdent(meta.key)} WHERE ${where}`;
    const out = await withTimeout(deps.datatableDbStore.query(scopeKey, scopeKey, sql, params), timeoutMs, `datatable ${meta.id}`);
    const row = out?.rows?.[0];
    return Number(row?.n ?? row?.count ?? 0) || 0;
}

async function _scanDatatables(orgId, needle, deps, state) {
    const datatableStore = deps.datatableStore;
    const datatableDbStore = deps.datatableDbStore;
    const sources = [];
    if (!datatableStore?.listDatatablesForScope || !datatableDbStore?.query) return sources;

    const scope = { kind: 'org', id: orgId };
    let tables = [];
    let model = null;
    try {
        tables = await datatableStore.listDatatablesForScope(scope);
        model = datatableStore.getModel ? (await datatableStore.getModel(scope))?.model : null;
    } catch (e) {
        state.partial = true;
        _pushError(state, `datatables: ${e.message}`);
        return sources;
    }
    const metaById = new Map((Array.isArray(model?.tables) ? model.tables : []).map(t => [t.id, t]));
    const scopeKey = datatableDbStore.scopeKey ? datatableDbStore.scopeKey(scope) : `org:${orgId}`;

    const total = tables.length;
    if (tables.length > TABLE_CAP) {
        state.partial = true;
        _pushError(state, `datatables: table cap reached — ${total - TABLE_CAP} of ${total} tables not scanned`);
        state.notScanned.add('datatables');
        tables = tables.slice(0, TABLE_CAP);
    }

    // Counts by table INDEX, filled by TABLE_CONCURRENCY workers pulling from
    // one queue: independent queries, so waiting for them one at a time only
    // burns the budget. The items below are then assembled in table order, so
    // the output does not depend on which query answered first.
    const counts = new Array(tables.length).fill(0);
    let nextIndex = 0;
    let skipped = 0;
    const worker = async () => {
        for (;;) {
            const i = nextIndex++;
            if (i >= tables.length) return;
            const t = tables[i];
            let meta = metaById.get(t.id);
            if (!meta && datatableStore.getTableMeta) {
                try { meta = await datatableStore.getTableMeta(scope, t.id); } catch { meta = null; }
            }
            if (!meta) continue;
            // The budget decides whether this table is looked at at all, and
            // caps its query so a hung one cannot overshoot by a full
            // per-table timeout.
            const left = _budgetLeft(state);
            if (left <= 0) { skipped += 1; continue; }
            try {
                counts[i] = await countRowsContaining(meta, needle, scopeKey, deps, {
                    timeoutMs: Math.max(1, Math.min(state.perTableTimeoutMs, left)),
                });
            } catch (e) {
                state.partial = true;
                _pushError(state, `datatable ${t.id}: ${e.code || e.message}`);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(TABLE_CONCURRENCY, tables.length) }, worker));
    if (skipped) {
        state.partial = true;
        _pushError(state, `datatables: overall budget of ${state.budgetMs} ms exhausted — ${skipped} of ${total} tables not scanned`);
        state.notScanned.add('datatables');
    }

    const plainItems = [];
    const formGroups = new Map(); // automationId → { count, tables }
    for (let i = 0; i < tables.length; i++) {
        const t = tables[i];
        const n = counts[i];
        if (!n) continue;
        const retention = retentionNoteFor(t);
        if (t.managedKind === 'form_answers') {
            const automationId = t.source?.automationId || null;
            const key = automationId || `table:${t.id}`;
            const g = formGroups.get(key) || { id: automationId || t.id, automation_id: automationId, count: 0, tables: 0, retention_note: null };
            g.count += n;
            g.tables += 1;
            if (retention && !g.retention_note) g.retention_note = retention;
            formGroups.set(key, g);
        } else {
            plainItems.push({ id: t.id, title: t.name || t.key || t.id, count: n, retention_note: retention });
        }
        if (retention) state.retentionNotes.push({ kind: t.managedKind === 'form_answers' ? 'form_answers' : 'datatable', id: t.id, title: t.name || t.id, note: retention });
    }

    sources.push({
        kind: 'datatable_rows',
        count: plainItems.reduce((a, i) => a + i.count, 0),
        label_key: 'compliance.dsr_discovery_datatable_rows',
        href: '/app/studio/datatables',
        items: plainItems,
    });
    const formItems = [...formGroups.values()].map(g => ({
        id: g.id,
        title: g.automation_id ? `automation ${g.automation_id}` : `table ${g.id}`,
        count: g.count,
        retention_note: g.retention_note,
        automation_id: g.automation_id,
    }));
    sources.push({
        kind: 'form_answers',
        count: formItems.reduce((a, i) => a + i.count, 0),
        label_key: 'compliance.dsr_discovery_form_answers',
        href: '/app/studio/automations',
        items: formItems,
    });
    return sources;
}

async function _scanKnowledgeBases(orgId, needle, deps, state) {
    const db = deps.db;
    const source = {
        kind: 'kb_chunks',
        count: 0,
        label_key: 'compliance.dsr_discovery_kb_chunks',
        href: '/app/studio/knowledge',
        items: [],
    };
    // The budget is the whole scan's, not the datatables'. With nothing left,
    // the knowledge bases go UNSCANNED and say so: `count: null` is "unknown"
    // everywhere in this feed, and a 0 here would read as "nothing of this
    // person in any knowledge base".
    if (_budgetLeft(state) <= 0) {
        state.partial = true;
        state.notScanned.add('knowledge_bases');
        _pushError(state, `kb: overall budget of ${state.budgetMs} ms exhausted before the knowledge bases were scanned`);
        source.count = null;
        return source;
    }
    if (!db?.withTransaction) return source;
    try {
        const rows = await db.withTransaction(async (client) => {
            await client.query(`SET LOCAL statement_timeout = ${KB_TIMEOUT_MS}`);
            const kbs = await client.query(`SELECT id, name FROM knowledge_bases WHERE organization_id = $1`, [orgId]);
            const ids = (kbs.rows || []).map(r => String(r.id));
            if (!ids.length) return [];
            const names = new Map((kbs.rows || []).map(r => [String(r.id), r.name]));
            const res = await client.query(`
                SELECT knowledge_base_id, document_id, COUNT(*)::int AS n
                FROM kb_chunks
                WHERE knowledge_base_id = ANY($1) AND content ILIKE $2
                GROUP BY 1, 2
                LIMIT ${KB_ROW_CAP}
            `, [ids, needle]);
            return (res.rows || []).map(r => ({
                id: `${r.knowledge_base_id}/${r.document_id}`,
                kb_id: String(r.knowledge_base_id),
                document_id: String(r.document_id),
                title: names.get(String(r.knowledge_base_id)) || String(r.knowledge_base_id),
                count: Number(r.n) || 0,
                retention_note: null,
            }));
        });
        source.items = rows;
        source.count = rows.reduce((a, r) => a + r.count, 0);
        if (rows.length >= KB_ROW_CAP) state.partial = true;
    } catch (e) {
        // 57014 = query_canceled (statement_timeout); a missing table on a
        // fresh install (42P01) is simply "nothing there".
        if (e?.code !== '42P01') {
            state.partial = true;
            _pushError(state, `kb: ${e.code || e.message}`);
        }
    }
    return source;
}

async function _scanPriorDsrs(orgId, email, requestId, deps) {
    const db = deps.db;
    if (!db?.getOne) return { count: null };
    try {
        const row = await db.getOne(`
            SELECT COUNT(*)::int AS n FROM dsr_requests
            WHERE organization_id = $1 AND subject_email = $2 AND id <> $3
        `, [orgId, email, requestId]);
        return { count: Number(row?.n) || 0 };
    } catch { return { count: null }; }
}

// ───────────────────────── Entry point ─────────────────────────

const DEP_PATHS = Object.freeze({
    db: '../../db',
    userStore: '../../stores/userStore',
    memoryStore: '../../stores/memoryStore',
    datatableStore: '../../stores/datatableStore',
    datatableDbStore: '../../stores/datatableDbStore',
});

/** Injected deps win; only the missing ones are required (tests never touch a real store). */
function _resolveDeps(deps) {
    const d = {};
    for (const [k, p] of Object.entries(DEP_PATHS)) {
        d[k] = deps && k in deps ? deps[k] : _lazy(p);
    }
    return d;
}

/**
 * @param {string} orgId
 * @param {{id:number|string, subject_email:string}} request  the dsr_requests row
 * @param {{actorId?:string|null, deps?:object, force?:boolean, now?:number,
 *          perTableTimeoutMs?:number, overallBudgetMs?:number}} [opts]
 */
async function run(orgId, request, {
    actorId = null, deps = null, force = false, now = Date.now(),
    perTableTimeoutMs = PER_TABLE_TIMEOUT_MS, overallBudgetMs = OVERALL_BUDGET_MS,
} = {}) {
    if (!orgId) throw new Error('orgId is required');
    if (!request || request.id == null || !request.subject_email) throw new Error('request with id and subject_email is required');
    const memoKey = `${orgId}:${request.id}`;
    if (!force) {
        const hit = _memoGet(memoKey, now);
        if (hit) return hit;
    }

    const d = _resolveDeps(deps);
    const email = String(request.subject_email).trim().toLowerCase();
    const needle = likeNeedle(email);
    // The budget runs on the wall clock, not on the injectable `now` (which
    // drives the memo and `scanned_at`, and is a fixed instant in tests).
    const budgetMs = Number.isFinite(overallBudgetMs) && overallBudgetMs > 0 ? overallBudgetMs : null;
    const state = {
        partial: false, errors: [], retentionNotes: [], notScanned: new Set(),
        perTableTimeoutMs, budgetMs, deadlineAt: budgetMs == null ? null : Date.now() + budgetMs,
    };

    const userId = await _scanUser(orgId, email, d);
    const memories = await _scanMemories(userId, d);
    const datatableSources = await _scanDatatables(orgId, needle, d, state);
    const kb = await _scanKnowledgeBases(orgId, needle, d, state);
    const prior = await _scanPriorDsrs(orgId, email, Number(request.id), d);

    const sources = [
        {
            kind: 'user_account',
            count: userId ? 1 : 0,
            label_key: 'compliance.dsr_discovery_user_account',
            href: userId ? '/app/admin/security/users' : null,
        },
        {
            kind: 'memories',
            count: memories.count,
            label_key: 'compliance.dsr_discovery_memories',
            href: userId ? '/app/admin/security/users' : null,
        },
        ...datatableSources,
        kb,
        {
            kind: 'prior_dsrs',
            count: prior.count,
            label_key: 'compliance.dsr_discovery_prior_dsrs',
            href: complianceSectionPath('dsr'),
        },
    ];

    const result = {
        subject: { email_masked: maskEmail(email), user_id: userId },
        sources,
        retention_notes: state.retentionNotes,
        // Conversations are never scanned (encrypted per org); whatever the
        // budget or the cap could not reach joins them, by name.
        not_scanned: ['conversations', ...[...state.notScanned].sort()],
        partial: state.partial,
        errors: state.errors,
        scanned_at: new Date(now).toISOString(),
    };
    _memoSet(memoKey, now, result);

    // Access audit: who looked where, never the address.
    try {
        await d.userStore?.logAccessAudit?.('dsr.discovery_run', 'dsr_request', String(request.id), actorId, null, {
            sources: sources.map(s => ({ kind: s.kind, count: s.count })),
            partial: state.partial,
        }, orgId);
    } catch { /* audit is best-effort */ }

    return result;
}

/**
 * The memoised result of the last scan for this request, or null (never
 * scans). The TTL applies here too: POST /fulfil stamps this summary into the
 * append-only evidence chain, and an hours-old scan written as the state of
 * the tenant AT FULFILMENT is a false record that nothing downstream can tell
 * from a true one. Past the TTL the caller gets null and records nothing.
 */
function peek(orgId, requestId, { now = Date.now() } = {}) {
    return _memoGet(`${orgId}:${requestId}`, now);
}

/** Counts per kind for evidence rows / the dossier — no items, no address. */
function summarize(result) {
    if (!result) return null;
    const counts = {};
    for (const s of result.sources || []) counts[s.kind] = s.count;
    return { counts, partial: !!result.partial, not_scanned: result.not_scanned || [], scanned_at: result.scanned_at };
}

function _resetMemo() { _memo.clear(); }
/** Tests only. */
function _memoSize() { return _memo.size; }

module.exports = {
    run,
    peek,
    summarize,
    countRowsContaining,
    retentionNoteFor,
    likeNeedle,
    _resetMemo,
    _memoSize,
    TABLE_CAP,
    PER_TABLE_TIMEOUT_MS,
    OVERALL_BUDGET_MS,
    TABLE_CONCURRENCY,
    MAX_ERRORS,
    KB_TIMEOUT_MS,
    MEMO_TTL_MS,
    MEMO_MAX_ENTRIES,
    RETENTION_LEGAL_HOLD_DAYS,
};
