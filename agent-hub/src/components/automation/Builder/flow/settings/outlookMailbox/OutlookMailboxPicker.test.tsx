import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ComponentType, ReactNode } from 'react';
import SettingsFormJs from '../../SettingsForm';
import { VariablePickerProvider as VariablePickerProviderJs } from '@/components/automation/Builder/mapping/VariablePickerContext';
import scopedStorage from '@/utils/scopedStorage';
import OutlookMailboxPicker from './OutlookMailboxPicker';
import { OutlookMailNewFilterFields } from './OutlookMailNewFilterFields';
import { isMailboxAddress, mailboxFromBinding, withoutMailboxInput } from './outlookMailbox';

const SettingsForm = SettingsFormJs as unknown as ComponentType<Record<string, unknown>>;
const VariablePickerProvider = VariablePickerProviderJs as unknown as ComponentType<Record<string, unknown> & { children: ReactNode }>;

beforeEach(() => {
    cleanup();
    scopedStorage.setCurrentUser('test-user');
    try { localStorage.clear(); } catch { /* ignore */ }
});

describe('the mailbox picker', () => {
    it('starts on "My mailbox" and writes nothing until an address is typed', async () => {
        const onChange = vi.fn();
        render(<OutlookMailboxPicker value={undefined} onChange={onChange} />);
        expect(screen.getByRole('radio', { name: 'My mailbox' })).toBeChecked();
        expect(screen.queryByLabelText('Shared mailbox address')).toBeNull();

        await userEvent.click(screen.getByRole('radio', { name: 'Shared mailbox' }));
        expect(onChange).not.toHaveBeenCalled();
        await userEvent.type(screen.getByLabelText('Shared mailbox address'), 'team@contoso.com');
        expect(onChange).toHaveBeenLastCalledWith('team@contoso.com');
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('says when the text is not an address yet, and going back to "My mailbox" clears it', async () => {
        const onChange = vi.fn();
        render(<OutlookMailboxPicker value="team@" onChange={onChange} />);
        expect(screen.getByRole('radio', { name: 'Shared mailbox' })).toBeChecked();
        expect(screen.getByRole('alert').textContent).toBe('Enter the e-mail address of the shared mailbox.');
        await userEvent.click(screen.getByRole('radio', { name: 'My mailbox' }));
        expect(onChange).toHaveBeenLastCalledWith(undefined);
    });

    it('warns when the Microsoft connection has no shared-mailbox access', () => {
        const client = new QueryClient();
        client.setQueryData(['microsoft365', 'status'], { configured: true, connected: true, sharedMailboxGranted: false });
        render(
            <QueryClientProvider client={client}>
                <OutlookMailboxPicker value="team@contoso.com" onChange={vi.fn()} />
            </QueryClientProvider>,
        );
        expect(screen.getByText(/no shared-mailbox access yet\. Reconnect Microsoft in Settings → Connections/)).toBeTruthy();
    });

    it('stays quiet when the connection has the access', () => {
        const client = new QueryClient();
        client.setQueryData(['microsoft365', 'status'], { configured: true, connected: true, sharedMailboxGranted: true });
        render(
            <QueryClientProvider client={client}>
                <OutlookMailboxPicker value="team@contoso.com" onChange={vi.fn()} />
            </QueryClientProvider>,
        );
        expect(screen.queryByText(/no shared-mailbox access yet/)).toBeNull();
    });
});

describe('an Outlook step in the builder', () => {
    const catalog = {
        apps: [{
            id: 'outlook',
            label: 'Outlook',
            actions: [{
                name: 'outlook_list_recent',
                label: 'List recent emails',
                inputSchema: {
                    type: 'object',
                    properties: {
                        folder: { type: 'string', description: 'Mail folder' },
                        mailbox: { type: 'string', description: 'Optional: whose mailbox.' },
                    },
                    required: [],
                },
            }],
        }],
    };
    const renderStep = (inputs: Record<string, unknown>, onPatch = vi.fn()) => {
        render(
            <VariablePickerProvider groups={[]} previewSample={null} stepLabelById={new Map()}>
                <SettingsForm
                    step={{ id: 'o1', type: 'integration_action', label: 'Latest mail', tool: 'outlook_list_recent', inputs }}
                    modelTiers={{}}
                    stepIssues={{ errors: [], warnings: [] }}
                    saving={false}
                    saveError={null}
                    onPatch={onPatch}
                    catalog={catalog}
                    groups={[]}
                />
            </VariablePickerProvider>,
        );
        return onPatch;
    };
    const lastPatch = (onPatch: ReturnType<typeof vi.fn>) => onPatch.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;

    it('shows the picker instead of a raw mailbox field, and writes the shared address as a literal', async () => {
        const onPatch = renderStep({});
        expect(screen.queryByTestId('param-mailbox')).toBeNull();
        expect(screen.getByTestId('param-folder')).toBeTruthy();
        const picker = screen.getByRole('group', { name: 'Mailbox' });
        await userEvent.click(within(picker).getByRole('radio', { name: 'Shared mailbox' }));
        await userEvent.type(within(picker).getByLabelText('Shared mailbox address'), 'team@contoso.com');
        await waitFor(() => expect((lastPatch(onPatch)?.inputs as Record<string, unknown>)?.mailbox).toEqual({ kind: 'literal', value: 'team@contoso.com' }), { timeout: 2000 });
    });

    it('opens on the stored shared mailbox and removes the field for "My mailbox"', async () => {
        const onPatch = renderStep({ mailbox: { kind: 'literal', value: 'team@contoso.com' }, folder: { kind: 'literal', value: 'inbox' } });
        expect(screen.getByLabelText('Shared mailbox address')).toHaveValue('team@contoso.com');
        await userEvent.click(screen.getByRole('radio', { name: 'My mailbox' }));
        await waitFor(() => {
            const inputs = lastPatch(onPatch)?.inputs as Record<string, unknown> | undefined;
            expect(inputs && 'mailbox' in inputs).toBe(false);
            expect(inputs?.folder).toEqual({ kind: 'literal', value: 'inbox' });
        }, { timeout: 2000 });
    });

    it('a mailbox bound to data (trigger.output.mailbox) stays in the ordinary field', () => {
        renderStep({ mailbox: { kind: 'ref', path: 'trigger.output.mailbox' } });
        expect(screen.queryByRole('group', { name: 'Mailbox' })).toBeNull();
        expect(screen.getByTestId('param-mailbox')).toBeTruthy();
    });
});

describe('the Outlook "New email" trigger', () => {
    it('has the mailbox picker, says a shared inbox is polled, and writes filter.mailbox', async () => {
        const setFilter = vi.fn();
        render(<OutlookMailNewFilterFields filter={{}} setFilter={setFilter} />);
        await userEvent.click(screen.getByRole('radio', { name: 'Shared mailbox' }));
        expect(screen.getByText(/about once a minute/)).toBeTruthy();
        await userEvent.type(screen.getByLabelText('Shared mailbox address'), 'a@b.co');
        expect(setFilter).toHaveBeenLastCalledWith('mailbox', 'a@b.co');
        await userEvent.click(screen.getByRole('radio', { name: 'My mailbox' }));
        expect(setFilter).toHaveBeenLastCalledWith('mailbox', undefined);
    });
});

describe('the helpers', () => {
    it('accepts what the server accepts, more or less', () => {
        expect(isMailboxAddress('team@contoso.com')).toBe(true);
        expect(isMailboxAddress('team')).toBe(false);
        expect(isMailboxAddress('x/../y@contoso.com')).toBe(false);
    });

    it('reads a binding: own, literal address, or bound to data', () => {
        expect(mailboxFromBinding(undefined)).toBe('');
        expect(mailboxFromBinding({ kind: 'literal', value: 'me' })).toBe('');
        expect(mailboxFromBinding({ kind: 'literal', value: 'team@contoso.com' })).toBe('team@contoso.com');
        expect(mailboxFromBinding({ kind: 'ref', path: 'trigger.output.mailbox' })).toBeNull();
    });

    it('drops mailbox from a schema and leaves the rest', () => {
        const out = withoutMailboxInput({ properties: { a: {}, mailbox: {} }, required: ['a'] });
        expect(Object.keys(out.properties || {})).toEqual(['a']);
        expect(out.required).toEqual(['a']);
    });
});
