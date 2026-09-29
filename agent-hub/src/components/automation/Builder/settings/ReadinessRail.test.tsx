import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../../test/queryWrapper';

const { state } = vi.hoisted(() => ({ state: { readiness: null as unknown, check: null as unknown } }));

vi.mock('../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(async (url: string) => {
        if (url.endsWith('/readiness')) return { ok: true, status: 200, json: async () => state.readiness };
        if (url.endsWith('/ai-act/check')) return { ok: true, status: 200, json: async () => state.check };
        return { ok: false, status: 404, json: async () => ({}) };
    }),
}));

import ReadinessRail, { agoText } from './ReadinessRail';
import AiActSection from './AiActSection';

const automation = { id: 'a1', title: 'Collect files', definition: {} };
const base = {
    stepsComplete: { ok: true, issues: [] },
    lastTest: { ok: true, at: new Date(Date.now() - 11 * 60_000).toISOString() },
    aiAct: { required: true, status: 'missing', expiresAt: null },
    description: { ok: false },
    canActivate: false,
};
const QUESTION = {
    id: 'externalOutput', confidence: 'likely', suggested: 'yes',
    evidence: [{ code: 'ai_act.external.email', params: { label: 'Reply' }, text: '"Reply" sends an e-mail that can reach people outside the organisation.' }],
};
const checked = {
    required: true, status: 'valid', outcome: 'minimal', expiresAt: '2027-09-28T10:00:00Z', attestedBy: 'bee', source: 'auto',
    canEdit: true, recorded: true, questions: [],
    findings: [{ id: 'usesAi', answer: 'yes', confidence: 'certain', by: 'bee', evidence: [{ code: 'ai_act.uses_ai.steps', params: { count: 1, steps: [{ label: 'Extract invoice details' }] }, text: 'Bee found an AI step: "Extract invoice details".' }] }],
};

describe('ReadinessRail', () => {
    beforeEach(() => {
        state.readiness = base;
        state.check = { required: true, status: 'missing', questions: [QUESTION], findings: [] };
    });

    it('lists the checklist and asks only the question Bee could not answer', async () => {
        render(withQueryClient(<ReadinessRail automation={automation} />));
        expect(await screen.findByText('All steps filled in')).toBeInTheDocument();
        expect(screen.getByText('Last test passed · 11 min ago')).toBeInTheDocument();
        expect(screen.getByText('Description (recommended)')).toBeInTheDocument();
        expect(await screen.findByText('1 question left')).toBeInTheDocument();
        expect(screen.getByRole('radio', { name: /Yes, customers or the public · Bee thinks this/ })).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByTestId('ready-aiAct')).toHaveAttribute('data-state', 'todo');
        expect(screen.getByRole('link', { name: 'Editor preferences' })).toHaveAttribute('href', '/app/settings/preferences');
    });

    it('shows no AI Act card once Bee checked it by itself, and ticks the row', async () => {
        state.check = checked;
        render(withQueryClient(<ReadinessRail automation={automation} />));
        expect(await screen.findByText('All steps filled in')).toBeInTheDocument();
        await vi.waitFor(() => expect(screen.getByTestId('ready-aiAct')).toHaveAttribute('data-state', 'ok'));
        expect(screen.queryByTestId('aiact-card-rail')).not.toBeInTheDocument();
        expect(screen.queryByTestId('aiact-open')).not.toBeInTheDocument();
    });

    it('hides the AI Act card and row when no check is required', async () => {
        state.readiness = { ...base, aiAct: { required: false, status: 'not_required', expiresAt: null }, lastTest: null };
        render(withQueryClient(<ReadinessRail automation={automation} />));
        expect(await screen.findByText('Not tested yet')).toBeInTheDocument();
        expect(screen.queryByTestId('aiact-card-rail')).not.toBeInTheDocument();
        expect(screen.queryByTestId('ready-aiAct')).not.toBeInTheDocument();
    });

    it('opens the section behind an open item', async () => {
        const onOpenSection = vi.fn();
        render(withQueryClient(<ReadinessRail automation={automation} onOpenSection={onOpenSection} />));
        await userEvent.setup().click(await screen.findByRole('button', { name: 'Description (recommended)' }));
        expect(onOpenSection).toHaveBeenCalledWith('general');
    });

    it('says the time in words', () => {
        const now = Date.parse('2026-09-28T12:00:00Z');
        const t = (_k: string, f?: unknown, p?: Record<string, unknown>) => String(f).replace('{n}', String(p?.n));
        expect(agoText('2026-09-28T11:59:40Z', t as never, now)).toBe('just now');
        expect(agoText('2026-09-28T09:00:00Z', t as never, now)).toBe('3 h ago');
    });
});

describe('AiActSection', () => {
    beforeEach(() => { state.readiness = base; });

    it('a viewer sees the open question but cannot answer it', async () => {
        state.check = { required: true, status: 'missing', questions: [QUESTION], findings: [] };
        render(withQueryClient(<AiActSection automation={{ ...automation, myRole: 'view' }} />));
        expect(await screen.findByText(/Someone who can edit this automation has to answer this/)).toBeInTheDocument();
        expect(screen.getByRole('radio', { name: /^No, internal only/ })).toBeDisabled();
    });

    it('says a prohibited outcome blocks going live, and offers to change the answers', async () => {
        state.readiness = { ...base, aiAct: { required: true, status: 'prohibited', expiresAt: null } };
        state.check = { required: true, status: 'prohibited', questions: [], findings: [] };
        render(withQueryClient(<AiActSection automation={automation} />));
        expect(await screen.findByText(/prohibited practice/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Change answers' })).toBeInTheDocument();
    });

    it('renders nothing when the check does not apply', async () => {
        state.readiness = { ...base, aiAct: { required: false, status: 'not_required', expiresAt: null } };
        const { container } = render(withQueryClient(<AiActSection automation={automation} />));
        await new Promise(r => setTimeout(r, 20));
        expect(container).toBeEmptyDOMElement();
    });

    it('shows a check Bee did by itself with its end date and what Bee found', async () => {
        state.readiness = { ...base, aiAct: { required: true, status: 'valid', expiresAt: '2027-09-28T00:00:00Z' } };
        state.check = checked;
        render(withQueryClient(<AiActSection automation={automation} />));
        const line = await screen.findByTestId('aiact-checked');
        expect(line).toHaveTextContent(/^Checked automatically · Minimal risk, no extra duties · valid until /);
        await userEvent.setup().click(screen.getByText('What Bee found'));
        expect(screen.getByTestId('aiact-findings')).toHaveTextContent('Uses AI: Yes · Bee found 1 AI step(s): "Extract invoice details".');
        expect(screen.getByRole('button', { name: 'Change answers' })).toBeInTheDocument();
    });
});
