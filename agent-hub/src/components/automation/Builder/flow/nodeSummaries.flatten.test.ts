import { describe, expect, it } from 'vitest';
import { flattenSummary } from './nodeSummaries';

const t = (_key: string, fallback: string, vars: Record<string, unknown> = {}) =>
    fallback.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? ''));

describe('flattenSummary: the canvas line', () => {
    it('names the outer list the step works through', () => {
        const labels = new Map([['g_read_many', 'Read many']]);
        const line = flattenSummary({ arrayRef: 'steps.g_read_many.output.messages[*].attachments' }, { stepLabelById: labels, t });
        expect(line).toMatch(/^From Read many/);
        expect(line).toContain('Messages');
        expect(line).not.toContain('Attachments');
    });

    it('asks for a list while there is none', () => {
        expect(flattenSummary({ arrayRef: '' }, { t })).toEqual({ muted: 'Pick a list' });
        expect(flattenSummary({})).toEqual({ muted: 'Pick a list' });
    });
});
