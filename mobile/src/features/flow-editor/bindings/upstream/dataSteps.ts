/**
 * The steps that read or write Bee Flow's OWN stores: a datatable and a
 * knowledge base. Both samples are synthesised from what is DECLARED — never
 * from real rows, which would put customer data into a portable definition.
 * Port of agent-hub `Builder/mapping/upstream/dataSteps.js`.
 */

import { translate as t } from '@/core/i18n';
import { nodeDefaultLabel } from '@/features/flow-editor/model/nodeDefs';

import type { Catalog, FlowNode, VariableGroup } from '../types';
import { stepGroup } from './sampleFields';

const COLUMN_SAMPLE: Record<string, unknown> = {
    text: 'text', richtext: 'text', select: 'option', multiselect: ['option'],
    number: 0, bool: true, date: '2026-01-31', datetime: '2026-01-31T09:00:00Z',
    relation: 'rec_…', file: { name: 'file.pdf' }, computed: 'value',
};

// Example payload value (data, not copy): the title a written document reports.
const EXAMPLE_DOCUMENT_TITLE = 'Untitled';

type Table = NonNullable<Catalog['datatables']>[number];

/** The row id a MIRROR shows: Nextcloud's own ids, or a sheet's `r<row>`. */
function sourceRowIdSample(table: Table | null): string | null {
    if (table?.managedKind === 'nextcloud_table') return '7';
    if (table?.managedKind === 'spreadsheet_file') return 'r12';
    return null;
}

function columnSample(type: unknown, sourceRowId: string | null): unknown {
    if (sourceRowId && type === 'relation') return sourceRowId;
    return typeof type === 'string' && Object.hasOwn(COLUMN_SAMPLE, type) ? COLUMN_SAMPLE[type] : 'value';
}

function sampleForOp(op: string, row: Record<string, unknown>): Record<string, unknown> {
    // `returned` is how many rows THIS page holds, not how many match.
    if (op === 'find_rows') return { rows: [row], returned: 0, found: false, hasMore: false, nextCursor: '' };
    if (op === 'count_rows') return { count: 0, found: false };
    if (op === 'update_rows') return { updated: 0, truncated: false };
    if (op === 'delete_rows') return { deleted: 0, truncated: false };
    return { row, id: 'rec_…', created: true, updated: 0 };
}

/** What a datatable step hands downstream, from the table's DECLARED columns. */
export function describeDatatable(node: FlowNode, catalog: Catalog | null | undefined): VariableGroup {
    const table = (catalog?.datatables || []).find((tb) => tb.id === node.datatableId) || null;
    const sourceRowId = sourceRowIdSample(table);
    const row: Record<string, unknown> = {};
    for (const c of table?.columns || []) row[c.key] = columnSample(c.type, sourceRowId);
    row.id = sourceRowId || 'rec_…';
    row.created_at = '2026-01-31T09:00:00Z';
    const label = node.label || (table ? table.name : nodeDefaultLabel('datatable', t));
    return stepGroup(node, { label: label as string, kind: 'datatable' }, sampleForOp((node.op as string) || 'find_rows', row));
}

/**
 * What a knowledge-write step hands downstream. `refreshed` (the same source
 * replaced its own earlier document) and `written` (false on the one
 * non-failing refusal) are why this step has a group at all.
 */
export function describeKnowledgeWrite(node: FlowNode, catalog: Catalog | null | undefined): VariableGroup {
    const base = (catalog?.knowledgeBases || []).find((b) => b.id === node.knowledgeBaseId) || null;
    const sample = {
        written: true,
        knowledgeBaseId: node.knowledgeBaseId || 'kb_…',
        documentId: 'doc_…',
        chunks: 0,
        refreshed: false,
        deduped: false,
        sourceUri: node.sourceUri || '',
        title: EXAMPLE_DOCUMENT_TITLE,
    };
    const label = node.label || (base ? base.name : nodeDefaultLabel('knowledge_write', t));
    return stepGroup(node, { label: label as string, kind: 'knowledge_write' }, sample);
}

/**
 * The table a table step hands on, as it looks BEFORE any run: a placeholder
 * (`dry-run`, no run id), so nothing mistakes it for a stored table.
 */
function tableHandleSample(name: string) {
    return {
        kind: 'table', tableId: 'dry-run', runId: null, name, columns: [], rowCount: 0,
        preview: [], expiresAt: null, provenance: null,
    };
}

/**
 * What a Read table step hands downstream: the first sheet as `table`, every
 * sheet in `tables` and by name in `tablesByName`, plus facts about the file.
 */
export function describeReadTable(node: FlowNode): VariableGroup {
    const handle = tableHandleSample('Sheet1');
    const sample = {
        table: handle,
        tables: [handle],
        tablesByName: { Sheet1: handle },
        sheets: [{ name: 'Sheet1', index: 0, hidden: false, rowCount: 0, columnCount: 0, tableIndex: 0 }],
        provenance: null,
        source: { filename: 'file.xlsx', format: 'xlsx', size: 0 },
        warnings: [],
    };
    return stepGroup(node, { label: (node.label as string) || nodeDefaultLabel('read_table', t), kind: 'read_table' }, sample);
}

/**
 * What an Edit table step hands downstream: the table itself, its size and
 * columns, and the rows and a text version of them when the table is small.
 */
export function describeTable(node: FlowNode): VariableGroup {
    const label = (node.label as string) || nodeDefaultLabel('table', t);
    const sample = {
        table: tableHandleSample(label),
        rowCount: 0,
        columns: [],
        rows: [],
        markdown: '',
        opStats: [],
        warnings: [],
    };
    return stepGroup(node, { label, kind: 'table' }, sample);
}
