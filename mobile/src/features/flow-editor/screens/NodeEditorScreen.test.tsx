/**
 * The step editor over a real draft store and a mocked HTTP client: a step
 * opens in its declarative editor, an edit lands in the automation's draft, the
 * header pages in run order, "Test step" shows the output and it can be
 * pinned, a type with no form gets the JSON view, and a step that is gone
 * says so.
 */

import { QueryClient } from '@tanstack/react-query';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { ConfirmProvider } from '@/shared/patterns';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { NodeEditorScreen } from './NodeEditorScreen';
import { getByShownText } from '../components/fields/testing';
import type { FlowDefinition } from '../model/types';
import { peekDraftStore, resetDraftRegistry } from '../state/registry';

jest.setTimeout(30_000);

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

const mockRouter = { back: jest.fn(), setParams: jest.fn(), push: jest.fn(), replace: jest.fn() };
jest.mock('expo-router', () => ({
    useRouter: () => mockRouter,
    useNavigation: () => ({ addListener: () => () => undefined, dispatch: jest.fn() }),
}));

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
const put = api.put as jest.Mock;

const DEF = {
    trigger: { id: 'trg', type: 'trigger', kind: 'manual', label: 'Start' },
    steps: [
        { id: 'n1', type: 'notification', label: 'Tell me', icon: null, title: 'Hi', body: 'Hello' },
        { id: 'w1', type: 'wait', label: 'Pause', icon: null, seconds: 60 },
        { id: 'x1', type: 'mystery_step', label: 'Odd', icon: null, knob: 3 },
    ],
    edges: [
        { from: 'trg', to: 'n1' },
        { from: 'n1', to: 'w1' },
        { from: 'w1', to: 'x1' },
    ],
} as unknown as FlowDefinition;

const row = (definition: unknown, version = 1) => ({ id: 'a1', definition, version, title: 'Flow', isActive: false });

// "Test step" is a mutation, and a mutation's default 5-minute gc timer would
// keep Jest alive long after the last test.
const client = () =>
    new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });

function render(stepId: string, section: string | null = null) {
    return renderWithProviders(
        <ConfirmProvider>
            <ToastProvider>
                <NodeEditorScreen automationId="a1" stepId={stepId} section={section} />
            </ToastProvider>
        </ConfirmProvider>,
        { queryClient: client() },
    );
}

const stepIn = (id: string) => (peekDraftStore('a1')?.getState().definition?.steps || []).find((s) => s.id === id) as Record<string, unknown> | undefined;

beforeEach(() => {
    jest.clearAllMocks();
    get.mockImplementation(async (path: string) => (path === '/api/automation/a1' ? { automation: row(DEF, 3) } : {}));
    put.mockImplementation(async (_path: string, body: { definition: unknown }) => ({ automation: row(body.definition, 4), warnings: [] }));
});

afterEach(() => resetDraftRegistry());

describe('NodeEditorScreen', () => {
    it('names the step and where it runs, and opens on its settings', async () => {
        await render('n1');
        expect(await screen.findByText('Tell me')).toBeTruthy();
        expect(screen.getByText(/Step 2 of 4/)).toBeTruthy();
        expect(screen.getByRole('tab', { name: /Settings/ })).toBeTruthy();
        expect(getByShownText('Hello')).toBeTruthy();
    });

    it('writes an edit into the automation’s draft', async () => {
        await render('n1');
        await fireEvent.changeText(await waitFor(() => getByShownText('Hello')), 'Hello {{trigger.output.name}}');
        expect(stepIn('n1')?.body).toBe('Hello {{trigger.output.name}}');
        expect(peekDraftStore('a1')?.getState().dirty).toBe(true);
    });

    it('renames the step from the name field', async () => {
        await render('w1');
        await fireEvent.changeText(await screen.findByTestId('step-name'), 'Cool down');
        expect(stepIn('w1')).toMatchObject({ label: 'Cool down', labelManual: true });
        expect(screen.getByText('Cool down')).toBeTruthy();
    });

    it('gives the step a symbol of its own, and back to its type’s', async () => {
        await render('w1');
        await fireEvent.press(await screen.findByTestId('step-symbol'));
        await fireEvent.press(screen.getByTestId('symbol-Mail'));
        expect(stepIn('w1')).toMatchObject({ icon: 'Mail', iconManual: true });
        await fireEvent.press(screen.getByTestId('step-symbol'));
        await fireEvent.press(screen.getByText('Default'));
        expect(stepIn('w1')?.icon ?? null).toBeNull();
    });

    it('switches a step off', async () => {
        await render('w1');
        await fireEvent(await screen.findByTestId('step-disabled'), 'valueChange', true);
        expect(stepIn('w1')?.disabled).toBe(true);
    });

    it('offers a trigger no off switch: the runner never checks one there', async () => {
        await render('trg');
        expect(await screen.findByTestId('step-name')).toBeTruthy();
        expect(screen.queryByTestId('step-disabled')).toBeNull();
    });

    it('pages to the previous and next step in run order', async () => {
        await render('n1');
        await fireEvent.press(await screen.findByTestId('step-next'));
        expect(mockRouter.setParams).toHaveBeenLastCalledWith({ stepId: 'w1' });
        await fireEvent.press(screen.getByTestId('step-prev'));
        expect(mockRouter.setParams).toHaveBeenLastCalledWith({ stepId: 'trg' });
    });

    it('tests the step, shows its output and pins it', async () => {
        post.mockResolvedValue({
            run: null,
            steps: [],
            stepRecord: { runId: 'r1', stepId: 'w1', status: 'success', output: { waited: 60, note: 'ok' } },
        });
        await render('w1');
        await fireEvent.press(await screen.findByTestId('step-test'));
        await waitFor(() => expect(post).toHaveBeenCalledWith('/api/automation/a1/steps/w1/run', { mode: 'only' }, expect.anything()));
        // Drawn readably (a record's fields), not as the JSON tree's "ok".
        expect(await screen.findByText('ok')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('output-pin'));
        expect(stepIn('w1')?.pinnedOutput).toEqual({ waited: 60, note: 'ok' });
    });

    it('writes an output by hand, and refuses one that is not JSON', async () => {
        await render('w1');
        await fireEvent.press(await screen.findByRole('tab', { name: /Output/ }));
        await fireEvent.press(screen.getByTestId('output-edit'));
        // The field list is the face; the JSON is one disclosure away.
        await fireEvent.press(screen.getByTestId('output-raw-toggle'));
        await fireEvent.changeText(screen.getByTestId('output-json'), '{nope');
        await fireEvent.press(screen.getByTestId('output-save'));
        expect(screen.getByText(/^Invalid JSON/)).toBeTruthy();
        await fireEvent.changeText(screen.getByTestId('output-json'), '{"waited": 1}');
        await fireEvent.press(screen.getByTestId('output-save'));
        expect(stepIn('w1')).toMatchObject({ pinnedOutput: { waited: 1 }, pinnedSource: 'edited' });
    });

    it('shows a type with no form as JSON, and applies an edit', async () => {
        await render('x1');
        const box = await screen.findByTestId('step-json');
        expect(JSON.parse(box.props.value)).toEqual({ knob: 3 });
        await fireEvent.changeText(box, '{"knob": 4}');
        await fireEvent.press(screen.getByTestId('step-json-apply'));
        expect(stepIn('x1')?.knob).toBe(4);
    });

    it('opens the section a finding points at', async () => {
        await render('n1', 'advanced');
        expect((await screen.findByRole('button', { name: 'Advanced' })).props.accessibilityState).toMatchObject({ expanded: true });
    });

    it('keeps that section shut when no finding points at it', async () => {
        await render('n1');
        expect((await screen.findByRole('button', { name: 'Advanced' })).props.accessibilityState).toMatchObject({ expanded: false });
    });

    it('edits a step held in a loop’s body by its address, and pages through the body', async () => {
        const loop = { id: 'lp', type: 'loop', label: 'Each row', itemVar: 'row', overRef: 'trigger.output.rows', body: [
            { id: 'b1', type: 'wait', label: 'Breathe', seconds: 5 },
            { id: 'b2', type: 'notification', label: 'Ping', title: '', body: 'Row' },
        ] };
        const nested = { ...DEF, steps: [loop], edges: [{ from: 'trg', to: 'lp' }] };
        get.mockImplementation(async (path: string) => (path === '/api/automation/a1' ? { automation: row(nested, 3) } : {}));
        await render('lp/b2');
        expect(await screen.findByText('Ping')).toBeTruthy();
        expect(screen.getByText(/Step 2 of 2/)).toBeTruthy();
        expect(screen.queryByTestId('step-test')).toBeNull();
        await fireEvent.changeText(getByShownText('Row'), 'Row {{loop.row}}');
        expect((stepIn('lp')?.body as Record<string, unknown>[])[1]).toMatchObject({ id: 'b2', body: 'Row {{loop.row}}' });
        await fireEvent.press(screen.getByTestId('step-prev'));
        expect(mockRouter.setParams).toHaveBeenLastCalledWith({ stepId: 'lp/b1' });
        // Nor on the Output tab, which offered it anyway: the tab follows the header.
        await fireEvent.press(screen.getByRole('tab', { name: /Output/ }));
        expect(screen.getByTestId('output-edit')).toBeTruthy();
        expect(screen.queryByTestId('output-test')).toBeNull();
    });

    it('says so when the step is not in the automation', async () => {
        await render('gone');
        expect(await screen.findByText('This step is not in the automation any more')).toBeTruthy();
        await fireEvent.press(screen.getByRole('button', { name: 'Back' }));
        expect(mockRouter.back).toHaveBeenCalled();
    });
});
