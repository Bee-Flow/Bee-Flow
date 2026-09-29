/**
 * The meeting delete, end to end through the shared danger zone (M2).
 *
 * ── THE TRAP THIS FILE EXISTS FOR ───────────────────────────────────
 * The server treats a kind it could not CHECK as in-use, which is the right
 * way round: an unanswerable scan must not become permission to delete. But
 * `DangerZone` decides whether to send the confirmation by counting ROWS, and
 * a kind that could not be checked has no row. Wired naively, the request
 * goes out unconfirmed, comes back 409 with an EMPTY list, and pressing again
 * sends exactly the same unconfirmed request — a meeting nobody can ever
 * delete, with a dialog that says nothing depends on it.
 *
 * So MeetingDetail ORs `unchecked` into the confirmation, and pays for it by
 * SHOWING what could not be checked and demanding the meeting's title first.
 * Both halves are pinned here: skip the notice and the confirmation becomes a
 * lie; skip the OR and the delete deadlocks.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// BOTH exports: `useRelativeTime` imports the NAMED `useTranslation`, so a
// default-only mock takes the whole Used-by table down inside a `waitFor` and
// reads as a missing element rather than as a broken mock. The factory is
// hoisted above every `const` in this file, so it defines its own translator.
vi.mock('../../../hooks/useTranslation', () => {
    const translator = () => ({
        t: (key, fallback, vars) => {
            let out = fallback || key;
            for (const [k, v] of Object.entries(vars || {})) out = out.split(`{${k}}`).join(String(v));
            return out;
        },
        language: 'en',
        locale: 'en',
    });
    return { default: translator, useTranslation: translator };
});

const usageState = { usage: [], unchecked: [], error: null, loading: false };
vi.mock('../../../hooks/useUsage', () => ({
    default: () => ({ ...usageState, refetch: () => {}, setUsage: () => {} }),
    USAGE_KIND_PATH: {},
}));

const meeting = {
    id: 'm-1', title: 'Weekly sync', status: 'completed', isOwner: true,
    tags: ['sales'], segments: [], speakers: [], actionItems: [], decisions: [], questions: [],
    audio: { available: true }, summary: 'Notes', durationSeconds: 60,
};
vi.mock('../hooks/useTranscription', () => ({
    default: () => ({ data: meeting, loading: false, error: null, refresh: () => {}, setLocal: () => {} }),
}));

const deleteTranscription = vi.fn(async () => ({ success: true }));
vi.mock('../lib/transcriptionsApi', () => ({
    deleteTranscription: (...a) => deleteTranscription(...a),
    patchTranscription: vi.fn(async () => ({})),
    reprocessTranscription: vi.fn(async () => ({})),
    regenerateSummary: vi.fn(async () => ({})),
    exportTranscription: vi.fn(async () => new Blob()),
    listSummaryTemplates: vi.fn(async () => []),
    getSeriesPrevious: vi.fn(async () => null),
    audioUrl: () => '', audioDownloadUrl: () => '',
}));

// Heavy leaves that have nothing to do with deleting.
vi.mock('./WaveformPlayer', () => ({ default: () => <div data-testid="player" /> }));
vi.mock('./AssistantSidebar', () => ({ default: () => null }));
vi.mock('./SpeakerEditor', () => ({ default: () => null }));
vi.mock('./TemplateEditor', () => ({ default: () => null }));
vi.mock('./SummaryActionsLayout', () => ({ default: () => <div data-testid="body" /> }));
vi.mock('./MeetingVisibility', () => ({ default: () => null }));
vi.mock('../../../components/shared/Toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import MeetingDetail from './MeetingDetail';

function open() {
    render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" onDeleted={() => {}} />);
    fireEvent.click(screen.getByText(/Delete this meeting/i));
}

function press() {
    fireEvent.click(screen.getByText('Delete for good'));
}

describe('MeetingDetail — delete', () => {
    beforeEach(() => {
        deleteTranscription.mockClear();
        deleteTranscription.mockResolvedValue({ success: true });
        Object.assign(usageState, { usage: [], unchecked: [], error: null, loading: false });
    });

    it('nothing uses it and nothing was unanswered → an unconfirmed delete, and the server checks', async () => {
        open();
        expect(screen.getByTestId('danger-unused')).toBeTruthy();
        expect(screen.queryByTestId('meeting-delete-unchecked')).toBeNull();
        press();
        await waitFor(() => expect(deleteTranscription).toHaveBeenCalledWith('m-1', { confirmedBreaking: false }));
    });

    it('AN UNCHECKED KIND IS SHOWN, THE TITLE IS ASKED FOR, AND ONLY THEN IS IT CONFIRMED', async () => {
        usageState.unchecked = ['notebook'];
        open();
        // 1. said out loud, inside the armed card, before anything is typed
        expect(screen.getByTestId('meeting-delete-unchecked').textContent).toMatch(/could not be checked/i);
        // 2. the name is demanded even though the list is empty
        const field = screen.getByLabelText('Type the name to confirm.');
        press();
        expect(deleteTranscription).not.toHaveBeenCalled();
        // 3. and the request that finally goes out is CONFIRMED, so the guard
        //    cannot bounce the same unconfirmed request for ever
        fireEvent.change(field, { target: { value: 'Weekly sync' } });
        press();
        await waitFor(() => expect(deleteTranscription).toHaveBeenCalledWith('m-1', { confirmedBreaking: true }));
    });

    it('a listed dependent confirms the way it always did', async () => {
        usageState.usage = [{ kind: 'kb', id: 'kb-1', title: 'Sales', role: 'contains', ownerId: 'me' }];
        open();
        expect(screen.getByTestId('danger-dependents')).toBeTruthy();
        fireEvent.change(screen.getByLabelText('Type the name to confirm.'), { target: { value: 'Weekly sync' } });
        press();
        await waitFor(() => expect(deleteTranscription).toHaveBeenCalledWith('m-1', { confirmedBreaking: true }));
    });

    it('a 409 from the server re-shows its list instead of deleting', async () => {
        const err = new Error('This meeting is still in use');
        err.status = 409;
        err.code = 'in_use';
        err.body = { code: 'in_use', usage: [{ kind: 'automation', id: 'a-1', title: 'Nightly digest', role: 'read', ownerId: 'me' }], unchecked: [] };
        deleteTranscription.mockRejectedValueOnce(err);
        open();
        press();
        await waitFor(() => expect(screen.getByText('Nightly digest')).toBeTruthy());
        expect(screen.getByText(/type the name again/i)).toBeTruthy();
        expect(deleteTranscription).toHaveBeenCalledTimes(1);
    });

    it('the outputs bar renders the same list, and says when it could not be read', async () => {
        usageState.usage = [];
        usageState.unchecked = ['notebook'];
        render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" />);
        expect(await screen.findByTestId('meeting-outputs-unchecked')).toBeTruthy();
        expect(screen.getByTestId('meeting-outputs-empty').textContent).not.toMatch(/Nothing picks this meeting up/i);
    });

    it('the Used-by badge shows no number when part of the answer is missing', async () => {
        // An under-count reads as a complete count. Better no number at all.
        usageState.usage = [{ kind: 'kb', id: 'kb-1', title: 'Sales', role: 'contains', ownerId: 'me' }];
        usageState.unchecked = ['automation'];
        render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" />);
        const tab = (await screen.findByText(/Used by/i)).closest('button') || screen.getByText(/Used by/i);
        expect(tab.textContent).not.toMatch(/\b1\b/);
    });
});
