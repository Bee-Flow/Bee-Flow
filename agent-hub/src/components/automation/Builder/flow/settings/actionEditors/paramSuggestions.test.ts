import { describe, expect, it, vi } from 'vitest';
import { buildParamSuggestions, refLabel, safeDefault } from './paramSuggestions';

const t = (_k: string, en: string, p?: Record<string, unknown>) => String(en).replace(/\{(\w+)\}/g, (m, k) => (p && k in p ? String(p[k]) : m));

describe('paramSuggestions — a suggestion for every empty required setting (artboard 4b)', () => {
    const schema = {
        properties: { path: { type: 'string', title: 'Which file?' }, folder: { type: 'string' }, since: { type: 'string', format: 'date' }, note: { type: 'string' } },
        required: ['path', 'folder', 'since', 'note'],
    };
    const groups = [{ label: 'New file', basePath: 'trigger.output' }];

    it('prefers a matching upstream field, then a safe default, and skips what has neither', () => {
        const autoMap = vi.fn(() => ({ path: { kind: 'ref', path: 'trigger.output.path' } }));
        const out = buildParamSuggestions(schema, {}, groups, autoMap, t);
        expect(out.path).toEqual({ binding: { kind: 'ref', path: 'trigger.output.path' }, label: 'New file › Path', source: 'field' });
        expect(out.folder.binding).toEqual({ kind: 'literal', value: '/' });
        expect(out.since.label).toMatch(/^Today \(\d{4}-\d{2}-\d{2}\)$/);
        expect(out.note).toBeUndefined();
    });

    it('suggests nothing for a setting that already holds a value', () => {
        const out = buildParamSuggestions(schema, { folder: { kind: 'literal', value: '/Docs' } }, groups, () => ({}), t);
        expect(out.folder).toBeUndefined();
    });

    it('labels refs and defaults in plain words', () => {
        expect(refLabel('steps.s1.output.results[*].from_email', [{ label: 'Gmail search', basePath: 'steps.s1.output' }])).toBe('Gmail search › From email');
        expect(safeDefault('count', { type: 'integer' }, t)).toBeNull();
        expect(safeDefault('parentDir', { type: 'string' }, t)?.label).toBe('Root folder /');
    });
});
