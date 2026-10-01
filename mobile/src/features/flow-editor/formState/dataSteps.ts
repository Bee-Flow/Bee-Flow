/**
 * Drafts and patches for the data steps: Edit data (set), Parse JSON, Date &
 * Time, the collection ops, a datatable and a knowledge base. From agent-hub
 * `Builder/flow/settings/formState.js`; pinned by formState.lockstep.test.ts.
 */

import { applyForEachPatch, applyMaxItemsPatch, sanitizeFieldMap } from './common';
import { sanitizeOperations, sanitizeParseJsonFields } from './operations';
import { num, or, plainCopy, strOr, trimmedOr } from './read';
import type { Extractor, FormDraft, Patcher } from './types';

// ── Edit data ──────────────────────────────────────────────────────────

/** `null` = single mode; a string ('' = source not picked yet) = list mode. */
export const extractSet: Extractor = (step, base) => ({
    ...base,
    fields: or(step.fields, {}),
    forEach: or(step.forEach, null),
    repeat: or(step.repeat, null),
    arrayRef: strOr(step.arrayRef, null),
    maxItems: num(step.maxItems, ''),
    operations: Array.isArray(step.operations) ? step.operations : [],
});

export const patchSet: Patcher = (patch, step, draft) => {
    patch.fields = sanitizeFieldMap(or(draft.fields, {}));
    if (typeof draft.arrayRef === 'string') {
        // LIST MODE — the key's presence is the mode; forEach and list mode exclude each other.
        patch.arrayRef = draft.arrayRef;
        applyMaxItemsPatch(patch, draft);
        const ops = sanitizeOperations(draft.operations);
        patch.operations = ops.length ? ops : undefined;
        if (step.forEach) patch.forEach = null;
        if (step.repeat) patch.repeat = null;
    } else {
        // SINGLE MODE — undefined deletes the list-mode keys after the merge.
        patch.arrayRef = undefined;
        patch.operations = undefined;
        patch.maxItems = undefined;
        applyForEachPatch(patch, step, draft);
    }
};

// ── Parse JSON ─────────────────────────────────────────────────────────

export const extractParseJson: Extractor = (step, base) => ({
    ...base,
    sourceRef: or(step.sourceRef, ''),
    itemsRef: or(step.itemsRef, ''),
    mode: step.mode === 'ai' ? 'ai' : 'paths',
    fields: Array.isArray(step.fields) ? step.fields : [],
});

export const patchParseJson: Patcher = (patch, _step, draft) => {
    patch.sourceRef = or(draft.sourceRef, '');
    patch.itemsRef = or(draft.itemsRef, '');
    patch.mode = draft.mode === 'ai' ? 'ai' : 'paths';
    patch.fields = sanitizeParseJsonFields(draft.fields);
};

// ── Date & Time ────────────────────────────────────────────────────────

export const extractDateTime: Extractor = (step, base) => ({
    ...base,
    op: or(step.op, 'now'),
    input: or(step.input, ''),
    input2: or(step.input2, ''),
    amount: num(step.amount, 0),
    format: or(step.format, 'yyyy-MM-dd HH:mm'),
    part: or(step.part, 'year'),
    unit: or(step.unit, 'days'),
    // `null` = one date, a string (even '') = list mode.
    arrayRef: strOr(step.arrayRef, null),
    target: or(step.target, ''),
});

export const patchDateTime: Patcher = (patch, _step, draft) => {
    const listMode = typeof draft.arrayRef === 'string';
    patch.op = or(draft.op, 'now');
    patch.input = draft.input || undefined;
    patch.input2 = draft.input2 || undefined;
    patch.amount = num(draft.amount, undefined);
    patch.format = draft.format || undefined;
    patch.part = draft.part || undefined;
    patch.unit = draft.unit || undefined;
    // undefined REMOVES the key, which is how the step leaves list mode.
    patch.arrayRef = listMode ? draft.arrayRef : undefined;
    patch.target = listMode ? draft.target || undefined : undefined;
};

// ── Collection ops: all carry the optional input cap (C19) ─────────────

const cap = (step: FormDraft) => num(step.maxItems, '');

export const extractLimit: Extractor = (step, base) => ({
    ...base, arrayRef: or(step.arrayRef, ''), count: num(step.count, 10), mode: or(step.mode, 'first'), maxItems: cap(step),
});
export const patchLimit: Patcher = (patch, _step, draft) => {
    patch.arrayRef = or(draft.arrayRef, '');
    patch.count = Math.max(0, Math.floor(Number(draft.count) || 0));
    patch.mode = draft.mode === 'last' ? 'last' : 'first';
    applyMaxItemsPatch(patch, draft);
};

export const extractDedupe: Extractor = (step, base) => ({
    ...base, arrayRef: or(step.arrayRef, ''), keyField: or(step.keyField, ''), maxItems: cap(step),
});
export const patchDedupe: Patcher = (patch, _step, draft) => {
    patch.arrayRef = or(draft.arrayRef, '');
    patch.keyField = trimmedOr(draft.keyField, undefined);
    applyMaxItemsPatch(patch, draft);
};

export const extractAggregate: Extractor = (step, base) => ({
    ...base, arrayRef: or(step.arrayRef, ''), field: or(step.field, ''), maxItems: cap(step),
});
export const patchAggregate: Patcher = (patch, _step, draft) => {
    patch.arrayRef = or(draft.arrayRef, '');
    patch.field = or(draft.field, '');
    applyMaxItemsPatch(patch, draft);
};

export const extractSummarize: Extractor = (step, base) => ({
    ...base, arrayRef: or(step.arrayRef, ''), field: or(step.field, ''), op: or(step.op, 'sum'), maxItems: cap(step),
});
export const patchSummarize: Patcher = (patch, _step, draft) => {
    patch.arrayRef = or(draft.arrayRef, '');
    patch.field = or(draft.field, '');
    patch.op = or(draft.op, 'sum');
    applyMaxItemsPatch(patch, draft);
};

// ── Datatable / knowledge base ─────────────────────────────────────────

/** `where` and `values` are CLONED — the editor edits the draft in place. */
export const extractDatatable: Extractor = (step, base) => ({
    ...base,
    forEach: or(step.forEach, null),
    repeat: or(step.repeat, null),
    datatableId: or(step.datatableId, ''),
    op: or(step.op, 'find_rows'),
    where: Array.isArray(step.where) ? step.where.map((w) => ({ ...w })) : [],
    values: plainCopy(step.values),
    matchColumn: or(step.matchColumn, ''),
    limit: num(step.limit, 50),
});

export const patchDatatable: Patcher = (patch, step, draft) => {
    patch.datatableId = or(draft.datatableId, '');
    patch.op = or(draft.op, 'find_rows');
    // A half-written condition (no column) is noise, not feedback.
    patch.where = (Array.isArray(draft.where) ? draft.where : []).filter((w) => w && w.field);
    // An empty binding means "leave this column alone", not "write blank".
    const vals = draft.values && typeof draft.values === 'object' ? (draft.values as object) : {};
    patch.values = Object.fromEntries(Object.entries(vals).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    patch.matchColumn = or(draft.matchColumn, '');
    if (typeof draft.limit === 'number' && Number.isFinite(draft.limit)) patch.limit = draft.limit;
    applyForEachPatch(patch, step, draft);
};

/** A text field as the form keeps it: a string, or a compose binding; anything else as ''. */
function textOrCompose(v: unknown): unknown {
    if (typeof v === 'string') return v;
    return v && typeof v === 'object' && (v as { kind?: unknown }).kind === 'compose' ? v : '';
}

/**
 * All three are texts the runner renders: a `{{…}}` template string or a
 * compose (the AI builder writes one). Any other binding object opens empty.
 */
export const extractKnowledgeWrite: Extractor = (step, base) => ({
    ...base,
    forEach: or(step.forEach, null),
    repeat: or(step.repeat, null),
    knowledgeBaseId: or(step.knowledgeBaseId, ''),
    title: textOrCompose(step.title),
    content: textOrCompose(step.content),
    sourceUri: textOrCompose(step.sourceUri),
    nearDuplicateStrategy: or(step.nearDuplicateStrategy, 'skip'),
});

export const patchKnowledgeWrite: Patcher = (patch, step, draft) => {
    patch.knowledgeBaseId = or(draft.knowledgeBaseId, '');
    patch.title = or(draft.title, '');
    patch.content = or(draft.content, '');
    patch.sourceUri = or(draft.sourceUri, '');
    // 'skip' is the default and stays OFF the step, as the AI builder writes it.
    const strategy = draft.nearDuplicateStrategy;
    patch.nearDuplicateStrategy = strategy && strategy !== 'skip' ? strategy : undefined;
    applyForEachPatch(patch, step, draft);
};
