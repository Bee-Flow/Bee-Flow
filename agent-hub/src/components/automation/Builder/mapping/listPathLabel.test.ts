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
});
