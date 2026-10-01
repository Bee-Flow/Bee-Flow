import { describe, it, expect } from 'vitest';
import {
    changedKeys, listLabel, perItemIsSet, planForEachChange, planForEachOff, planLoopItemRename, planRepeat,
    planRepeatOff, planRepeatSwitch, repeatChoices, repeatCount, repeatShortcut,
} from './stepRepeat';
import type { TranslateFn } from '../../../../../../hooks/useTranslation';

// The English defaults, with {param}s filled: what an author reads.
const t: TranslateFn = (_key, fallback, params) => String(fallback ?? '').replace(/\{(\w+)\}/g, (m, k) => (params && k in params ? String(params[k]) : m));

const ORDERS = { root: 'steps' as const, id: 'get', path: ['orders'] };
const FILES = { root: 'steps' as const, id: 'files', path: ['items'] };
const labels = new Map([['get', 'Get orders'], ['files', 'List files'], ['read', 'Read file']]);

const draft = () => ({
    label: 'Mail',
    inputs: {
        to: { kind: 'ref', path: 'steps.get.output.orders[*].email' },
        subject: { kind: 'literal', value: 'Hi' },
    },
    forEach: null,
    repeat: null,
});

describe('changedKeys', () => {
    it('lists only what changed; a key that went away is null; type is not a draft key', () => {
        expect(changedKeys({ a: 1, b: { x: 1 }, gone: 2 }, { a: 1, b: { x: 2 }, type: 'set', added: 3 }))
            .toEqual({ b: { x: 2 }, gone: null, added: 3 });
    });
});

describe('turning per item on and off', () => {
    it('on: the value that read every item reads the current one, with a preview count', () => {
        const res = planRepeat(draft(), 'integration_action', ORDERS);
        if ('error' in res) throw new Error(res.error);
        expect(res.each).toBe(1);
        expect(res.patch.repeat).toEqual({ over: ORDERS, max: 100 });
        expect(res.patch.inputs).toEqual({
            to: { kind: 'pick', v: 1, from: { ...ORDERS, path: ['orders', 'email'] }, take: 'each', as: 'native' },
            subject: { kind: 'literal', value: 'Hi' },
        });
        expect(Object.keys(res.patch).sort()).toEqual(['inputs', 'repeat']);
    });

    it('regression: off again leaves no per-item run behind, and the value reads the whole list', () => {
        const on = planRepeat(draft(), 'integration_action', ORDERS);
        if ('error' in on) throw new Error(on.error);
        const repeated = { ...draft(), ...on.patch };
        const { patch } = planRepeatOff(repeated, 'integration_action');
        expect(patch.repeat).toBeNull();
        expect((patch.inputs as Record<string, { take: string }>).to.take).toBe('all');
        expect(perItemIsSet({ ...repeated, ...patch })).toBe(false);
    });

    it('a text of the step type is reached too (a notification body)', () => {
        const d = { title: 'x', body: { kind: 'compose', v: 1, parts: ['Hi ', { from: { ...ORDERS, path: ['orders', 'name'] }, take: 'all', as: 'text' }] }, repeat: null, forEach: null };
        const res = planRepeat(d, 'notification', ORDERS);
        if ('error' in res) throw new Error(res.error);
        expect(res.each).toBe(1);
        expect((res.patch.body as { parts: Array<{ take?: string }> }).parts[1].take).toBe('each');
    });

    it('regression: a second, different list is refused with a human sentence, the first is not re-pointed', () => {
        const on = planRepeat(draft(), 'integration_action', ORDERS);
        if ('error' in on) throw new Error(on.error);
        const repeated = { ...draft(), ...on.patch };
        const res = repeatShortcut(repeated, 'integration_action', FILES, labels, t);
        expect(res).toEqual({ message: 'This step already runs separately for each item in Orders from Get orders.' });
        expect('error' in planRepeat(repeated, 'integration_action', FILES)).toBe(true);
    });

    it('the section itself may move the repeat to another list: off over the old, on over the new', () => {
        const on = planRepeat(draft(), 'integration_action', ORDERS);
        if ('error' in on) throw new Error(on.error);
        const res = planRepeatSwitch({ ...draft(), ...on.patch }, 'integration_action', FILES);
        if ('error' in res) throw new Error(res.error);
        expect(res.patch.repeat).toEqual({ over: FILES, max: 100 });
        expect((res.patch.inputs as Record<string, { take: string }>).to.take).toBe('all');
        expect(res.each).toBe(0);
    });

    it('a step that still runs per item the older way is not given a repeat on top', () => {
        const res = repeatShortcut({ ...draft(), forEach: { overRef: 'steps.get.output.orders', itemVar: 'row' } }, 'integration_action', ORDERS, labels, t);
        expect(res).toEqual({ message: 'This step already runs once per item the older way. Turn that off first.' });
    });
});

describe('the older per-item setting (forEach)', () => {
    const legacy = () => ({
        inputs: { to: { kind: 'ref', path: 'loop.item.email' } },
        forEach: { overRef: 'steps.get.output.orders', itemVar: 'item', maxIterations: 100 },
        repeat: null,
    });

    it('regression: renaming the item rewrites the values that read it', () => {
        const res = planForEachChange(legacy(), 'integration_action', { itemVar: 'order' });
        if ('error' in res) throw new Error(res.error);
        expect(res.patch).toEqual({
            inputs: { to: { kind: 'ref', path: 'loop.order.email' } },
            forEach: { overRef: 'steps.get.output.orders', itemVar: 'order', maxIterations: 100 },
        });
    });

    it('regression: a new list that suggests a new name carries the values along', () => {
        const res = planForEachChange(legacy(), 'integration_action', { overRef: 'steps.files.output.items', itemVar: 'file' });
        if ('error' in res) throw new Error(res.error);
        expect(res.patch.forEach).toEqual({ overRef: 'steps.files.output.items', itemVar: 'file', maxIterations: 100 });
        expect(res.patch.inputs).toEqual({ to: { kind: 'ref', path: 'loop.file.email' } });
    });

    it('a name the run could not bind is refused', () => {
        expect(planForEachChange(legacy(), 'integration_action', { itemVar: '9x' })).toEqual({ error: 'invalid_name' });
    });

    it('off: the item refs read the whole list again', () => {
        const { patch, orphaned } = planForEachOff(legacy(), 'integration_action');
        expect(orphaned).toBe(false);
        expect(patch.forEach).toBeNull();
        expect(patch.inputs).toEqual({ to: { kind: 'pick', v: 1, from: { ...ORDERS, path: ['orders', 'email'] }, take: 'all', as: 'native' } });
    });

    it('off with a text that reads the item: removed anyway, and said', () => {
        const { patch, orphaned } = planForEachOff({ ...legacy(), inputs: { t: { kind: 'template', value: 'Hi {{loop.item.name}}' } } }, 'integration_action');
        expect(orphaned).toBe(true);
        expect(patch.forEach).toBeNull();
    });

    // A slide's draft keeps its chart and stats as text (chartLabels,
    // chartValues, chartData, stats), not in the stored shape the core reads.
    const slide = () => ({
        title: '{{loop.row.name}}', content: '', notes: '', image: '', layout: 'auto', style: '',
        visual: 'chart', chartType: 'bar', chartStacked: false,
        chartLabels: '{{loop.row.months}}', chartValues: '{{loop.row.sales}}', chartUnit: '{{loop.row.unit}}', chartData: '',
        stats: '',
        forEach: { overRef: 'steps.get.output.orders', itemVar: 'row', maxIterations: 100 },
        repeat: null,
    });

    it('regression: renaming a slide\'s item rewrites its chart, kept as text in the draft', () => {
        const res = planForEachChange(slide(), 'slide', { itemVar: 'order' });
        if ('error' in res) throw new Error(res.error);
        expect(res.patch).toMatchObject({
            title: '{{loop.order.name}}',
            chartLabels: '{{loop.order.months}}',
            chartValues: '{{loop.order.sales}}',
            chartUnit: '{{loop.order.unit}}',
            forEach: { overRef: 'steps.get.output.orders', itemVar: 'order', maxIterations: 100 },
        });
    });

    it('regression: a slide\'s stats are renamed too, and off says they are left without their item', () => {
        const stats = { ...slide(), visual: 'stats', stats: '{{loop.row.total}} | Total' };
        const res = planForEachChange(stats, 'slide', { itemVar: 'order' });
        if ('error' in res) throw new Error(res.error);
        expect(res.patch.stats).toBe('{{loop.order.total}} | Total');
        expect(planForEachOff(stats, 'slide').orphaned).toBe(true);
    });

    it('regression: renaming a loop item rewrites its body', () => {
        const loop = { itemVar: 'item', overRef: 'steps.get.output.orders', body: [{ id: 'b1', type: 'integration_action', inputs: { to: { kind: 'ref', path: 'loop.item.email' } } }] };
        const res = planLoopItemRename(loop, 'order');
        if ('error' in res) throw new Error(res.error);
        expect(res.patch.itemVar).toBe('order');
        expect((res.patch.body as Array<{ inputs: { to: { path: string } } }>)[0].inputs.to.path).toBe('loop.order.email');
    });
});

describe('words and lists', () => {
    it('names a list the way an author does', () => {
        expect(listLabel(ORDERS, labels, t)).toBe('Orders from Get orders');
        expect(listLabel({ root: 'trigger', path: ['line_items'] }, labels, t)).toBe('Line items from the trigger');
        expect(listLabel(null, labels, t)).toBe('a list');
    });

    it('counts the items the run would go through', () => {
        const sample = { steps: { get: { output: { orders: [{ email: 'a' }, { email: 'b' }] } } } };
        expect(repeatCount({ repeat: { over: ORDERS, max: 100 } }, sample)).toBe(2);
        expect(repeatCount({ forEach: { overRef: 'steps.get.output.orders' } }, sample)).toBe(2);
        expect(repeatCount({ repeat: null, forEach: null }, sample)).toBeNull();
    });

    it('offers the entries of a step that ran per item, nearest first, and no per-item columns', () => {
        const groups = [
            { id: 'files', basePath: 'steps.files.output', fields: [{ key: 'items', path: 'steps.files.output.items', sample: [{ path: '/a' }] }] },
            {
                id: 'read', basePath: 'steps.read.output', forEach: true,
                fields: [
                    { key: 'iterations', path: 'steps.read.output.iterations', sample: 0 },
                    { key: 'content', path: 'steps.read.output.results[*].output.content', sample: ['x'], perIteration: true },
                ],
            },
            { id: 'mail__foreach', basePath: 'loop.item', fields: [{ key: 'tags', path: 'loop.item.tags', sample: ['a'] }] },
        ];
        const choices = repeatChoices(groups, null);
        expect(choices.map(c => c.source)).toEqual([
            { root: 'steps', id: 'read', path: ['results'] },
            { root: 'steps', id: 'files', path: ['items'] },
        ]);
    });
});
