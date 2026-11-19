import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { VariablePickerProvider } from '@/components/automation/Builder/mapping/VariablePickerContext';
import { tableExtractors } from '../formState/extract/tables';
import { tablePatchers } from '../formState/patch/tables';
import { GROUPS, SAMPLE, SOURCE } from './testKit';
import WriteTableFields from './WriteTableFields';

const STEP = { id: 'w1', type: 'write_table', source: SOURCE, columns: ['Region', { column: 'Amount', header: 'Total' }], highlightColumn: 'Email' };

function mount() {
    let latest: Record<string, unknown> = {};
    function Host() {
        const [draft, setDraft] = useState(() => tableExtractors.write_table(STEP, { label: 'Write table', icon: '' }));
        latest = draft;
        const set = (key: string, value: unknown) => setDraft(d => ({ ...d, [key]: value }));
        return (
            <VariablePickerProvider groups={GROUPS as never} previewSample={SAMPLE} stepLabelById={new Map()}>
                <WriteTableFields draft={draft as never} set={set} previewSample={SAMPLE} />
            </VariablePickerProvider>
        );
    }
    render(<Host />);
    return () => latest;
}

afterEach(() => cleanup());

describe('Write table settings', () => {
    it('edit the file type, the columns and the rows to mark, and patch back what the server reads', async () => {
        const draft = mount();
        await userEvent.click(screen.getByRole('radio', { name: 'CSV (.csv)' }));
        await userEvent.click(screen.getByRole('button', { name: 'Add a column' }));
        await userEvent.type(screen.getByRole('combobox', { name: 'Column 3' }), 'Email');
        await userEvent.click(screen.getByRole('button', { name: 'Remove column 1' }));
        const patch: Record<string, unknown> = {};
        tablePatchers.write_table(patch, STEP, draft());
        expect(patch).toMatchObject({
            source: SOURCE, format: 'csv', delimiter: ';', highlightColumn: 'Email', expiresInDays: 7,
            columns: [{ column: 'Amount', header: 'Total' }, { column: 'Email', header: null }],
        });
    });
});
