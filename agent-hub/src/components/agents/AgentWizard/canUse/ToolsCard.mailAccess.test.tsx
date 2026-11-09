import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { READ } from './canUseFacts';
import { setAppMailAccess, toolRows } from './toolGrants';
import ToolsCard from './ToolsCard';
import { stub } from '@/test/mocks';
import type { ComponentProps } from 'react';

const t = (key: string, fallback: string) => fallback ?? key;

const APPS = [
    {
        id: 'gmail', label: 'Gmail', available: true, actionsKnown: true, provider: 'google',
        actions: [{ name: 'gmail_search', label: 'gmail search', effect: 'reads' }],
    },
    {
        id: 'outlook', label: 'Outlook', available: true, actionsKnown: true, provider: 'microsoft',
        actions: [{ name: 'outlook_search', label: 'outlook search', effect: 'reads' }],
    },
    {
        id: 'google-drive', label: 'Google Drive', available: true, actionsKnown: true, provider: 'google',
        actions: [{ name: 'drive_search', label: 'drive search', effect: 'reads' }],
    },
];

function renderCard(toolsConfig: unknown = null, props = {}) {
    const rows = toolRows({
        toolsConfig, enabledIntegrations: ['gmail', 'outlook', 'google-drive'], apps: APPS,
        catalogState: READ.OK, providersKnown: true, lentApps: new Set(), lendingEnabled: false,
    } as never);
    return render(<ToolsCard t={t as never} rows={stub<ComponentProps<typeof ToolsCard>['rows']>(rows)} apps={APPS as never} catalogState={READ.OK} {...props} />);
}

afterEach(cleanup);

describe('ToolsCard: mail access', () => {
    it('shows the three-way control on Gmail and Outlook only', () => {
        renderCard();
        const controls = screen.getAllByTestId('agent-tool-mail-access');
        expect(controls).toHaveLength(2);
        expect(within(controls[0]).getByText('Read only')).toBeTruthy();
        expect(within(controls[0]).getByText('Prepare draft')).toBeTruthy();
        expect(within(controls[0]).getByText('Send replies')).toBeTruthy();
    });

    it('writes the chosen preset through onChangeMailAccess', async () => {
        const user = userEvent.setup();
        const onChangeMailAccess = vi.fn();
        renderCard(null, { onChangeMailAccess });
        const [gmail, outlook] = screen.getAllByTestId('agent-tool-mail-access');
        await user.click(within(gmail).getByText('Prepare draft'));
        expect(onChangeMailAccess).toHaveBeenCalledWith('gmail', 'draft');
        await user.click(within(outlook).getByText('Send replies'));
        expect(onChangeMailAccess).toHaveBeenCalledWith('outlook', 'send_reply');
    });

    it('explains draft and send-reply under the control', () => {
        renderCard({ gmail: { actions: ['gmail_search'], mailAccess: 'draft' }, outlook: { actions: ['outlook_search'], mailAccess: 'send_reply' } });
        expect(screen.getByText('Drafts appear in your Gmail drafts for you to check and send.')).toBeTruthy();
        expect(screen.getByText('Only replies in the same thread, never to new addresses.')).toBeTruthy();
    });
});

describe('setAppMailAccess', () => {
    it('stores the preset, keeps the actions, and ignores other apps', () => {
        const base = { gmail: { actions: ['gmail_search'], confirm: 'ask' } };
        expect(setAppMailAccess(base, 'gmail', 'draft')).toEqual({ gmail: { actions: ['gmail_search'], confirm: 'ask', mailAccess: 'draft' } });
        expect(setAppMailAccess({ gmail: { actions: '*', mailAccess: 'draft' } }, 'gmail', null)).toEqual({ gmail: { actions: '*' } });
        expect(setAppMailAccess(base, 'google-drive', 'draft')).toEqual(base);
    });
});
