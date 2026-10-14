/**
 * extractFormState for the data nodes: set, parse_json, datetime, the
 * collection ops, data tables and knowledge-base writes.
 */
import { impliedListMode } from '../../../datetimeTarget';
import { flattenDraft } from '../../flattenEditorModel';
import type { FormRecord, TypeExtractor } from '../types';

// Collection ops all expose the optional input cap (C19 — `maxItems` was
// read by the runner and validated by the server but editable only via
// the raw JSON view). '' = unset.
const readMaxItems = (step: FormRecord): number | '' => (typeof step.maxItems === 'number' ? step.maxItems : '');

export const dataExtractors: Record<string, TypeExtractor> = {
    // n8n-style utility nodes
    set: (step, base) => ({
        ...base,
        fields: step.fields || {},
        forEach: step.forEach || null,
        // null = single mode; a string ('' allowed = source not picked yet) =
        // list mode. Mirrors the switch presence convention (routeModel.js) —
        // the mode is never stored, only derived from the key being there.
        arrayRef: typeof step.arrayRef === 'string' ? step.arrayRef : null,
        maxItems: typeof step.maxItems === 'number' ? step.maxItems : '',
        operations: Array.isArray(step.operations) ? step.operations : [],
    }),
    parse_json: (step, base) => ({
        ...base,
        sourceRef: step.sourceRef || '',
        itemsRef: step.itemsRef || '',
        mode: step.mode === 'ai' ? 'ai' : 'paths',
        fields: Array.isArray(step.fields) ? step.fields : [],
    }),
    datetime: (step, base) => {
        // A whole column saved in "Input date" without `arrayRef` runs as
        // list mode (BFSF-375), so the editor opens it as list mode too.
        const dt: FormRecord = { ...step, ...impliedListMode(step) };
        return {
            ...base,
            op: dt.op || 'now',
            input: dt.input || '',
            input2: dt.input2 || '',
            amount: typeof dt.amount === 'number' ? dt.amount : 0,
            format: dt.format || 'yyyy-MM-dd HH:mm',
            part: dt.part || 'year',
            unit: dt.unit || 'days',
            // `null` = single date, a string (even '') = list mode. Same
            // present-or-absent convention the set node uses for its own switch.
            arrayRef: typeof dt.arrayRef === 'string' ? dt.arrayRef : null,
            target: dt.target || '',
        };
    },
    // Collection ops: the optional input cap rides along on every one (readMaxItems).
    limit: (step, base) => ({ ...base, arrayRef: step.arrayRef || '', count: typeof step.count === 'number' ? step.count : 10, mode: step.mode || 'first', maxItems: readMaxItems(step) }),
    dedupe: (step, base) => ({ ...base, arrayRef: step.arrayRef || '', keyField: step.keyField || '', maxItems: readMaxItems(step) }),
    flatten: (step, base) => ({ ...base, ...flattenDraft(step), maxItems: readMaxItems(step) }),
    aggregate: (step, base) => ({ ...base, arrayRef: step.arrayRef || '', field: step.field || '', maxItems: readMaxItems(step) }),
    summarize: (step, base) => ({ ...base, arrayRef: step.arrayRef || '', field: step.field || '', op: step.op || 'sum', maxItems: readMaxItems(step) }),
    // `where` and `values` are cloned, not shared: the editor edits the draft in
    // place, and handing it the saved step's own arrays would mutate the
    // definition before anyone pressed save.
    datatable: (step, base) => {
        return {
            ...base,
            // Carried since K10. Without it the editor's Iteration toggle read
            // as OFF on a step that had one, and the first save dropped it.
            forEach: step.forEach || null,
            datatableId: step.datatableId || '',
            op: step.op || 'find_rows',
            where: Array.isArray(step.where) ? step.where.map(w => ({ ...w })) : [],
            values: (step.values && typeof step.values === 'object' && !Array.isArray(step.values)) ? { ...step.values } : {},
            matchColumn: step.matchColumn || '',
            limit: typeof step.limit === 'number' ? step.limit : 50,
        };
    },
    knowledge_write: (step, base) => {
        // All three are `{{…}}` template STRINGS, the shape TemplateField edits
        // and the shape the runner interpolates — never binding objects.
        return {
            ...base,
            forEach: step.forEach || null,
            knowledgeBaseId: step.knowledgeBaseId || '',
            title: typeof step.title === 'string' ? step.title : '',
            content: typeof step.content === 'string' ? step.content : '',
            sourceUri: typeof step.sourceUri === 'string' ? step.sourceUri : '',
            nearDuplicateStrategy: step.nearDuplicateStrategy || 'skip',
        };
    },
};
