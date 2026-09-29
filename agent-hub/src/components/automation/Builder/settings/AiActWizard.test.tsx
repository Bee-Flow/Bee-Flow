import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../../test/queryWrapper';

const { calls } = vi.hoisted(() => ({ calls: [] as Array<{ url: string; method: string; body: unknown }> }));

vi.mock('../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(async (url: string, opts: { method?: string; body?: string } = {}) => {
        const method = opts.method || 'GET';
        calls.push({ url, method, body: opts.body ? JSON.parse(opts.body) : null });
        if (url.endsWith('/ai-act/suggestion')) {
            return { ok: true, status: 200, json: async () => ({
                required: true,
                status: 'missing',
                questions: [
                    { id: 'usesAi', suggested: 'no', reasons: [{ code: 'ai_act.uses_ai.none', params: {}, text: 'Bee found no AI steps.' }] },
                    { id: 'externalOutput', suggested: 'no', reasons: [{ code: 'ai_act.external.none', params: {}, text: 'The output stays inside your own organisation.' }] },
                    {
                        id: 'sensitiveUse', suggested: null, applicable: false,
                        domains: [{ id: 'employment', point: 4, article: 'Annex III(4)', labelKey: 'compliance.annex_q_employment', hint: true },
                            { id: 'credit', point: 5, article: 'Annex III(5)', labelKey: 'compliance.annex_q_credit', hint: false }],
                        reasons: [{ code: 'ai_act.sensitive.not_applicable', params: {}, text: 'Without AI this question does not change the outcome.' }],
                    },
                ],
                suggestedOutcome: 'not_applicable',
                previous: null,
            }) };
        }
        if (url === '/api/automation/a1/ai-act' && method === 'PUT') {
            return { ok: true, status: 200, json: async () => ({ required: true, status: 'valid', outcome: 'not_applicable', attestedAt: '2026-09-28T10:00:00Z', expiresAt: '2027-09-28T10:00:00Z', canEdit: true }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
    }),
}));

import AiActWizard, { reasonText } from './AiActWizard';
import { answersToBody, parseSuggestion } from '../../../../api/queries/automation/readiness';

describe('AiActWizard', () => {
    beforeEach(() => { calls.length = 0; });

    it('walks three questions with Bee\'s suggestion filled in and records the answers', async () => {
        const user = userEvent.setup();
        const onDone = vi.fn();
        const onClose = vi.fn();
        render(withQueryClient(<AiActWizard open onClose={onClose} automationId="a1" onDone={onDone} />));
        const dialog = await screen.findByRole('dialog', { name: 'AI Act check' });
        expect(within(dialog).getByText('question 1 of 3')).toBeInTheDocument();
        expect(await within(dialog).findByText(/Bee thinks this/)).toBeInTheDocument();
        expect(within(dialog).getByRole('radio', { name: /^No/ })).toHaveAttribute('aria-checked', 'true');

        await user.click(within(dialog).getByRole('button', { name: 'Next' }));
        expect(within(dialog).getByText('question 2 of 3')).toBeInTheDocument();
        const answered = within(dialog).getByTestId('aiact-answered-usesAi');
        expect(answered).toHaveTextContent('Does this automation use AI? No · Bee found no AI steps.');
        expect(within(dialog).getByRole('link', { name: 'Why do we ask this?' })).toHaveAttribute('href', expect.stringContaining('article/50'));
        await user.click(within(dialog).getByRole('radio', { name: /Yes, customers or the public/ }));

        await user.click(within(dialog).getByRole('button', { name: 'Next' }));
        // Question 3 is never pre-answered; "yes" asks which area.
        await user.click(within(dialog).getByRole('radio', { name: /^Yes/ }));
        const finish = within(dialog).getByRole('button', { name: 'Finish check' });
        expect(finish).toBeDisabled();
        await user.click(within(dialog).getByRole('checkbox', { name: /at work/ }));
        await user.click(finish);
        const put = calls.find(c => c.method === 'PUT');
        expect(put?.url).toBe('/api/automation/a1/ai-act');
        expect(put?.body).toEqual({ usesAi: 'no', externalOutput: 'yes', sensitiveUse: 'yes', domains: ['employment'] });
        await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'not_applicable' })));
        expect(onClose).toHaveBeenCalled();
    });

    it('goes back to a question with "change"', async () => {
        const user = userEvent.setup();
        render(withQueryClient(<AiActWizard open onClose={vi.fn()} automationId="a1" />));
        const dialog = await screen.findByRole('dialog');
        await user.click(within(dialog).getByRole('button', { name: 'Next' }));
        await user.click(within(dialog).getByRole('button', { name: 'change' }));
        expect(within(dialog).getByText('question 1 of 3')).toBeInTheDocument();
    });
});

describe('readiness wire helpers', () => {
    it('reads the server questions, their reasons, all ten areas and the previous answers', () => {
        const parsed = parseSuggestion({
            questions: [
                { id: 'usesAi', suggested: 'yes', reasons: [{ code: 'ai_act.uses_ai.steps', params: { count: 1, steps: [{ stepId: 's1', label: 'Summarise', type: 'ai_step' }] }, text: 'Bee found an AI step: "Summarise".' }] },
                { id: 'externalOutput', suggested: 'no', reasons: [] },
                { id: 'sensitiveUse', suggested: null, applicable: true, domains: [{ id: 'education', article: 'Annex III(3)', hint: true }] },
            ],
            previous: { usesAi: 'yes', externalOutput: 'no', sensitiveUse: 'yes', domains: ['education', 'bogus'] },
        });
        expect(parsed.suggested).toEqual({ usesAi: 'yes', externalOutput: 'no', sensitiveUse: null });
        expect(parsed.reasons.usesAi[0]).toMatchObject({ code: 'ai_act.uses_ai.steps', text: 'Bee found an AI step: "Summarise".' });
        expect(parsed.domains[0]).toEqual({ id: 'education', article: 'Annex III(3)', hint: true });
        expect(parsed.domains).toHaveLength(10);
        expect(parsed.previous).toEqual({ usesAi: 'yes', externalOutput: 'no', sensitiveUse: 'yes', domains: ['education'] });
        const t = (_k: string, f?: unknown, p?: Record<string, unknown>) => String(f).replace('{labels}', String(p?.labels));
        expect(reasonText(parsed.reasons.usesAi[0], t as never)).toBe('Bee found an AI step: "Summarise".');
    });

    it('builds the PUT body; areas only travel with a "yes" on question 3', () => {
        expect(answersToBody({ usesAi: 'yes', externalOutput: 'yes', sensitiveUse: 'unknown', domains: ['credit'] }))
            .toEqual({ usesAi: 'yes', externalOutput: 'yes', sensitiveUse: 'unknown' });
        expect(answersToBody({ usesAi: 'yes', externalOutput: 'no', sensitiveUse: 'yes', domains: ['credit'] }))
            .toEqual({ usesAi: 'yes', externalOutput: 'no', sensitiveUse: 'yes', domains: ['credit'] });
    });
});
