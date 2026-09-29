/**
 * A DATATABLE AS AGENT KNOWLEDGE — `datatable_query`, read-only, at question
 * time, as the person asking.
 *
 * A price list, a project register, a list of standard clauses. The owner of an
 * agent picks a table in the editor; the agent can then look a row up while it
 * answers, and cite it. One tool, one grant section:
 *
 *   config.tools.datatables = { [datatableId]: { scope:'own'|'all', columns } }
 *
 * ── LIVE, NOT INGESTED — AND NOT THE SAME THING AS THE KB SOURCE ────
 * `core/kb/sources/datatable.js` (K8) copies rows into `documents` on a
 * schedule and reads them back as embedded chunks. This reads the TABLE, now,
 * with SQL. Two consequences worth stating, because they are the whole reason
 * both exist:
 *
 *   K8 answers "what does the handbook say about the XL", fuzzily, over
 *   whatever was synced — and it reads AS THE KNOWLEDGE BASE'S OWNER, so its
 *   rows become visible to everyone the KB is shared with.
 *
 *   This answers "what is the XL's price right now", exactly, and it reads AS
 *   THE PERSON ASKING. Two colleagues asking the same agent the same question
 *   can get different rows, and that is correct: the table's own row-level
 *   rules are the ones that decide, per asker, every time.
 *
 * ── AS THE ASKER. NEVER AS THE AGENT'S OWNER ────────────────────────
 * The grade is recomputed from the table row and its grants on EVERY call, for
 * the asker (`resolveDatatableForStep`, which carries that refusal itself), and
 * the access predicate is the same one the routes and the routine runner
 * compile. There is deliberately no `actAs:'owner'` here: connection lending
 * exists so an agent can use its owner's Gmail token, and a datatable is not a
 * token — borrowing the owner's grade would hand every colleague the owner's
 * view of an HR table through a chat box.
 *
 * `scope:'own'` narrows FURTHER, on top of that predicate — `created_by =` the
 * asker — and it is the default for anything unreadable in the grant
 * (`toolPolicy.datatableGrantsOf`). It is a narrowing, never a replacement: an
 * asker who may see nothing still sees nothing when the grant says 'all'.
 *
 * ── WHAT THE MODEL MAY ADDRESS ──────────────────────────────────────
 * Only the granted columns, and only through the compiler's CLOSED descriptor
 * (field + op + bound value) — there is no SQL surface here, the same as every
 * other datatable path.
 *
 * The filterable set is the granted set, NOT everything the compiler will
 * resolve. `queryCompiler.resolveColumn` accepts the system columns
 * (id/created_at/updated_at/created_by/org_id) for filter and sort whatever the
 * table declares, so passing the model's `field` straight through would let it
 * binary-search a column the owner deliberately left out — `created_by eq X`
 * answers "did X write a row in here", one call at a time, without that column
 * ever being returned. So `created_by` and `org_id` are refused outright and
 * only `created_at`/`updated_at` ride along, for ordering and date filters:
 * they say when a row was touched, never by whom.
 *
 * ── A FAILED CHECK IS A REFUSAL, NEVER AN EMPTY TABLE ───────────────
 * Every failure below comes back as an `error` the model has to relay. None of
 * them returns `rows: []`, because "there are no matching rows" and "I could
 * not find out" are different sentences and only one of them is true — and the
 * false one is the reassuring one. That includes the identity read: an
 * unresolved account degrades to "in no org, not an admin, in no group", so
 * `resolveDatatableForStep` is handed `identityError` and refuses an org table
 * with `datatable_identity_unavailable` rather than blaming the owner for a
 * lookup failure.
 *
 * ── OFFERED AND ENFORCED, TWICE ─────────────────────────────────────
 * `buildDatatableTools` resolves every granted table AS THE ASKER and omits the
 * ones they cannot read, so the model is never told about a table it would be
 * refused on (and no table name leaks through a tool description). That is a
 * convenience, not the gate: `executeDatatableTool` re-reads the grants off the
 * PUBLISHED agent config and re-resolves the table on every call. A definition
 * assembled at the top of a turn is a snapshot, and a grant revoked mid-turn
 * has to stop working inside that turn.
 *
 * A table dropped from the stack because the DATABASE blinked is a different
 * thing from one the asker may not read, and it is the same false reassurance
 * in another place: the agent then answers the question from its own head,
 * with no sign that a source went missing. It is still not offered — a table
 * we could not resolve is not a table we can serve — but the count of them
 * reaches the tool description, so the model can say a source was unreachable
 * instead of answering as though it had been read. `ANSWERED_REFUSALS` is
 * where the two are told apart.
 */

'use strict';

const { toCitation } = require('../kb/citation');
const log = require('../../telemetry/log');

/** The one tool this module owns. */
const DATATABLE_QUERY_TOOL = 'datatable_query';

// ── Bounds ──────────────────────────────────────────────────────────
// Rows here land in the model's context window, so the caps are much tighter
// than the HTTP surface's (500 a page) or K8's (5000 a pass). A model that
// needs more than fifty rows to answer a question is doing analysis, which is
// what the routine datatable step is for.
const DEFAULT_ROW_LIMIT = 10;
const MAX_ROW_LIMIT = 50;
const MAX_QUERY_FILTERS = 10;
/** Characters of one cell the model is shown. A note field can be a novel. */
const MAX_CELL_CHARS = 400;
/** Characters of the rendered row a citation carries. */
const MAX_ROW_CHARS = 2000;
/**
 * Organisations probed when the asker belongs to several.
 *
 * The table lives in exactly one, so this is a lookup, not a widening: org
 * isolation is re-checked inside `gradeForPrincipal` for each attempt, and only
 * a `datatable_not_found` moves on to the next.
 */
const MAX_ORG_PROBES = 8;

/**
 * Columns never returned and never addressable, whatever a grant says.
 *
 * `created_by`/`updated_by` are a person's id; `org_id` is tenancy; `deleted_at`
 * is bookkeeping. None of them is knowledge, all of them are answers to
 * questions nobody asked the agent, and `created_by` in particular is the one
 * an unbounded filter would turn into a "who wrote in this table" oracle.
 * `id` is not in here — it is returned as `row_id`, which is what makes a
 * citation checkable — but it is not filterable or sortable either.
 */
const HIDDEN_COLUMNS = Object.freeze(new Set([
    'id', 'created_by', 'updated_by', 'org_id', 'deleted_at',
]));

/** System columns the model may order and filter by. Timestamps only. */
const ORDERABLE_SYSTEM_COLUMNS = Object.freeze(['created_at', 'updated_at']);

/** Field types `?q=`-style search looks inside (mirrors routes/datatables.js). */
const SEARCHABLE_TYPES = Object.freeze(new Set(['text', 'richtext', 'select', 'multiselect']));

/** Rows always live in Postgres — see stores/datatableDbStore.js. */
const PG = Object.freeze({ dialect: 'pg' });

function isDatatableTool(toolName) {
    return toolName === DATATABLE_QUERY_TOOL;
}

/**
 * Everything this module talks to, injectable for tests.
 *
 * Lazily required (like `core/kb/sources/datatable.js`) so the module stays
 * loadable in the suites that stub the database — these pull in the pg pool.
 */
function _deps(deps = {}) {
    return {
        agentStore: deps.agentStore || require('../../stores/agentStore'),
        datatableDbStore: deps.datatableDbStore || require('../../stores/datatableDbStore'),
        resolveDatatableForStep: deps.resolveDatatableForStep
            || require('../automationRunner/datatableResolve').resolveDatatableForStep,
        queryCompiler: deps.queryCompiler || require('../dataEngine/queryCompiler'),
        accessFilter: deps.accessFilter || require('../dataEngine/accessFilter'),
        askerContext: deps.askerContext || require('../kb/askerContext').askerContext,
        applyShield: deps.applyShield || require('../kb/ingestPrivacy').applyShield,
        SHIELD_OUTCOME: deps.SHIELD_OUTCOME || require('../kb/ingestPrivacy').OUTCOME,
        userStore: deps.userStore || require('../../stores/userStore'),
        toolPolicy: deps.toolPolicy || require('../agentRuntime/toolPolicy'),
        renderRow: deps.renderRow || require('../kb/sources/datatable').renderRow,
    };
}

/** The grants, read off an agent config through the policy module's reader. */
function grantsOf(agentConfig, deps) {
    return deps.toolPolicy.datatableGrantsOf(deps.toolPolicy.toolsConfigOf(agentConfig));
}

// ── Who is asking ───────────────────────────────────────────────────

/**
 * The asker, in the shape `resolveDatatableForStep` needs a principal in.
 *
 * `askerContext` for the org set and the groups — one resolver, and a failure
 * there NARROWS (empty set, no groups) rather than widening. It deliberately
 * carries no `orgRole`, so that one is read here: without it an org admin is
 * graded as an ordinary member and would be refused a table they can open in
 * the UI, which is the wrong kind of wrong — "as the asker" has to mean the
 * grade the asker actually holds, not a smaller one this path invented.
 *
 * A failed read is REPORTED, not swallowed. Both degradations point the same
 * way (no org → the table is not found; no orgRole → not an admin), so the
 * refusal that follows would look like the owner's fault. `identityError` is
 * what turns it back into an outage the resolver names.
 */
async function resolveAsker(userId, deps) {
    let orgIds = new Set();
    let userGroups = [];
    let orgRole = null;
    let homeOrgId = null;
    let identityError = null;

    try {
        const ctx = await deps.askerContext(userId);
        orgIds = ctx?.orgIds instanceof Set ? ctx.orgIds : new Set(ctx?.orgIds || []);
        userGroups = Array.isArray(ctx?.userGroups) ? ctx.userGroups : [];
    } catch (e) {
        identityError = `the organisations of the person asking could not be read (${e.message})`;
    }
    try {
        const user = await deps.userStore.getUser(userId);
        orgRole = user?.orgRole || null;
        // Truthiness, not `!= null`: an org-less account holds the EMPTY STRING
        // (stores/user/users.js writes `organizationId || ''`), and passing ''
        // on as a tenant key is how a non-tenant becomes one.
        homeOrgId = user?.organizationId || null;
    } catch (e) {
        identityError = identityError || `the account of the person asking could not be read (${e.message})`;
    }
    return { userId, orgIds, userGroups, orgRole, homeOrgId, identityError };
}

/**
 * Resolve one granted table for the asker, at viewer grade or better.
 *
 * The tenant is never guessed: each organisation the asker belongs to is tried
 * in turn and `gradeForPrincipal` re-checks org isolation inside every attempt.
 * Only "not found here" moves on — a refusal or an unreadable identity is the
 * answer, and trying the next org would just be asking the same question until
 * one says yes.
 */
async function resolveForAsker(datatableId, asker, deps) {
    const orgIds = [...(asker.orgIds || [])].filter(Boolean).slice(0, MAX_ORG_PROBES);
    const attempts = orgIds.length > 0 ? orgIds : [null];
    let lastErr = null;
    for (const orgId of attempts) {
        try {
            return await deps.resolveDatatableForStep(datatableId, {
                userId: asker.userId,
                orgId,
                userGroupIds: asker.userGroups,
                orgRole: asker.orgRole,
                userHomeOrgId: asker.homeOrgId,
                identityError: asker.identityError,
            }, { needed: 'viewer' });
        } catch (e) {
            lastErr = e;
            if (e && e.errorClass === 'datatable_not_found') continue;
            throw e;
        }
    }
    throw lastErr || new Error(`That table is not available (${datatableId}).`);
}

// ── Columns ─────────────────────────────────────────────────────────

/** Every column a person declared, minus the ones nothing may ever read. */
function declaredColumnsOf(tableMeta) {
    return ((tableMeta && tableMeta.fields) || [])
        .map(f => f && f.key)
        .filter(k => typeof k === 'string' && k && !HIDDEN_COLUMNS.has(k));
}

/**
 * The columns this grant may read, in the TABLE's declared order.
 *
 * `'*'` (or an absent list) means every declared column: the owner picked the
 * table, and picking it plainly meant its contents. A picked list is
 * INTERSECTED with what the table declares, so a column that was renamed or
 * dropped since the grant was written narrows the answer instead of throwing —
 * and an empty result is a real state the caller has to refuse out loud, not a
 * table served whole.
 */
function grantedColumnsFor(grant, tableMeta) {
    const declared = declaredColumnsOf(tableMeta);
    if (grant && grant.columns === '*') return declared;
    const picked = new Set(Array.isArray(grant && grant.columns) ? grant.columns : []);
    return declared.filter(k => picked.has(k));
}

function fieldMapOf(tableMeta) {
    const m = new Map();
    for (const f of ((tableMeta && tableMeta.fields) || [])) {
        if (f && typeof f.key === 'string') m.set(f.key, f);
    }
    return m;
}

/** A read-time computed field has no physical column, so it cannot be queried. */
function isQueryable(field) {
    if (!field) return false;
    return field.type !== 'computed' || (field.computed && field.computed.stored === true);
}

// ── Offering the tool ───────────────────────────────────────────────

/**
 * Error classes that are an ANSWER about this asker and this table, as opposed
 * to a failure to find one out. `resolveDatatableForStep` draws exactly this
 * line itself — it is why `datatable_identity_unavailable` exists and is not
 * just another `datatable_forbidden`.
 */
const ANSWERED_REFUSALS = Object.freeze(new Set([
    'datatable_forbidden', 'datatable_not_found', 'datatable_no_org', 'datatable_no_columns',
]));

/**
 * One granted table, described for the model.
 *
 * Returns `{table}` when the asker can read it, `{refused:true}` when they
 * plainly cannot, and `{unavailable:true}` when we could not find out.
 *
 * The third case is the one worth having. A table dropped from the stack
 * because the database blinked leaves the agent answering the question from
 * its own head, confidently and without its source — the reassuring sentence
 * nobody verified. It is still not offered (offering a table we could not
 * resolve is worse), but the caller is told so it can say SOMETHING was
 * unreadable, without naming it.
 */
async function describeGrantedTable(datatableId, grant, asker, deps) {
    let resolved;
    try {
        resolved = await resolveForAsker(datatableId, asker, deps);
    } catch (e) {
        const answered = e && ANSWERED_REFUSALS.has(e.errorClass);
        if (!answered) {
            log.warn(`[DatatableTools] granted table ${datatableId} could not be checked: ${e && e.message}`);
            return { unavailable: true };
        }
        return { refused: true };
    }
    const { table, tableMeta } = resolved;
    const columns = grantedColumnsFor(grant, tableMeta);
    // Nothing readable is an ANSWER — the owner granted no columns — so it is a
    // refusal, not an outage. The executor says so in words if it is called.
    if (columns.length === 0) return { refused: true };
    const fm = fieldMapOf(tableMeta);
    return {
        table: {
            id: datatableId,
            name: table && table.name ? String(table.name) : 'Table',
            description: table && table.description ? String(table.description).slice(0, 200) : '',
            scope: grant.scope,
            columns: columns.map(k => ({ key: k, type: (fm.get(k) || {}).type || 'text' })),
        },
    };
}

/** The tool definition for the tables the asker can actually read. */
function toolDefinitionFor(tables, { unavailable = 0 } = {}) {
    const lines = tables.map(t => {
        const cols = t.columns.map(c => `${c.key} (${c.type})`).join(', ');
        const whose = t.scope === 'own'
            ? 'only rows the person asking created'
            : 'every row the person asking may see';
        return `- id "${t.id}" — ${t.name}${t.description ? `: ${t.description}` : ''}\n`
            + `  columns: ${cols}\n  returns: ${whose}`;
    }).join('\n');

    return {
        type: 'function',
        function: {
            name: DATATABLE_QUERY_TOOL,
            description: 'Look a fact up in one of this assistant\'s data tables. '
                + 'Read-only and LIVE: it reads the table as it is right now, as the person you are '
                + 'talking to — so it can return fewer rows for one colleague than for another, and '
                + 'that is correct. Use it for exact facts that live in a table (a price, a status, a '
                + 'contact, a record), not for prose — the knowledge base is for prose.\n\n'
                + `Tables you may read:\n${lines}\n\n`
                + (unavailable > 0
                    ? `NOTE: ${unavailable} further table(s) this assistant has could not be reached just now. `
                        + 'If your answer would have depended on one, say that a source could not be checked '
                        + 'rather than answering as though it had been.\n\n'
                    : '')
                + 'Filter rather than paging: ask for the rows you need, not the first page of all of '
                + 'them. Only the columns listed above can be filtered or sorted on; created_at and '
                + 'updated_at can be used for ordering and date filters too.',
            parameters: {
                type: 'object',
                properties: {
                    datatable_id: {
                        type: 'string',
                        enum: tables.map(t => t.id),
                        description: 'Which table to read, from the list above.',
                    },
                    filters: {
                        type: 'array',
                        maxItems: MAX_QUERY_FILTERS,
                        description: 'Conditions the rows must meet. Omit to read the most recent rows.',
                        items: {
                            type: 'object',
                            properties: {
                                field: { type: 'string', description: 'A column of the chosen table.' },
                                op: {
                                    type: 'string',
                                    enum: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains',
                                        'notContains', 'startsWith', 'endsWith', 'in', 'notIn',
                                        'between', 'isNull', 'isNotNull'],
                                },
                                value: { description: 'The value to compare against. A list for in/notIn and a [min, max] pair for between. Omit for isNull/isNotNull.' },
                            },
                            required: ['field', 'op'],
                        },
                    },
                    match: {
                        type: 'string',
                        enum: ['all', 'any'],
                        description: 'Rows must meet all of the conditions (default) or any of them.',
                    },
                    search: {
                        type: 'string',
                        description: 'A word to look for anywhere in the row\'s text columns. Combines with filters.',
                    },
                    sort: {
                        type: 'object',
                        description: 'Order the rows. Defaults to newest first.',
                        properties: {
                            field: { type: 'string' },
                            dir: { type: 'string', enum: ['asc', 'desc'] },
                        },
                        required: ['field'],
                    },
                    limit: {
                        type: 'integer',
                        description: `Rows to return, 1–${MAX_ROW_LIMIT}. Default ${DEFAULT_ROW_LIMIT}.`,
                    },
                },
                required: ['datatable_id'],
            },
        },
    };
}

/**
 * `[]` or one `datatable_query` definition, for THIS asker and THIS agent.
 *
 * Never throws and never rejects: it is called from inside `getIntegrationTools`,
 * where an exception costs the agent its entire toolbelt — a datatable that
 * cannot be resolved must cost it one tool, not all of them.
 */
async function buildDatatableTools({ userId, agentConfig, deps: injected } = {}) {
    try {
        const deps = _deps(injected);
        const grants = grantsOf(agentConfig, deps);
        const ids = Object.keys(grants);
        if (!userId || ids.length === 0) return [];

        const asker = await resolveAsker(userId, deps);
        const tables = [];
        let unavailable = 0;
        for (const id of ids) {
            const described = await describeGrantedTable(id, grants[id], asker, deps);
            if (described && described.table) tables.push(described.table);
            else if (described && described.unavailable) unavailable += 1;
        }
        // No readable table means no tool — an enum with nothing in it is not a
        // tool, and offering a table we could not resolve is worse than not
        // offering one. The outage is in the log either way.
        if (tables.length === 0) return [];
        return [toolDefinitionFor(tables, { unavailable })];
    } catch (e) {
        log.warn('[DatatableTools] datatable_query not offered:', e && e.message);
        return [];
    }
}

// ── Running one query ───────────────────────────────────────────────

/** A refusal the model relays. Never `{rows: []}` — see the module header. */
function refuse(message) {
    return { error: message };
}

/**
 * Validate the model's descriptor against the GRANTED columns.
 *
 * Returns `{descriptor}` or `{error}`. Everything the compiler would accept but
 * the grant does not name is refused here, by name, so the model corrects
 * itself instead of retrying the same hidden column.
 */
function readDescriptor(args, { columns, tableMeta }) {
    const fm = fieldMapOf(tableMeta);
    const queryable = new Set(columns.filter(k => isQueryable(fm.get(k))));
    const addressable = new Set([...queryable, ...ORDERABLE_SYSTEM_COLUMNS]);

    const rawFilters = args && args.filters;
    const filters = [];
    if (rawFilters !== undefined && rawFilters !== null) {
        if (!Array.isArray(rawFilters)) return { error: '`filters` must be a list of {field, op, value}.' };
        if (rawFilters.length > MAX_QUERY_FILTERS) {
            return { error: `At most ${MAX_QUERY_FILTERS} conditions per query.` };
        }
        for (const f of rawFilters) {
            if (!f || typeof f !== 'object' || Array.isArray(f)) {
                return { error: 'Every filter is an object {field, op, value}.' };
            }
            if (!addressable.has(f.field)) {
                return {
                    error: `"${f.field}" is not a column you may filter on here. `
                        + `Available: ${[...addressable].join(', ')}.`,
                };
            }
            filters.push({ field: f.field, op: f.op, value: f.value });
        }
    }

    const match = args && args.match === 'any' ? 'any' : 'all';

    let sort = [];
    const rawSort = args && args.sort;
    if (rawSort && typeof rawSort === 'object' && !Array.isArray(rawSort)) {
        if (!addressable.has(rawSort.field)) {
            return {
                error: `"${rawSort.field}" is not a column you may sort on here. `
                    + `Available: ${[...addressable].join(', ')}.`,
            };
        }
        sort = [{ field: rawSort.field, dir: String(rawSort.dir || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc' }];
    }

    // Built here from the GRANTED text columns, never asked for: a search whose
    // column list came from the caller is a filter on a hidden column wearing a
    // different name.
    let search = null;
    const term = typeof (args && args.search) === 'string' ? args.search.trim() : '';
    if (term) {
        const fields = columns.filter(k => {
            const f = fm.get(k);
            return f && isQueryable(f) && SEARCHABLE_TYPES.has(f.type);
        }).slice(0, MAX_QUERY_FILTERS);
        if (fields.length === 0) {
            return { error: 'This table has no text columns to search — use filters on the listed columns instead.' };
        }
        search = { value: term, fields };
    }

    return { descriptor: { filters, match, sort, search } };
}

/** One cell, as the model should read it. Long text is cut, objects are JSON. */
function cellValue(v) {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'object') {
        try { return JSON.stringify(v).slice(0, MAX_CELL_CHARS); } catch (_) { return String(v).slice(0, MAX_CELL_CHARS); }
    }
    const s = String(v);
    return s.length > MAX_CELL_CHARS ? `${s.slice(0, MAX_CELL_CHARS)}…` : s;
}

/** The granted columns of one row, empty cells left out. */
function projectRow(row, columns) {
    const out = {};
    for (const key of columns) {
        const v = cellValue(row[key]);
        if (v === null || v === '') continue;
        out[key] = v;
    }
    return out;
}

/** The row's own name for a chip: the first granted column that has a value. */
function rowLabel(row, columns) {
    for (const key of columns) {
        const v = row[key];
        if (v === null || v === undefined || v === '') continue;
        return String(v).slice(0, 120);
    }
    return `Row ${row.id}`;
}

/**
 * Run `datatable_query`.
 *
 * @param {string} toolName
 * @param {object} toolArgs   the model's arguments
 * @param {object} context
 *   @param {string} context.userId    the person asking — the identity every
 *     access decision here is made for
 *   @param {string} context.agentId   whose grants apply
 *   @param {object} [context.deps]    injection seam for tests
 */
async function executeDatatableTool(toolName, toolArgs, context = {}) {
    if (!isDatatableTool(toolName)) return refuse(`Unknown tool: ${toolName}`);
    const deps = _deps(context.deps);
    const args = (toolArgs && typeof toolArgs === 'object' && !Array.isArray(toolArgs)) ? toolArgs : {};

    const userId = context.userId;
    if (!userId) {
        return refuse('This table can only be read on behalf of a signed-in person, and this run has none.');
    }
    const agentId = context.agentId;
    if (!agentId) {
        return refuse('Only an assistant whose owner granted a table can read one, and this run is not one.');
    }

    // ── The grants, fresh off the PUBLISHED config ──
    // Never the definition assembled at the top of the turn: a grant revoked
    // while the model was thinking has to stop working inside the same turn.
    let agent;
    try {
        agent = await deps.agentStore.getForRuntime(agentId);
    } catch (e) {
        return refuse(`Could not check which tables this assistant may read (${e.message}). Nothing was read.`);
    }
    const grants = grantsOf(agent && agent.config, deps);
    const grantedIds = Object.keys(grants);
    if (grantedIds.length === 0) {
        return refuse('This assistant has no data tables. Answer from what you already know instead.');
    }

    const datatableId = typeof args.datatable_id === 'string' ? args.datatable_id.trim() : '';
    if (!datatableId || !Object.hasOwn(grants, datatableId)) {
        // The granted ids are deliberately NOT listed back. Some of them are
        // tables this asker cannot read, and `buildDatatableTools` goes to the
        // trouble of keeping those out of the tool description — enumerating
        // them in an error would hand them over through the back door. The
        // model already has the readable ones in its tool definition.
        return refuse(`"${datatableId || '(none given)'}" is not a table this assistant may read. `
            + 'Use one of the table ids listed in the tool description.');
    }
    const grant = grants[datatableId];

    // ── The asker, and the table AS the asker ──
    const asker = await resolveAsker(userId, deps);
    let resolved;
    try {
        resolved = await resolveForAsker(datatableId, asker, deps);
    } catch (e) {
        // A refusal, an outage and a deleted table are three different
        // sentences, and every one of them beats "no rows found".
        return refuse(e && e.message ? e.message : 'That table could not be read.');
    }

    const { table, tableMeta, grade, scopeKey, orgId } = resolved;
    const columns = grantedColumnsFor(grant, tableMeta);
    if (columns.length === 0) {
        return refuse(`No columns of "${table.name}" are shared with this assistant, so there is nothing to read. `
            + 'Its owner has to pick the columns in the assistant\'s editor.');
    }

    const parsed = readDescriptor(args, { columns, tableMeta });
    if (parsed.error) return refuse(parsed.error);

    // ── The access predicate, plus the grant's own narrowing ──
    let filter;
    try {
        filter = deps.accessFilter.compileAccessFilter(tableMeta, grade, { id: userId }, 'read', PG);
    } catch (e) {
        return refuse(`Could not work out which rows you may see (${e.message}). Nothing was read.`);
    }
    if (grant.scope === 'own') {
        // ANDed OUTSIDE the table's own predicate, never instead of it: the
        // grant narrows what the asker may already see, and replacing the
        // predicate would hand them rows they created in a table they may not
        // read at all.
        filter = {
            where: `(${filter.where}) AND "created_by" = ?`,
            params: [...filter.params, userId],
        };
    }

    // ── Compile, run, slice ──
    let rows = [];
    let hasMore = false;
    try {
        const compiled = deps.queryCompiler.compileRecordList(tableMeta, {
            ...parsed.descriptor,
            limit: clampRowLimit(args.limit),
            maxLimit: MAX_ROW_LIMIT,
            dialect: 'pg',
        }, filter);
        const out = await deps.datatableDbStore.query(scopeKey, scopeKey, compiled.sql, compiled.params);
        const all = (out && out.rows) || [];
        // compileRecordList asks for limit+1 as a cursor probe and EVERY caller
        // must slice — stepDataSource.js records the run where that extra row
        // leaked into an AI prompt.
        rows = all.slice(0, compiled.limit);
        hasMore = all.length > compiled.limit;
    } catch (e) {
        return refuse(`That query could not be run (${e.message}).`);
    }

    // ── THE PRIVACY SHIELD, ON THIS PATH TOO ────────────────────────
    //
    // These rows go to a model. The SAME rows reaching the same model through
    // the knowledge-base route (K8) are scanned first — tokenised, so the agent
    // knows the terms and not the customer, or blocked outright. This path sent
    // them raw. The module header above reasons carefully about WHO may read a
    // row and never asked what leaves with it.
    //
    // One scan per tool call, over the rendered rows, not one per row: fifty
    // guard round trips inside a chat turn is not a privacy feature, it is an
    // outage.
    //
    // The switch is the org's knowledge-base setting (`privacy_scan_knowledge_bases`),
    // deliberately: it is the same data, from the same table, going to the same
    // model, and an org that asked for that to be scanned did not mean "only on
    // Tuesdays". The org is the TABLE's (`resolved.orgId`) — the policy belongs
    // to whoever owns the data, not to whoever happens to be asking.
    //
    // AND IT FAILS CLOSED, which is where this differs from the ingest path.
    // `applyShield` answers PASS with `piiStatus: 'unscanned'` when it could not
    // read the policy, could not reach the detector, or the detector threw. At
    // ingest that is survivable: the document is stored and carries the mark, so
    // somebody can see it later. Here there is no row to mark and no later — the
    // text either goes to the model or it does not. So "I could not check"
    // refuses, exactly like every other unknown in this file.
    let shielded = null;
    if (rows.length > 0) {
        const verdict = await deps.applyShield({
            orgId: orgId || null,
            userId,
            text: rows.map(row => renderRowText(row, columns, deps)).join('\n\n'),
            filename: table.name || 'table',
        }).catch(e => ({ _threw: e }));

        if (verdict && verdict._threw) {
            return refuse(`The privacy check on this table could not run (${verdict._threw.message}). Nothing was read.`);
        }
        if (verdict.outcome === deps.SHIELD_OUTCOME.SKIPPED) {
            return refuse(`This table holds personal data that your organisation does not allow an assistant to read (${verdict.reason || 'blocked by the privacy shield'}). Nothing was read.`);
        }
        if (verdict.piiStatus === 'unscanned') {
            return refuse(`This table could not be checked for personal data (${verdict.reason || 'the privacy check did not answer'}), so it was not read.`);
        }
        if (verdict.outcome === deps.SHIELD_OUTCOME.REDACTED) {
            shielded = verdict.text;
        }
        // PASS with 'none' (shield off, or knowledge bases excluded from it) and
        // PASS with 'found' (the legacy "warn" setting: mark it, do not touch
        // it) both fall through to the untouched rows below. The second one is
        // an explicit choice by the org and this path honours it rather than
        // upgrading it into redaction on its own.
    }

    // A redacted result set travels as ONE source and ONE row, not as fifty
    // half-tokenised ones. `toolRoundExecutor` reads `_sources` and `results` by
    // the same index, so the two lists have to stay the same length — and a
    // tokenised blob cannot honestly be split back into the columns it came
    // from.
    if (shielded !== null) {
        return {
            _action: 'kb_sources',
            _sources: [toCitation({
                title: table.name,
                content: shielded,
                datatable_id: datatableId,
                row_id: null,
                section: table.name,
            }, { index: 0, kind: 'datatable_row', source: { id: null, name: table.name } })],
            query: `${table.name}${parsed.descriptor.search ? ` · "${parsed.descriptor.search.value}"` : ''}`,
            table: { id: datatableId, name: table.name },
            rows_scope: grant.scope === 'own' ? 'only rows the person asking created' : 'every row the person asking may see',
            privacy: 'Personal data in these rows was replaced with placeholders before you saw them. The terms are real; the people are not named.',
            results: [{ row_id: null, redacted_rows: shielded }],
            returned: rows.length,
            has_more: hasMore,
        };
    }

    const sources = rows.map((row, index) => toCitation({
        title: rowLabel(row, columns),
        content: renderRowText(row, columns, deps),
        datatable_id: datatableId,
        row_id: row.id,
        // The heading a chip shows. There are no headings in a table, so it is
        // the table's own name — sectionLabelOf would otherwise mine the row's
        // first sentence, which for "prijs: 12,50" is noise.
        section: table.name,
    }, {
        index,
        kind: 'datatable_row',
        source: { id: null, name: table.name },
    }));

    return {
        // Draws the same source panel a kb_search does — one citation shape,
        // one panel. `toolRoundExecutor` reads `_sources` and `results` by the
        // same index, so the two lists stay aligned row for row.
        _action: 'kb_sources',
        _sources: sources,
        query: `${table.name}${parsed.descriptor.search ? ` · "${parsed.descriptor.search.value}"` : ''}`,
        table: { id: datatableId, name: table.name },
        rows_scope: grant.scope === 'own' ? 'only rows the person asking created' : 'every row the person asking may see',
        results: rows.map(row => ({ row_id: row.id, ...projectRow(row, columns) })),
        returned: rows.length,
        has_more: hasMore,
    };
}

/** The compiler's own clamp, capped at what a context window can carry. */
function clampRowLimit(raw) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_ROW_LIMIT;
    return Math.min(n, MAX_ROW_LIMIT);
}

/**
 * The row as "column: value" lines — the text a citation shows.
 *
 * Shared with the knowledge source (`core/kb/sources/datatable.js`) on purpose:
 * a row that reads one way in a synced document and another way in a live
 * citation is two shapes for one thing, which is the bug `core/kb/citation.js`
 * exists to stop happening again.
 */
function renderRowText(row, columns, deps) {
    const text = deps.renderRow(row, columns) || '';
    return text.length > MAX_ROW_CHARS ? `${text.slice(0, MAX_ROW_CHARS)}…` : text;
}

module.exports = {
    DATATABLE_QUERY_TOOL,
    isDatatableTool,
    buildDatatableTools,
    executeDatatableTool,
    // Exported for the colocated tests and for the editor surfaces that need
    // the same bounds the runtime uses.
    DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT, MAX_QUERY_FILTERS, MAX_CELL_CHARS, MAX_ORG_PROBES,
    HIDDEN_COLUMNS, ORDERABLE_SYSTEM_COLUMNS,
    declaredColumnsOf, grantedColumnsFor, readDescriptor, projectRow, rowLabel,
    resolveAsker, resolveForAsker, describeGrantedTable, toolDefinitionFor, clampRowLimit,
};
