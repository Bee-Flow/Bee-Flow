import { describe, it, expect } from 'vitest';
import { buildPreviewConfig, fillTemplate, isDisplayField } from './formPreview';

const theme = { primary: '#000' };

describe('buildPreviewConfig', () => {
    it('falls back to the default texts and drops nameless fields', () => {
        const cfg = buildPreviewConfig({ form: { fields: [{ type: 'text' }, { name: 'a', type: 'text', label: 'A' }] }, theme });
        expect(cfg.title).toBe('Form');
        expect(cfg.submitLabel).toBe('Submit');
        expect(cfg.successMessage).toBe('Thanks!');
        expect(cfg.fields).toHaveLength(1);
        expect(cfg.fields[0].maxSizeMb).toBe(10);
        expect(cfg.theme).toBe(theme);
    });

    it('titles an ending page "All done" by default', () => {
        expect(buildPreviewConfig({ form: {}, theme, isEnding: true }).title).toBe('All done');
    });

    it('resolves templates only when variables are allowed', () => {
        const form = { title: 'Hi {{trigger.output.name}}', fields: [] };
        const sample = { trigger: { output: { name: 'Ada' } } };
        expect(buildPreviewConfig({ form, theme, allowVariables: true, previewSample: sample }).title).toBe('Hi Ada');
        expect(buildPreviewConfig({ form, theme, allowVariables: false, previewSample: sample }).title).toBe('Hi {{trigger.output.name}}');
    });

    it('leaves an unresolvable path standing', () => {
        expect(fillTemplate('x {{nope.path}}', { a: 1 })).toBe('x {{nope.path}}');
    });

    it('normalises options and stands in a file for display fields', () => {
        const cfg = buildPreviewConfig({
            form: { fields: [{ name: 's', type: 'select', options: ['a', 'b'] }, { name: 'd', type: 'download' }] },
            theme,
        });
        expect(cfg.fields[0].options).toEqual([{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }]);
        expect(cfg.fields[1]).toMatchObject({ filename: 'document.pdf', size: 182000 });
    });
});

const SAMPLE = {
    steps: { s1: { output: { rows: [
        { id: 'a1', name: 'Alpha', note: 'First row' },
        { id: 'b2', name: 'Beta' },
        { id: 'a1', name: 'Alpha again' },
        { name: 'No value' },
    ], plain: ['x', 'y', 'x', 3] } } },
};
const later = { allowVariables: true, previewSample: SAMPLE };

describe('buildPreviewConfig: choices from an earlier step', () => {
    const pick = (optionsFrom: Record<string, unknown>, extra: Record<string, unknown> = {}, args: Record<string, unknown> = later) =>
        buildPreviewConfig({ form: { fields: [{ name: 'c', type: 'select', label: 'Pick', required: true, optionsFrom, ...extra }] }, theme, ...args } as never).fields[0] as Record<string, unknown>;

    it('resolves value, label and hint against the sample list, skipping repeats and items without a value', () => {
        const f = pick({ ref: 'steps.s1.output.rows', value: 'id', label: 'name', hint: 'note' });
        expect(f.options).toEqual([{ value: 'a1', label: 'Alpha', hint: 'First row' }, { value: 'b2', label: 'Beta' }]);
        expect(f).not.toHaveProperty('optionsFrom');
        expect(f).not.toHaveProperty('noOptions');
    });

    it('reads a list of plain values when no value path is given', () => {
        expect(pick({ ref: 'steps.s1.output.plain' }).options).toEqual([
            { value: 'x', label: 'x' }, { value: 'y', label: 'y' }, { value: '3', label: '3' },
        ]);
    });

    it('stops at the limit', () => {
        expect((pick({ ref: 'steps.s1.output.rows', value: 'id', limit: 1 }).options as unknown[]).length).toBe(1);
    });

    it('stands in two example choices when there is no sample', () => {
        const f = pick({ ref: 'steps.s1.output.rows', value: 'id' }, {}, { allowVariables: true, previewSample: null });
        expect((f.options as { label: string }[]).map(o => o.label)).toEqual(['Example choice 1', 'Example choice 2']);
    });

    it('marks a list that came out empty, and makes the question optional', () => {
        const f = pick({ ref: 'steps.s1.output.plain' }, {}, { allowVariables: true, previewSample: { steps: { s1: { output: { plain: [] } } } } });
        expect(f).toMatchObject({ options: [], noOptions: true, required: false });
    });

    it('offers nothing on the first page, which is shown before anything has run', () => {
        expect(pick({ ref: 'steps.s1.output.rows' }, {}, { allowVariables: false, previewSample: SAMPLE })).toMatchObject({ options: [], noOptions: true });
    });

    it('keeps a typed list with its hints', () => {
        const cfg = buildPreviewConfig({ form: { fields: [{ name: 's', type: 'radio', options: ['a', { value: 'b', label: 'B', hint: 'second' }] }] }, theme });
        expect(cfg.fields[0].options).toEqual([{ value: 'a', label: 'a' }, { value: 'b', label: 'B', hint: 'second' }]);
    });
});

describe('buildPreviewConfig: one question per item', () => {
    const template = { name: 'rate', type: 'number', label: 'Rate', help: 'From 1 to 5', required: true, min: 1, max: 5, showIf: 'form.go == true', fieldsFrom: { ref: 'steps.s1.output.rows', value: 'id', label: 'name', hint: 'note' } };
    const rendered = (args: Record<string, unknown> = later) => buildPreviewConfig({ form: { fields: [template] }, theme, ...args } as never).fields as Record<string, unknown>[];

    it('expands to a heading and one question per item, named like the server does', () => {
        const fields = rendered();
        expect(fields.map(f => f.name)).toEqual(['rate__0', 'rate__1', 'rate__2']);
        expect(fields[0]).toMatchObject({ type: 'info', label: 'Rate', content: 'From 1 to 5', group: 'rate', groupHeader: true, showIf: 'form.go == true' });
        expect(fields[1]).toMatchObject({ type: 'number', label: 'Alpha', help: 'First row', group: 'rate', groupKey: 'a1', min: 1, max: 5, required: true, showIf: 'form.go == true' });
        expect(fields[2]).toMatchObject({ label: 'Beta', groupKey: 'b2', help: '' });
        expect(fields.every(f => !('fieldsFrom' in f))).toBe(true);
    });

    it('stands in two example items when there is no sample', () => {
        const fields = rendered({ allowVariables: true, previewSample: null });
        expect(fields.map(f => f.name)).toEqual(['rate__0', 'rate__1', 'rate__2']);
        expect(fields[1]?.label).toBe('Example item 1');
    });

    it('is just the heading for a list that is empty', () => {
        const fields = rendered({ allowVariables: true, previewSample: { steps: { s1: { output: { rows: [] } } } } });
        expect(fields.map(f => f.name)).toEqual(['rate__0']);
    });
});

describe('buildPreviewConfig: text blocks', () => {
    it('fills the content from the sample, only where variables are allowed', () => {
        const form = { fields: [{ name: 'note', type: 'info', label: 'Note', content: 'Hello {{trigger.output.name}}' }] };
        const sample = { trigger: { output: { name: 'Ada' } } };
        expect(buildPreviewConfig({ form, theme, allowVariables: true, previewSample: sample }).fields[0]?.content).toBe('Hello Ada');
        expect(buildPreviewConfig({ form, theme, allowVariables: false, previewSample: sample }).fields[0]?.content).toBe('Hello {{trigger.output.name}}');
    });

    it('is a display field with no file standing in', () => {
        const f = buildPreviewConfig({ form: { fields: [{ name: 'note', type: 'info', content: 'x' }] }, theme }).fields[0] as Record<string, unknown>;
        expect(f).not.toHaveProperty('filename');
        expect(isDisplayField({ type: 'info' })).toBe(true);
    });
});

describe('buildPreviewConfig: rules and conditions travel to the renderer', () => {
    it('keeps showIf and the answer rules', () => {
        const f = buildPreviewConfig({ form: { fields: [{ name: 'n', type: 'number', min: 1, max: 9, showIf: 'form.a == "x"', minLength: 2, pattern: '[a-z]+', patternMessage: 'Letters.', minSelected: 1 }] }, theme }).fields[0] as Record<string, unknown>;
        expect(f).toMatchObject({ min: 1, max: 9, showIf: 'form.a == "x"', minLength: 2, pattern: '[a-z]+', patternMessage: 'Letters.', minSelected: 1 });
    });
});
