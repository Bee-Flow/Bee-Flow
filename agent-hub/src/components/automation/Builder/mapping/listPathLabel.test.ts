import { describe, expect, it } from 'vitest';
import { listPathLabel } from './listPathLabel';

const labels = new Map([['s1', 'Read the purchasing inbox'], ['http', 'Graph call']]);

describe('listPathLabel', () => {
    it('names every level, never shows path syntax', () => {
        expect(listPathLabel('steps.s1.output.value[*].attachments', labels)).toBe('Read the purchasing inbox ▸ Value ▸ Attachments (inside each row)');
        expect(listPathLabel('steps.s1.output.value', labels)).toBe('Read the purchasing inbox ▸ Value');
        expect(listPathLabel('trigger.output.data.object.lines.data')).toBe('Trigger ▸ Data ▸ Object ▸ Lines ▸ Data');
        expect(listPathLabel('steps.http.output.body["line-items"]', labels)).toBe('Graph call ▸ Body ▸ Line items');
        expect(listPathLabel('loop.order.line_items[*].properties')).toBe('Each order ▸ Line items ▸ Properties (inside each row)');
    });

    it('leaves out the per-item envelope, reads a match as its entry and an index as a number', () => {
        expect(listPathLabel('steps.s1.output.results[*].output.attachments', labels)).toBe('Read the purchasing inbox ▸ Results ▸ Attachments (inside each row)');
        expect(listPathLabel('steps.s1.output.payload.headers[name="Subject"].value', labels)).toBe('Read the purchasing inbox ▸ Payload ▸ Headers ▸ Subject ▸ Value');
        expect(listPathLabel('steps.s1.output.items[0].lines', labels)).toBe('Read the purchasing inbox ▸ Items ▸ #1 ▸ Lines');
        expect(listPathLabel('steps.gone.output.items')).toBe('Previous step ▸ Items');
    });

    it('a list itself is not "inside each row"; a long chain is shortened', () => {
        expect(listPathLabel('steps.s1.output.items[*]', labels)).toBe('Read the purchasing inbox ▸ Items');
        expect(listPathLabel('trigger.output.a.b.c.d.e.f')).toBe('Trigger ▸ A ▸ … ▸ D ▸ E ▸ F');
    });

    it('translates through t', () => {
        const t = (k: string, en: string, v?: Record<string, unknown>) => `[${k}]${en.replace(/\{(\w+)\}/g, (_, x) => String(v?.[x]))}`;
        expect(listPathLabel('steps.s1.output.value[*].attachments', labels, t)).toBe('[automations.builder.inside_each_row]Read the purchasing inbox ▸ Value ▸ Attachments (inside each row)');
    });

    it('names a rule\'s own item "Each item"', () => {
        expect(listPathLabel('item.attachments')).toBe('Each item ▸ Attachments');
        expect(listPathLabel('item')).toBe('Each item');
    });

    it('compact: a list inside each row reads as the step and the inner list, no brackets', () => {
        expect(listPathLabel('steps.s1.output.value[*].attachments', labels, null, { compact: true })).toBe('Read the purchasing inbox ▸ Attachments');
        expect(listPathLabel('steps.s1.output.value', labels, null, { compact: true })).toBe('Read the purchasing inbox ▸ Value');
    });

    it('a Condition\'s outputs read as the output\'s name and "Otherwise", never its runner keys', () => {
        const routeLabels = new Map([['ms_split', 'Split attachments'], ['mc', 'Keep invoices'], ['s1', 'Read the purchasing inbox']]);
        const types = new Map([['ms_split', 'switch'], ['mc', 'filter'], ['s1', 'integration_action']]);
        const opts = { stepTypeById: types };
        expect(listPathLabel('steps.ms_split.output.matchesByCase.pdf', routeLabels, null, opts)).toBe('Split attachments ▸ pdf');
        expect(listPathLabel('steps.ms_split.output.matchesByCase["Output 1"]', routeLabels)).toBe('Split attachments ▸ Output 1');
        expect(listPathLabel('steps.ms_split.output.matchesByCase.default', routeLabels)).toBe('Split attachments ▸ Otherwise');
        expect(listPathLabel('steps.mc.output.items', routeLabels, null, opts)).toBe('Keep invoices');
        expect(listPathLabel('steps.mc.output.items[*].attachments', routeLabels, null, opts)).toBe('Keep invoices ▸ Attachments (inside each row)');
        expect(listPathLabel('steps.mc.output.items[*].attachments', routeLabels, null, { ...opts, compact: true })).toBe('Keep invoices ▸ Attachments');
        for (const p of ['steps.ms_split.output.matchesByCase.pdf', 'steps.ms_split.output.matchesByCase.default', 'steps.mc.output.items[*].attachments']) {
            const label = listPathLabel(p, routeLabels, null, opts);
            expect(label).not.toMatch(/Matches by case|Default|Items/);
        }
        // Another step's list called "items" keeps its name.
        expect(listPathLabel('steps.s1.output.items', routeLabels, null, opts)).toBe('Read the purchasing inbox ▸ Items');
    });

    it('"Otherwise" goes through t', () => {
        const t = (k: string, en: string) => (k === 'condition_node.otherwise.label' ? 'Anders' : en);
        expect(listPathLabel('steps.ms.output.matchesByCase.default', new Map([['ms', 'Splitsen']]), t)).toBe('Splitsen ▸ Anders');
    });
});
