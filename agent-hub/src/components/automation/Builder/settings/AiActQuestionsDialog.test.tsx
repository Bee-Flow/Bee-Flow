import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../../test/queryWrapper';

const { state } = vi.hoisted(() => ({
    state: { check: null as unknown, answered: null as unknown, calls: [] as Array<{ url: string; method: string; body: unknown }> },
}));

vi.mock('../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(async (url: string, opts: { method?: string; body?: string } = {}) => {
        const method = opts.method || 'GET';
        state.calls.push({ url, method, body: opts.body ? JSON.parse(opts.body) : null });
        if (url.endsWith('/ai-act/check')) return { ok: true, status: 200, json: async () => state.check };
        if (url.endsWith('/ai-act/answers')) return { ok: true, status: 200, json: async () => state.answered };
        return { ok: false, status: 404, json: async () => ({}) };
    }),
}));

import AiActQuestionsDialog from './AiActQuestionsDialog';

const PROHIBITED = {
    id: 'prohibitedUse', confidence: 'unknown', suggested: 'no',
    evidence: [{ code: 'ai_act.model.unsure', params: {}, text: 'Bee could not tell for sure from the name, description and AI instructions.' }],
};
const EXTERNAL = {
    id: 'externalOutput', confidence: 'likely', suggested: 'yes',
    evidence: [{ code: 'ai_act.external.email', params: { label: 'Reply' }, text: '"Reply" sends an e-mail that can reach people outside the organisation.' }],
};
const VALID = { required: true, status: 'valid', outcome: 'transparency', source: 'mixed', questions: [], findings: [], recorded: true };

function dialog(props: Partial<React.ComponentProps<typeof AiActQuestionsDialog>> = {}) {
    const onAnswered = vi.fn();
    const onClose = vi.fn();
    render(withQueryClient(
        <AiActQuestionsDialog open automationId="a1" stamp="4" action="publish" onClose={onClose} onAnswered={onAnswered} {...props} />,
    ));
    return { onAnswered, onClose };
}

describe('AiActQuestionsDialog', () => {
    beforeEach(() => {
        state.calls.length = 0;
        state.answered = VALID;
    });

    it('asks only the open questions on one screen, then saves and hands back to make it live', async () => {
        state.check = { required: true, status: 'missing', questions: [EXTERNAL, PROHIBITED], findings: [] };
        const user = userEvent.setup();
        const { onAnswered } = dialog();
        const d = await screen.findByRole('dialog', { name: 'AI Act check' });
        expect(await within(d).findByTestId('aiact-question-externalOutput')).toBeInTheDocument();
        expect(within(d).getByTestId('aiact-question-prohibitedUse')).toBeInTheDocument();
        expect(within(d).queryByTestId('aiact-question-usesAi')).not.toBeInTheDocument();
        expect(within(d).queryByText(/question 1 of/)).not.toBeInTheDocument();
        expect(within(d).queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
        expect(within(d).queryByRole('button', { name: 'Previous' })).not.toBeInTheDocument();

        // The likely one is preselected; the unsure one only carries Bee's lean.
        expect(within(d).getByRole('radio', { name: /Yes, customers or the public/ })).toHaveAttribute('aria-checked', 'true');
        const lean = within(within(d).getByTestId('aiact-question-prohibitedUse')).getByRole('radio', { name: /^No · Bee thinks this/ });
        expect(lean).toHaveAttribute('aria-checked', 'false');

        const save = within(d).getByRole('button', { name: 'Save and make live' });
        expect(save).toBeDisabled();
        await user.click(lean);
        expect(state.calls.some(c => c.method === 'PUT')).toBe(false);
        await user.click(save);
        await vi.waitFor(() => expect(onAnswered).toHaveBeenCalledTimes(1));
        expect(state.calls.find(c => c.method === 'PUT')?.body).toEqual({ externalOutput: 'yes', prohibitedUse: 'no' });
    });

    it('names the activate action on its button', async () => {
        state.check = { required: true, status: 'missing', questions: [EXTERNAL], findings: [] };
        dialog({ action: 'activate' });
        expect(await screen.findByRole('button', { name: 'Save and activate' })).toBeEnabled();
    });

    it('with nothing left to ask it hands back straight away, once', async () => {
        state.check = VALID;
        const { onAnswered } = dialog();
        await vi.waitFor(() => expect(onAnswered).toHaveBeenCalledTimes(1));
        await new Promise(r => setTimeout(r, 20));
        expect(onAnswered).toHaveBeenCalledTimes(1);
    });

    it('a prohibited practice is said, not asked', async () => {
        state.check = { required: true, status: 'prohibited', questions: [], findings: [] };
        const { onAnswered, onClose } = dialog();
        expect(await screen.findByText(/prohibited practice/)).toBeInTheDocument();
        expect(onAnswered).not.toHaveBeenCalled();
        await userEvent.setup().click(screen.getByRole('button', { name: 'Close' }));
        expect(onClose).toHaveBeenCalled();
    });
});
