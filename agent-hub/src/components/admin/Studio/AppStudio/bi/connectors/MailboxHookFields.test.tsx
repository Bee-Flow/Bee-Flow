import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import MailboxHookFields from './MailboxHookFields';
import { hookActionOptions } from './mailboxHook';
import type { Connector } from './connectorModel';

const ACTIONS = {
    act_file: { kind: 'sequence', steps: [{ kind: 'ai_generate' }, { kind: 'update_record' }] },
    act_mail: { kind: 'sequence', steps: [{ kind: 'condition', then: [{ kind: 'send_email' }] }] },
};
const connector = (extra: Partial<Connector> = {}): Connector => ({ id: 'conn_1', kind: 'mailbox', groupIntoThreads: true, ...extra } as Connector);

describe('hookActionOptions', () => {
    it('summarises each action and marks the one that sends mail, wherever the step sits', () => {
        expect(hookActionOptions(ACTIONS)).toEqual([
            { id: 'act_file', summary: 'ai_generate, update_record', blocked: false },
            { id: 'act_mail', summary: 'condition', blocked: true },
        ]);
        expect(hookActionOptions(undefined)).toEqual([]);
    });
});

describe('MailboxHookFields', () => {
    it('picking an action sets the hook with the default target', async () => {
        const user = userEvent.setup();
        const patch = vi.fn();
        render(<MailboxHookFields connector={connector()} actions={ACTIONS} patch={patch} />);
        await user.selectOptions(screen.getByLabelText('Run this action'), 'act_file');
        expect(patch).toHaveBeenCalledWith({ onNewRecord: { actionId: 'act_file', target: 'inbound_message' } });
    });

    it('an action with a send_email step cannot be picked', () => {
        render(<MailboxHookFields connector={connector()} actions={ACTIONS} patch={vi.fn()} />);
        const blocked = screen.getByRole('option', { name: /act_mail \(has a step that cannot run on its own\)/ }) as HTMLOptionElement;
        expect(blocked.disabled).toBe(true);
    });

    it('choosing Nothing removes the setting; the target follows the chosen action', async () => {
        const user = userEvent.setup();
        const patch = vi.fn();
        const withHook = connector({ onNewRecord: { actionId: 'act_file', target: 'inbound_message' } });
        render(<MailboxHookFields connector={withHook} actions={ACTIONS} patch={patch} />);
        await user.selectOptions(screen.getByLabelText('For each new'), 'thread');
        expect(patch).toHaveBeenLastCalledWith({ onNewRecord: { actionId: 'act_file', target: 'thread' } });
        await user.selectOptions(screen.getByLabelText('Run this action'), '');
        expect(patch).toHaveBeenLastCalledWith({ onNewRecord: undefined });
    });

    it('offers conversations only when the connector groups into threads', () => {
        render(<MailboxHookFields connector={connector({ groupIntoThreads: false })} actions={ACTIONS} patch={vi.fn()} />);
        expect(screen.queryByRole('option', { name: 'conversation' })).toBeNull();
        expect(screen.getByText(/send_email is not/)).toBeTruthy();
    });
});
