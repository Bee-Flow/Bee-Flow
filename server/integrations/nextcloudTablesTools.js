// @typecheck
/**
 * Nextcloud Tables Tools — structured data inside Nextcloud.
 *
 * Tables is the data layer of Nextcloud Flow: the place a form submission, an
 * approval decision or a scraped invoice line actually lands. Without it a
 * automation can only move files and post messages; with it, Bee Flow can run the
 * "collect → store → report" workflows that people otherwise build in
 * Airtable, Power Apps or a spreadsheet on someone's desktop.
 *
 * API: `/index.php/apps/tables/api/1/...` — the app's own REST namespace, not
 * an OCS one. It answers JSON directly (no `ocs.data` envelope) and, unlike the
 * Deck REST family, it tolerates the `OCS-APIRequest` header, so a single
 * header set works for every call here.
 *
 * Column values. Rows are addressed by *numeric column id*, not by column
 * title — `{"data": [{"columnId": 12, "value": "Acme BV"}]}`. Agents (and
 * humans) reason in titles, so every write tool here accepts a title→value map
 * and resolves it against the table's columns; `nextcloud_tables_list_rows`
 * does the inverse so the output is readable and bindable in the automation
 * builder. Callers who already know the ids can pass them and skip the lookup.
 */

const ncClient = require('./nextcloudClient');
const { nextcloudHttpError } = require('./nextcloudHttpError');
const { columnKind, toWireValue, fromWireValue, mapTable, mapColumn, describeColumn } = require('./nextcloudTablesValues');

const TABLES_API = '/index.php/apps/tables/api/1';
// A table with tens of thousands of rows would blow the model's context and
// the run-log budget. Reads are capped and report whether they truncated.
const MAX_ROWS = 500;
const DEFAULT_ROWS = 100;

const NEXTCLOUD_TABLES_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'nextcloud_tables_list',
            description: 'List the Nextcloud Tables the user can access, with id, title, emoji, ownership and row/column counts. Call this first to find a table id.',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tables_create',
            description: 'Create a new Nextcloud Table. Returns the new table id.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Title of the new table.' },
                    emoji: { type: 'string', description: 'Optional single emoji used as the table icon.' },
                    template: { type: 'string', description: 'Optional starter template, e.g. "todo", "members", "weight". Omit for an empty table.' }
                },
                required: ['title']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tables_update',
            description: 'Rename a table, change its emoji, or archive/unarchive it.',
            parameters: {
                type: 'object',
                properties: {
                    tableId: { type: ['integer', 'string'], description: 'Table id (from nextcloud_tables_list) — or the exact table title, e.g. "Facturen", when the id is unknown.' },
                    title: { type: 'string', description: 'New title.' },
                    emoji: { type: 'string', description: 'New emoji icon.' },
                    archived: { type: 'boolean', description: 'true archives the table, false restores it.' }
                },
                required: ['tableId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tables_delete',
            description: 'Permanently delete a table and every row in it. Destructive — prefer archiving via nextcloud_tables_update.',
            parameters: {
                type: 'object',
                properties: {
                    tableId: { type: ['integer', 'string'], description: 'Table id (from nextcloud_tables_list) — or the exact table title, e.g. "Facturen", when the id is unknown.' }
                },
                required: ['tableId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tables_list_columns',
            description: 'List a table\'s columns with their numeric ids, titles and types. Needed to interpret row values, and to build a filter for nextcloud_tables_list_rows.',
            parameters: {
                type: 'object',
                properties: {
                    tableId: { type: ['integer', 'string'], description: 'Table id (from nextcloud_tables_list) — or the exact table title, e.g. "Facturen", when the id is unknown.' }
                },
                required: ['tableId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tables_create_column',
            description: 'Add a column to a table.',
            parameters: {
                type: 'object',
                properties: {
                    tableId: { type: ['integer', 'string'], description: 'Table id (from nextcloud_tables_list) — or the exact table title, e.g. "Facturen", when the id is unknown.' },
                    title: { type: 'string', description: 'Column title.' },
                    type: { type: 'string', description: 'Column type: "text", "number", "datetime", "selection" or "usergroup". Defaults to "text".' },
                    subtype: { type: 'string', description: 'Optional subtype, e.g. "line" or "long" for text, "date" for datetime, "check" for selection.' },
                    mandatory: { type: 'boolean', description: 'Whether the column is required.' },
                    description: { type: 'string', description: 'Optional column description.' },
                    selectionOptions: { type: 'array', items: { type: 'string' }, description: 'For "selection" columns: the list of allowed option labels. Rows are then written and read by label.' },
                    numberDecimals: { type: 'integer', description: 'For "number" columns: how many decimals are kept (default 0, so 3.5 is stored as 3). Set 2 for amounts.' },
                    numberPrefix: { type: 'string', description: 'For "number" columns: optional prefix such as a currency symbol.' },
                    numberSuffix: { type: 'string', description: 'For "number" columns: optional suffix such as a unit.' }
                },
                required: ['tableId', 'title']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tables_delete_column',
            description: 'Delete a column and all of its values.',
            parameters: {
                type: 'object',
                properties: {
                    columnId: { type: 'integer', description: 'Column id (from nextcloud_tables_list_columns).' }
                },
                required: ['columnId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tables_list_rows',
            description: 'Read rows from a table. Values are returned keyed by column TITLE so they are readable and can be bound in an automation. Optionally filter with a simple field/operator/value match.',
            parameters: {
                type: 'object',
                properties: {
                    tableId: { type: ['integer', 'string'], description: 'Table id (from nextcloud_tables_list) — or the exact table title, e.g. "Facturen", when the id is unknown.' },
                    limit: { type: 'integer', description: `Max rows (default ${DEFAULT_ROWS}, max ${MAX_ROWS}).` },
                    offset: { type: 'integer', description: 'Rows to skip, for paging through a large table.' },
                    filterColumn: { type: 'string', description: 'Optional column title to filter on.' },
                    filterOperator: { type: 'string', description: 'One of "equals", "not_equals", "contains", "greater_than", "less_than", "is_empty", "is_not_empty". Defaults to "equals".' },
                    filterValue: { type: 'string', description: 'Value to compare against. Not needed for is_empty / is_not_empty.' }
                },
                required: ['tableId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tables_create_row',
            description: 'Append a row to a table — tableId is the table id or its exact title (e.g. "Facturen"). Pass values keyed by column title, e.g. {"Company": "Acme BV", "Status": "new"}.',
            parameters: {
                type: 'object',
                properties: {
                    tableId: { type: ['integer', 'string'], description: 'Table id (from nextcloud_tables_list) — or the exact table title, e.g. "Facturen", when the id is unknown.' },
                    values: { type: 'object', description: 'Object mapping column TITLE to value. Unknown titles are reported as an error rather than silently dropped.' }
                },
                required: ['tableId', 'values']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tables_update_row',
            description: 'Update values on an existing row. Only the columns you pass are changed.',
            parameters: {
                type: 'object',
                properties: {
                    tableId: { type: ['integer', 'string'], description: 'Table id (from nextcloud_tables_list) — or the exact table title, e.g. "Facturen", when the id is unknown.' },
                    rowId: { type: 'integer', description: 'Row id (from nextcloud_tables_list_rows).' },
                    values: { type: 'object', description: 'Object mapping column TITLE to the new value.' }
                },
                required: ['tableId', 'rowId', 'values']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tables_delete_row',
            description: 'Delete a single row from a table.',
            parameters: {
                type: 'object',
                properties: {
                    rowId: { type: 'integer', description: 'Row id to delete.' }
                },
                required: ['rowId']
            }
        }
    }
];

const HEADERS = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'OCS-APIRequest': 'true',
};

async function readJsonSafe(res) {
    const text = await res.text().catch(() => '');
    try { return JSON.parse(text); } catch { return text; }
}

/**
 * Shared response handling. The Tables app answers with a bare JSON body, but
 * a misrouted call can still come back inside an OCS envelope, so unwrap both.
 */
async function handle(res, authError, what, opts = {}) {
    // 401 is the connector/session itself. 403 is NOT: the Tables app answers
    // 403 for a table id that does not exist or belongs to someone else, and
    // reporting that as "the Bee Flow connector could not reach Nextcloud"
    // sent an automation author hunting a connection problem while every other
    // Nextcloud step in the same run was green (2026-09-12). Say which id, and
    // name the tool that hands out valid ones.
    if (res.status === 401) return { error: authError };
    if (res.status === 403) {
        return {
            error: opts.forbidden || `No access to this Nextcloud ${what}. It may not exist, or it belongs to another user — `
                + 'call nextcloud_tables_list to get the id of a table you can write to.',
        };
    }
    if (res.status === 404) {
        if (opts.missing) return { error: `No ${opts.missing} with that id exists (it may already be deleted).` };
        return { error: `Nextcloud Tables is not installed or the ${what} does not exist. Install the "Tables" app in Nextcloud to use these tools.` };
    }
    // Other failures go through the shared mapper: a 5xx body (raw SQL, the
    // table prefix) is never echoed, a 4xx shows only Nextcloud's own reason.
    if (!res.ok) return nextcloudHttpError(res, { authError, what: `Tables ${what}`, app: 'Tables' });
    const body = await readJsonSafe(res);
    return { ok: true, data: body?.ocs?.data ?? body };
}

/**
 * The table a call means. An id passes through; a title is looked up in the
 * user's table list and must match exactly one table (case-insensitively,
 * then by the same accent/punctuation-blind key column titles use). Every
 * miss is a soft error that lists what IS there, so an automation — or the
 * model building one — can correct itself. A title is what the user knows;
 * the id is what the API wants. Before this, a builder briefed with "the
 * table Facturen" had no way to find the id at build time and guessed 1.
 */
async function resolveTableId(api, ncFetch, authError, raw) {
    if (raw === undefined || raw === null || raw === '') {
        return { error: 'tableId is required — the table id from nextcloud_tables_list, or the exact table title (e.g. "Facturen").' };
    }
    if (typeof raw === 'number') {
        return Number.isInteger(raw) && raw > 0 ? { tableId: raw } : { error: `tableId ${raw} is not a valid table id.` };
    }
    if (typeof raw !== 'string') return { error: `tableId must be a table id or a table title, got ${JSON.stringify(raw)}.` };
    const title = raw.trim();
    if (/^\d+$/.test(title)) return { tableId: Number(title) };
    if (!title) return { error: 'tableId is required — the table id from nextcloud_tables_list, or the exact table title (e.g. "Facturen").' };
    const res = await ncFetch(`${api}/tables`, { headers: HEADERS });
    const out = await handle(res, authError, 'table list');
    if (out.error) return out;
    const tables = (Array.isArray(out.data) ? out.data : []).filter(t => t && t.id !== undefined);
    const lc = title.toLowerCase();
    let hits = tables.filter(t => String(t.title || '').trim().toLowerCase() === lc);
    if (!hits.length) {
        const key = normaliseColumnKey(title);
        if (key) hits = tables.filter(t => normaliseColumnKey(String(t.title || '')) === key);
    }
    if (hits.length === 1) return { tableId: hits[0].id, title: hits[0].title };
    const names = tables.map(t => `"${t.title}" (id ${t.id})`).join(', ') || '(none)';
    if (!hits.length) return { error: `No Nextcloud table called "${title}" is visible to this user. Tables: ${names}.` };
    return { error: `"${title}" matches ${hits.length} tables (${hits.map(t => `id ${t.id}`).join(', ')}) — pass the table id instead. Tables: ${names}.` };
}

// The tools whose `tableId` names the table they work on. update_row's
// tableId only resolves column titles, but a title there is just as valid.
const TABLE_SCOPED_TOOLS = new Set([
    'nextcloud_tables_update', 'nextcloud_tables_delete', 'nextcloud_tables_list_columns',
    'nextcloud_tables_create_column', 'nextcloud_tables_list_rows', 'nextcloud_tables_create_row',
    'nextcloud_tables_update_row',
]);

async function fetchColumns(api, ncFetch, authError, tableId) {
    const res = await ncFetch(`${api}/tables/${encodeURIComponent(tableId)}/columns`, { headers: HEADERS });
    const out = await handle(res, authError, 'column list', {
        forbidden: `Table ${tableId} is not accessible: it does not exist (was it deleted?) or belongs to another user. `
            + 'Call nextcloud_tables_list to get the id of a table you can use.',
    });
    if (out.error) return out;
    const columns = Array.isArray(out.data) ? out.data.map(mapColumn) : [];
    return { columns };
}

/**
 * Resolve a {title: value} map to the [{columnId, value}] shape the API wants.
 * An unknown title is an error, not a silent drop: an automation that quietly
 * discarded half of a form submission would look like it succeeded.
 */
/**
 * The Tables API takes `data` as an OBJECT keyed by column id — its controller
 * does `foreach ($data as $key => $value) { columnId = (int)$key }`. Handing it
 * the array of {columnId, value} pairs this function builds made PHP read the
 * ARRAY INDEX as the column id, so every write died on "Column with id 0 is
 * not part of table with id N" (found 2026-09-12, on Tables 34). Keep the pair
 * list internally — it is what mapRow and the error messages read — and shape
 * it at the wire.
 */
function toWireData(pairs) {
    const data = {};
    for (const { columnId, value } of pairs) data[String(columnId)] = value;
    return data;
}

/**
 * A column title as a matching key: lower-case, diacritics stripped, and every
 * character that is not a letter or digit dropped. "Excl. btw", "excl_btw",
 * "EXCL BTW" and "Excl.btw" all become "exclbtw". The AI that fills a row keys
 * it by the field names of ITS OWN extraction step (excl_btw, amount_total),
 * not by the table's titles; the harmless spelling differences should not fail
 * the row, and only those — "amount_total" does NOT become "Totaal". The
 * frontend's flow/settings/columnMatch.js mirrors this function exactly.
 */
function normaliseColumnKey(title) {
    return String(title ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

function resolveValues(values, columns) {
    const byTitle = new Map(columns.map(c => [String(c.title).toLowerCase(), c]));
    const byId = new Map(columns.map(c => [String(c.id), c]));
    // Normalised titles — but only where the normalised form is UNIQUE. Two
    // columns that collapse to the same key ("Btw" and "BTW.") are ambiguous,
    // and a guess there would write the value into the wrong column silently.
    const byNorm = new Map();
    const ambiguous = new Set();
    for (const c of columns) {
        const k = normaliseColumnKey(c.title);
        if (!k) continue;
        if (byNorm.has(k)) { ambiguous.add(k); continue; }
        byNorm.set(k, c);
    }
    const data = [];
    const unknown = [];
    const seenCols = new Set();
    for (const [key, value] of Object.entries(values || {})) {
        const norm = normaliseColumnKey(key);
        const col = byTitle.get(String(key).toLowerCase())
            || byId.get(String(key))
            || (norm && !ambiguous.has(norm) ? byNorm.get(norm) : null);
        if (!col) { unknown.push(key); continue; }
        if (seenCols.has(col.id)) {
            return { error: `Two keys in values map onto the same column "${col.title}" — send each column once.` };
        }
        seenCols.add(col.id);
        const wire = toWireValue(col, value);
        if ('error' in wire) return { error: wire.error };
        data.push({ columnId: col.id, value: wire.value });
    }
    if (unknown.length) {
        return {
            error: `Unknown column(s) in this table: ${unknown.join(', ')}. `
                + `Available columns: ${columns.map(c => c.title).join(', ') || '(none)'}. `
                + 'Keys are matched to column titles ignoring case, accents and punctuation — but not renamed: '
                + 'use the title as it appears in the table.',
        };
    }
    return { data };
}

/** Turn the API's columnId-keyed row data back into a title-keyed object. */
function mapRow(row, columns, { fillEmpty = false } = {}) {
    const colById = new Map(columns.map(c => [String(c.id), c]));
    const values = {};
    // Tables omits empty cells; a stable shape lets a caller bind every column.
    if (fillEmpty) for (const c of columns) values[c.title] = null;
    for (const cell of Array.isArray(row.data) ? row.data : []) {
        const col = colById.get(String(cell.columnId));
        if (col !== undefined) values[col.title] = fromWireValue(col, cell.value);
        else values[`column_${cell.columnId}`] = cell.value;
    }
    return {
        id: row.id,
        tableId: row.tableId,
        createdBy: row.createdBy ?? null,
        createdAt: row.createdAt ?? null,
        lastEditBy: row.lastEditBy ?? null,
        lastEditAt: row.lastEditAt ?? null,
        values,
    };
}

// Client-side row filtering. The Tables API expresses filters through saved
// views rather than query parameters, and creating a throwaway view per read
// would litter the user's table list. Rows are already capped at MAX_ROWS.
const FILTER_OPS = {
    equals: (a, b) => String(a ?? '') === b,
    not_equals: (a, b) => String(a ?? '') !== b,
    contains: (a, b) => String(a ?? '').toLowerCase().includes(b.toLowerCase()),
    greater_than: (a, b) => Number(a) > Number(b),
    less_than: (a, b) => Number(a) < Number(b),
    is_empty: (a) => a === null || a === undefined || String(a) === '',
    is_not_empty: (a) => !(a === null || a === undefined || String(a) === ''),
};

/**
 * The answer of a row write is the row as STORED, read back: the write
 * response echoes the request, so a number the column rounded (3.5 in a column
 * with no decimals) would be reported as sent. Differences are named.
 */
async function storedRow(api, ncFetch, written, columns, sentPairs) {
    let row = written;
    const warnings = [];
    if (written.id !== undefined) {
        const res = await ncFetch(`${api}/rows/${encodeURIComponent(written.id)}`, { headers: HEADERS });
        if (res.ok) {
            const body = await readJsonSafe(res);
            const fresh = body?.ocs?.data ?? body;
            if (fresh && typeof fresh === 'object' && Array.isArray(fresh.data)) row = fresh;
        } else {
            warnings.push('Could not re-read the stored row; values are as sent.');
        }
    }
    const mapped = mapRow(row, columns);
    for (const { columnId, value } of sentPairs) {
        const col = columns.find(c => String(c.id) === String(columnId));
        if (!col || columnKind(col) !== 'number' || typeof value !== 'number') continue;
        const cell = (Array.isArray(row.data) ? row.data : []).find(c => String(c.columnId) === String(columnId));
        if (cell && Number(cell.value) !== value) {
            warnings.push(`Column "${col.title}" stores ${col.numberDecimals ?? 0} decimals: ${value} was stored as ${cell.value}. `
                + 'Create the column with numberDecimals to keep more.');
        }
    }
    return warnings.length ? { success: true, row: mapped, warnings } : { success: true, row: mapped };
}

async function executeNextcloudTablesTool(toolName, args, userId, session) {
    const ctx = await ncClient.resolveAuth(session, userId);
    const { baseUrl, fetch: ncFetch, authError } = ctx;
    const api = `${baseUrl}${TABLES_API}`;

    // One resolution for every table-scoped tool: from here on `args.tableId`
    // is always the numeric id the API takes.
    if (TABLE_SCOPED_TOOLS.has(toolName)) {
        const table = await resolveTableId(api, ncFetch, authError, args && args.tableId);
        if (table.error) return table;
        args = { ...args, tableId: table.tableId };
    }

    switch (toolName) {
        case 'nextcloud_tables_list': {
            const res = await ncFetch(`${api}/tables`, { headers: HEADERS });
            const out = await handle(res, authError, 'table list');
            if (out.error) return out;
            const tables = Array.isArray(out.data) ? out.data.map(mapTable) : [];
            return { count: tables.length, tables };
        }

        case 'nextcloud_tables_create': {
            if (!args.title) return { error: 'title is required' };
            const payload = { title: args.title };
            if (args.emoji) payload.emoji = args.emoji;
            if (args.template) payload.template = args.template;
            const res = await ncFetch(`${api}/tables`, {
                method: 'POST', headers: HEADERS, body: JSON.stringify(payload),
            });
            const out = await handle(res, authError, 'table create');
            if (out.error) return out;
            return { success: true, table: mapTable(out.data || {}) };
        }

        case 'nextcloud_tables_update': {
            if (!args.tableId) return { error: 'tableId is required' };
            const payload = {};
            if (args.title !== undefined) payload.title = args.title;
            if (args.emoji !== undefined) payload.emoji = args.emoji;
            if (args.archived !== undefined) payload.archived = !!args.archived;
            if (!Object.keys(payload).length) {
                return { error: 'Nothing to update — pass at least one of title, emoji or archived.' };
            }
            const res = await ncFetch(`${api}/tables/${encodeURIComponent(args.tableId)}`, {
                method: 'PUT', headers: HEADERS, body: JSON.stringify(payload),
            });
            const out = await handle(res, authError, 'table update');
            if (out.error) return out;
            return { success: true, table: mapTable(out.data || {}) };
        }

        case 'nextcloud_tables_delete': {
            if (!args.tableId) return { error: 'tableId is required' };
            const res = await ncFetch(`${api}/tables/${encodeURIComponent(args.tableId)}`, {
                method: 'DELETE', headers: HEADERS,
            });
            const out = await handle(res, authError, 'table delete');
            if (out.error) return out;
            return { success: true, tableId: args.tableId };
        }

        case 'nextcloud_tables_list_columns': {
            if (!args.tableId) return { error: 'tableId is required' };
            const out = await fetchColumns(api, ncFetch, authError, args.tableId);
            if (out.error) return out;
            return { tableId: args.tableId, count: out.columns.length, columns: out.columns };
        }

        case 'nextcloud_tables_create_column': {
            if (!args.tableId) return { error: 'tableId is required' };
            if (!args.title) return { error: 'title is required' };
            const type = args.type || 'text';
            const payload = {
                title: args.title,
                type,
                subtype: args.subtype || (type === 'text' ? 'line' : ''),
                mandatory: !!args.mandatory,
                description: args.description || '',
            };
            if (type === 'selection' && Array.isArray(args.selectionOptions)) {
                payload.selectionOptions = JSON.stringify(
                    args.selectionOptions.map((label, i) => ({ id: i, label: String(label) }))
                );
            }
            if (type === 'number') {
                if (Number.isInteger(args.numberDecimals)) payload.numberDecimals = args.numberDecimals;
                if (args.numberPrefix) payload.numberPrefix = String(args.numberPrefix);
                if (args.numberSuffix) payload.numberSuffix = String(args.numberSuffix);
            }
            const res = await ncFetch(`${api}/tables/${encodeURIComponent(args.tableId)}/columns`, {
                method: 'POST', headers: HEADERS, body: JSON.stringify(payload),
            });
            const out = await handle(res, authError, 'column create');
            if (out.error) return out;
            return { success: true, column: mapColumn(out.data || {}) };
        }

        case 'nextcloud_tables_delete_column': {
            if (!args.columnId) return { error: 'columnId is required' };
            const res = await ncFetch(`${api}/columns/${encodeURIComponent(args.columnId)}`, {
                method: 'DELETE', headers: HEADERS,
            });
            const out = await handle(res, authError, 'column delete', { missing: 'column' });
            if (out.error) return out;
            return { success: true, columnId: args.columnId };
        }

        case 'nextcloud_tables_list_rows': {
            if (!args.tableId) return { error: 'tableId is required' };
            const cols = await fetchColumns(api, ncFetch, authError, args.tableId);
            if (cols.error) return cols;

            const limit = Math.min(Math.max(args.limit || DEFAULT_ROWS, 1), MAX_ROWS);
            // Ask for one row more than we return: that extra row is the proof
            // there is more, so exactly `limit` rows is not reported as cut off.
            const params = new URLSearchParams({ limit: String(limit + 1) });
            if (args.offset) params.set('offset', String(args.offset));
            const res = await ncFetch(
                `${api}/tables/${encodeURIComponent(args.tableId)}/rows?${params.toString()}`,
                { headers: HEADERS },
            );
            const out = await handle(res, authError, 'row list');
            if (out.error) return out;

            const fetched = Array.isArray(out.data) ? out.data : [];
            const truncated = fetched.length > limit;
            let rows = fetched.slice(0, limit).map(r => mapRow(r, cols.columns, { fillEmpty: true }));

            if (args.filterColumn) {
                const op = args.filterOperator || 'equals';
                const fn = FILTER_OPS[op];
                if (!fn) {
                    return { error: `Unknown filterOperator "${op}". Use one of: ${Object.keys(FILTER_OPS).join(', ')}.` };
                }
                const known = cols.columns.find(c => String(c.title).toLowerCase() === String(args.filterColumn).toLowerCase());
                if (!known) {
                    return { error: `Unknown filterColumn "${args.filterColumn}". Available: ${cols.columns.map(c => c.title).join(', ') || '(none)'}.` };
                }
                rows = rows.filter(r => fn(r.values[known.title], String(args.filterValue ?? '')));
            }

            return {
                tableId: args.tableId,
                count: rows.length,
                // Say so when the cap bit, rather than letting an automation treat
                // a truncated page as the whole table.
                truncated,
                columns: cols.columns.map(c => c.title),
                rows,
            };
        }

        case 'nextcloud_tables_create_row': {
            if (!args.tableId) return { error: 'tableId is required' };
            if (!args.values || typeof args.values !== 'object') return { error: 'values must be an object mapping column titles to values' };
            const cols = await fetchColumns(api, ncFetch, authError, args.tableId);
            if (cols.error) return cols;
            const resolved = resolveValues(args.values, cols.columns);
            if (resolved.error) return resolved;
            const res = await ncFetch(`${api}/tables/${encodeURIComponent(args.tableId)}/rows`, {
                method: 'POST', headers: HEADERS, body: JSON.stringify({ data: toWireData(resolved.data) }),
            });
            const out = await handle(res, authError, 'row create');
            if (out.error) return out;
            return storedRow(api, ncFetch, out.data || {}, cols.columns, resolved.data);
        }

        case 'nextcloud_tables_update_row': {
            if (!args.tableId) return { error: 'tableId is required' };
            if (!args.rowId) return { error: 'rowId is required' };
            if (!args.values || typeof args.values !== 'object') return { error: 'values must be an object mapping column titles to values' };
            const cols = await fetchColumns(api, ncFetch, authError, args.tableId);
            if (cols.error) return cols;
            const resolved = resolveValues(args.values, cols.columns);
            if (resolved.error) return resolved;
            const res = await ncFetch(`${api}/rows/${encodeURIComponent(args.rowId)}`, {
                method: 'PUT', headers: HEADERS, body: JSON.stringify({ data: toWireData(resolved.data) }),
            });
            const out = await handle(res, authError, 'row update', { missing: 'row' });
            if (out.error) return out;
            return storedRow(api, ncFetch, out.data || {}, cols.columns, resolved.data);
        }

        case 'nextcloud_tables_delete_row': {
            if (!args.rowId) return { error: 'rowId is required' };
            const res = await ncFetch(`${api}/rows/${encodeURIComponent(args.rowId)}`, {
                method: 'DELETE', headers: HEADERS,
            });
            const out = await handle(res, authError, 'row delete', { missing: 'row' });
            if (out.error) return out;
            return { success: true, rowId: args.rowId };
        }

        default:
            return { error: `Unknown Nextcloud Tables tool: ${toolName}` };
    }
}

function isNextcloudTablesTool(toolName) {
    return typeof toolName === 'string' && toolName.startsWith('nextcloud_tables_');
}

module.exports = {
    resolveTableId,
    TABLE_SCOPED_TOOLS,
    normaliseColumnKey,
    resolveValues,
    NEXTCLOUD_TABLES_TOOLS,
    executeNextcloudTablesTool,
    isNextcloudTablesTool,
    // Shared with the mirror engine (core/dataEngine/sources/nextcloudTable):
    // one API prefix, one header set, one wire shape for row data.
    TABLES_API,
    HEADERS,
    toWireData,
    mapTable,
    mapColumn,
    describeColumn,
    readJsonSafe,
    // exported for tests
    mapRow,
};
