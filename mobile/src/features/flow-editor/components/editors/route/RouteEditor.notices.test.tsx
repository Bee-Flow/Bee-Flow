/**
 * The Condition editor around its list, on screen: the next step that still
 * reads the list this Condition filters (W7), the rules a new list cannot
 * read (R11), a whole-run Condition that reads a list as a whole (BFSF-485
 * F3/F4), sending what doesn't match to “Otherwise” (F2) and the one
 * "Otherwise" story (O2). Demo data: Fabrikam mails and sheets.
 */

import { fireEvent, screen, userEvent } from '@testing-library/react-native';

import { api } from '@/core/api/client';
import type { FlowNode } from '@/features/flow-editor/bindings';
import type { FlowDefinition } from '@/features/flow-editor/model';

import { renderEditor } from '../testing';

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));

const MAILS = 'steps.mc_read_many.output.messages';
const MAIL = {
    subject: 'Invoice 0042',
    from: 'billing@fabrikam.example',
    attachments: [{ filename: 'invoice-0042.pdf', mimeType: 'application/pdf' }],
};
const sampleRoot = { steps: { mc_read_many: { output: { messages: [MAIL, { ...MAIL, from: 'info@contoso.example', attachments: [] }] } } } };

const filter = { id: 'mc_condition', type: 'filter', label: 'Condition', arrayRef: MAILS, expr: 'anyOf(fileType(item.attachments[*]), "equals", "pdf") && contains(item.from, "fabrikam")' };
const mailDefinition = {
    trigger: { id: 'trg', type: 'trigger' },
    steps: [
        { id: 'mc_read_many', type: 'action', label: 'Read many' },
        filter,
        { id: 'mc_read_attachment', type: 'action', label: 'Read attachment', forEach: { overRef: `${MAILS}[*].attachments` } },
    ],
    edges: [
        { from: 'mc_read_many', to: 'mc_condition' },
        { from: 'mc_condition', to: 'mc_read_attachment' },
    ],
} as unknown as FlowDefinition;

beforeEach(() => {
    jest.clearAllMocks();
    (api.get as jest.Mock).mockResolvedValue([]);
});

describe('RouteEditor — the steps after a list Condition (W7)', () => {
    it('says the next step still reads the unfiltered list, and re-points it in one edit with a toast', async () => {
        const followRoute = jest.fn(() => [{ stepId: 'mc_read_attachment', from: MAILS, to: 'steps.mc_condition.output.items' }]);
        await renderEditor(filter as unknown as FlowNode, { definition: mailDefinition, sampleRoot, followRoute });
        expect(await screen.findByText(/^“Read attachment” still reads .*Messages, so what this Condition drops still reaches it\.$/)).toBeTruthy();
        await fireEvent.press(screen.getByText('Use what this Condition keeps'));
        expect(followRoute).toHaveBeenCalledWith('mc_condition', ['mc_read_attachment']);
        expect(await screen.findByText('“Read attachment” now works through what “Condition” keeps.')).toBeTruthy();
    });

    it('says nothing where the editor cannot re-point steps', async () => {
        await renderEditor(filter as unknown as FlowNode, { definition: mailDefinition, sampleRoot });
        await screen.findByTestId('route-assist');
        expect(screen.queryByTestId('route-stale-notice')).toBeNull();
    });
});

describe('RouteEditor — changing the list (R11)', () => {
    it('moves the attachment rule onto each attachment, and names the rule an attachment cannot read until it is removed', async () => {
        const h = await renderEditor(filter as unknown as FlowNode, { definition: mailDefinition, sampleRoot });
        await fireEvent.press(await screen.findByRole('button', { name: 'Advanced' }));
        await fireEvent.changeText(screen.getByTestId('route-source-input'), `${MAILS}[*].attachments`);
        expect(h.patch()).toMatchObject({ arrayRef: `${MAILS}[*].attachments`, expr: 'equals(fileType(item), "pdf") && contains(item.from, "fabrikam")' });
        expect(screen.getByText('These rules read From, which each attachment doesn’t have.')).toBeTruthy();
        await fireEvent.press(screen.getByText('Remove those rules'));
        expect(h.patch()).toMatchObject({ expr: 'equals(fileType(item), "pdf")' });
        expect(screen.queryByTestId('route-unfit-notice')).toBeNull();
    });
});

describe('RouteEditor — a whole-run Condition that reads a list (BFSF-485 F3/F4)', () => {
    const condition = { id: 'c1', type: 'condition', label: 'Reiskosten?', expr: 'contains(steps.sheets.output.results[*].name, "Reiskosten")' };
    const definition = {
        trigger: { id: 'trg', type: 'trigger' },
        steps: [{ id: 'sheets', type: 'action', label: 'List sheets' }, condition, { id: 'each', type: 'action', label: 'Process sheet', forEach: { overRef: 'steps.sheets.output.results' } }],
        edges: [
            { from: 'sheets', to: 'c1' },
            { from: 'c1', to: 'each', label: 'then' },
        ],
    } as unknown as FlowDefinition;

    it('says it checks the whole list once and the loop still sees every item, and turns it into a Filter in one edit', async () => {
        const h = await renderEditor(condition as unknown as FlowNode, { definition });
        expect(
            await screen.findByText(/^This checks the whole list .*Results once: the run goes one way for all its items\. It does not filter them\. “Process sheet” still runs once for every item of that list\.$/),
        ).toBeTruthy();
        await fireEvent.press(screen.getByText('Check each item instead'));
        expect(h.patch()).toMatchObject({ type: 'filter', arrayRef: 'steps.sheets.output.results', expr: 'contains(item.name, "Reiskosten")' });
        expect(screen.queryByTestId('route-whole-list-notice')).toBeNull();
    });

    it('stays quiet for a membership check on a list of plain values (labels contain “urgent”)', async () => {
        const labels = { ...condition, expr: 'contains(trigger.output.labels, "urgent")' };
        await renderEditor(labels as unknown as FlowNode, { definition, sampleRoot: { trigger: { output: { labels: ['urgent', 'x'] } } } });
        await screen.findByTestId('route-assist');
        expect(screen.queryByTestId('route-whole-list-notice')).toBeNull();
    });

    it('offers no “Check each item instead” for a list of records no rule reads the items of', async () => {
        const whole = { ...condition, expr: 'steps.sheets.output.results == "Reiskosten"' };
        const sheets = { steps: { sheets: { output: { results: [{ name: 'Reiskosten' }, { name: 'Omzet' }] } } } };
        await renderEditor(whole as unknown as FlowNode, { definition, sampleRoot: sheets });
        expect(await screen.findByTestId('route-whole-list-notice')).toBeTruthy();
        expect(screen.queryByTestId('route-whole-list-notice-fix')).toBeNull();
    });

    it('stays quiet for a rule that only asks whether the list is empty', async () => {
        await renderEditor({ ...condition, expr: 'isEmpty(steps.sheets.output.results)' } as unknown as FlowNode, { definition });
        await screen.findByTestId('route-assist');
        expect(screen.queryByTestId('route-whole-list-notice')).toBeNull();
    });
});

describe('RouteEditor — one output and “Otherwise” (F2, O2)', () => {
    it('tells one Otherwise story, and sends what does not match to “Otherwise” when asked', async () => {
        const h = await renderEditor(filter as unknown as FlowNode, { definition: mailDefinition, sampleRoot });
        expect((await screen.findAllByText('What matches continues; the rest stops here.')).length).toBeGreaterThan(0);
        await fireEvent.press(screen.getByTestId('route-keep-rest'));
        expect(h.patch()).toMatchObject({ type: 'switch', cases: [{ name: 'Output 1', expr: filter.expr }] });
        expect(screen.getAllByText('What matches continues; what doesn\'t goes to “Otherwise”; leave “Otherwise” unconnected to drop it.').length).toBeGreaterThan(0);
        await fireEvent.press(screen.getByText('Several outputs'));
        expect(h.patch()).toMatchObject({ type: 'switch', matchMode: 'all', cases: [{ name: 'Output 1' }, { name: 'Output 2' }] });
        expect(screen.getByText('Each output is checked on its own, so one item can go down several outputs. What matches no output goes to “Otherwise”; leave “Otherwise” unconnected to drop it.')).toBeTruthy();
        expect(screen.queryByTestId('route-keep-rest')).toBeNull();
    });
});

describe('RouteEditor — one output and “Otherwise”, said once (F2)', () => {
    it('says the count with “Otherwise” once the rest goes there', async () => {
        const user = userEvent.setup();
        await renderEditor(filter as unknown as FlowNode, { definition: mailDefinition, sampleRoot });
        expect(await screen.findByText('This node has 1 output.')).toBeTruthy();
        await user.press(screen.getByTestId('route-keep-rest'));
        expect(screen.getByText('This node has 1 output plus “Otherwise”.')).toBeTruthy();
    });

    it('counts the suggested rule’s misses as going to “Otherwise” with keep-rest on, not stopping here', async () => {
        const user = userEvent.setup();
        const keepRest = { id: 'mc_condition', type: 'switch', label: 'Condition', arrayRef: MAILS, cases: [{ name: 'Output 1', expr: 'contains(item.from, "fabrikam")' }] };
        await renderEditor(keepRest as unknown as FlowNode, { definition: mailDefinition, sampleRoot });
        await user.type(await screen.findByTestId('route-assist-input'), 'pdf');
        expect(screen.getByText('1 of 2 sample messages don’t match and go to “Otherwise”.')).toBeTruthy();
        expect(screen.queryByText(/stop here\.$/)).toBeNull();
    });
});

describe('RouteEditor — Suggest outputs on mails with attachments (S4)', () => {
    it('says a mail with both files goes down the first matching output on a first-match router', async () => {
        const user = userEvent.setup();
        const router = { id: 'mc_condition', type: 'switch', label: 'Condition', arrayRef: MAILS, cases: [{ name: 'a', expr: 'contains(item.subject, "a")' }, { name: 'b', expr: 'contains(item.subject, "b")' }] };
        await renderEditor(router as unknown as FlowNode, { definition: mailDefinition, sampleRoot });
        await user.type(await screen.findByTestId('route-assist-input'), 'split by pdf and word');
        expect(screen.getByText('These outputs look at the attachments of each message: a message with a PDF and a Word file goes down the first matching output only.')).toBeTruthy();
        expect(screen.queryByText(/goes down both\.$/)).toBeNull();
    });

    it('says the outputs look at the attachments of each message, and offers to check each attachment instead', async () => {
        const plain = { ...filter, expr: '' };
        const h = await renderEditor(plain as unknown as FlowNode, { definition: mailDefinition, sampleRoot });
        await fireEvent.changeText(await screen.findByTestId('route-assist-input'), 'split by pdf and word');
        expect(screen.getByText('These outputs look at the attachments of each message: a message with a PDF and a Word file goes down both.')).toBeTruthy();
        expect(screen.getByText('Splits the attachments themselves, one by one.')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('route-assist-check-each'));
        expect(h.patch()).toMatchObject({ arrayRef: `${MAILS}[*].attachments` });
        // The sentence stays, and is suggested again against the attachments themselves.
        expect(screen.getByTestId('route-assist-input').props.value).toBe('split by pdf and word');
    });
});

describe('RouteEditor — a list with no sample yet (R10)', () => {
    it('names the list instead of showing its path', async () => {
        await renderEditor(filter as unknown as FlowNode, { definition: mailDefinition });
        expect(await screen.findByText(/Messages · no sample yet: run the step above to see its fields$/)).toBeTruthy();
        expect(screen.queryByText(MAILS)).toBeNull();
    });
});
