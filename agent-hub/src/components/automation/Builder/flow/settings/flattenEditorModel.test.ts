import { FLATTEN_MAIL_STEP, flattenMailRoot, flattenOrdersRoot } from '@shared/expr/corpus.mjs';
import { describe, expect, it } from 'vitest';
import {
    candidatesOf, childKeysOf, clashNotes, columnsSentence, flattenDraft, flattenPatch, isDefaultLabel, leftOutParts,
    levelOptions, outerListOf, refreshPlan, routePatch, sampleFromRunOf, sampleRows, sourcePatch, toggleField,
    type FlattenDraft, type FlattenParent,
} from './flattenEditorModel';

/** English `t` with `{name}` placeholders filled, as the app's translator does. */
const t = (_key: string, fallback: string, vars: Record<string, unknown> = {}) =>
    fallback.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? `{${k}}`));

const MAIL = flattenMailRoot();
const MAIL_DRAFT: FlattenDraft = { ...flattenDraft(FLATTEN_MAIL_STEP as unknown as Record<string, unknown>), label: 'One row per attachment' };
const ORDERS = flattenOrdersRoot();
const ORDER_ROUTE = 'steps.http.output.body.orders[*].lines';

describe('flattenEditorModel: the draft', () => {
    it('round-trips the stored step, and an unplanned step stores no parents', () => {
        expect(flattenPatch(MAIL_DRAFT)).toEqual({ arrayRef: FLATTEN_MAIL_STEP.arrayRef, parents: FLATTEN_MAIL_STEP.parents, keepEmpty: false });
        expect(flattenPatch({ arrayRef: 'steps.g.output.messages', parents: null })).toEqual({ arrayRef: 'steps.g.output.messages', parents: undefined, keepEmpty: false });
    });

    it('never shares the stored arrays with the draft', () => {
        expect(MAIL_DRAFT.parents![0].fields).not.toBe(FLATTEN_MAIL_STEP.parents[0].fields);
    });

    it('names the outer list of a route and of a bare list', () => {
        expect(outerListOf(FLATTEN_MAIL_STEP.arrayRef)).toBe('steps.g_read_many.output.messages');
        expect(outerListOf('steps.g_read_many.output.messages')).toBe('steps.g_read_many.output.messages');
        expect(outerListOf('')).toBe('');
    });
});

describe('flattenEditorModel: sentences (J1)', () => {
    const rows = sampleRows(MAIL, MAIL_DRAFT)!.items as Array<Record<string, unknown>>;

    it('counts the attachment\'s own 7 fields and names the copied mail fields', () => {
        expect(childKeysOf(rows, MAIL_DRAFT)).toHaveLength(7);
        expect(columnsSentence(MAIL_DRAFT, 7, t)).toBe('Each row has the attachment\'s 7 fields, plus From, To, Subject and Date from its message.');
    });

    it('lists the long body as left out and the fills as already there', () => {
        expect(leftOutParts(MAIL, MAIL_DRAFT)).toEqual({ long: ['body'], fills: ['messageId', 'threadId'] });
    });

    it('promises no field count before the step before it has run', () => {
        expect(columnsSentence(MAIL_DRAFT, 0, t)).toBe('Each row has the attachment\'s own fields, plus From, To, Subject and Date from its message.');
    });

    it('does not call Body left out once it is ticked on', () => {
        const ticked = { ...MAIL_DRAFT, parents: toggleField(MAIL_DRAFT, 0, 'body', true, []) };
        expect(leftOutParts(MAIL, ticked).long).toEqual([]);
        expect(columnsSentence(ticked, 7, t)).toContain('Body');
    });

    it('names a child list called items "item", not "parent"', () => {
        const root = { steps: { h: { output: { orders: [{ id: 'o1', items: [{ sku: 'x' }] }] } } } };
        expect(routePatch({ arrayRef: '', parents: null, keepEmpty: false }, 'steps.h.output.orders[*].items', root, t).label).toBe('One row per item');
    });

    it('says when nothing is copied', () => {
        const none = { ...MAIL_DRAFT, parents: [{ ...MAIL_DRAFT.parents![0], fields: [] }] };
        expect(columnsSentence(none, 7, t)).toBe('Each row has the attachment\'s 7 fields. Nothing is copied from its message.');
    });

    it('explains a renamed parent field (F40), never a generic one', () => {
        const draft: FlattenDraft = {
            ...MAIL_DRAFT,
            parents: [{ ...MAIL_DRAFT.parents![0], fields: [{ from: 'id', to: 'messageId', mode: 'copy' }, { from: 'date', to: 'messageDate', mode: 'copy' }] }],
        };
        expect(clashNotes(draft, t)).toEqual(['The message\'s Date is called Message date, because each attachment has its own Date.']);
    });
});

describe('flattenEditorModel: levels and patches', () => {
    it('offers inner lists of records only', () => {
        expect(levelOptions('steps.g_read_many.output.messages', MAIL).map(o => o.path)).toEqual([FLATTEN_MAIL_STEP.arrayRef]);
        expect(levelOptions('steps.http.output.body.orders', ORDERS).map(o => o.key)).toEqual(['lines']);
        expect(levelOptions('', MAIL)).toEqual([]);
    });

    it('re-plans and relabels a default label on a level change (F37)', () => {
        const patch = routePatch({ arrayRef: '', parents: null, keepEmpty: false, label: 'Flatten a list' }, ORDER_ROUTE, ORDERS, t);
        expect(patch.arrayRef).toBe(ORDER_ROUTE);
        expect(patch.label).toBe('One row per line');
        expect(patch.parents![0]).toMatchObject({ overRef: 'steps.http.output.body.orders', itemVar: 'order', auto: true });
        expect(patch.parents![0].fields!.find(f => f.from === 'id')).toEqual({ from: 'id', to: 'orderId', mode: 'copy' });
    });

    it('keeps a label the author wrote', () => {
        const patch = routePatch({ ...MAIL_DRAFT, label: 'Invoice files' }, FLATTEN_MAIL_STEP.arrayRef, MAIL, t);
        expect(patch.label).toBeUndefined();
        expect(isDefaultLabel('One row per attachment', FLATTEN_MAIL_STEP.arrayRef, t)).toBe(true);
    });

    it('picks the first inner list for a new source, and keeps a bare list without one', () => {
        expect(sourcePatch(MAIL_DRAFT, 'steps.g_read_many.output.messages', MAIL, t).arrayRef).toBe(FLATTEN_MAIL_STEP.arrayRef);
        expect(sourcePatch(MAIL_DRAFT, 'steps.nowhere.output.items', MAIL, t)).toEqual({ arrayRef: 'steps.nowhere.output.items', parents: null });
    });
});

describe('flattenEditorModel: choosing fields (F42)', () => {
    it('shows the plan, then the long text unticked', () => {
        const c = candidatesOf(MAIL, MAIL_DRAFT, 0);
        expect(c.find(x => x.key === 'id')).toEqual({ key: 'id', on: true, fill: true, long: false });
        expect(c.find(x => x.key === 'body')).toEqual({ key: 'body', on: false, fill: false, long: true });
    });

    it('a tick by hand ends auto, and a ticked key is named against the child', () => {
        const childKeys = ['attachmentId', 'filename', 'mimeType', 'size', 'canOCR', 'messageId', 'threadId'];
        const off = toggleField(MAIL_DRAFT, 0, 'to', false, childKeys);
        expect(off[0].auto).toBe(false);
        expect(off[0].fields!.map(f => f.from)).not.toContain('to');
        const on = toggleField({ ...MAIL_DRAFT, parents: off }, 0, 'body', true, childKeys);
        expect(on[0].fields!.at(-1)).toEqual({ from: 'body', to: 'body', mode: 'copy' });
    });
});

describe('flattenEditorModel: refresh on open (F6, F43)', () => {
    it('plans a step stored without fields', () => {
        const draft: FlattenDraft = { arrayRef: FLATTEN_MAIL_STEP.arrayRef, parents: null, keepEmpty: false };
        const next = refreshPlan(MAIL, draft)!;
        expect(next.parents).toEqual(FLATTEN_MAIL_STEP.parents);
        expect(next.added).toEqual([]);
    });

    it('appends a new key to an auto level and says which, never renaming', () => {
        const root = flattenMailRoot();
        const messages = (root.steps.g_read_many.output as { messages: Array<Record<string, unknown>> }).messages;
        messages.forEach(m => { m.cc = 'archief@contoso.example'; });
        const next = refreshPlan(root, MAIL_DRAFT)!;
        expect(next.added).toEqual(['cc']);
        expect(next.parents[0].fields!.slice(0, 6)).toEqual(FLATTEN_MAIL_STEP.parents[0].fields);
    });

    it('leaves a level chosen by hand alone', () => {
        const parents: FlattenParent[] = [{ ...MAIL_DRAFT.parents![0], auto: false }];
        expect(refreshPlan(MAIL, { ...MAIL_DRAFT, parents })).toBeNull();
        expect(refreshPlan(MAIL, MAIL_DRAFT)).toBeNull();
    });
});

describe('flattenEditorModel: sampleFromRunOf', () => {
    it('is true only when the outer list\'s step carries real data', () => {
        const groups = [{ basePath: 'steps.g_read_many.output', hasRealData: true }];
        expect(sampleFromRunOf(groups, FLATTEN_MAIL_STEP.arrayRef)).toBe(true);
        expect(sampleFromRunOf([{ basePath: 'steps.g_read_many.output' }], FLATTEN_MAIL_STEP.arrayRef)).toBe(false);
        expect(sampleFromRunOf(null, '')).toBe(false);
    });
});
