/**
 * The steps that read or write Bee Flow's OWN stores: a datatable and a
 * knowledge base.
 *
 * Both synthesise their sample from what is DECLARED — the table's column
 * types, the step's own settings — never from real rows. The picker has to be
 * populated before the step has ever run, and a sample drawn from real rows
 * would put customer data into the definition, which is a portable document.
 */
import { groupLabel } from './env.mjs';
import { stepGroup } from './sampleFields.mjs';

/**
 * What a datatable step hands downstream.
 *
 * The sample is synthesised from the table's DECLARED COLUMN TYPES, never from
 * real rows. Two reasons, and they happen to be the same fix: the picker has to
 * be populated before the step has ever run (otherwise the author cannot bind
 * to it while building), and a sample drawn from real rows would put customer
 * data into the definition, which is a portable document.
 */
const COLUMN_SAMPLE = {
    text: 'text', richtext: 'text', select: 'option', multiselect: ['option'],
    number: 0, bool: true, date: '2026-01-31', datetime: '2026-01-31T09:00:00Z',
    relation: 'rec_…', file: { name: 'file.pdf' }, computed: 'value',
};

/**
 * The row id a MIRROR sample shows. A Nextcloud mirror stores its rows under
 * Nextcloud's own row ids (a number); a spreadsheet mirror under the sheet's
 * key value, or `r<row number>` when it has no key column — the `r` is what
 * keeps a routine from ever mistaking one for a count. Null for an ordinary
 * table, whose ids are the platform's own.
 */
function sourceRowIdSample(table) {
    if (table?.managedKind === 'nextcloud_table') return '7';
    if (table?.managedKind === 'spreadsheet_file') return 'r12';
    return null;
}

export function describeDatatable(node, catalog, env) {
    const table = (catalog?.datatables || []).find(t => t.id === node.datatableId) || null;
    const sourceRowId = sourceRowIdSample(table);
    const row = {};
    for (const c of (table?.columns || [])) {
        row[c.key] = Object.hasOwn(COLUMN_SAMPLE, c.type) ? COLUMN_SAMPLE[c.type] : 'value';
        // A mirror's relation columns hold the SOURCE's row id of the linked
        // row — for a Nextcloud mirror bindable straight into a
        // nextcloud_tables_update_row step.
        if (sourceRowId && c.type === 'relation') row[c.key] = sourceRowId;
    }
    // System columns every row carries, so `created_at` is bindable too.
    row.id = sourceRowId || 'rec_…';
    row.created_at = '2026-01-31T09:00:00Z';

    const op = node.op || 'find_rows';
    let sample;
    // `returned` is how many rows THIS PAGE holds; `nextCursor` is what a later
    // find_rows step feeds its `cursor` to reach the next one. The old name
    // `count` is deliberately NOT offered here any more — it reads as "how many
    // rows match" and never was (it is clamped by the page size), so a
    // condition on `count > 100` after a page of 50 could never fire. It still
    // resolves at run time for one release; count_rows answers the real
    // question.
    if (op === 'find_rows') {
        sample = { rows: [row], returned: 0, found: false, hasMore: false, nextCursor: '' };
    } else if (op === 'count_rows') sample = { count: 0, found: false };
    else if (op === 'update_rows') sample = { updated: 0, truncated: false };
    else if (op === 'delete_rows') sample = { deleted: 0, truncated: false };
    // `id` at the top level as well as inside `row`: an add/save is almost
    // always followed by a step that needs the id of the row just written, and
    // reaching for it through `row` is one indirection nobody guesses.
    else sample = { row, id: 'rec_…', created: true, updated: 0 };

    const label = node.label || (table ? table.name : groupLabel(env, 'node.datatable', 'Datatable'));
    return stepGroup(node, label, 'datatable', sample);
}

/**
 * What a knowledge-write step hands downstream.
 *
 * `refreshed` is the field worth binding to, and the reason this step gets a
 * group at all: it is TRUE when the same source reference replaced its own
 * earlier document and FALSE when a new one was added. "Only tell me about
 * genuinely new articles" is the commonest thing to build after this step, and
 * without the field it cannot be expressed.
 *
 * `written` is false on the one non-failing refusal: the run's identity may no
 * longer write to that base. It is a skip, not an error, so a branch that cares
 * has to be able to see it.
 */
export function describeKnowledgeWrite(node, catalog, env) {
    const base = (catalog?.knowledgeBases || []).find(b => b.id === node.knowledgeBaseId) || null;
    const sample = {
        written: true,
        knowledgeBaseId: node.knowledgeBaseId || 'kb_…',
        documentId: 'doc_…',
        chunks: 0,
        refreshed: false,
        deduped: false,
        sourceUri: node.sourceUri || '',
        title: 'Untitled',
    };
    const label = node.label || (base ? base.name : groupLabel(env, 'node.knowledge_write', 'To knowledge base'));
    return stepGroup(node, label, 'knowledge_write', sample);
}
