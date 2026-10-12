/**
 * The build screen over a mocked HTTP client: the automation loads into the
 * outline, a "+" opens the picker and the pick lands on the edge it was
 * tapped on (and opens the new step), Undo takes it back, and a card's menu
 * edits the graph.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { api } from '@/core/api/client';

import type { FlowDefinition } from '../model';
import { peekDraftStore } from '../state';
import { MAIL_SORTER as DEF, MAIL_SORTER_ROW as row, releaseDrafts, renderBuild as mount, serveAutomation } from './testing';

jest.setTimeout(30_000);

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => jest.requireActual('@/shared/testing/screenMocks').focusedRouter(() => mockRouter));
jest.mock('@/core/auth/AuthProvider', () => ({ useAuth: jest.fn() }));
jest.mock('@/core/access/api', () => jest.requireActual('@/shared/testing/screenMocks').noAccess());
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

beforeEach(() => serveAutomation(row));
afterEach(releaseDrafts);

describe('BuildScreen', () => {
    it('shows the automation as an outline of cards', async () => {
        await mount();
        expect(await screen.findByText('Mail sorter')).toBeTruthy();
        expect(screen.getByText('Sort the mail')).toBeTruthy();
        expect(screen.getByText('Tell me')).toBeTruthy();
        // Off, and not a draft: the web says Paused, and so does the subline.
        expect(screen.getByText(/^Paused/)).toBeTruthy();
    });

    it('puts a picked step on the edge its "+" sat on, opens it, and undoes it', async () => {
        await mount();
        await screen.findByText('Sort the mail');
        await fireEvent.press(screen.getAllByLabelText('Insert a step here')[1] as never);
        await fireEvent.changeText(await screen.findByPlaceholderText('Search steps and apps'), 'wait');
        await fireEvent.press(await screen.findByLabelText('Wait'));
        const store = peekDraftStore('a1');
        await waitFor(() => expect(store?.getState().definition?.steps).toHaveLength(3));
        const added = store?.getState().definition?.steps[2];
        expect(added?.type).toBe('wait');
        expect(store?.getState().definition?.edges).toEqual(expect.arrayContaining([{ from: 'a', to: added?.id }, { from: added?.id, to: 'b' }]));
        expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/automations/[id]/steps/[stepId]', params: { id: 'a1', stepId: added?.id } });
        await fireEvent.press(screen.getByLabelText('Undo'));
        expect(store?.getState().definition?.steps).toHaveLength(2);
    });

    it('auto-maps a step added before the catalog answered, once it has', async () => {
        let answerCatalog: (value: unknown) => void = () => undefined;
        const pinned: FlowDefinition = {
            ...DEF,
            steps: DEF.steps.map((s) => (s.id === 'a' ? { ...s, pinnedOutput: { rows: [{ n: 1 }] } } : s)),
        };
        (api.get as jest.Mock).mockImplementation(async (path: string) => {
            if (path === '/api/automation/a1') return { automation: { ...row, definition: pinned }, summary: '' };
            if (path === '/api/automation/catalog') return new Promise((resolve) => (answerCatalog = resolve));
            return null;
        });
        await mount();
        await screen.findByText('Sort the mail');
        await fireEvent.press(screen.getAllByLabelText('Insert a step here')[1] as never);
        await fireEvent.changeText(await screen.findByPlaceholderText('Search steps and apps'), 'repeat');
        await fireEvent.press(await screen.findByLabelText('Repeat for each'));
        const store = peekDraftStore('a1');
        const loop = () => store?.getState().definition?.steps.find((s) => s.type === 'loop');
        await waitFor(() => expect(loop()).toBeTruthy());
        expect(loop()?.overRef).not.toBe('steps.a.output.rows');
        answerCatalog({ apps: [], flags: { code: true } });
        await waitFor(() => expect(loop()?.overRef).toBe('steps.a.output.rows'));
    });

    it('edits the graph from a card’s menu', async () => {
        await mount();
        await screen.findByText('Sort the mail');
        await fireEvent(screen.getByTestId('step-card-b'), 'longPress');
        await fireEvent.press(await screen.findByRole('menuitem', { name: 'Move up' }));
        const store = peekDraftStore('a1');
        expect(store?.getState().definition?.edges).toEqual([{ from: 'trg', to: 'b' }, { from: 'b', to: 'a' }]);
    });
});
