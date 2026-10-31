import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import MailboxFields from './MailboxFields';
import { mailboxProviderFields } from './connectorModel';
import type { Connector } from './connectorModel';


/**
 * `sharedMode` and `integrationId` follow from the provider and the server refuses a
 * model where they disagree. A connector that started as Gmail and is switched to
 * Outlook therefore has to carry Outlook's derived values in the same edit, or the
 * save fails with "sharedMode is derived from the provider" and the old Gmail model
 * keeps running (which then asks the viewer to connect Gmail for an Outlook mailbox).
 */
describe('mailboxProviderFields', () => {
    it('derives the integration and the shared-mailbox mode from the provider', () => {
        expect(mailboxProviderFields('outlook')).toEqual({ integrationId: 'outlook', sharedMode: 'delegated_mailbox' });
        expect(mailboxProviderFields('gmail')).toEqual({ integrationId: 'gmail', sharedMode: 'delivered_alias' });
        expect(mailboxProviderFields(undefined)).toEqual({ integrationId: undefined, sharedMode: undefined });
    });
});

describe('MailboxFields provider switch', () => {
    const gmail: Connector = {
        id: 'conn_1', kind: 'mailbox', name: 'Sales', provider: 'gmail', mode: 'shared', address: 'info@example.test',
        integrationId: 'gmail', sharedMode: 'delivered_alias',
    } as Connector;

    it('rewrites the derived fields together with the provider', async () => {
        const user = userEvent.setup();
        const patch = vi.fn();
        render(<MailboxFields connector={gmail} setOpt={vi.fn()} patch={patch} appId="app1" />);
        await user.selectOptions(screen.getByLabelText('Mail provider'), 'outlook');
        expect(patch).toHaveBeenCalledWith({ provider: 'outlook', integrationId: 'outlook', sharedMode: 'delegated_mailbox' });
    });

    it('drops the derived fields when no provider is chosen', async () => {
        const user = userEvent.setup();
        const patch = vi.fn();
        render(<MailboxFields connector={gmail} setOpt={vi.fn()} patch={patch} appId="app1" />);
        await user.selectOptions(screen.getByLabelText('Mail provider'), '');
        expect(patch).toHaveBeenCalledWith({ provider: undefined, integrationId: undefined, sharedMode: undefined });
    });
});
