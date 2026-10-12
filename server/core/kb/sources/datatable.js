// @typecheck
/**
 * A datatable as a knowledge source ("live").
 *
 * A price list, a product catalogue, a list of standard clauses — things that
 * already live in a table and are already kept current there. Pointing a
 * knowledge base at one means an agent answers "what does the XL cost?" from
 * the row rather than from a PDF somebody exported in March.
 *
 * ── READ AS THE KNOWLEDGE BASE'S OWNER, WITH THE REAL ACCESS FILTER ─
 * A datatable has row-level access rules of its own (`accessFilter`), and they
 * are not decoration: a table can be readable by everyone while individual
 * rows are not. So this resolves the table and compiles the SAME access
 * predicate the automation runner and the routes compile — as the KB's OWNER, for
 * the same reason K7 does: a scheduled pass has nobody pressing anything, and
 * keying it on whoever last touched the source would make the document set
 * depend on who that happened to be.
 *
 * What that means in practice is worth stating plainly, because it is the risk
 * of this source: rows the owner may read become searchable by everyone the
 * knowledge base is shared with. The row rules protect the OWNER's view of the
 * table, not the reader's. That is the same trade K7 makes, and the settings
 * screen says it.
 *
 * ── ONE DOCUMENT PER ROW, UNTIL THAT IS ABSURD ──────────────────────
 * A row is the unit somebody means when they ask a question ("the XL", "the
 * Van Dijk contract"), so a row is a document — retrieval scores it whole and
 * a citation names it. Past `CHUNK_ABOVE_ROWS` that stops being sensible:
 * fifty thousand documents to hold a lookup table would swamp every other
 * source in the knowledge base and cost fifty thousand embeddings. Above the
 * threshold rows are grouped `chunkRows` at a time, which keeps the table
 * searchable as reference material without pretending each row is a topic.
 *
 * ── A DELETED ROW LEAVES NO TRACE ───────────────────────────────────
 * `syncSource` removes documents the enumerate no longer offers, with
 * `skipSnapshot: true` (K1). That matters here more than anywhere: a row can
 * disappear because the retention sweep took it or because somebody exercised
 * a data-subject request, and a snapshot in `kb_document_versions` would be
 * the erased row surviving the erasure.
 *
 * ── A RELATION CELL IS RENDERED AS ITS LABEL, NOT ITS ID ────────────
 * A relation column holds the id of a row in another table. Written out as
 * "supplier: 7f3a…" it retrieves for nothing and reads as nothing; written as
 * "supplier: Van Dijk" the order retrieves for the question that names the
 * supplier, which is the question people ask. So the pass resolves every
 * relation cell to the target row's label — as the KB's owner, through the
 * target table's OWN access filter, in batches of ids — and renders that.
 *
 * The ids still ride in the document metadata (`relations`), one entry per
 * cell, because that is what `relationHop` walks at query time: a hit on the
 * supplier pulls in the orders that point at it, and a hit on an order pulls
 * in its supplier. Both directions are exact joins on ids the tables already
 * hold; nothing is guessed from text.
 *
 * ── AND IT IS KEPT CURRENT FROM THE OTHER TABLE TOO ─────────────────
 * A label lives in the target table, so a rename there changes THIS document
 * while this row's `updated_at` stands still — and a deleted target must take
 * its name out of every row that pointed at it, for the same reason a deleted
 * row leaves no trace. Two things make that automatic:
 *
 *   • the pass hands the engine the target tables it read (`ctx.relatedTables`)
 *     so a `live` source is armed when any of THEM changes, not only its own;
 *   • `isUnchanged` compares a signature of the resolved labels (`relSig`)
 *     beside the row timestamp, so only the rows whose labels actually moved
 *     are rebuilt, never the whole table.
 */
const log = require('../../../telemetry/log');

const supportsModes = ['manual', 'schedule', 'live'];
const defaultMode = 'live';

/**
 * A row is identified by its id, never by its text. The engine's duplicate
 * filter (exact hash, then a simhash within a few bits) exists for newsletters
 * and re-uploaded PDFs; on a narrow table it reads two invoices from the same
 * supplier — a date and an amount apart — as one document and drops the
 * second. With a privacy screen that redacts the name, the email and the IBAN,
 * every row of a supplier table reads the same and most of it vanishes.
 * `externalId` (`row:<id>`) already keeps a row from being ingested twice.
 */
const dedupe = false;

/**
 * Above this many rows a table stops being one-document-per-row.
 *
 * A row is what somebody means when they ask a question, so a row is a
 * document — until the table is a lookup table, where five thousand of them
 * would swamp every other source in the knowledge base and cost five thousand
 * embeddings to say what a hundred could.
 */
const CHUNK_ABOVE_ROWS = 5000;
/** Rows per grouped document, when grouping. */
const DEFAULT_CHUNK_ROWS = 50;

/**
 * Rows one pass will read. TWO caps, because the cost that matters is
 * DOCUMENTS, not rows:
 *
 *   ungrouped — 5000 rows is already 5000 documents and 5000 embeddings;
 *   grouped   — 50 000 rows is 1000 documents, which is affordable.
 *
 * A table larger than its cap is covered as far as the cap in its sort order,
 * and the source's subline says how many rows it holds so the shortfall is
 * visible rather than silent.
 */
const MAX_ROWS = 5000;
const MAX_ROWS_GROUPED = 50_000;

/** System columns a person did not write and would not want quoted at them. */
const SKIP_COLUMNS = new Set(['id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at']);

/**
 * Ids per label lookup. The compiler's `in` takes at most 200 values and a
 * page is at most 200 rows, so this is the one number both accept.
 */
const LABEL_BATCH = 200;
/** A label is a name, not a paragraph. */
const MAX_LABEL_CHARS = 200;
/**
 * Relation entries one document carries. A block of 50 rows with three
 * relation columns is 150; the cap keeps a pathological table from growing a
 * metadata bag the GIN index has to carry for every search.
 */
const MAX_RELATIONS_PER_DOC = 300;

/**
 * The rows this source currently offers.
 *
 * Paginated through the compiler's own keyset cursor rather than one huge
 * LIMIT: `compileRecordList` asks for `limit + 1` as a probe and EVERY caller
 * must slice — `stepDataSource.js` records the bug where that extra row leaked
 * into an AI prompt.
 */
async function enumerate(source, ctx, deps) {
    const config = source?.config || {};
    const datatableId = config.datatableId;
    if (!datatableId) return [];

    const owner = ctx.kb?.tenant_id || null;
    if (!owner) return [];

    const { resolveDatatableForStep } = deps.datatableResolve || require('../../automationRunner/datatableResolve');
    const queryCompiler = deps.queryCompiler || require('../../dataEngine/queryCompiler');
    const accessFilter = deps.accessFilter || require('../../dataEngine/accessFilter');
    const datatableDbStore = deps.datatableDbStore || require('../../../stores/datatableDbStore');

    let asker = { orgIds: new Set(), userGroups: [] };
    try {
        asker = await require('../askerContext').askerContext(owner);
    } catch (_) { /* a failed resolve narrows; see askerContext */ }

    // The owner, as the principal every table in this pass is read as — the
    // source's own table and every table its relation columns point at.
    const principal = {
        userId: owner,
        orgId: [...asker.orgIds][0] || null,
        userGroupIds: asker.userGroups,
    };

    let resolved;
    try {
        resolved = await resolveDatatableForStep(datatableId, principal, { needed: 'viewer' });
    } catch (e) {
        // The table was deleted, or the owner lost access to it. Either way
        // this source has nothing to offer — and returning [] would make
        // syncSource delete every document it holds. That is the RIGHT answer
        // for "the rows are gone" and the wrong one for "we could not ask", so
        // it is a thrown failure the pass records rather than a silent empty.
        throw new Error(`This table is no longer available to the knowledge base's owner (${e.message})`);
    }

    const { tableMeta, grade, scopeKey } = resolved;
    const readFilter = accessFilter.compileAccessFilter(tableMeta, grade, { id: owner }, 'read', 'pg');

    /**
     * Grouped or not is decided from the TABLE's own row count, before a
     * single row is read.
     *
     * Deciding it afterwards from `rows.length` cannot work: the read cap and
     * the grouping threshold would have to be the same number for the branch
     * to be reachable at all, and then it never is. The count also lets a big
     * table be read to its higher cap rather than being cut at the small one.
     */
    const totalRows = Number(resolved.table?.rowCount ?? resolved.table?.row_count) || 0;
    const grouped = totalRows > CHUNK_ABOVE_ROWS;
    const chunkRows = grouped ? Math.max(1, Number(config.chunkRows) || DEFAULT_CHUNK_ROWS) : 1;
    const readCap = grouped ? MAX_ROWS_GROUPED : MAX_ROWS;

    const rows = [];
    let cursor = null;
    while (rows.length < readCap) {
        const compiled = queryCompiler.compileRecordList(tableMeta, {
            filters: [], match: 'all', sort: [],
            limit: Math.min(200, readCap - rows.length),
            maxLimit: 200,
            cursor,
            dialect: 'pg',
        }, readFilter);
        const out = await datatableDbStore.query(scopeKey, scopeKey, compiled.sql, compiled.params);
        const all = out?.rows || [];
        // The probe row, sliced off — see the docblock.
        const page = all.slice(0, compiled.limit);
        rows.push(...page);
        if (all.length <= compiled.limit || page.length === 0) break;
        const last = page[page.length - 1];
        cursor = queryCompiler.encodeCursor(last[compiled.primaryField], last.id);
    }

    const columns = pickColumns(config, tableMeta);
    const tableName = resolved.table?.name || null;

    /**
     * The relation columns among those, and every label they point at.
     *
     * Resolved for the WHOLE read at once, per target table, so a 5000-row
     * order table with 300 suppliers costs two label queries, not 5000. Read
     * AFTER the rows: a target renamed mid-pass belongs to the next version of
     * the target table, which the engine records after this returns.
     */
    const relations = relationColumns(tableMeta, columns);
    const links = relations.length
        ? await resolveRelationLabels(rows, relations, {
            principal, resolveDatatableForStep, queryCompiler, accessFilter, datatableDbStore,
            log: ctx.log,
        })
        : { labels: new Map(), tables: new Map() };

    /**
     * The target tables this pass depended on, with the version each was at —
     * read after their labels, for the reason the engine reads the source's
     * own version after its rows. The engine records these on the source so a
     * `live` one is armed when a TARGET changes, which its own row timestamps
     * would never show.
     */
    if (links.tables.size) {
        const dtStore = deps.datatableStore || require('../../../stores/datatableStore');
        const versions = {};
        for (const tableId of links.tables.keys()) {
            try {
                const v = await dtStore.getDataVersion(tableId);
                if (v !== null && v !== undefined) versions[tableId] = Number(v) || 0;
            } catch (_) { /* unreadable now; the backstop simply cannot compare it */ }
        }
        ctx.relatedTables = versions;
    } else {
        ctx.relatedTables = {};
    }

    const relationsFor = (row) => rowRelations(row, relations, links.labels);
    const shared = { columns, relations, labels: links.labels, datatableId: String(datatableId), tableName };

    if (!grouped) {
        // No row ordinal here, deliberately: one row per document already
        // cites by its own name ("Product 1"), and "row 37" is a position in
        // THIS read that a single insert at the top invalidates. A number that
        // is wrong by tomorrow is worse than no number.
        return rows.map(row => {
            const rels = relationsFor(row);
            return {
                externalId: `row:${row.id}`,
                row, ...shared,
                title: titleFor(row, config, columns) || `Row ${row.id}`,
                sourceModifiedAt: row.updated_at || row.created_at || null,
                rels,
                relSig: relationSignature(rels),
            };
        });
    }

    const groups = [];
    for (let i = 0; i < rows.length; i += chunkRows) {
        const slice = rows.slice(i, i + chunkRows);
        const rels = slice.flatMap(row => relationsFor(row).map(r => ({ ...r, from: row.id })));
        groups.push({
            // Keyed on the BLOCK, not on the first row's id: a row inserted at
            // the top would otherwise renumber every block and re-embed the
            // whole table.
            externalId: `rows:${i}-${i + slice.length - 1}`,
            rows: slice, ...shared,
            title: `${tableName || 'Table'} ${i + 1}–${i + slice.length}`,
            rels,
            relSig: relationSignature(rels),
            // The same two numbers as the title, carried as numbers so the
            // citation does not have to parse them back out of a string — and
            // 1-based like the title, not 0-based like `externalId`, which is
            // keyed on the block and is off by one from what a person reads.
            rowStart: i + 1,
            rowEnd: i + slice.length,
            // The freshest row in the block: any edit inside it is a change.
            sourceModifiedAt: slice
                .map(r => r.updated_at || r.created_at)
                .filter(Boolean)
                .sort()
                .pop() || null,
        });
    }
    return groups;
}

/** The columns worth reading: the source's choice, else everything a person declared. */
function pickColumns(config, tableMeta) {
    // `key` is the field identifier queryCompiler resolves to a column; `name`
    // is a label. Only the key addresses a row.
    const declared = (tableMeta?.fields || [])
        .map(f => f?.key)
        .filter(k => typeof k === 'string' && k && !SKIP_COLUMNS.has(k));
    const chosen = Array.isArray(config.columns) ? config.columns.filter(c => declared.includes(c)) : [];
    return chosen.length ? chosen : declared;
}

/** The row's own name, when the source says which column holds it. */
function titleFor(row, config, columns) {
    const key = config.titleColumn && columns.includes(config.titleColumn)
        ? config.titleColumn
        : columns[0];
    const v = key ? row[key] : null;
    return v === null || v === undefined || v === '' ? null : String(v).slice(0, 200);
}

// ── Relations ───────────────────────────────────────────────────────

/**
 * The relation columns among the chosen ones: `[{ column, table }]`, where
 * `table` is the TARGET datatable's id (`field.relation.table`, the same id
 * the DDL resolves a foreign key from).
 */
function relationColumns(tableMeta, columns) {
    return (tableMeta?.fields || [])
        .filter(f => f && f.type === 'relation' && f.relation && f.relation.table && columns.includes(f.key))
        .map(f => ({ column: f.key, table: String(f.relation.table) }));
}

/**
 * The column that names a row of a table, when nothing says otherwise.
 *
 * The first text column somebody declared, else the first declared column at
 * all — the same guess `titleFor` makes for a document's title, so a row is
 * called the same thing whether it is the document or the label in another.
 */
function labelFieldFor(tableMeta) {
    const fields = (tableMeta?.fields || [])
        .filter(f => f && typeof f.key === 'string' && f.key && !SKIP_COLUMNS.has(f.key));
    const text = fields.find(f => f.type === 'text');
    return (text || fields[0])?.key || null;
}

/** The ids one relation cell holds — one, several, or none. */
function cellIds(v) {
    if (v === null || v === undefined || v === '') return [];
    const list = Array.isArray(v) ? v : [v];
    return list
        .map(x => (x && typeof x === 'object' ? (x.id ?? x.value ?? null) : x))
        .filter(x => x !== null && x !== undefined && x !== '')
        .map(String);
}

/**
 * Every label the relation cells of `rows` point at, per target table.
 *
 * Each target is resolved AS THE OWNER with its own access filter, exactly as
 * the source's table is: a supplier the owner may not read is a supplier whose
 * name must not appear in the orders, however many orders point at it. A
 * target that cannot be resolved at all — deleted, or out of reach — leaves
 * its column blank rather than failing the pass; the rows are still worth
 * having without the name.
 *
 * @returns {Promise<{ labels: Map<string, Map<string, string>>, tables: Map<string, {name: string|null}> }>}
 *   `labels`: target table id → (row id → label); `tables`: the targets read.
 */
async function resolveRelationLabels(rows, relations, deps) {
    const labels = new Map();
    const tables = new Map();
    const { principal, resolveDatatableForStep, queryCompiler, accessFilter, datatableDbStore } = deps;
    const log = deps.log || (() => {});

    // Ids per target, across every column that points at it.
    const idsByTable = new Map();
    for (const rel of relations) {
        if (!idsByTable.has(rel.table)) idsByTable.set(rel.table, new Set());
        const set = idsByTable.get(rel.table);
        for (const row of rows) for (const id of cellIds(row?.[rel.column])) set.add(id);
    }

    for (const [tableId, idSet] of idsByTable) {
        const map = new Map();
        labels.set(tableId, map);
        let target;
        try {
            target = await resolveDatatableForStep(tableId, principal, { needed: 'viewer' });
        } catch (e) {
            log(`relation target ${tableId} is not readable by the knowledge base's owner: ${e.message}`);
            continue;
        }
        tables.set(tableId, { name: target.table?.name || null });
        if (idSet.size === 0) continue;

        const labelKey = labelFieldFor(target.tableMeta);
        if (!labelKey) continue;
        const readFilter = accessFilter.compileAccessFilter(target.tableMeta, target.grade, { id: principal.userId }, 'read', 'pg');

        const ids = [...idSet];
        for (let i = 0; i < ids.length; i += LABEL_BATCH) {
            const batch = ids.slice(i, i + LABEL_BATCH);
            let compiled;
            try {
                compiled = queryCompiler.compileRecordList(target.tableMeta, {
                    filters: [{ field: 'id', op: 'in', value: batch }],
                    match: 'all', sort: [],
                    limit: LABEL_BATCH, maxLimit: LABEL_BATCH,
                    dialect: 'pg',
                }, readFilter);
            } catch (e) {
                log(`relation target ${tableId}: label query could not be compiled: ${e.message}`);
                break;
            }
            const out = await datatableDbStore.query(target.scopeKey, target.scopeKey, compiled.sql, compiled.params);
            // The probe row, sliced off — see enumerate.
            for (const r of (out?.rows || []).slice(0, compiled.limit)) {
                const v = r?.[labelKey];
                if (v === null || v === undefined || v === '') continue;
                map.set(String(r.id), formatCell(v).slice(0, MAX_LABEL_CHARS));
            }
        }
    }
    return { labels, tables };
}

/**
 * One row's relation entries: `{ column, table, rowId, label }` per id in a
 * relation cell — `rowId` being the TARGET row. A cell whose target could not
 * be named still yields an entry (label null): the hop needs the id, and the
 * signature needs to notice when the name comes back.
 */
function rowRelations(row, relations, labels) {
    const out = [];
    for (const rel of relations) {
        for (const id of cellIds(row?.[rel.column])) {
            out.push({ column: rel.column, table: rel.table, rowId: id, label: labels.get(rel.table)?.get(id) ?? null });
        }
    }
    return out;
}

/**
 * A short, stable signature of the labels a document renders, so change
 * detection can see a target rename without rebuilding the text. Null when
 * there is nothing to sign, which is what a document without relations has
 * always had.
 */
function relationSignature(rels) {
    if (!rels || rels.length === 0) return null;
    const crypto = require('crypto');
    const canon = rels
        .map(r => `${r.from ?? ''}\u0001${r.column}\u0001${r.table}\u0001${r.rowId}\u0001${r.label ?? ''}`)
        .sort()
        .join('\n');
    return crypto.createHash('sha1').update(canon).digest('hex').slice(0, 16);
}

/** `stored.metadata` as an object, whatever the driver handed back. */
function storedMeta(stored) {
    let m = stored?.metadata;
    if (typeof m === 'string') { try { m = JSON.parse(m); } catch (_) { m = null; } }
    return m && typeof m === 'object' ? m : {};
}

/**
 * Unchanged when the row has not been written since we last read it — AND its
 * relation labels read the same as they did then.
 *
 * Comparing the built text instead would mean building it for every row on
 * every pass — the work this check exists to avoid, and on a 5000-row table it
 * is the difference between a pass that costs nothing and one that costs
 * everything. The label signature is the one thing the timestamp cannot see:
 * a supplier renamed in ITS table changes this order's text while this row's
 * `updated_at` stands still.
 */
function isUnchanged(item, stored) {
    if (!stored || !item?.sourceModifiedAt || !stored.source_modified_at) return false;
    if (new Date(item.sourceModifiedAt).getTime() !== new Date(stored.source_modified_at).getTime()) return false;
    return (item.relSig ?? null) === (storedMeta(stored).relSig ?? null);
}

/**
 * One row (or one block of rows) as text.
 *
 * "column: value" lines, because that is what makes a row answerable: "prijs:
 * 12,50" retrieves for "wat kost", where a bare "12,50" retrieves for nothing.
 * An empty cell is left out rather than written as "prijs: " — a line that
 * says a column exists and is empty is noise in every chunk it appears in.
 */
async function fetch(item) {
    const rows = item.rows || (item.row ? [item.row] : []);
    if (rows.length === 0) return null;

    const render = { relations: item.relations || [], labels: item.labels || new Map() };
    const blocks = rows.map(row => renderRow(row, item.columns, render)).filter(Boolean);
    if (blocks.length === 0) return null;

    const rels = Array.isArray(item.rels) ? item.rels.slice(0, MAX_RELATIONS_PER_DOC) : [];

    return {
        content: blocks.join('\n\n'),
        title: item.title,
        sourceType: 'datatable',
        sourceUri: `datatable:${item.externalId}`,
        sourceModifiedAt: item.sourceModifiedAt,
        metadata: {
            rowIds: rows.map(r => r.id), columns: item.columns,
            // Which table, by id and by name: the id is what a hop joins on,
            // the name is what a citation can say ("Orders, 312 rows").
            ...(item.datatableId ? { datatableId: item.datatableId } : {}),
            ...(item.tableName ? { tableName: item.tableName } : {}),
            // The ids behind every relation cell, and the signature of the
            // labels they rendered as — see the docblock.
            ...(rels.length ? { relations: rels } : {}),
            ...(item.relSig ? { relSig: item.relSig } : {}),
            // Only the grouped path knows these; a single-row document leaves
            // them out and cites by its own title, as it always has.
            ...(item.rowStart ? { rowStart: item.rowStart, rowEnd: item.rowEnd } : {}),
        },
    };
}

/**
 * @param {object} row
 * @param {string[]} columns
 * @param {object} [opts]
 * @param {Array<{column:string, table:string}>} [opts.relations]  relation columns
 * @param {Map<string, Map<string, string>>} [opts.labels]        table → (id → label)
 */
function renderRow(row, columns, opts = {}) {
    const byColumn = new Map((opts.relations || []).map(r => [r.column, r.table]));
    const lines = [];
    for (const key of columns) {
        const v = row[key];
        if (v === null || v === undefined || v === '') continue;
        if (byColumn.has(key)) {
            // A relation cell reads as the row it points at. An id nobody can
            // name is left out: "supplier: 7f3a…" retrieves for nothing and a
            // line that says nothing is noise in every chunk it appears in.
            const map = opts.labels?.get(byColumn.get(key));
            const named = cellIds(v).map(id => map?.get(id)).filter(Boolean);
            if (named.length) lines.push(`${key}: ${named.join(', ')}`);
            continue;
        }
        lines.push(`${key}: ${formatCell(v)}`);
    }
    return lines.join('\n');
}

/** A cell as a person would read it. Objects and arrays are JSON, not `[object Object]`. */
function formatCell(v) {
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'object') {
        try { return JSON.stringify(v); } catch (_) { return String(v); }
    }
    return String(v);
}

/**
 * Tell the datatable which knowledge bases read it (K8).
 *
 * ── WHY THE WHOLE KB, EVERY TIME ────────────────────────────────────
 * `reconcileUsageFor` is delete-then-insert for one consumer, so it has to be
 * handed EVERY entry that consumer still has. Passing only the source that
 * just changed would erase the rows for its siblings — a knowledge base with
 * two table sources would forget one on every edit to the other.
 *
 * The consumer is the KNOWLEDGE BASE, not the source: that is the thing a
 * person opens from the datatable's "Used by" tab and the thing they would be
 * warned about before deleting the table. The source id rides in `step_id`,
 * which is the generic "which part of the consumer" column.
 *
 * Best-effort. The index is what makes a delete ask first; failing to write it
 * must not fail the source the person just created, and the next edit
 * reconciles it.
 */
async function reconcileUsage(kbId, scope, deps = {}) {
    if (!kbId || !scope) return 0;
    const kbSourcesStore = deps.kbSourcesStore || require('../../../stores/kbSources');
    const datatableStore = deps.datatableStore || require('../../../stores/datatableStore');
    try {
        const sources = await kbSourcesStore.listByKb(kbId);
        const entries = (sources || [])
            .filter(s => s.kind === 'datatable' && s.config?.datatableId)
            .map(s => ({
                datatableId: s.config.datatableId,
                stepId: s.id,
                // A knowledge source only ever READS. Saying so is what lets
                // the datatable's own UI show "as a source" rather than
                // implying a knowledge base might write rows back.
                mode: 'read',
                columns: Array.isArray(s.config.columns) ? s.config.columns : [],
            }));
        return await datatableStore.reconcileUsageFor('kb', kbId, scope, entries);
    } catch (e) {
        log.warn(`[KB] could not record datatable usage for ${kbId}:`, e.message);
        return 0;
    }
}

module.exports = {
    enumerate, fetch, isUnchanged, supportsModes, defaultMode, dedupe, reconcileUsage,
    pickColumns, titleFor, renderRow, formatCell,
    relationColumns, labelFieldFor, resolveRelationLabels, rowRelations, relationSignature, cellIds,
    MAX_ROWS, MAX_ROWS_GROUPED, CHUNK_ABOVE_ROWS, DEFAULT_CHUNK_ROWS, SKIP_COLUMNS,
    LABEL_BATCH, MAX_RELATIONS_PER_DOC,
};
