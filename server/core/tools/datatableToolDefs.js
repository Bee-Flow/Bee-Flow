const log = require('../../telemetry/log');

/** The one tool this module owns. */
const DATATABLE_QUERY_TOOL = 'datatable_query';

// ── Bounds ──────────────────────────────────────────────────────────
// Rows here land in the model's context window, so the caps are much tighter
// than the HTTP surface's (500 a page) or K8's (5000 a pass). A model that
// needs more than fifty rows to answer a question is doing analysis, which is
// what the automation datatable step is for.
const DEFAULT_ROW_LIMIT = 10;

const MAX_ROW_LIMIT = 50;

const MAX_QUERY_FILTERS = 10;

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
    /** @type {string | null} */
    let identityError = null;

    try {
        const ctx = await deps.askerContext(userId);
        orgIds = ctx?.orgIds instanceof Set ? ctx.orgIds : new Set(ctx?.orgIds || []);
        userGroups = Array.isArray(ctx?.userGroups) ? ctx.userGroups : [];
    } catch (e) {
        identityError = `the organisations of the person asking could not be read (${/** @type {Error} */ (e).message})`;
    }
    try {
        const user = await deps.userStore.getUser(userId);
        orgRole = user?.orgRole || null;
        // Truthiness, not `!= null`: an org-less account holds the EMPTY STRING
        // (stores/user/users.js writes `organizationId || ''`), and passing ''
        // on as a tenant key is how a non-tenant becomes one.
        homeOrgId = user?.organizationId || null;
    } catch (e) {
        identityError = identityError || `the account of the person asking could not be read (${/** @type {Error} */ (e).message})`;
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
            log.warn(`[DatatableTools] granted table ${datatableId} could not be checked: ${e && /** @type {Error} */ (e).message}`);
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
        log.warn('[DatatableTools] datatable_query not offered:', e && /** @type {Error} */ (e).message);
        return [];
    }
}

module.exports = { DATATABLE_QUERY_TOOL, DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT, MAX_QUERY_FILTERS, MAX_ORG_PROBES, HIDDEN_COLUMNS, _deps, grantsOf, resolveAsker, resolveForAsker, declaredColumnsOf, grantedColumnsFor, fieldMapOf, describeGrantedTable, toolDefinitionFor, buildDatatableTools };
