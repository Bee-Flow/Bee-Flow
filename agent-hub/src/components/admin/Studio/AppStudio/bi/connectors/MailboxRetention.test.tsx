import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import MailboxFields from './MailboxFields';
import { parseRetentionDays } from './MailboxRetention';
import type { Connector } from './connectorModel';
import type { ModelTable } from '../../tables/tablesManagerModel';

const flatTable: ModelTable = {
    id: 'tbl_m', key: 'messages',
    fields: [{ id: 'f1', key: 'subject', type: 'text' }, { id: 'f2', key: 'received_at', type: 'datetime' }],
};
const twoDates: ModelTable = {
    id: 'tbl_m', key: 'messages',
    fields: [{ id: 'f2', key: 'received_at', type: 'datetime' }, { id: 'f3', key: 'due_on', type: 'date' }],
};

function connector(extra: Partial<Connector> = {}): Connector {
    return {
        id: 'conn_1', kind: 'mailbox', name: 'Support', provider: 'outlook', mode: 'personal',
        sync: { tableId: 'tbl_m', mode: 'upsert', retentionDays: 90 },
        ...extra,
    } as Connector;
}

/** Holds the connector like the editor does, and reports every write. */
function renderFields(initial: Connector, tables: ModelTable[]) {
    const writes: Connector[] = [];
    function Harness() {
        const [value, setValue] = useState(initial);
        const patch = (p: Record<string, unknown>) => {
            const next = { ...value, ...p } as Connector;
            writes.push(next);
            setValue(next);
        };
        return <MailboxFields connector={value} setOpt={vi.fn()} patch={patch} appId="app1" tables={tables} />;
    }
    render(<Harness />);
    return writes;
}

describe('mailbox retention fields', () => {
    it('shows the current retentionDays', () => {
        renderFields(connector(), [flatTable]);
        expect(screen.getByLabelText('Keep mail for (days)')).toHaveValue(90);
    });

    it('offers no way to switch deletion off: a mailbox always has a retention (the server requires it)', () => {
        renderFields(connector(), [flatTable]);
        expect(screen.queryByRole('checkbox')).toBeNull();
    });

    it('saves a new number of days', async () => {
        const user = userEvent.setup();
        const writes = renderFields(connector(), [flatTable]);
        const input = screen.getByLabelText('Keep mail for (days)');
        await user.clear(input);
        await user.type(input, '365');
        expect(writes[writes.length - 1].sync?.retentionDays).toBe(365);
    });

    it.each(['0', '731'])('refuses %s days in the UI', async (raw) => {
        const user = userEvent.setup();
        const writes = renderFields(connector(), [flatTable]);
        const input = screen.getByLabelText('Keep mail for (days)');
        await user.clear(input);
        await user.type(input, raw);
        // Partial entries such as "7" are valid on the way; the refused value is never written.
        expect(writes.map((w) => w.sync?.retentionDays)).not.toContain(Number(raw));
        expect(screen.getByRole('alert')).toHaveTextContent('1 to 730');
    });

    it('parses only whole days between 1 and 730', () => {
        expect(['0', '-5', '1.5', '731', ''].map(parseRetentionDays)).toEqual([null, null, null, null, null]);
        expect([parseRetentionDays('1'), parseRetentionDays('730')]).toEqual([1, 730]);
    });

    it('hides the date column with a single date column', () => {
        renderFields(connector(), [flatTable]);
        expect(screen.queryByLabelText('Date column')).toBeNull();
    });

    it('offers only the main table\'s date columns (retentionField is read there)', () => {
        const child: ModelTable = { id: 'tbl_att', key: 'attachments', fields: [{ id: 'a1', key: 'saved_at', type: 'datetime' }] };
        renderFields(connector({ sync: { tableId: 'tbl_m', mode: 'upsert', retentionDays: 90, children: [{ tableId: 'tbl_att', level: 1 }] } } as Partial<Connector>), [flatTable, child]);
        expect(screen.queryByLabelText('Date column')).toBeNull();
    });

    it('says that mail is removed from the app, not from the provider, with the days and the provider', () => {
        renderFields(connector(), [flatTable]);
        expect(screen.getByText('Mail older than 90 days is removed from the app; it stays in Outlook.')).toBeInTheDocument();
        expect(screen.getByText(/The app’s own records stay\./)).toBeInTheDocument();
    });

    it('names Gmail for a Gmail mailbox and tells a thread-mode desk that conversations stay', () => {
        renderFields(connector({ provider: 'gmail', groupIntoThreads: true } as Partial<Connector>), [flatTable]);
        expect(screen.getByText('Mail older than 90 days is removed from the app; it stays in Gmail.')).toBeInTheDocument();
        expect(screen.getByText(/Conversations and the app’s own records stay\./)).toBeInTheDocument();
    });

    it('offers no date column in thread mode: the conversation table is never purged', () => {
        renderFields(connector({ groupIntoThreads: true } as Partial<Connector>), [twoDates]);
        expect(screen.queryByLabelText('Date column')).toBeNull();
    });

    it('writes retentionField from the date-column select', async () => {
        const user = userEvent.setup();
        const writes = renderFields(connector(), [twoDates]);
        await user.selectOptions(screen.getByLabelText('Date column'), 'due_on');
        expect(writes[writes.length - 1].sync?.retentionField).toBe('due_on');
        await user.selectOptions(screen.getByLabelText('Date column'), '');
        expect('retentionField' in (writes[writes.length - 1].sync as Record<string, unknown>)).toBe(false);
    });
});
