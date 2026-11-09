/**
 * CoworkPage with a mail trigger: the message after creating one, and what a
 * refused save of one says. The harness mirrors CoworkPage.test.jsx.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import CoworkPage from './CoworkPage';
import { withQueryClient } from '../../test/queryWrapper';

const api = vi.hoisted(() => ({
    listCowork: vi.fn(),
    createCowork: vi.fn(),
    updateCowork: vi.fn(),
    toggleCowork: vi.fn(),
    runCoworkNow: vi.fn(),
    deleteCowork: vi.fn(),
    composeCowork: vi.fn(),
    listCoworkRuns: vi.fn(),
    listCoworkAgents: vi.fn(),
}));
const beta = vi.hoisted(() => ({ agents: false }));

vi.mock('../../api/coworkApi', () => api);
vi.mock('../licensing/EntitlementsContext', () => ({
    useEntitlements: () => ({ loading: false, can: (f) => beta.agents && f === 'agent_routines' }),
}));
vi.mock('../../hooks/useIntegrationStatus', () => ({
    useIntegrationStatus: () => ({
        integrationStatus: { isGoogleUser: true, enabledApps: null, orgEnabledIntegrations: null },
    }),
}));
vi.mock('../../hooks/useModelTierSelection', () => ({
    default: () => ({
        modelTiers: { auto: { model: 'gpt-4o' }, thinking: { model: 'gpt-5' } },
        selectedTier: 'thinking',
        setSelectedTier: vi.fn(),
    }),
}));

const MAIL_ITEM = {
    id: 'w1',
    title: 'Mail helper',
    prompt: 'Answer new mail',
    isActive: true,
    lastStatus: 'pending',
    nextRunAt: null,
    repeatInterval: null,
    runCount: 0,
    agentId: 'a1',
    triggerKind: 'app_event',
    trigger: { provider: 'gmail', event: 'mail.new', filter: {} },
};

beforeEach(() => {
    vi.clearAllMocks();
    api.listCowork.mockResolvedValue({ items: [], maxItems: 10 });
    api.createCowork.mockResolvedValue({ id: 'new', title: 'Answer new mail' });
    api.listCoworkAgents.mockResolvedValue([{ id: 'a1', name: 'Mail helper' }]);
    api.listCoworkRuns.mockResolvedValue({ runs: [], total: 0 });
    api.composeCowork.mockRejectedValue(new Error('offline'));
    beta.agents = true;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
        triggers: [{ kind: 'app_event', providers: [{ id: 'gmail', label: 'Gmail', events: [{ id: 'mail.new' }] }] }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
});
afterEach(() => { beta.agents = false; vi.unstubAllGlobals(); });

describe('CoworkPage — mail triggers', () => {
    it('says it is watching for mail after a mail trigger is created', async () => {
        const user = userEvent.setup();
        render(withQueryClient(<CoworkPage />));
        await screen.findByTestId('cowork-brief-input');

        await user.type(screen.getByTestId('cowork-brief-input'), 'Answer new mail');
        await user.click(await screen.findByTestId('cowork-agent-chip'));
        await user.click(screen.getByText('Mail helper'));
        await user.click(screen.getByTestId('cowork-repeat-chip'));
        await user.click(screen.getByText('When a new email arrives…'));
        await user.click(screen.getByTestId('cowork-send'));

        expect(await screen.findByText('Watching for new email.')).toBeInTheDocument();
        expect(screen.queryByText('Scheduled.')).not.toBeInTheDocument();
    });

    it('explains mail_not_connected when saving a mail trigger is refused', async () => {
        const user = userEvent.setup();
        api.listCowork.mockResolvedValue({ items: [MAIL_ITEM], maxItems: 10 });
        api.updateCowork.mockRejectedValue(Object.assign(new Error('mail_not_connected'), { code: 'mail_not_connected' }));
        render(withQueryClient(<CoworkPage initialCoworkId="w1" />));
        await screen.findByTestId('cowork-detail');
        await user.click(screen.getByTestId('cowork-edit'));
        await user.click(await screen.findByTestId('cowork-edit-save'));

        expect(await screen.findByText(/mail account is not connected/)).toBeInTheDocument();
        expect(api.updateCowork.mock.calls[0][1].triggerKind).toBe('app_event');
    });
})
