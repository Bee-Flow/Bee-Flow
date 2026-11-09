import { render, screen, within, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import CoworkOptionsBar from './CoworkOptionsBar';
import MailTriggerPanel from './MailTriggerPanel';
import { defaultMailTrigger, describeMailTrigger, normaliseMailTrigger, isMailTriggerReady } from './mailTrigger';
import { withQueryClient } from '@/test/queryWrapper';
import { stub } from '@/test/mocks';
import type { ComponentProps } from 'react';

const AGENTS = [{ id: 'a1', name: 'Mail helper' }];
const t = (_k: string, fb: string, vars?: Record<string, string>) => (vars ? fb.replace(/\{(\w+)\}/g, (_m, k) => vars[k]) : fb);

function setup(over = {}) {
    const props = {
        when: { presetId: 'now', date: '', time: '' },
        onWhenChange: vi.fn(),
        repeatInterval: '',
        onRepeatChange: vi.fn(),
        agentId: '',
        onAgentChange: vi.fn(),
        agents: AGENTS,
        isMobile: false,
        mailTrigger: null,
        onMailTriggerChange: vi.fn(),
        ...over,
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
        triggers: [{ kind: 'app_event', providers: [{ id: 'gmail', label: 'Gmail', events: [{ id: 'mail.new' }] }] }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    render(withQueryClient(<CoworkOptionsBar {...stub<ComponentProps<typeof CoworkOptionsBar>>(props)} />));
    return props;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('CoworkOptionsBar: when a new email arrives', () => {
    it('offers the option only when an agent is selected', async () => {
        const user = userEvent.setup();
        setup({ agentId: '' });
        await user.click(screen.getByTestId('cowork-repeat-chip'));
        expect(screen.queryByText('When a new email arrives…')).toBeNull();
        cleanup();

        setup({ agentId: 'a1' });
        await user.click(screen.getByTestId('cowork-repeat-chip'));
        expect(screen.getByText('When a new email arrives…')).toBeTruthy();
    });

    it('starts a gmail trigger when the option is picked', async () => {
        const user = userEvent.setup();
        const props = setup({ agentId: 'a1' });
        await user.click(screen.getByTestId('cowork-repeat-chip'));
        await user.click(screen.getByText('When a new email arrives…'));
        expect(props.onMailTriggerChange).toHaveBeenCalledWith({ provider: 'gmail', event: 'mail.new', filter: {} });
    });

    it('drops the trigger again when a clock option is picked', async () => {
        const user = userEvent.setup();
        const props = setup({ agentId: 'a1', mailTrigger: defaultMailTrigger('gmail') });
        await user.click(screen.getByTestId('cowork-repeat-chip'));
        await user.click(screen.getByText('Every week'));
        expect(props.onMailTriggerChange).toHaveBeenCalledWith(null);
        expect(props.onRepeatChange).toHaveBeenCalledWith('weekly');
    });

    it('hides the When chip and names the trigger on the chip while one is set', () => {
        setup({ agentId: 'a1', mailTrigger: defaultMailTrigger('gmail') });
        expect(screen.queryByTestId('cowork-when-chip')).toBeNull();
        expect(screen.getByTestId('cowork-repeat-chip').textContent).toContain('On new email · Gmail');
    });
});

describe('MailTriggerPanel', () => {
    it('edits the filter and shows only connected providers', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            triggers: [{ kind: 'app_event', providers: [{ id: 'gmail', label: 'Gmail', events: [{ id: 'mail.new' }] }] }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(withQueryClient(<MailTriggerPanel value={defaultMailTrigger('gmail')} onChange={onChange} />));
        const panel = await screen.findByTestId('mail-trigger-panel');
        await user.type(within(panel).getByLabelText('From contains (optional)'), 'x');
        expect(onChange).toHaveBeenLastCalledWith({ provider: 'gmail', event: 'mail.new', filter: { from: 'x' } });
        expect(within(panel).queryByRole('radiogroup')).toBeNull();
    });

    it('says so when no mail app is connected', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ triggers: [{ kind: 'app_event', providers: [] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
        render(withQueryClient(<MailTriggerPanel value={defaultMailTrigger('gmail')} onChange={vi.fn()} />));
        await waitFor(() => expect(screen.getByTestId('mail-trigger-none')).toBeTruthy());
    });
});

describe('mailTrigger helpers', () => {
    it('drops empty and foreign filter keys', () => {
        expect(normaliseMailTrigger({ provider: 'gmail', event: 'mail.new', filter: { from: ' a ', subjectContains: '', mailbox: 'x@y.nl', labelIds: ['INBOX'] } }))
            .toEqual({ provider: 'gmail', event: 'mail.new', filter: { from: 'a', labelIds: ['INBOX'] } });
        expect(normaliseMailTrigger({ provider: 'msgraph', event: 'mail.new', filter: { mailbox: 'me', labelIds: ['INBOX'] } }).filter).toEqual({});
    });

    it('needs a real address for a shared Outlook mailbox', () => {
        expect(isMailTriggerReady({ provider: 'msgraph', event: 'mail.new', filter: { mailbox: 'team@' } })).toBe(false);
        expect(isMailTriggerReady({ provider: 'msgraph', event: 'mail.new', filter: { mailbox: 'team@example.com' } })).toBe(true);
        expect(isMailTriggerReady(null)).toBe(false);
    });

    it('describes the trigger', () => {
        expect(describeMailTrigger({ provider: 'msgraph', event: 'mail.new', filter: { mailbox: 'team@example.com' } }, t as never)).toBe('On new email · Outlook · team@example.com');
    });
});
