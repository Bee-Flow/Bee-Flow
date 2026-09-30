/**
 * The live split on the build screen (handoff 5): a live routine whose working
 * copy is ahead says so and offers Make vN live, which publishes the version
 * on screen; a save says its change is not live yet; a routine saved
 * elsewhere in the meantime is read again; a refusal reads like Go live's;
 * and a server without the split gets the screen it always had.
 */

import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { ApiError, api } from '@/core/api/client';
import { MAIL_SORTER_ROW, releaseDrafts, renderBuild as mount, serveRoutine } from '@/features/flow-editor/screens/testing';
import { peekDraftStore } from '@/features/flow-editor/state';

jest.setTimeout(30_000);

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => jest.requireActual('@/shared/testing/screenMocks').focusedRouter(() => mockRouter));
jest.mock('@/core/auth/AuthProvider', () => ({ useAuth: jest.fn() }));
jest.mock('@/core/access/api', () => jest.requireActual('@/shared/testing/screenMocks').noAccess());
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

afterEach(releaseDrafts);

/** Live since v3, the working copy at v5 with two structural changes on top. */
const AHEAD = { ...MAIL_SORTER_ROW, version: 5, isActive: true, isDraft: false, liveVersion: 3, liveAt: '2026-09-20T10:00:00Z', neverLive: false, pendingChanges: 2 };
const post = api.post as jest.Mock;
const get = api.get as jest.Mock;
const countsReads = () => get.mock.calls.filter(([path]) => path === '/api/automation/a1/counts').length;

/** Rename step a, the way an edit on screen would. */
async function edit(label: string): Promise<void> {
    await act(async () => {
        peekDraftStore('a1')?.getState().applyOp((d) => ({ ...d, steps: d.steps.map((s) => (s.id === 'a' ? { ...s, label } : s)) }));
    });
}

async function editAndSave(): Promise<void> {
    await edit('Sort it all');
    await act(async () => {
        await peekDraftStore('a1')?.getState().flush();
    });
}

describe('PublishBanner', () => {
    it('says what is not live yet, and makes the version on screen live', async () => {
        serveRoutine(AHEAD);
        post.mockResolvedValue({ automation: { ...AHEAD, liveVersion: 5, pendingChanges: 0 }, warnings: [] });
        await mount();
        expect(await screen.findByText('editing v5 · 2 changes not live yet')).toBeTruthy();
        expect(screen.getByText(/^Live · v3/)).toBeTruthy();
        await fireEvent.press(screen.getByText('Make v5 live'));
        await waitFor(() => expect(post).toHaveBeenCalledWith('/api/automation/a1/publish', { version: 5 }, { retry: false }));
        expect(await screen.findByText('Runs use v5 from now on')).toBeTruthy();
        await waitFor(() => expect(screen.queryByTestId('publish-banner')).toBeNull());
        expect(screen.getByText(/^Live · v5/)).toBeTruthy();
        // The row said how many changes were pending: no counts read.
        expect(countsReads()).toBe(0);
    });

    it('after a save on a live routine, reads the pending count the answer leaves out', async () => {
        serveRoutine({ ...AHEAD, version: 3, pendingChanges: 0 }, { '/api/automation/a1/counts': { runs7d: 0, pendingChanges: 1 } });
        (api.put as jest.Mock).mockImplementation(async (_path: string, body: { definition: unknown }) => {
            const { pendingChanges: _omitted, ...saved } = AHEAD;
            return { automation: { ...saved, definition: body.definition, version: 4 }, warnings: [] };
        });
        await mount();
        await screen.findByText('Mail sorter');
        expect(screen.queryByTestId('publish-banner')).toBeNull();
        await editAndSave();
        expect(await screen.findByText('editing v4 · 1 change not live yet')).toBeTruthy();
        expect(screen.getByText('Make v4 live')).toBeTruthy();
        expect(countsReads()).toBeGreaterThan(0);
    });

    it('waits for the autosave before it makes anything live', async () => {
        serveRoutine(AHEAD);
        await mount();
        await screen.findByText('Make v5 live');
        await edit('Sort');
        expect(screen.getByTestId('publish-live').props.accessibilityState).toMatchObject({ disabled: true });
        await fireEvent.press(screen.getByTestId('publish-live'));
        expect(post).not.toHaveBeenCalled();
    });

    it('reads the routine again when it moved on since, and says so', async () => {
        serveRoutine(AHEAD);
        post.mockRejectedValueOnce(new ApiError('Version 5 is no longer the latest', { status: 409, body: { error: 'Version 5 is no longer the latest', code: 'version_changed', version: 6 } }));
        await mount();
        await fireEvent.press(await screen.findByText('Make v5 live'));
        expect(await screen.findByText(/saved elsewhere in the meantime/)).toBeTruthy();
        await waitFor(() => expect(get.mock.calls.filter(([path]) => path === '/api/automation/a1').length).toBeGreaterThan(1));
    });

    it('tells a refusal the way Go live does, findings and all', async () => {
        serveRoutine(AHEAD);
        post.mockRejectedValueOnce(new ApiError('Invalid definition', {
            status: 400,
            body: { error: 'Invalid definition', details: [{ code: 'tool.unknown', severity: 'error', path: 'steps[b]', message: 'This tool is not available to the owner.' }] },
        }));
        await mount();
        await fireEvent.press(await screen.findByText('Make v5 live'));
        expect(await screen.findByText('Invalid definition')).toBeTruthy();
        expect((await screen.findAllByText('This tool is not available to the owner.')).length).toBeGreaterThan(0);
    });

    it('on a paused routine says what is pending, and leaves going live to Go live', async () => {
        serveRoutine({ ...AHEAD, isActive: false });
        await mount();
        expect(await screen.findByText('editing v5 · 2 changes not live yet')).toBeTruthy();
        expect(screen.queryByTestId('publish-live')).toBeNull();
        expect(screen.getByTestId('build-status-action').props.accessibilityHint).toBe('Switches the live version back on');
    });

    it('on a server without the live split, shows the screen it always had', async () => {
        serveRoutine({ ...MAIL_SORTER_ROW, isActive: true, isDraft: false });
        await mount();
        await screen.findByText('Mail sorter');
        // "Live" under the name and on the switch-off button, no version beside it.
        expect(screen.getAllByText('Live')).toHaveLength(2);
        expect(screen.queryByText(/^Live · v/)).toBeNull();
        expect(screen.queryByTestId('publish-banner')).toBeNull();
        await editAndSave();
        expect(screen.queryByTestId('publish-banner')).toBeNull();
        expect(countsReads()).toBe(0);
    });
});
