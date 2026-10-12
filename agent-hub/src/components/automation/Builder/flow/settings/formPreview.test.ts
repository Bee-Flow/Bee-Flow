import { describe, it, expect } from 'vitest';
import { buildPreviewConfig, fillTemplate } from './formPreview';

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
