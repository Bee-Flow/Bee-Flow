import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import scopedStorage from '../../../../../../utils/scopedStorage';
import { VariablePickerProvider } from '../../../mapping/VariablePickerContext';
import ReadTableFields from './ReadTableFields';
import { fileOptions } from './fileSources';

const GROUPS = [
    {
        id: 'trigger', label: 'Form', kind: 'trigger', basePath: 'trigger.output', sample: {},
        fields: [
            { key: 'name', path: 'trigger.output.name', sample: 'Ada' },
            { key: 'report', path: 'trigger.output.report', sample: { kind: 'form_upload', filename: 'attachment.pdf' } },
        ],
    },
    {
        id: 'doc', label: 'Make document', kind: 'generate_document', basePath: 'steps.doc.output', sample: {},
        fields: [{ key: 'sourceHandle', path: 'steps.doc.output.sourceHandle', sample: { kind: 'generated_file', fileId: 'f1' } }],
    },
];
const SAMPLE = { steps: { read: { output: { sheets: [{ name: 'Sales' }, { name: 'Notes' }] } } } };

const DRAFT = { source: null, sheets: 'all', headerRow: 1, provenanceSheet: 'auto', format: 'auto', delimiter: 'auto', skipHiddenSheets: true, expiresInDays: 7 };

function mount(initial: Record<string, unknown> = {}) {
    const drafts: Record<string, unknown>[] = [];
    function Host() {
        const [draft, setDraft] = useState({ ...DRAFT, ...initial });
        const set = (key: string, value: unknown) => setDraft(d => { const next = { ...d, [key]: value }; drafts.push(next); return next; });
        return (
            <VariablePickerProvider groups={GROUPS as never} previewSample={SAMPLE} stepLabelById={new Map()}>
                <ReadTableFields draft={draft as never} set={set} stepId="read" groups={GROUPS} previewSample={SAMPLE} />
            </VariablePickerProvider>
        );
    }
    render(<Host />);
    return () => drafts[drafts.length - 1] as Record<string, unknown>;
}

beforeEach(() => {
    scopedStorage.setCurrentUser('test-user');
    try { localStorage.clear(); } catch { /* storage blocked */ }
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the files a Read table step can open', () => {
    it('are the file answers of the form and the files earlier steps made', () => {
        expect(fileOptions(GROUPS).map(o => [o.path, o.label])).toEqual([
            ['trigger.output.report', 'Form · report'],
            ['steps.doc.output.sourceHandle', 'Make document'],
        ]);
    });

    it('are offered as a plain choice, and the pick is stored as a reference', async () => {
        const user = userEvent.setup();
        const last = mount();
        const select = screen.getByRole('combobox', { name: 'File' });
        expect(within(select).getAllByRole('option').map(o => o.textContent)).toEqual(['Choose a table', 'Form · report', 'Make document', 'Another reference…']);
        await user.selectOptions(select, 'trigger.output.report');
        expect(last().source).toEqual({ kind: 'ref', path: 'trigger.output.report' });
    });
});

describe('sheets and header row', () => {
    it('reads all sheets unless told otherwise', async () => {
        const user = userEvent.setup();
        const last = mount();
        expect((screen.getByRole('radio', { name: 'All sheets' }) as HTMLInputElement).checked).toBe(true);
        await user.click(screen.getByRole('radio', { name: 'The first sheet' }));
        expect(last().sheets).toBe('first');
    });

    it('lets sheets be chosen by name, and suggests the ones the last run saw', async () => {
        const user = userEvent.setup();
        const last = mount();
        await user.click(screen.getByRole('radio', { name: 'Choose sheets' }));
        expect(last().sheets).toEqual([]);
        await user.click(screen.getByRole('button', { name: 'Sales' }));
        await user.type(screen.getByRole('textbox', { name: 'Add a sheet name' }), 'Extra{Enter}');
        expect(last().sheets).toEqual(['Sales', 'Extra']);
        expect(screen.queryByRole('button', { name: 'Sales' })).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Remove Sales' }));
        expect(last().sheets).toEqual(['Extra']);
    });

    it('takes the number of the row with the column names', async () => {
        const user = userEvent.setup();
        const last = mount();
        const box = screen.getByRole('spinbutton', { name: 'Row with the column names' });
        await user.clear(box);
        await user.type(box, '3');
        expect(last().headerRow).toBe(3);
        expect(screen.getByText(/If the sheet starts with a title/)).toBeTruthy();
    });
});

describe('advanced settings', () => {
    it('explain each setting in a sentence', () => {
        mount();
        expect(screen.getByText(/Leave on automatic to look at the file itself/)).toBeTruthy();
        expect(screen.getByText(/A sheet someone has hidden is usually not meant to be used/)).toBeTruthy();
        expect(screen.getByText(/says where the data comes from/)).toBeTruthy();
        expect(screen.getByText(/After this many days the stored tables are deleted/)).toBeTruthy();
    });

    it('ask for a separator only for CSV files', async () => {
        const user = userEvent.setup();
        const last = mount({ format: 'xlsx' });
        expect(screen.queryByRole('combobox', { name: 'Separator in a CSV file' })).toBeNull();
        await user.selectOptions(screen.getByRole('combobox', { name: 'File type' }), 'csv');
        await user.selectOptions(screen.getByRole('combobox', { name: 'Separator in a CSV file' }), ';');
        expect(last()).toMatchObject({ format: 'csv', delimiter: ';' });
    });

    it('find the details sheet by itself, or by name', async () => {
        const user = userEvent.setup();
        const last = mount();
        await user.click(screen.getByRole('radio', { name: 'There is none' }));
        expect(last().provenanceSheet).toBe('none');
        await user.click(screen.getByRole('radio', { name: 'The sheet with this name' }));
        await user.clear(screen.getByRole('textbox', { name: 'Name of that sheet' }));
        await user.type(screen.getByRole('textbox', { name: 'Name of that sheet' }), 'About');
        expect(last().provenanceSheet).toBe('About');
        await user.click(screen.getByRole('radio', { name: 'Find it automatically' }));
        expect(last().provenanceSheet).toBe('auto');
    });

    it('keep hidden sheets out, and the tables for a number of days', async () => {
        const user = userEvent.setup();
        const last = mount();
        await user.click(screen.getByRole('checkbox', { name: 'Skip hidden sheets' }));
        expect(last().skipHiddenSheets).toBe(false);
        const days = screen.getByRole('spinbutton', { name: 'Keep the tables for (days)' });
        await user.clear(days);
        await user.type(days, '30');
        expect(last().expiresInDays).toBe(30);
    });
});
