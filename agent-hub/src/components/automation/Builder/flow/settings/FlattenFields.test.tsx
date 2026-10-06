import { FLATTEN_MAIL_STEP, flattenMailRoot, flattenOrdersRoot } from '@shared/expr/corpus.mjs';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import scopedStorage from '../../../../../utils/scopedStorage';
import { VariablePickerProvider } from '../../mapping/VariablePickerContext';
import FlattenFields from './FlattenFields';
import { flattenDraft, type FlattenDraft } from './flattenEditorModel';

/** Demo data is invented: Fabrikam invoice mails and Contoso webshop orders (corpus.mjs). */
const MAIL = flattenMailRoot();
const MESSAGES = (MAIL.steps.g_read_many.output as { messages: unknown[] }).messages;
const mailGroups = (real: boolean) => [{
    id: 'g_read_many', label: 'Read many', kind: 'integration_action', basePath: 'steps.g_read_many.output', hasRealData: real,
    sample: MAIL.steps.g_read_many.output, fields: [{ key: 'messages', path: 'steps.g_read_many.output.messages', sample: MESSAGES }],
}];
const ORDERS = flattenOrdersRoot();
const ORDER_STEP = { id: 'fl', type: 'flatten', label: 'One row per line', arrayRef: 'steps.http.output.body.orders[*].lines' };

type Draft = FlattenDraft & { maxItems?: number | '' };
let last: Draft | null = null;

function Harness({ step, root, sampleFromRun = true }: { step: Record<string, unknown>; root: unknown; sampleFromRun?: boolean }) {
    const [draft, setDraft] = useState<Draft>({ ...flattenDraft(step), label: String(step.label || ''), maxItems: '' });
    last = draft;
    const set = (k: string, v: unknown) => setDraft(d => ({ ...d, [k]: v }));
    return (
        <VariablePickerProvider groups={mailGroups(sampleFromRun)} previewSample={root} stepLabelById={new Map([['g_read_many', 'Read many'], ['http', 'HTTP']])} stepTypeById={new Map()}>
            <FlattenFields draft={draft} set={set} groups={mailGroups(sampleFromRun)} previewSample={root} sampleFromRun={sampleFromRun} />
        </VariablePickerProvider>
    );
}

beforeEach(() => {
    scopedStorage.setCurrentUser('test-user');
    try { localStorage.clear(); } catch { /* storage blocked */ }
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); last = null; });

describe('FlattenFields: Simple, the owner\'s mail table (J1)', () => {
    it('says what the table will be, in sentences', () => {
        render(<Harness step={FLATTEN_MAIL_STEP} root={MAIL} />);
        expect(screen.getByText('One row per attachment')).toBeTruthy();
        expect(screen.getByText('64 attachments in 4 messages (last run)')).toBeTruthy();
        expect(screen.getByTestId('flatten-columns-sentence').textContent)
            .toBe('Each row has the attachment\'s 7 fields, plus From, To, Subject and Date from its message.');
        expect(screen.getByText('Left out: Body (long text). Message id and Thread id already come with each attachment.')).toBeTruthy();
    });

    it('shows no path, JSON or max items', () => {
        render(<Harness step={FLATTEN_MAIL_STEP} root={MAIL} />);
        expect(screen.queryByText(/steps\.g_read_many/)).toBeNull();
        expect(screen.queryByText('Max input items')).toBeNull();
        expect(screen.queryByText(/JSON/)).toBeNull();
    });

    it('keeps the preview folded until asked', async () => {
        render(<Harness step={FLATTEN_MAIL_STEP} root={MAIL} />);
        const toggle = screen.getByRole('button', { name: /Preview: 64 rows/ });
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(screen.queryByTestId('output-smart-table')).toBeNull();
        await userEvent.click(toggle);
        const table = screen.getByTestId('output-smart-table');
        // The ids show as they will in the run's table (F50), three rows only.
        expect(within(table).getAllByRole('columnheader').map(th => th.textContent).slice(0, 3)).toEqual(['Filename', 'Attachment id', 'Message id']);
        expect(within(table).getAllByRole('row')).toHaveLength(4);
        expect(screen.queryByTestId('output-wide-view')).toBeNull();
        await userEvent.click(screen.getByRole('button', { name: 'Open' }));
        expect(screen.getByTestId('output-wide-view')).toBeTruthy();
    });

    it('describes the shape, not counts, when the sample is not from a run', () => {
        render(<Harness step={FLATTEN_MAIL_STEP} root={MAIL} sampleFromRun={false} />);
        expect(screen.getByText('Each message holds a list of attachments.')).toBeTruthy();
        expect(screen.queryByText(/\(last run\)/)).toBeNull();
    });
});

describe('FlattenFields: orders with an empty one (J2)', () => {
    it('warns in amber, and Keep it anyway turns keepEmpty on', async () => {
        render(<Harness step={ORDER_STEP} root={ORDERS} />);
        expect(screen.getByTestId('flatten-empty-warn').textContent).toContain('1 of the 5 orders has no lines, so it makes no row.');
        await userEvent.click(screen.getByRole('button', { name: 'Keep it anyway' }));
        expect(last?.keepEmpty).toBe(true);
        expect(screen.getByText(/Orders without lines get one row without line details\./)).toBeTruthy();
        await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
        expect(last?.keepEmpty).toBe(false);
    });

    it('plans the columns on open when the step has none yet (F6)', () => {
        render(<Harness step={ORDER_STEP} root={ORDERS} />);
        expect(last?.parents?.[0].fields?.find(f => f.from === 'status')).toEqual({ from: 'status', to: 'orderStatus', mode: 'copy' });
    });
});

describe('FlattenFields: a renamed parent field (F40)', () => {
    it('says why the field has another name', () => {
        const step = {
            ...FLATTEN_MAIL_STEP,
            parents: [{ ...FLATTEN_MAIL_STEP.parents[0], auto: false, fields: [{ from: 'date', to: 'messageDate', mode: 'copy' }] }],
        };
        render(<Harness step={step} root={MAIL} />);
        expect(screen.getByText('The message\'s Date is called Message date, because each attachment has its own Date.')).toBeTruthy();
    });
});

describe('FlattenFields: Choose fields', () => {
    it('opens the checklist, and an untick removes the field and ends auto (J1 step 8)', async () => {
        render(<Harness step={FLATTEN_MAIL_STEP} root={MAIL} />);
        await userEvent.click(screen.getByRole('button', { name: 'Choose fields' }));
        await userEvent.click(screen.getByRole('checkbox', { name: 'To' }));
        expect(last?.parents?.[0].auto).toBe(false);
        expect(last?.parents?.[0].fields?.map(f => f.from)).toEqual(['id', 'threadId', 'from', 'subject', 'date']);
        expect(screen.getByTestId('flatten-columns-sentence').textContent).toContain('plus From, Subject and Date from its message.');
    });
});

describe('FlattenFields: More options (F44)', () => {
    it('edits the route and the input cap, without the list steps\' "merges into one list" warning', async () => {
        const user = userEvent.setup();
        render(<Harness step={FLATTEN_MAIL_STEP} root={MAIL} />);
        await user.click(screen.getByRole('button', { name: 'More options' }));
        expect(screen.getByText('Source list')).toBeTruthy();
        expect(screen.queryByText(/merges them into one list/)).toBeNull();
        await user.type(screen.getByPlaceholderText('10000'), '500');
        expect(last?.maxItems).toBe(500);
    });
});
