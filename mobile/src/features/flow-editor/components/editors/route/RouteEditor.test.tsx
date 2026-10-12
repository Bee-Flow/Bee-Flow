/**
 * The Condition, loop and AI step editors on screen: choosing several outputs
 * turns a condition into a router, a rule built from a named field saves as
 * its expression, collapsing a wired router asks first; a loop picks its list
 * by name; an AI step takes its prompt and structured output.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { api } from '@/core/api/client';
import type { FlowNode } from '@/features/flow-editor/bindings';
import { shownText } from '@/features/flow-editor/components/fields/testing';

import { renderEditor } from '../testing';

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));

const get = api.get as jest.Mock;

const groups = [
    {
        id: 'trg',
        label: 'Trigger',
        kind: 'trigger',
        basePath: 'trigger.output',
        sample: { subject: 'Hello', rows: [{ a: 1 }, { a: 2 }] },
        fields: [
            { key: 'subject', path: 'trigger.output.subject', sample: 'Hello' },
            { key: 'rows', path: 'trigger.output.rows', sample: [{ a: 1 }, { a: 2 }] },
        ],
    },
];
const sampleRoot = { trigger: { output: { subject: 'Hello', rows: [{ a: 1 }, { a: 2 }] } } };

beforeEach(() => {
    jest.clearAllMocks();
    get.mockResolvedValue([]);
});

describe('RouteEditor', () => {
    it('asks for a hand-picked field with Insert data, and shows a formula’s example in its pills’ words', async () => {
        await renderEditor({ id: 'c1', type: 'condition', label: 'Check', expr: 'true' } as FlowNode, { groups, sampleRoot });
        await fireEvent.press(await screen.findByTestId('condition-row-1-field'));
        await fireEvent.press(screen.getByText('Use an expression instead'));
        expect(screen.getByPlaceholderText('Tap Insert data to pick a field')).toBeTruthy();
        await renderEditor({ id: 'c2', type: 'condition', label: 'Check', expr: 'len(trigger.output.rows) > 2' } as FlowNode);
        expect(await screen.findByPlaceholderText('‹Previous step ▸ Amount› > 1000')).toBeTruthy();
    });

    it('saves a field typed as an expression as the path it names, not as the words, and shows it as a pill', async () => {
        const h = await renderEditor({ id: 'c1', type: 'condition', label: 'Check', expr: 'true' } as FlowNode, { groups, sampleRoot });
        await fireEvent.press(await screen.findByTestId('condition-row-1-field'));
        await fireEvent.press(screen.getByText('Use an expression instead'));
        await fireEvent.changeText(screen.getByTestId('condition-row-1-expr-input'), 'trigger.output.subject');
        await fireEvent.changeText(screen.getByLabelText('Value'), 'urgent');
        // Was `"trigger.output.subject" == "urgent"`: two constants, never true.
        // Text "is" ignores upper/lower case (R7): equals().
        expect(h.patch()).toMatchObject({ expr: 'equals(trigger.output.subject, "urgent")' });
        // Typed by hand it stays text under the caret, and is a pill once the field is left.
        await fireEvent(screen.getByTestId('condition-row-1-expr-input'), 'blur');
        expect(shownText(screen.getByTestId('condition-row-1-expr-input'))).toBe(' Trigger ▸ Subject ');
        await fireEvent.changeText(screen.getByTestId('condition-row-1-expr-input'), 'len(trigger.output.subject)');
        expect(h.patch()).toMatchObject({ expr: 'equals(len(trigger.output.subject), "urgent")' });
    });

    it('builds a rule from a named field and saves it as the expression', async () => {
        const h = await renderEditor({ id: 'c1', type: 'condition', label: 'Check', expr: 'true' } as FlowNode, { groups, sampleRoot });
        await fireEvent.press(await screen.findByTestId('condition-row-1-field'));
        await fireEvent.press(screen.getByText('Subject'));
        await fireEvent.changeText(screen.getByLabelText('Value'), 'urgent');
        expect(h.patch()).toMatchObject({ expr: 'equals(trigger.output.subject, "urgent")' });
    });

    it('suggests outputs from plain words, counts them on the sample rows, and applies them on accept', async () => {
        const files = [{ name: 'a.pdf' }, { name: 'b.docx' }, { name: 'c.png' }];
        const fileGroups = [{
            id: 'trg', label: 'Trigger', kind: 'trigger', basePath: 'trigger.output', sample: { files },
            fields: [{ key: 'files', path: 'trigger.output.files', sample: files }],
        }];
        const step = { id: 'c1', type: 'filter', label: 'Split', arrayRef: 'trigger.output.files', expr: '' } as unknown as FlowNode;
        const h = await renderEditor(step, { groups: fileGroups, sampleRoot: { trigger: { output: { files } } } });
        await fireEvent.changeText(await screen.findByTestId('route-assist-input'), 'split these files by pdf and word');
        expect(screen.getByText('Split by file type — 2 outputs, using File type:')).toBeTruthy();
        // Read back as the canvas says it (S3), counted in the list's own word (P3).
        expect(screen.getAllByText(/File type is (PDF|Word) · 1 of 3 sample files$/).length).toBe(2);
        expect(screen.getByText('1 of 3 sample files match none of these and go to “Otherwise”.')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('route-assist-apply'));
        const patch = h.patch() as { type?: string; cases?: { name: string; expr: string }[] };
        expect(patch.type).toBe('switch');
        expect(patch.cases?.map((c) => c.name)).toEqual(['pdf', 'word']);
        expect(patch.cases?.[1]?.expr).toBe('equals(fileType(item), "word")');
    });

    it('says nothing about the rest when every sample row has an output (S5)', async () => {
        const files = [{ name: 'a.pdf' }, { name: 'b.docx' }];
        const fileGroups = [{
            id: 'trg', label: 'Trigger', kind: 'trigger', basePath: 'trigger.output', sample: { files },
            fields: [{ key: 'files', path: 'trigger.output.files', sample: files }],
        }];
        const step = { id: 'c1', type: 'filter', label: 'Split', arrayRef: 'trigger.output.files', expr: '' } as unknown as FlowNode;
        await renderEditor(step, { groups: fileGroups, sampleRoot: { trigger: { output: { files } } } });
        await fireEvent.changeText(await screen.findByTestId('route-assist-input'), 'split these files by pdf and word');
        expect(screen.getAllByText(/File type is (PDF|Word) · 1 of 2 sample files$/).length).toBe(2);
        expect(screen.queryByText(/match none of these/)).toBeNull();
    });

    it('says what it understands when a sentence is not something it can read', async () => {
        await renderEditor({ id: 'c1', type: 'condition', label: 'Check', expr: 'true' } as FlowNode, { groups, sampleRoot });
        await fireEvent.changeText(await screen.findByTestId('route-assist-input'), 'whatever feels right');
        expect(screen.getByText(/Nothing recognised there yet/)).toBeTruthy();
        expect(screen.queryByTestId('route-assist-apply')).toBeNull();
    });

    it('turns a condition into a two-output router that fans out', async () => {
        const h = await renderEditor({ id: 'c1', type: 'condition', label: 'Check', expr: 'trigger.output.subject == "x"' } as FlowNode, { groups, sampleRoot });
        await fireEvent.press(await screen.findByText('Several outputs'));
        expect(h.patch()).toMatchObject({ type: 'switch', matchMode: 'all' });
        expect(screen.getByTestId('route-output-2')).toBeTruthy();
    });

    it('asks before collapsing a router whose outputs are wired', async () => {
        const step = {
            id: 's1',
            type: 'switch',
            label: 'Route',
            cases: [
                { name: 'a', expr: 'trigger.output.subject == "a"' },
                { name: 'b', expr: 'trigger.output.subject == "b"' },
            ],
        } as unknown as FlowNode;
        const definition = { trigger: { id: 'trg', type: 'trigger' }, steps: [step], edges: [{ from: 's1', to: 'x', label: 'case:b', caseName: 'b' }] };
        const h = await renderEditor(step, { groups, sampleRoot, definition: definition as never });
        await fireEvent.press(await screen.findByText('One output'));
        expect(await screen.findByText(/removes b\. That output is wired on the canvas/)).toBeTruthy();
        await fireEvent.press(screen.getByText('Remove them anyway'));
        await waitFor(() => expect(h.patch()).toMatchObject({ type: 'condition', expr: 'trigger.output.subject == "a"' }));
    });

    it('renames an output only when the name is committed, and refuses a sibling’s name', async () => {
        const step = {
            id: 's1',
            type: 'switch',
            label: 'Route',
            cases: [
                { name: 'a', expr: 'trigger.output.subject == "a"' },
                { name: 'b', expr: 'trigger.output.subject == "b"' },
            ],
        } as unknown as FlowNode;
        const h = await renderEditor(step, { groups, sampleRoot });
        const box = await screen.findByTestId('route-output-1-name');
        await fireEvent.changeText(box, 'b');
        await fireEvent(box, 'blur');
        expect(await screen.findByText('A case named “b” already exists.')).toBeTruthy();
        await fireEvent.changeText(box, 'urgent');
        expect(h.patch().cases).toBeUndefined();
        await fireEvent(box, 'blur');
        expect((h.patch().cases as { name: string }[]).map((c) => c.name)).toEqual(['urgent', 'b']);
    });
});

describe('LoopEditor', () => {
    it('picks the list to repeat over by name, and names the item after it', async () => {
        const h = await renderEditor({ id: 'l1', type: 'loop', label: 'Each', overRef: '', body: [] } as unknown as FlowNode, { groups, sampleRoot });
        // Named as the loop's card and the canvas name it, not as `trigger.output.rows`.
        await fireEvent.press(await screen.findByText('Trigger ▸ Rows'));
        expect(h.patch()).toMatchObject({ overRef: 'trigger.output.rows', itemVar: 'row' });
        expect(screen.getAllByText('Trigger ▸ Rows').length).toBe(2);
        expect(screen.getByText('No steps inside the loop yet — add them under the loop in the outline.')).toBeTruthy();
    });

    it('says how each item is reached in its pill’s words, and asks for a typed list with Insert data', async () => {
        await renderEditor({ id: 'l1', type: 'loop', label: 'Each', overRef: '', itemVar: 'row', body: [] } as unknown as FlowNode, { groups, sampleRoot });
        expect(await screen.findByText('The steps inside read each item as “Each row”; pick it with Insert data.')).toBeTruthy();
        await fireEvent.press(screen.getByRole('button', { name: 'Advanced' }));
        expect(screen.getByPlaceholderText('Tap Insert data to pick a list')).toBeTruthy();
    });
});

describe('LoopEditor item name', () => {
    it('lets the name be cleared and retyped, instead of snapping back to "item"', async () => {
        const h = await renderEditor({ id: 'l1', type: 'loop', label: 'Each', overRef: '', itemVar: 'item', body: [] } as unknown as FlowNode, { groups, sampleRoot });
        const box = await screen.findByLabelText('Name each item');
        await fireEvent.changeText(box, '');
        expect(screen.getByLabelText('Name each item').props.value).toBe('');
        await fireEvent.changeText(screen.getByLabelText('Name each item'), 'order');
        expect(h.patch()).toMatchObject({ itemVar: 'order' });
    });
});

describe('AiStepEditor', () => {
    it('takes a prompt and a structured output', async () => {
        const h = await renderEditor({ id: 'ai1', type: 'ai_step', label: 'Think', prompt: '' } as FlowNode);
        await fireEvent.changeText(await screen.findByTestId('ai-prompt-input'), 'Summarise {{trigger.output.subject}}');
        await fireEvent.press(screen.getByRole('button', { name: 'Structured output' }));
        await fireEvent.press(screen.getByTestId('output-field-add'));
        expect(h.patch()).toMatchObject({ prompt: 'Summarise {{trigger.output.subject}}', outputSchema: { type: 'object', properties: { field: { type: 'string' } } } });
    });
});
