import { sectionForIssue } from '@/features/flow-editor/model';
import { branchy } from '@/features/flow-editor/model/testing/fixtures';

import { issueRows, pillSummary } from './issuesModel';

const t = (_key: string, fallback: string, params?: Record<string, string | number>) =>
    fallback.replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? ''));

const ISSUES = {
    errors: [{ code: 'binding.missing', severity: 'error' as const, path: 'steps[act_a].inputs.to', message: 'act_a has no recipient', hint: 'Pick one for act_a' }],
    warnings: [{ code: 'graph.unreachable', severity: 'warning' as const, path: 'definition', message: 'Something is loose' }],
};

describe('issueRows', () => {
    it('names the step by its label, never its id, and knows the section that fixes it', () => {
        const [first, second] = issueRows(ISSUES, branchy);
        const step = branchy.steps.find((s) => s.id === 'act_a');
        expect(first).toMatchObject({ severity: 'error', stepId: 'act_a', code: 'binding.missing' });
        expect(first?.message).not.toContain('act_a');
        expect(first?.hint).not.toContain('act_a');
        expect(first?.stepLabel).toBeTruthy();
        expect(first?.section).toBe(sectionForIssue(step, ISSUES.errors[0]));
        expect(second).toMatchObject({ severity: 'warning', stepId: null, stepLabel: null, section: null });
    });

    it('is empty without findings or a definition', () => {
        expect(issueRows(null, branchy)).toEqual([]);
        expect(issueRows(ISSUES, null)).toEqual([]);
    });
});

describe('pillSummary', () => {
    it('is absent for a healthy automation', () => {
        expect(pillSummary([], t)).toBeNull();
    });

    it('says the one finding in its own words, with its step', () => {
        const [row] = issueRows({ errors: ISSUES.errors, warnings: [] }, branchy);
        expect(pillSummary(row ? [row] : [], t)).toEqual({ total: 1, tone: 'error', text: `${row?.message} · ${row?.stepLabel}` });
    });

    it('counts several, in the colour of the worst', () => {
        expect(pillSummary(issueRows(ISSUES, branchy), t)).toEqual({ total: 2, tone: 'error', text: '2 problems' });
        expect(pillSummary(issueRows({ errors: [], warnings: [...ISSUES.warnings, ...ISSUES.warnings] }, branchy), t)).toEqual({
            total: 2, tone: 'warning', text: '2 warnings',
        });
    });
});
