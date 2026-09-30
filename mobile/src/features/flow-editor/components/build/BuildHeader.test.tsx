/**
 * The build screen's header on a phone: the name keeps its row, the state and
 * the autosave read under it, Go live waits for something to switch on, a
 * live routine asks before switching off, and only a refusal with findings
 * opens the findings.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { ApiError, api } from '@/core/api/client';
import { MAIL_SORTER as DEF, MAIL_SORTER_ROW as row, releaseDrafts, renderBuild as mount, serveRoutine } from '@/features/flow-editor/screens/testing';

jest.setTimeout(30_000);

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => jest.requireActual('@/shared/testing/screenMocks').focusedRouter(() => mockRouter));
jest.mock('@/core/auth/AuthProvider', () => ({ useAuth: jest.fn() }));
jest.mock('@/core/access/api', () => jest.requireActual('@/shared/testing/screenMocks').noAccess());
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

afterEach(releaseDrafts);

describe('BuildHeader', () => {
    it('says the state under the name, and keeps Ask AI in the toolbar', async () => {
        serveRoutine({ ...row, isDraft: true });
        await mount();
        expect(await screen.findByText('Mail sorter')).toBeTruthy();
        expect(screen.getByText(/^Draft/)).toBeTruthy();
        expect(screen.getByTestId('build-ask-ai')).toBeTruthy();
        expect(screen.getByTestId('build-status-action')).toBeTruthy();
    });

    it('offers nothing to switch on for a flow without steps', async () => {
        serveRoutine({ ...row, definition: { ...DEF, steps: [], edges: [] } });
        await mount();
        await screen.findByText('Mail sorter');
        expect(screen.getByTestId('build-status-action').props.accessibilityState).toMatchObject({ disabled: true });
    });

    it('asks before switching a live routine off', async () => {
        serveRoutine({ ...row, isActive: true });
        (api.post as jest.Mock).mockResolvedValue({ automation: { ...row, isActive: false }, warnings: [] });
        await mount();
        await screen.findByText('Mail sorter');
        await fireEvent.press(screen.getByTestId('build-status-action'));
        expect(await screen.findByText('Switch this routine off?')).toBeTruthy();
        expect(api.post).not.toHaveBeenCalled();
        await fireEvent.press(screen.getAllByText('Switch off').at(-1) as never);
        await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/automation/a1/deactivate', undefined, { retry: false }));
    });

    it('opens the findings only when the refusal came with some', async () => {
        serveRoutine(row);
        (api.post as jest.Mock).mockRejectedValueOnce(new ApiError('Offline', { status: 503 }));
        await mount();
        await screen.findByText('Mail sorter');
        await fireEvent.press(screen.getByTestId('build-status-action'));
        await waitFor(() => expect(api.post).toHaveBeenCalled());
        expect(screen.queryByText('Nothing blocks going live')).toBeNull();
    });

    it('keeps ⋯ before the routine exists, and its screens name their routes', async () => {
        serveRoutine(row);
        await mount();
        await screen.findByText('Mail sorter');
        await fireEvent.press(screen.getByTestId('build-more'));
        await fireEvent.press(await screen.findByText('Run history'));
        expect(mockRouter.push).toHaveBeenCalledWith('/automations/a1/runs');
    });
});
