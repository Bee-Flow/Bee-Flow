import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { READ } from './canUseFacts';
import { MAIL_RUN_OPTIONS } from './toolGrants.helpers';
import { setAppMailRunOption, toolRows } from './toolGrants';
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
        id: 'google-drive', label: 'Google Drive', available: true, actionsKnown: true, provider: 'google',
        actions: [{ name: 'drive_search', label: 'drive search', effect: 'reads' }],
    },
];

function renderCard(toolsConfig: unknown = null, props = {}) {
    const rows = toolRows({
        toolsConfig, enabledIntegrations: ['gmail', 'google-drive'], apps: APPS,
        catalogState: READ.OK, providersKnown: true, lentApps: new Set(), lendingEnabled: false,
    } as never);
    return render(<ToolsCard t={t as never} rows={stub<ComponentProps<typeof ToolsCard>['rows']>(rows)} apps={APPS as never} catalogState={READ.OK} {...props} />);
}

afterEach(cleanup);

describe('ToolsCard: runs started by an e-mail', () => {
    it('offers the mail-run switch on other apps, off by default, and writes it through onChangeMailRunOption', async () => {
        const user = userEvent.setup();
        const onChangeMailRunOption = vi.fn();
        renderCard(null, { onChangeMailRunOption });
        const switches = screen.getAllByTestId('agent-tool-mail-runs');
        expect(switches).toHaveLength(1);
        const box = within(switches[0]).getByRole('checkbox');
        expect((box as HTMLInputElement).checked).toBe(false);
        await user.click(box);
        expect(onChangeMailRunOption).toHaveBeenCalledWith('google-drive', MAIL_RUN_OPTIONS.MAIL_RUNS, true);
        expect(screen.queryByTestId('agent-tool-reply-all')).toBeNull();
    });

    it('shows reply-all and the draft note only with "Send replies"', () => {
        renderCard({ gmail: { actions: ['gmail_search'], mailAccess: 'send_reply', replyAll: true } });
        const replyAll = screen.getByTestId('agent-tool-reply-all');
        expect((within(replyAll).getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
        expect(screen.getByText('If the agent used information from outside the thread, the reply is saved as a draft for you.')).toBeTruthy();
        cleanup();
        renderCard({ gmail: { actions: ['gmail_search'], mailAccess: 'draft' } });
        expect(screen.queryByTestId('agent-tool-reply-all')).toBeNull();
    });
});

describe('setAppMailRunOption', () => {
    it('stores only true, removes the key when off, keeps the actions, and ignores a switch that does not apply', () => {
        const base = { 'google-drive': { actions: ['drive_search'] }, gmail: { actions: '*', mailAccess: 'send_reply' } };
        expect(setAppMailRunOption(base, 'google-drive', MAIL_RUN_OPTIONS.MAIL_RUNS, true)['google-drive'])
            .toEqual({ actions: ['drive_search'], mailRuns: true });
        expect(setAppMailRunOption({ 'google-drive': { actions: '*', mailRuns: true } }, 'google-drive', MAIL_RUN_OPTIONS.MAIL_RUNS, false)['google-drive'])
            .toEqual({ actions: '*' });
        expect(setAppMailRunOption(base, 'gmail', MAIL_RUN_OPTIONS.REPLY_ALL, true).gmail)
            .toEqual({ actions: '*', mailAccess: 'send_reply', replyAll: true });
        expect(setAppMailRunOption(base, 'gmail', MAIL_RUN_OPTIONS.MAIL_RUNS, true)).toEqual(base);
        expect(setAppMailRunOption(base, 'google-drive', MAIL_RUN_OPTIONS.REPLY_ALL, true)).toEqual(base);
    });
});
