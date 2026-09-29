import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../../test/queryWrapper';

const { state } = vi.hoisted(() => ({
    state: {
        check: null as unknown,
        answered: null as unknown,
        calls: [] as Array<{ url: string; method: string; body: unknown }>,
        hold: null as Promise<void> | null,
    },
}));

vi.mock('../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(async (url: string, opts: { method?: string; body?: string } = {}) => {
        const method = opts.method || 'GET';
        state.calls.push({ url, method, body: opts.body ? JSON.parse(opts.body) : null });
        if (url.endsWith('/ai-act/check')) {
            if (state.hold) await state.hold;
            return { ok: true, status: 200, json: async () => state.check };
        }
        if (url.endsWith('/ai-act/answers')) return { ok: true, status: 200, json: async () => state.answered };
        if (url.endsWith('/ai-act/suggestion')) return { ok: true, status: 200, json: async () => ({ questions: [] }) };
        return { ok: false, status: 404, json: async () => ({}) };
    }),
}));

import AiActAutoCard from './AiActAutoCard';

const EXTERNAL = {
    id: 'externalOutput', confidence: 'likely', suggested: 'yes',
    evidence: [
        { code: 'ai_act.external.email', params: { label: 'Reply' }, text: '"Reply" sends an e-mail that can reach people outside the organisation.' },
        { code: 'ai_act.external.ai_flows', params: { label: 'Reply' }, text: 'AI output goes into "Reply".' },
    ],
};
const SENSITIVE = {
    id: 'sensitiveUse', confidence: 'unknown', suggested: null,
    evidence: [{ code: 'ai_act.model.unavailable', params: {}, text: 'Bee could not reach its AI model to check this.' }],
    domains: [{ id: 'employment', article: 'Annex III(4)', hint: true }],
};
const DONE = { required: true, status: 'valid', outcome: 'transparency', source: 'mixed', expiresAt: '2027-09-28T10:00:00Z', questions: [], findings: [], recorded: true };

const card = (canEdit = true) => withQueryClient(<AiActAutoCard automationId="a1" stamp="5|x|0" canEdit={canEdit} />);

describe('AiActAutoCard', () => {
    beforeEach(() => {
        state.calls.length = 0;
        state.hold = null;
        state.answered = DONE;
    });

    it('says Bee is checking while the check runs', async () => {
        let release: () => void = () => {};
        state.hold = new Promise<void>((r) => { release = r; });
        state.check = DONE;
        render(card());
        expect(await screen.findByText('Bee is checking…')).toBeInTheDocument();
        release();
        expect(await screen.findByTestId('aiact-checked')).toHaveTextContent('Checked · Tell people that AI was used · valid until');
    });

    it('one question left: the evidence line, and the answer saves at once', async () => {
        state.check = { required: true, status: 'missing', questions: [SENSITIVE], findings: [] };
        const user = userEvent.setup();
        render(card());
        expect(await screen.findByText('1 question left')).toBeInTheDocument();
        expect(screen.getByTestId('aiact-evidence-sensitiveUse')).toHaveTextContent('Bee could not reach its AI model to check this.');
        // 'unknown' is never preselected.
        for (const r of screen.getAllByRole('radio')) expect(r).toHaveAttribute('aria-checked', 'false');
        expect(screen.queryByRole('button', { name: 'Save answers' })).not.toBeInTheDocument();
        await user.click(screen.getByRole('radio', { name: /^No/ }));
        await vi.waitFor(() => expect(state.calls.find(c => c.method === 'PUT')?.body).toEqual({ sensitiveUse: 'no' }));
        expect(await screen.findByTestId('aiact-checked')).toBeInTheDocument();
    });

    it('a likely suggestion is preselected and confirmed with one click', async () => {
        state.check = { required: true, status: 'missing', questions: [EXTERNAL], findings: [] };
        const user = userEvent.setup();
        render(card());
        const yes = await screen.findByRole('radio', { name: /Yes, customers or the public · Bee thinks this/ });
        expect(yes).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByTestId('aiact-evidence-externalOutput')).toHaveTextContent('"Reply" sends an e-mail that can reach people outside the organisation. AI output goes into "Reply".');
        await user.click(screen.getByRole('button', { name: 'Save answers' }));
        await vi.waitFor(() => expect(state.calls.find(c => c.method === 'PUT')?.body).toEqual({ externalOutput: 'yes' }));
    });

    it('two questions: nothing is sent until both are answered; "yes, an area" waits for the button', async () => {
        state.check = { required: true, status: 'missing', questions: [EXTERNAL, SENSITIVE], findings: [] };
        const user = userEvent.setup();
        render(card());
        expect(await screen.findByText('2 questions left')).toBeInTheDocument();
        const sensitive = screen.getByTestId('aiact-question-sensitiveUse');
        await user.click(within(sensitive).getByRole('radio', { name: /^Yes/ }));
        expect(state.calls.some(c => c.method === 'PUT')).toBe(false);
        await user.click(within(sensitive).getByRole('checkbox', { name: /at work/ }));
        await user.click(screen.getByRole('button', { name: 'Save answers' }));
        await vi.waitFor(() => expect(state.calls.find(c => c.method === 'PUT')?.body)
            .toEqual({ externalOutput: 'yes', sensitiveUse: 'yes', domains: ['employment'] }));
    });

    it('"Change answers" opens the full editor', async () => {
        state.check = { ...DONE, source: 'auto', findings: [] };
        render(card());
        await userEvent.setup().click(await screen.findByRole('button', { name: 'Change answers' }));
        expect(await screen.findByRole('dialog', { name: 'AI Act check' })).toBeInTheDocument();
    });

    it('a failed check says so and can be tried again', async () => {
        const { authFetch } = await import('../../../../utils/helpers');
        vi.mocked(authFetch).mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: 'x' }) } as never);
        state.check = DONE;
        const user = userEvent.setup();
        render(card());
        await user.click(await screen.findByRole('button', { name: 'Try again' }));
        expect(await screen.findByTestId('aiact-checked')).toBeInTheDocument();
    });
});
