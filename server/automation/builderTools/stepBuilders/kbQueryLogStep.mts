/**
 * The builder for `kb_query_log`: read or review a knowledge base's query log (Enterprise).
 *
 * One step type with an `op` (like `datatable`): `list` returns { rows, total, count }, `review`
 * sets the review status and note of one entry. Every text field is a `{{…}}` template STRING, the
 * shape `knowledge_write` uses, and a binding object is flattened back to one.
 *
 * Pure and DB-free like every builder: the knowledge base (the automation OWNER must manage it) and
 * the licence are checked at save and activate (core/kb/automationKbCheck) and again on every run
 * (core/automationRunner/execKbQueryLog.mts).
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
type Obj = Record<string, any>;
const { newId, appendAfter } = nodeRequire('../draftGraph') as { newId: (p: string) => string; appendAfter: (draft: Obj, after: unknown, step: Obj, o: Obj) => void };
const { bindingToTemplate } = nodeRequire('./inputBindings') as { bindingToTemplate: (v: unknown) => string };

export const KB_QUERY_LOG_OPS = ['list', 'review'];
const OPS = KB_QUERY_LOG_OPS;
export const KB_QUERY_LOG_FILTER_KEYS = ['from', 'to', 'userId', 'channel', 'outcome', 'status'];
export const KB_QUERY_LOG_MAX_LIMIT = 200;
const MAX_LIMIT = KB_QUERY_LOG_MAX_LIMIT;
const FILTER_KEYS = KB_QUERY_LOG_FILTER_KEYS;

function listFields(args: Obj): { fields: Obj } | { error: string } {
    const out: Obj = {};
    const filters: Record<string, string> = {};
    const given = args.filters && typeof args.filters === 'object' && !Array.isArray(args.filters) ? args.filters : {};
    for (const k of FILTER_KEYS) {
        const v = bindingToTemplate(given[k]);
        if (v) filters[k] = v;
    }
    if (Object.keys(filters).length) out.filters = filters;
    if (args.limit !== undefined) {
        const n = Math.floor(Number(args.limit));
        if (!Number.isFinite(n) || n < 1) return { error: `limit must be a whole number from 1 to ${MAX_LIMIT}.` };
        out.limit = Math.min(n, MAX_LIMIT);
    }
    if (args.resultDetail === 'summary') out.resultDetail = 'summary';
    return { fields: out };
}

export function applyAddKbQueryLog(draft: Obj, args: Obj): { error: string } | { added: Obj } {
    const op = args.op === undefined ? 'list' : args.op;
    if (!OPS.includes(op)) return { error: `op must be one of ${OPS.join(', ')}.` };
    const extra = op === 'list'
        ? listFields(args)
        : { fields: { entryId: bindingToTemplate(args.entryId), status: bindingToTemplate(args.status), note: bindingToTemplate(args.note) } };
    if ('error' in extra) return { error: extra.error };
    const step = {
        id: newId('kql'),
        type: 'kb_query_log',
        label: args.label || 'Knowledge base query log',
        op,
        knowledgeBaseId: typeof args.knowledgeBaseId === 'string' ? args.knowledgeBaseId.trim() : '',
        ...extra.fields,
    };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName, splice: args.splice === true });
    return { added: step };
}
