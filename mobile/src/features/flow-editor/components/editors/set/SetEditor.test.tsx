/**
 * Edit data and a form page on screen: a list-mode step gets its table tools
 * (each card named, each saved in order) and "The whole run" drops them; a
 * form page is created on a tap and waits as long as the author says.
 */

import { fireEvent, screen } from '@testing-library/react-native';

import { api } from '@/core/api/client';
import type { FlowNode } from '@/features/flow-editor/bindings';

import { renderEditor } from '../testing';

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));

beforeEach(() => {
    jest.clearAllMocks();
    (api.get as jest.Mock).mockResolvedValue([]);
});

const sampleRoot = { steps: { src: { output: { rows: [{ name: 'Ann', payload: '{"id":7,"tags":["a"]}' }] } } } };
const groups = [
    {
        id: 'src',
        label: 'Search',
        kind: 'step',
        basePath: 'steps.src.output',
        sample: sampleRoot.steps.src.output,
        fields: [{ key: 'rows', path: 'steps.src.output.rows', sample: sampleRoot.steps.src.output.rows }],
    },
];

describe('SetEditor', () => {
    const listStep = { id: 's1', type: 'set', label: 'Tidy', fields: {}, arrayRef: 'steps.src.output.rows', operations: [] } as unknown as FlowNode;

    it('adds table tools in order and saves them', async () => {
        const h = await renderEditor(listStep, { groups, sampleRoot });
        expect(await screen.findByText('Fields added to each row')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('set-op-add'));
        await fireEvent.press(screen.getByTestId('set-op-add-rowId'));
        await fireEvent.press(screen.getByTestId('set-op-add'));
        await fireEvent.press(screen.getByTestId('set-op-add-sort'));
        expect(screen.getByText('Number the rows')).toBeTruthy();
        expect(h.patch().operations).toEqual([{ op: 'rowId', target: 'id' }, { op: 'sort', key: '' }]);
    });

    it('picks a field out of JSON text in the current row', async () => {
        const h = await renderEditor(listStep, { groups, sampleRoot });
        await fireEvent.press(await screen.findByText('Pick fields from it'));
        await fireEvent.press(screen.getByText('id'));
        // The run reads JSON text as the value it encodes: a plain path, as on the web.
        expect(h.patch().fields).toEqual({ id: { kind: 'ref', path: 'item.payload.id' } });
    });

    it('works on the whole run instead, dropping the list', async () => {
        const h = await renderEditor({ ...listStep, operations: [{ op: 'rowId', target: 'n' }] } as unknown as FlowNode, { groups, sampleRoot });
        await fireEvent.press(await screen.findByRole('button', { name: 'Advanced' }));
        expect(screen.getByText('Switching to “The whole run” also removes the table tools.')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('set-works-on-select'));
        await fireEvent.press(screen.getByTestId('set-works-on-option-single'));
        const patch = h.patch();
        expect('arrayRef' in patch && patch.arrayRef === undefined).toBe(true);
        expect(screen.getByText('Fields')).toBeTruthy();
    });
});

describe('FormPageStepEditor', () => {
    it('creates the page on a tap, and waits as long as asked', async () => {
        const h = await renderEditor({ id: 'p1', type: 'form_page', label: 'More', mode: 'input', form: null } as unknown as FlowNode);
        expect(await screen.findByText('This asks the visitor one more thing, on the same link they are already on.')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('form-page-create'));
        await fireEvent.press(screen.getByTestId('form-page-wait-select'));
        await fireEvent.press(screen.getByTestId('form-page-wait-option-86400'));
        const patch = h.patch();
        expect(patch.waitSeconds).toBe(86400);
        expect((patch.form as { fields?: unknown[] }).fields?.length).toBeGreaterThan(0);
    });

    it('has no waiting for a closing page', async () => {
        await renderEditor({ id: 'p2', type: 'form_page', label: 'Done', mode: 'ending', form: { title: 'Thanks', fields: [] } } as unknown as FlowNode);
        expect(await screen.findByText('Page')).toBeTruthy();
        expect(screen.queryByText('Waiting')).toBeNull();
    });
});
