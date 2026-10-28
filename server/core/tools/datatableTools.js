// @typecheck
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
 * the access predicate is the same one the routes and the automation runner
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
const { DATATABLE_QUERY_TOOL, DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT, MAX_QUERY_FILTERS, MAX_ORG_PROBES, HIDDEN_COLUMNS, _deps, grantsOf, resolveAsker, resolveForAsker, declaredColumnsOf, grantedColumnsFor, describeGrantedTable, toolDefinitionFor, buildDatatableTools } = require('./datatableToolDefs');
const { MAX_CELL_CHARS, ORDERABLE_SYSTEM_COLUMNS, readDescriptor, projectRow, rowLabel, clampRowLimit, renderRowText } = require('./datatableRows');

/** Rows always live in Postgres — see stores/datatableDbStore.js. */
const PG = Object.freeze({ dialect: 'pg' });

/**
 * @param {string} toolName
 */
function isDatatableTool(toolName) {
    return toolName === DATATABLE_QUERY_TOOL;
}

// ── Who is asking ───────────────────────────────────────────────────

// ── Columns ─────────────────────────────────────────────────────────

// ── Offering the tool ───────────────────────────────────────────────

// ── Running one query ───────────────────────────────────────────────

/**
 * A refusal the model relays. Never `{rows: []}` — see the module header.
 * @param {string} message
 */
function refuse(message) {
    return { error: message };
}

/**
 * Run `datatable_query`.
 *
 * @param {string} toolName
 * @param {Record<string, unknown>} toolArgs   the model's arguments
 * @param {{ userId?: string, agentId?: string, deps?: object }} [context]
 *   userId: the person asking — the identity every access decision here is made for;
 *   agentId: whose grants apply; deps: injection seam for tests
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
        return refuse(`Could not check which tables this assistant may read (${/** @type {Error} */ (e).message}). Nothing was read.`);
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
        return refuse(e && /** @type {Error} */ (e).message ? /** @type {Error} */ (e).message : 'That table could not be read.');
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
        return refuse(`Could not work out which rows you may see (${/** @type {Error} */ (e).message}). Nothing was read.`);
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
        return refuse(`That query could not be run (${/** @type {Error} */ (e).message}).`);
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

/**
 * @typedef {{
 *   agentStore: typeof import('../../stores/agentStore'),
 *   datatableDbStore: typeof import('../../stores/datatableDbStore'),
 *   resolveDatatableForStep: typeof import('../automationRunner/datatableResolve').resolveDatatableForStep,
 *   queryCompiler: typeof import('../dataEngine/queryCompiler'),
 *   accessFilter: typeof import('../dataEngine/accessFilter'),
 *   askerContext: typeof import('../kb/askerContext').askerContext,
 *   applyShield: typeof import('../kb/ingestPrivacy').applyShield,
 *   SHIELD_OUTCOME: typeof import('../kb/ingestPrivacy').OUTCOME,
 *   userStore: typeof import('../../stores/userStore'),
 *   toolPolicy: typeof import('../agentRuntime/toolPolicy'),
 *   renderRow: typeof import('../kb/sources/datatable').renderRow,
 * }} DatatableDeps
 */

/** @typedef {ReturnType<typeof import('../agentRuntime/toolPolicy').datatableGrantsOf>[string]} DatatableGrant */

/** @typedef {import('../automationRunner/datatableResolve').ResolvedDatatable['tableMeta']} TableMeta */

/** One declared column of a table descriptor. @typedef {{ key?: string, type?: string, computed?: { stored?: boolean } }} DatatableField */

/** @typedef {Awaited<ReturnType<typeof resolveAsker>>} Asker */

/** A data-table row as the database returns it (user-defined columns). @typedef {Record<string, any>} DatatableRecord */
