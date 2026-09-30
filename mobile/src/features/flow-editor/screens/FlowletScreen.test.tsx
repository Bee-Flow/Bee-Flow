/**
 * A flowlet built on its own screen, over the routine's draft: its steps as
 * the outline, a step added through its "+" landing in the flowlet inside
 * the whole routine, its Return offered while it has none, and a flowlet
 * that is gone said so. The routine's Flowlets sheet creates one and opens it.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { renderScreen } from '@/shared/testing/renderWithProviders';

import type { FlowDefinition } from '../model';
import { peekDraftStore } from '../state';
import { BuildScreen } from './BuildScreen';
import { FlowletScreen } from './FlowletScreen';
import { NodeEditorScreen } from './NodeEditorScreen';
import { releaseDrafts, serveRoutine } from './testing';
import { getByShownText } from '../components/fields/testing';

jest.setTimeout(30_000);

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), setParams: jest.fn() };
jest.mock('expo-router', () => jest.requireActual('@/shared/testing/screenMocks').focusedRouter(() => mockRouter));
jest.mock('@/core/auth/AuthProvider', () => ({ useAuth: jest.fn() }));
jest.mock('@/core/access/api', () => jest.requireActual('@/shared/testing/screenMocks').noAccess());
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const DEF: FlowDefinition = {
    trigger: { id: 'trg', type: 'trigger', kind: 'manual', label: 'Start' },
    steps: [{ id: 'call', type: 'call_layer', layerKey: 'lookup', label: 'Look it up' }],
    edges: [{ from: 'trg', to: 'call' }],
    layers: {
        lookup: {
            title: 'Lookup',
            trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', label: 'Flowlet input', params: [] },
            steps: [{ id: 'tidy', type: 'notification', label: 'Tell me', body: 'Found it' }],
            edges: [{ from: 'trg', to: 'tidy' }],
        },
    },
};
const row = { id: 'a1', title: 'Mail sorter', definition: DEF, version: 3, isActive: false };
const root = () => peekDraftStore('a1')?.getState().definition as FlowDefinition;

beforeEach(() => serveRoutine(row));
afterEach(releaseDrafts);

describe('FlowletScreen', () => {
    it('builds the flowlet: a step added here lands in it, inside the whole routine', async () => {
        await renderScreen(<FlowletScreen id="a1" layerKey="lookup" />);
        expect(await screen.findByText('Lookup')).toBeTruthy();
        expect(screen.getByText('Tell me')).toBeTruthy();
        expect(screen.queryByLabelText('Test run')).toBeNull();
        await fireEvent.press(screen.getAllByLabelText('Insert a step here')[0] as never);
        await fireEvent.changeText(await screen.findByPlaceholderText('Search steps and apps'), 'return');
        await fireEvent.press(await screen.findByLabelText('Flowlet output'));
        await waitFor(() => expect(root().layers?.lookup?.steps.some((s) => s.type === 'layer_output')).toBe(true));
        expect(root().steps).toEqual(DEF.steps);
        const added = root().layers?.lookup?.steps.find((s) => s.type === 'layer_output');
        expect(mockRouter.push).toHaveBeenCalledWith({
            pathname: '/automations/[id]/steps/[stepId]',
            params: { id: 'a1', stepId: added?.id, flowlet: 'lookup' },
        });
    });

    it('says so when the flowlet is gone', async () => {
        await renderScreen(<FlowletScreen id="a1" layerKey="gone" />);
        expect(await screen.findByText('This flowlet is not in the routine any more')).toBeTruthy();
    });

    it('edits a flowlet’s step in the step editor, writing into the flowlet', async () => {
        await renderScreen(<NodeEditorScreen automationId="a1" stepId="tidy" flowlet="lookup" />);
        await fireEvent.changeText(await waitFor(() => getByShownText('Found it')), 'Found it twice');
        expect(root().layers?.lookup?.steps[0]).toMatchObject({ id: 'tidy', body: 'Found it twice' });
        expect(screen.queryByTestId('step-test')).toBeNull();
    });
});

describe('the routine’s flowlets', () => {
    it('opens a call’s flowlet from its card', async () => {
        await renderScreen(<BuildScreen id="a1" />);
        await screen.findByText('Look it up');
        await fireEvent(screen.getByTestId('step-card-call'), 'longPress');
        await fireEvent.press(await screen.findByRole('menuitem', { name: 'Open flowlet' }));
        expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/automations/[id]/flowlets/[layerKey]', params: { id: 'a1', layerKey: 'lookup' } });
    });

    it('creates a flowlet from the sheet and opens it', async () => {
        await renderScreen(<BuildScreen id="a1" />);
        await screen.findByText('Look it up');
        await fireEvent.press(screen.getByLabelText('More'));
        await fireEvent.press(await screen.findByRole('menuitem', { name: 'Flowlets' }));
        expect(await screen.findByText('Lookup')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('flowlet-create'));
        const keys = Object.keys(root().layers || {});
        expect(keys).toHaveLength(2);
        const made = keys.find((k) => k !== 'lookup') as string;
        expect(made).toMatch(/^new_flowlet_/);
        expect(mockRouter.push).toHaveBeenLastCalledWith({ pathname: '/automations/[id]/flowlets/[layerKey]', params: { id: 'a1', layerKey: made } });
    });
});
