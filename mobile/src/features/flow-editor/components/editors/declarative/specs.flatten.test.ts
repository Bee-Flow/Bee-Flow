/**
 * The FLATTEN spec (F35-F42 on the phone): sentences over the shared plan,
 * the "One row per" chooser only when a list offers two or more inner lists,
 * the empty-parent warning with its keep toggle, and the field chips. Every
 * write goes through the shared flattenPlan, so what is saved is what the
 * server would plan for the same sample.
 */

import type { FlowNode } from '@/features/flow-editor/bindings';

import { isVisible, readField, resolveOptions, say, specDraft, writeField } from './runtime';
import type { FieldSpec, SpecTranslate } from './spec';
import { specFor } from './specs';
import { findField, specContext } from './testing';

interface Corpus {
    FLATTEN_MAIL_STEP: FlowNode;
    flattenMailRoot: () => Record<string, unknown>;
    flattenOrdersRoot: (o?: { taxes?: boolean }) => Record<string, unknown>;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const corpus = require('../../../../../../../agent-hub/src/shared/expr/corpus.mjs') as Corpus;

const spec = specFor('flatten');
if (!spec) throw new Error('no FLATTEN spec');
const FLATTEN = spec;
const field = (id: string) => findField(FLATTEN, id);

/** The English, placeholders filled: what t() answers without a dictionary. */
const t: SpecTranslate = (_key, fallback, params) =>
    fallback.replace(/\{(\w+)\}/g, (m, k: string) => (params && k in params ? String(params[k]) : m));

const mailStep = (): FlowNode => ({ ...corpus.FLATTEN_MAIL_STEP, icon: null } as FlowNode);
const ORDERS_ROUTE = 'steps.http.output.body.orders[*].lines';
const ordersStep = (extra: Record<string, unknown> = {}): FlowNode =>
    ({ id: 'f2', type: 'flatten', label: 'Flatten a list', icon: null, arrayRef: '', ...extra }) as FlowNode;

function open(step: FlowNode, root: unknown) {
    const ctx = specContext(step, { sampleRoot: root });
    const draft = specDraft(FLATTEN, step);
    const shown = (f: FieldSpec) => isVisible(f, draft, ctx);
    const show = (id: string) => {
        const f = field(id);
        return f.kind === 'display' ? f.show(draft, ctx, t) : '';
    };
    const hint = (id: string) => say(t, typeof field(id).hint === 'function' ? (field(id).hint as never as (d: unknown, c: unknown) => never)(draft, ctx) : null);
    return { ctx, draft, shown, show, hint };
}

describe('FLATTEN: the J1 mail table', () => {
    const root = corpus.flattenMailRoot();

    it('says what a row is and what it carries, with no path to type', () => {
        const { show, shown } = open(mailStep(), root);
        expect(show('level')).toBe('One row per attachment. Each message holds a list of attachments.');
        expect(show('columns')).toBe("Each row has the attachment's 7 fields, plus From, To, Subject and Date from its message.");
        expect(show('columnsNote')).toBe('Left out: Body (long text). Message id and Thread id already come with each attachment.');
        expect(shown(field('route'))).toBe(false);
        expect(shown(field('emptyWarn'))).toBe(false);
        expect(shown(field('keepEmpty'))).toBe(false);
    });

    it('shows the copied fields as chips, the ones that already come with each attachment fixed', () => {
        const { ctx, draft } = open(mailStep(), root);
        const chips = field('fields');
        expect(readField(chips, draft, ctx)).toEqual(['id', 'threadId', 'from', 'to', 'subject', 'date']);
        const options = 'options' in chips ? resolveOptions(chips.options, draft, ctx) : [];
        expect(options.map((o) => [o.value, !!o.disabled])).toEqual([
            ['id', true], ['threadId', true], ['from', false], ['to', false], ['subject', false], ['date', false], ['body', true],
        ]);
        expect(say(t, options[0]?.blurb)).toBe('already on each attachment');
        expect(say(t, options[6]?.blurb)).toBe('long text');
    });

    it('unticking To keeps the other entries as stored and turns auto off (J1 step 8)', () => {
        const { ctx, draft } = open(mailStep(), root);
        const next = writeField(field('fields'), ['id', 'threadId', 'from', 'subject', 'date'], draft, ctx);
        const level = (next.parents as { auto: boolean; fields: { from: string }[] }[])[0];
        expect(level?.auto).toBe(false);
        expect(level?.fields.map((f) => f.from)).toEqual(['id', 'threadId', 'from', 'subject', 'date']);
        expect(open({ ...mailStep(), ...next } as FlowNode, root).show('columns')).toContain('plus From, Subject and Date from its message');
    });
});

describe('FLATTEN: the J2 orders', () => {
    const root = corpus.flattenOrdersRoot();

    it('picking the source takes its inner list, plans it and names the step', () => {
        const { ctx, draft } = open(ordersStep(), root);
        const next = writeField(field('source'), 'steps.http.output.body.orders', draft, ctx);
        expect(next.arrayRef).toBe(ORDERS_ROUTE);
        expect(next.label).toBe('One row per line');
        const fields = (next.parents as { itemVar: string; fields: { from: string; to: string }[] }[])[0];
        expect(fields?.itemVar).toBe('order');
        expect(fields?.fields.find((f) => f.from === 'id')?.to).toBe('orderId');
        expect(fields?.fields.find((f) => f.from === 'status')?.to).toBe('orderStatus');
    });

    it('warns about the order without lines, and the toggle keeps it', () => {
        const { ctx, draft } = open(ordersStep(), root);
        const step = { ...ordersStep(), ...writeField(field('source'), 'steps.http.output.body.orders', draft, ctx) } as FlowNode;
        const view = open(step, root);
        expect(view.shown(field('emptyWarn'))).toBe(true);
        expect(view.hint('emptyWarn')).toBe('1 of the 5 orders has no lines, so it makes no row.');
        expect(view.shown(field('keepEmpty'))).toBe(true);
        const kept = open({ ...step, keepEmpty: true } as FlowNode, root);
        expect(kept.shown(field('emptyWarn'))).toBe(false);
        expect(kept.shown(field('keepEmpty'))).toBe(true);
    });

    it('offers the chooser only when an item holds two or more inner lists', () => {
        const two = { steps: { http: { output: { body: { orders: [{ id: 'o1', lines: [{ sku: 'a' }], payments: [{ amount: 1 }] }] } } } } };
        const step = { ...ordersStep(), arrayRef: ORDERS_ROUTE } as FlowNode;
        expect(open(step, corpus.flattenOrdersRoot()).shown(field('route'))).toBe(false);
        const view = open(step, two);
        expect(view.shown(field('route'))).toBe(true);
        const route = field('route');
        const options = 'options' in route ? resolveOptions(route.options, view.draft, view.ctx) : [];
        expect(options.map((o) => o.value)).toEqual([ORDERS_ROUTE, 'steps.http.output.body.orders[*].payments']);
        expect(options.map((o) => o.label)).toEqual(['Line', 'Payment']);
        const next = writeField(route, 'steps.http.output.body.orders[*].payments', view.draft, view.ctx);
        expect(next).toMatchObject({ arrayRef: 'steps.http.output.body.orders[*].payments', label: 'One row per payment' });
    });

    it('says so when the source holds no list of its own', () => {
        const flat = { steps: { http: { output: { body: { orders: [{ id: 'o1', total: 3 }] } } } } };
        const view = open({ ...ordersStep(), arrayRef: 'steps.http.output.body.orders' } as FlowNode, flat);
        expect(view.shown(field('noInner'))).toBe(true);
        expect(view.hint('noInner')).toMatch(/^The orders in this list hold no list of their own/);
        expect(view.show('columns')).toBe('');
    });

    it('a deeper route set elsewhere is a sentence, never the chooser', () => {
        const step = { ...ordersStep(), arrayRef: 'steps.http.output.body.orders[*].lines[*].taxes' } as FlowNode;
        const view = open(step, corpus.flattenOrdersRoot({ taxes: true }));
        expect(view.shown(field('route'))).toBe(false);
        expect(view.show('level')).toMatch(/^One row per tax\./);
    });
});

describe('FLATTEN: counts and words', () => {
    it('says "have" and "they" when more than one parent has no children', () => {
        const root = { steps: { http: { output: { body: { orders: [{ id: 'o1', lines: [] }, { id: 'o2', lines: [] }, { id: 'o3', lines: [{ sku: 'a' }] }] } } } } };
        const view = open({ ...ordersStep(), arrayRef: ORDERS_ROUTE, parents: [] } as FlowNode, root);
        expect(view.hint('emptyWarn')).toBe('2 of the 3 orders have no lines, so they make no rows.');
    });

    it('does not call Body left out once the step copies it', () => {
        const step = mailStep() as FlowNode & { parents: { fields: unknown[] }[] };
        const withBody = { ...step, parents: [{ ...step.parents[0], fields: [...step.parents[0]!.fields, { from: 'body', to: 'body', mode: 'copy' }] }] } as FlowNode;
        expect(open(withBody, corpus.flattenMailRoot()).show('columnsNote')).toBe('Message id and Thread id already come with each attachment.');
    });

    it('names a child list called items "item"', () => {
        const root = { steps: { http: { output: { body: { orders: [{ id: 'o1', items: [{ sku: 'a' }] }] } } } } };
        const { ctx, draft } = open(ordersStep(), root);
        expect(writeField(field('source'), 'steps.http.output.body.orders', draft, ctx).label).toBe('One row per item');
    });
});
