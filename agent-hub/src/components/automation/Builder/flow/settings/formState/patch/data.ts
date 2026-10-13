/**
 * buildPatch for the data nodes: set, parse_json, datetime, the collection
 * ops, data tables and knowledge-base writes.
 */
import { sanitizeFieldMap } from '../bindings';
import { sanitizeOperations, sanitizeParseJsonFields } from '../dataNodeRows';
import { flattenPatch } from '../../flattenEditorModel';
import { applyForEachPatch, applyMaxItemsPatch } from '../stepOptions';
import type { TypePatcher } from '../types';

export const dataPatchers: Record<string, TypePatcher> = {
    // n8n-style utility nodes
    set: (patch, step, draft) => {
        patch.fields = sanitizeFieldMap(draft.fields || {});
        if (typeof draft.arrayRef === 'string') {
            // LIST MODE — the key's presence is the mode, so it's always sent.
            patch.arrayRef = draft.arrayRef;
            applyMaxItemsPatch(patch, draft);
            const ops = sanitizeOperations(draft.operations);
            patch.operations = ops.length ? ops : undefined;
            // Mutually exclusive with forEach (the validator errors on both);
            // an explicit null clears a legacy per-item setting on save.
            if (step.forEach) patch.forEach = null;
        } else {
            // SINGLE MODE — explicit undefined deletes the list-mode keys
            // after the patch-merge + JSON round-trip (the writeRoute idiom);
            // the changed-keys diff below drops the no-ops.
            patch.arrayRef = undefined;
            patch.operations = undefined;
            patch.maxItems = undefined;
            applyForEachPatch(patch, step, draft); // C16 — runner+validator allow it
        }
    },
    parse_json: (patch, step, draft) => {
        patch.sourceRef = draft.sourceRef || '';
        patch.itemsRef = draft.itemsRef || '';
        patch.mode = draft.mode === 'ai' ? 'ai' : 'paths';
        patch.fields = sanitizeParseJsonFields(draft.fields);
    },
    datetime: (patch, step, draft) => {
        patch.op = draft.op || 'now';
        patch.input = draft.input || undefined;
        patch.input2 = draft.input2 || undefined;
        patch.amount = typeof draft.amount === 'number' ? draft.amount : undefined;
        patch.format = draft.format || undefined;
        patch.part = draft.part || undefined;
        patch.unit = draft.unit || undefined;
        // undefined REMOVES the key, which is how the step leaves list mode.
        patch.arrayRef = typeof draft.arrayRef === 'string' ? draft.arrayRef : undefined;
        patch.target = typeof draft.arrayRef === 'string' ? (draft.target || undefined) : undefined;
    },
    limit: (patch, step, draft) => {
        patch.arrayRef = draft.arrayRef || '';
        patch.count = Math.max(0, Math.floor(Number(draft.count) || 0));
        patch.mode = draft.mode === 'last' ? 'last' : 'first';
        applyMaxItemsPatch(patch, draft);
    },
    dedupe: (patch, step, draft) => {
        patch.arrayRef = draft.arrayRef || '';
        patch.keyField = draft.keyField?.trim() ? draft.keyField.trim() : undefined;
        applyMaxItemsPatch(patch, draft);
    },
    flatten: (patch, step, draft) => {
        Object.assign(patch, flattenPatch(draft));
        applyMaxItemsPatch(patch, draft);
    },
    aggregate: (patch, step, draft) => {
        patch.arrayRef = draft.arrayRef || '';
        patch.field = draft.field || '';
        applyMaxItemsPatch(patch, draft);
    },
    summarize: (patch, step, draft) => {
        patch.arrayRef = draft.arrayRef || '';
        patch.field = draft.field || '';
        patch.op = draft.op || 'sum';
        applyMaxItemsPatch(patch, draft);
    },
    datatable: (patch, step, draft) => {
        patch.datatableId = draft.datatableId || '';
        patch.op = draft.op || 'find_rows';
        // Drop half-written conditions rather than saving a row with no column:
        // the validator would flag it, but an empty row the user did not mean to
        // add is noise, not feedback.
        patch.where = (Array.isArray(draft.where) ? draft.where : []).filter(w => w && w.field);
        // Only the columns actually given a value are written. An empty binding
        // means "leave this column alone", not "write blank".
        const vals = (draft.values && typeof draft.values === 'object') ? draft.values : {};
        patch.values = Object.fromEntries(
            Object.entries(vals).filter(([, v]) => v !== undefined && v !== null && v !== ''),
        );
        patch.matchColumn = draft.matchColumn || '';
        if (typeof draft.limit === 'number' && Number.isFinite(draft.limit)) patch.limit = draft.limit;
        applyForEachPatch(patch, step, draft);
    },
    knowledge_write: (patch, step, draft) => {
        patch.knowledgeBaseId = draft.knowledgeBaseId || '';
        patch.title = draft.title || '';
        patch.content = draft.content || '';
        patch.sourceUri = draft.sourceUri || '';
        // 'skip' is the default and stays OFF the step, so a step saved from
        // the form is the same shape as one the AI builder produced.
        patch.nearDuplicateStrategy = (draft.nearDuplicateStrategy && draft.nearDuplicateStrategy !== 'skip')
            ? draft.nearDuplicateStrategy
            : undefined;
        applyForEachPatch(patch, step, draft);
    },
};
