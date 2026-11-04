/**
 * What MeetingDetail does with the action list (plan M3).
 *
 * ── THE RULE THIS FILE EXISTS FOR ───────────────────────────────────
 * "Opnieuw" re-runs the extractor. It must replace ONLY what the extractor
 * produced. An action a person typed themselves — the one with a destination
 * on it, the one they will look for tomorrow — has to survive, and there is no
 * undo if it does not. The server merges (core/meetingNotes/actionItems.js);
 * this screen has to take that merged answer WHOLE, and every write it makes
 * in between has to send the WHOLE list, because the PATCH replaces the
 * column.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
    patchTranscription: vi.fn(),
    regenerateSummary: vi.fn(),
    refresh: vi.fn(),
    refetchUsage: vi.fn(),
    updateSpeakers: vi.fn(),
    getTranscription: vi.fn(),
    reprocessTranscription: vi.fn(),
    setData: null,
    state: { meeting: null },
}));

vi.mock('@/hooks/useTranslation', () => import('@/test/useTranslationParamsMock'));

vi.mock('@/hooks/useUsage', () => ({
    default: () => ({ usage: [], unchecked: [], error: null, loading: false, refetch: H.refetchUsage, setUsage: () => {} }),
    USAGE_KIND_PATH: {},
}));

// A real local copy of the note, so an optimistic write and the server's echo
// can actually be told apart on screen.
vi.mock('../hooks/useTranscription', async () => {
    const React2 = await import('react');
    function useTranscriptionStub() {
        const [data, setData] = React2.useState(() => H.state.meeting);
        // The detail's own poll, by hand: a test moves the note on through this.
        React2.useEffect(() => { H.setData = setData; });
        return {
            data,
            loading: false,
            error: null,
            refresh: H.refresh,
            setLocal: (next) => setData((p) => (typeof next === 'function' ? next(p) : next)),
        };
    }
    return { default: useTranscriptionStub };
});

vi.mock('@/api/transcriptionsApi', () => ({
    patchTranscription: (...a) => H.patchTranscription(...a),
    regenerateSummary: (...a) => H.regenerateSummary(...a),
    deleteTranscription: vi.fn(async () => ({ success: true })),
    reprocessTranscription: (...a) => H.reprocessTranscription(...a),
    updateSpeakers: (...a) => H.updateSpeakers(...a),
    getTranscription: (...a) => H.getTranscription(...a),
    exportTranscription: vi.fn(async () => new Blob()),
    listSummaryTemplates: vi.fn(async () => []),
    getSeriesPrevious: vi.fn(async () => null),
    audioUrl: () => '', audioDownloadUrl: () => '',
}));

vi.mock('./WaveformPlayer', () => ({ default: () => <div data-testid="player" /> }));
vi.mock('./AssistantSidebar', () => ({ default: () => null }));
// The editor's save, as one button: what matters is the banner it leads to.
vi.mock('./SpeakerEditor', () => ({
    default: ({ onSave }) => (
        <button type="button" onClick={() => onSave({ renames: { 'Spreker 2': 'Anna' } })}>harness-save-speakers</button>
    ),
}));
vi.mock('./TemplateEditor', () => ({ default: () => null }));
vi.mock('./MeetingVisibility', () => ({ default: () => null }));
vi.mock('@/components/shared/Toast', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

/**
 * A harness in place of the real body: it shows the list MeetingDetail holds
 * and gives the two handlers under test a button each. The pill's own
 * rendering is pinned in ActionItemsList.destination.test.jsx — what matters
 * here is what this screen sends and what it keeps.
 */
vi.mock('./SummaryActionsLayout', () => ({
    default: ({ meeting, onSetActionDestination, onRegenerateSummary, onToggleActionItem }) => (
        <div>
            <div data-testid="summary">{meeting.summary}</div>
            {/* Welke sjabloonstempel deze schermkopie draagt (M4 stap 3). */}
            <div data-testid="stamp">{`${meeting.summaryTemplateId ?? 'null'}|${meeting.summaryTemplateVersion ?? 'null'}`}</div>
            <ul data-testid="actions">
                {(meeting.actionItems || []).map((ai) => (
                    <li key={ai.id} data-source={ai.source} data-id={ai.id}>
                        {ai.text}{ai.destination ? ` → ${ai.destination.label}` : ''}
                    </li>
                ))}
            </ul>
            <button type="button" onClick={() => onRegenerateSummary?.('general')}>harness-regenerate</button>
            <button
                type="button"
                onClick={() => onSetActionDestination?.('u-42', {
                    kind: 'automation', ref: 'a-1', label: 'Weging', at: '2026-07-27T10:00:00.000Z', itemRef: 'run-9',
                })}
            >
                harness-set-destination
            </button>
            {onToggleActionItem && <button type="button" onClick={() => onToggleActionItem('ai-0')}>harness-toggle</button>}
        </div>
    ),
}));

import MeetingDetail from './MeetingDetail';
import makeMeetingEdits from './useMeetingEdits';

const AI_ITEM = { id: 'ai-0', text: 'Filter inbouwen', assignee: 'Tom', done: false, source: 'ai' };
const USER_ITEM = {
    id: 'u-42', text: 'Morgen contact opnemen', done: false, source: 'user',
    destination: { kind: 'datatable_row', ref: 't-1', label: 'Backlog', at: '2026-07-27T10:00:00.000Z' },
};

function note(actionItems) {
    return {
        id: 'm-1', title: 'Weekly sync', status: 'completed', isOwner: true,
        tags: [], segments: [], speakers: [], decisions: [], questions: [],
        audio: { available: true }, summary: 'Notes', durationSeconds: 60,
        createdAt: '2026-07-27T09:30:00.000Z',
        actionItems,
    };
}

const texts = () => Array.from(screen.getByTestId('actions').querySelectorAll('li')).map((li) => li.textContent);

beforeEach(() => {
    H.patchTranscription.mockReset();
    H.regenerateSummary.mockReset();
    H.refresh.mockReset();
    H.refetchUsage.mockReset();
    H.updateSpeakers.mockReset();
    H.getTranscription.mockReset();
    H.getTranscription.mockResolvedValue({ tags: [] });
    H.reprocessTranscription.mockReset();
    H.reprocessTranscription.mockResolvedValue({ id: 'm-1', status: 'processing' });
    H.patchTranscription.mockImplementation(async (_id, patch) => ({ success: true, ...patch }));
    H.state.meeting = note([AI_ITEM, USER_ITEM]);
});

describe('MeetingDetail — "Opnieuw" keeps what the person wrote', () => {
    /**
     * THE BITE, and it bites from BOTH sides.
     *
     * The server answers the MERGED list: every `source:'user'` item, then the
     * freshly extracted ones. A screen that filtered that answer down to the
     * AI's half would silently delete the action this person typed — the exact
     * loss M3 exists to prevent. A screen that ignored the answer and kept its
     * own copy would show a summary regenerated against action items that were
     * not, which is the same button lying in the other direction.
     *
     * So: after a regenerate the user item is STILL THERE, with its
     * destination, and the AI's item is the NEW one.
     */
    it('keeps the user’s action AND its destination, and takes the fresh AI ones', async () => {
        const user = userEvent.setup();
        H.regenerateSummary.mockResolvedValue({
            summary: 'Fresh',
            actionItems: [
                USER_ITEM,
                { id: 'ai-0', text: 'Opnieuw geëxtraheerd', done: false, source: 'ai' },
            ],
        });
        render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" />);
        expect(texts()).toEqual(['Filter inbouwen', 'Morgen contact opnemen → Backlog']);

        await user.click(screen.getByText('harness-regenerate'));
        await waitFor(() => expect(texts()).toContain('Opnieuw geëxtraheerd'));
        // Survived, with the chip that says where it went.
        expect(texts()).toContain('Morgen contact opnemen → Backlog');
        // And the stale AI item is gone — the answer was taken whole.
        expect(texts()).not.toContain('Filter inbouwen');
    });

    /**
     * ── A FAILED ARTIFACT PASS MUST SAY SO ───────────────────────────
     * On a failed extraction the server keeps the existing action items, decisions and
     * questions, and replies `artifactsRegenerated: false`. Nobody read that field. For
     * the person who just pressed "Regenerate", the result is then indistinguishable
     * from "the meeting produced nothing new": the summary is refreshed, the lists are
     * still there, and nothing says that half of the button did not run. Then nobody
     * presses again.
     */
    it('says so when the server reports the artifact pass did not run', async () => {
        const user = userEvent.setup();
        const { toast } = await import('@/components/shared/Toast');
        toast.info.mockClear();
        H.regenerateSummary.mockResolvedValue({
            summary: 'Fresh',
            actionItems: [AI_ITEM, USER_ITEM],
            artifactsRegenerated: false,
        });
        render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" />);
        await user.click(screen.getByText('harness-regenerate'));
        await waitFor(() => expect(screen.getByTestId('summary').textContent).toBe('Fresh'));

        expect(toast.info).toHaveBeenCalled();
        expect(String(toast.info.mock.calls.at(-1)[0])).toMatch(/action items/i);
        // En de lijst staat er nog: bewaren is de helft, zeggen dat je
        // bewaard hebt is de andere helft.
        expect(texts()).toContain('Filter inbouwen');
    });

    it('stays quiet when the artifact pass DID run', async () => {
        const user = userEvent.setup();
        const { toast } = await import('@/components/shared/Toast');
        toast.info.mockClear();
        H.regenerateSummary.mockResolvedValue({
            summary: 'Fresh', actionItems: [AI_ITEM], artifactsRegenerated: true,
        });
        render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" />);
        await user.click(screen.getByText('harness-regenerate'));
        await waitFor(() => expect(screen.getByTestId('summary').textContent).toBe('Fresh'));
        expect(toast.info).not.toHaveBeenCalled();
    });

    it('leaves the list alone when the answer is not a list, rather than emptying the card', async () => {
        const user = userEvent.setup();
        H.regenerateSummary.mockResolvedValue({ summary: 'Fresh' });
        render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" />);
        await user.click(screen.getByText('harness-regenerate'));
        // The summary DID land, so this is the state after the answer was
        // applied — not a list that has simply not been touched yet.
        await waitFor(() => expect(screen.getByTestId('summary').textContent).toBe('Fresh'));
        expect(texts()).toEqual(['Filter inbouwen', 'Morgen contact opnemen → Backlog']);
    });
});

describe('MeetingDetail — writing a destination', () => {
    /**
     * THE BITE. `PATCH actionItems` REPLACES the column. Sending only the item
     * that changed — the obvious "why send all of them" optimisation — deletes
     * every other action on the note, the user's included, with no undo and
     * nothing on screen to say it happened.
     */
    it('sends the WHOLE list, not just the item that changed', async () => {
        const user = userEvent.setup();
        render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" />);
        await user.click(screen.getByText('harness-set-destination'));
        await waitFor(() => expect(H.patchTranscription).toHaveBeenCalled());

        const [id, patch] = H.patchTranscription.mock.calls[0];
        expect(id).toBe('m-1');
        expect(patch.actionItems.map((ai) => ai.id)).toEqual(['ai-0', 'u-42']);
        expect(patch.actionItems[1].destination).toMatchObject({ kind: 'automation', ref: 'a-1', itemRef: 'run-9' });
        // The other action is carried over untouched, not rebuilt.
        expect(patch.actionItems[0]).toEqual(AI_ITEM);
    });

    /**
     * The route re-shapes what it is given — it mints an id for an item that
     * arrived without one, and stamps the destination with its own clock — and
     * echoes the cleaned list back. Ignoring that echo leaves the optimistic
     * copy on screen until the next full refetch, and then the ids change under
     * whoever is mid-edit.
     */
    it('adopts the server’s cleaned list over its own optimistic copy', async () => {
        const user = userEvent.setup();
        H.patchTranscription.mockResolvedValue({
            success: true,
            actionItems: [
                AI_ITEM,
                { ...USER_ITEM, text: 'Morgen contact opnemen', destination: { kind: 'automation', ref: 'a-1', label: 'Weging (server)', at: '2026-07-27T10:00:00.000Z' } },
            ],
        });
        render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" />);
        await user.click(screen.getByText('harness-set-destination'));
        await waitFor(() => expect(texts()).toContain('Morgen contact opnemen → Weging (server)'));
    });

    it('keeps the rail’s open-action count in step with a checkbox', async () => {
        const user = userEvent.setup();
        const onChanged = vi.fn();
        render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" onChanged={onChanged} />);
        await user.click(screen.getByText('harness-toggle'));
        await waitFor(() => expect(H.patchTranscription).toHaveBeenCalled());
        expect(onChanged).toHaveBeenCalledWith('m-1', { actionsTotal: 2, actionsOpen: 1 });
    });

    it('says so when the note could not be saved after the automation already ran', async () => {
        const user = userEvent.setup();
        const { toast } = await import('@/components/shared/Toast');
        H.patchTranscription.mockRejectedValue(new Error('offline'));
        render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" />);
        await user.click(screen.getByText('harness-set-destination'));
        await waitFor(() => expect(toast.error).toHaveBeenCalled());
        expect(String(toast.error.mock.calls.at(-1)[0])).toMatch(/could not be updated/i);
        expect(H.refresh).toHaveBeenCalled();
    });
});


// ── THE TEMPLATE STAMP AFTER "REGENERATE" (M4 step 3) ──────────────
//
// The stamp says with which template the text that is NOW there was written.
// After a regenerate the screen must therefore carry the stamp of the ANSWER, even if
// that answer is "no template".

describe('MeetingDetail — de sjabloonstempel volgt de nieuwe tekst', () => {
    it('neemt de stempel van het antwoord over', async () => {
        const user = userEvent.setup();
        H.state.meeting = { ...note([AI_ITEM]), summaryTemplateId: 'builtin:general', summaryTemplateVersion: null };
        H.regenerateSummary.mockResolvedValue({
            summary: 'Fresh', actionItems: [AI_ITEM],
            summaryTemplateId: 'tpl-9', summaryTemplateVersion: 4,
        });
        render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" />);
        await user.click(screen.getByText('harness-regenerate'));
        await waitFor(() => expect(screen.getByTestId('stamp').textContent).toBe('tpl-9|4'));
    });

    it('WIST de stempel als het antwoord er geen draagt (eenmalige prompt)', async () => {
        const user = userEvent.setup();
        // Leaving the previous template in place would stick a template name on text that
        // template never wrote.
        H.state.meeting = { ...note([AI_ITEM]), summaryTemplateId: 'tpl-9', summaryTemplateVersion: 4 };
        H.regenerateSummary.mockResolvedValue({ summary: 'Fresh', actionItems: [AI_ITEM], summaryTemplateId: null, summaryTemplateVersion: null });
        render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" />);
        expect(screen.getByTestId('stamp').textContent).toBe('tpl-9|4');
        await user.click(screen.getByText('harness-regenerate'));
        await waitFor(() => expect(screen.getByTestId('summary').textContent).toBe('Fresh'));
        expect(screen.getByTestId('stamp').textContent).toBe('null|null');
    });
});


// ── A KEPT POINT MUST SAY SO (M4) ───────────────────────────────────
//
// The server keeps an AI point that a human had ticked off or retyped, even when the
// new extraction no longer yields it. Throw-away-and-create-again would wipe that input
// after all. Such a point comes back with `orphaned: true`. Letting it through silently
// makes the card claim that the AI has just produced it, so it is named at the moment
// it happens (the lasting marker stands on the card itself, ActionItemsList).

describe('MeetingDetail — bewaarde actiepunten worden benoemd', () => {
    it('zegt hoeveel punten bewaard zijn die de nieuwe pass niet meer opleverde', async () => {
        const user = userEvent.setup();
        const { toast } = await import('@/components/shared/Toast');
        toast.info.mockClear();
        H.regenerateSummary.mockResolvedValue({
            summary: 'Fresh',
            actionItems: [
                { id: 'ai-gen-9', text: 'Contract tekenen', done: true, source: 'ai', orphaned: true },
                AI_ITEM,
            ],
            artifactsRegenerated: true,
        });
        render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" />);
        await user.click(screen.getByText('harness-regenerate'));
        await waitFor(() => expect(screen.getByTestId('summary').textContent).toBe('Fresh'));

        expect(toast.info).toHaveBeenCalled();
        const said = String(toast.info.mock.calls.at(-1)[0]);
        // ONE point says "one", not "1": the choice of form falls on the KEY (base +
        // `_plural`), not on a "(s)" in the sentence. Pinning on the number would bring
        // back the English grammar-in-code.
        expect(said).toMatch(/\bone\b/i);
        expect(said).not.toMatch(/\d/);
        expect(said).toMatch(/kept/i);
        // And the point is still there: naming it may never replace keeping it.
        expect(texts()).toContain('Contract tekenen');
    });

    it('...en telt ze wél zodra het er meer dan een zijn', async () => {
        const user = userEvent.setup();
        const { toast } = await import('@/components/shared/Toast');
        toast.info.mockClear();
        H.regenerateSummary.mockResolvedValue({
            summary: 'Fresh',
            actionItems: [
                { id: 'ai-gen-9', text: 'Contract tekenen', done: true, source: 'ai', orphaned: true },
                { id: 'ai-gen-10', text: 'Offerte nakijken', done: true, source: 'ai', orphaned: true },
                AI_ITEM,
            ],
            artifactsRegenerated: true,
        });
        render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" />);
        await user.click(screen.getByText('harness-regenerate'));
        await waitFor(() => expect(screen.getByTestId('summary').textContent).toBe('Fresh'));

        const said = String(toast.info.mock.calls.at(-1)[0]);
        expect(said).toMatch(/\b2\b/);
        expect(said).toMatch(/kept/i);
        expect(texts()).toContain('Contract tekenen');
        expect(texts()).toContain('Offerte nakijken');
    });

    it('zwijgt wanneer elk punt gewoon herkend werd', async () => {
        const user = userEvent.setup();
        const { toast } = await import('@/components/shared/Toast');
        toast.info.mockClear();
        H.regenerateSummary.mockResolvedValue({
            summary: 'Fresh', actionItems: [AI_ITEM], artifactsRegenerated: true,
        });
        render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" />);
        await user.click(screen.getByText('harness-regenerate'));
        await waitFor(() => expect(screen.getByTestId('summary').textContent).toBe('Fresh'));
        expect(toast.info).not.toHaveBeenCalled();
    });
});


// ── "SPEAKERS UPDATED, REGENERATE?" KEEPS THE NOTE'S TEMPLATE (MN-026) ──

describe('MeetingDetail — the rename banner regenerates with the note’s own template', () => {
    async function acceptBanner(stamp) {
        const user = userEvent.setup();
        H.state.meeting = { ...note([AI_ITEM]), ...stamp };
        H.updateSpeakers.mockResolvedValue({ ...H.state.meeting, speakers: [{ id: 'Anna' }] });
        H.regenerateSummary.mockResolvedValue({ summary: 'Fresh', actionItems: [AI_ITEM], ...stamp });
        render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" />);
        await user.click(screen.getByText('harness-save-speakers'));
        await user.click(await screen.findByRole('button', { name: 'Regenerate' }));
        await waitFor(() => expect(H.regenerateSummary).toHaveBeenCalled());
        return H.regenerateSummary.mock.calls[0];
    }

    it('a saved template', async () => {
        expect(await acceptBanner({ summaryTemplateId: 'tpl-sales-v3', summaryTemplateVersion: 3 })).toEqual(['m-1', { templateId: 'tpl-sales-v3' }]);
    });

    it('a built-in other than General', async () => {
        expect(await acceptBanner({ summaryTemplateId: 'builtin:sales', summaryTemplateVersion: null })).toEqual(['m-1', { template: 'sales' }]);
    });
});


// ── WHAT ONLY THE OWNER MAY DO (MN-117, MN-125) ─────────────────────

describe('MeetingDetail — a reader of a shared note', () => {
    it('gets no action-item checkbox handler', () => {
        H.state.meeting = { ...note([AI_ITEM]), isOwner: false };
        render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" />);
        expect(screen.queryByText('harness-toggle')).toBeNull();
    });

    it('is not offered Re-transcribe, which the server refuses with a 403', async () => {
        const user = userEvent.setup();
        H.state.meeting = { ...note([AI_ITEM]), isOwner: false };
        render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" />);
        await user.click(screen.getByTestId('meeting-more'));
        expect(screen.queryByText('Re-transcribe')).toBeNull();
        expect(screen.getByText('Copy transcript')).toBeTruthy();
    });

    it('is not offered Re-transcribe on a failed note either', () => {
        H.state.meeting = { ...note([]), isOwner: false, status: 'failed', failureReason: 'boom' };
        render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" />);
        expect(screen.queryByTestId('meeting-more')).toBeNull();
    });
});

describe('MeetingDetail — a checkbox the server refused (MN-117)', () => {
    it('puts the rail count back and says so', async () => {
        const user = userEvent.setup();
        const { toast } = await import('@/components/shared/Toast');
        toast.error.mockClear();
        const onChanged = vi.fn();
        H.patchTranscription.mockRejectedValue(new Error('Not found'));
        render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" onChanged={onChanged} />);
        await user.click(screen.getByText('harness-toggle'));
        await waitFor(() => expect(toast.error).toHaveBeenCalled());
        expect(onChanged).toHaveBeenLastCalledWith('m-1', { actionsTotal: 2, actionsOpen: 2 });
        expect(H.refresh).toHaveBeenCalled();
    });
});


// ── THE LIBRARY ROW AND THE USAGE LIST FOLLOW THE NOTE (MN-116, MN-118, MN-124) ──

describe('MeetingDetail — re-transcribe keeps the library row current (MN-116)', () => {
    it('marks the row processing, then hands it the finished note', async () => {
        const user = userEvent.setup();
        const onChanged = vi.fn();
        H.state.meeting = { ...note([AI_ITEM]), status: 'failed', failureReason: 'boom' };
        render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" onChanged={onChanged} />);
        await user.click(screen.getByTestId('meeting-more'));
        await user.click(screen.getByText('Re-transcribe'));
        const dialog = await screen.findByRole('dialog');
        await user.click(within(dialog).getByRole('button', { name: 'Re-transcribe' }));
        await waitFor(() => expect(onChanged).toHaveBeenCalledWith('m-1', { status: 'processing', failureReason: null }));

        act(() => H.setData((p) => ({ ...p, status: 'processing' })));
        act(() => H.setData((p) => ({ ...p, status: 'completed', failureReason: undefined, tags: ['sales'], actionItems: [AI_ITEM, USER_ITEM] })));
        await waitFor(() => expect(onChanged).toHaveBeenLastCalledWith('m-1', expect.objectContaining({
            status: 'completed', failureReason: null, tags: ['sales'], actionsTotal: 2, actionsOpen: 2,
        })));
        expect(H.refetchUsage).toHaveBeenCalled();
    });
});

describe('MeetingDetail — what uses this meeting is re-read after a tag change (MN-118)', () => {
    it('after a tag is removed', async () => {
        const user = userEvent.setup();
        H.state.meeting = { ...note([AI_ITEM]), tags: ['sales'] };
        render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" />);
        await user.click(screen.getByLabelText('Remove tag sales'));
        await waitFor(() => expect(H.refetchUsage).toHaveBeenCalledTimes(1));
    });
});

describe('MeetingDetail — tags a regenerate wrote (MN-124)', () => {
    it('shows them, so the next tag edit does not PATCH over them', async () => {
        const user = userEvent.setup();
        const onChanged = vi.fn();
        H.state.meeting = note([AI_ITEM]);
        H.regenerateSummary.mockResolvedValue({ summary: 'Fresh', actionItems: [AI_ITEM], artifactsRegenerated: true });
        H.getTranscription.mockResolvedValue({ ...note([AI_ITEM]), tags: ['budget', 'q3'] });
        render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" onChanged={onChanged} />);
        await user.click(screen.getByText('harness-regenerate'));
        await waitFor(() => expect(within(screen.getByTestId('meeting-tags')).getByText('budget')).toBeTruthy());
        expect(onChanged).toHaveBeenCalledWith('m-1', { tags: ['budget', 'q3'] });
        expect(H.refetchUsage).toHaveBeenCalled();
    });

    it('takes them from the answer when it carries them', async () => {
        const user = userEvent.setup();
        H.state.meeting = note([AI_ITEM]);
        H.regenerateSummary.mockResolvedValue({ summary: 'Fresh', actionItems: [AI_ITEM], tags: ['planning'] });
        render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" />);
        await user.click(screen.getByText('harness-regenerate'));
        await waitFor(() => expect(within(screen.getByTestId('meeting-tags')).getByText('planning')).toBeTruthy());
        expect(H.getTranscription).not.toHaveBeenCalled();
    });
});

// The hook is a plain factory of handlers, called here outside a component.
function edits(data) {
    let local = data;
    const onChanged = vi.fn();
    const onTagsSaved = vi.fn();
    const api = makeMeetingEdits({
        data,
        setLocal: (next) => { local = typeof next === 'function' ? next(local) : next; },
        refresh: vi.fn(),
        onChanged,
        onTagsSaved,
        offerRegenerate: vi.fn(),
        notifyDestinationNotSaved: vi.fn(),
    });
    return { api, onChanged, onTagsSaved, local: () => local };
}

describe('useMeetingEdits — legacy action items without an id (MN-126)', () => {
    const legacy = () => ({
        id: 'm1',
        actionItems: [{ text: 'A', done: false }, { text: 'B', done: false }, { id: 'ai-2', text: 'C', done: false }],
    });

    it('ticks only the item whose position was handed back', async () => {
        const { api } = edits(legacy());
        await api.handleToggleActionItem('legacy-index:0');
        const sent = H.patchTranscription.mock.calls[0][1].actionItems;
        expect(sent.map((ai) => ai.done)).toEqual([true, false, false]);
    });

    it('rewrites only that item’s text', async () => {
        const { api } = edits(legacy());
        await api.handleEditActionItem('legacy-index:1', 'X');
        const sent = H.patchTranscription.mock.calls[0][1].actionItems;
        expect(sent.map((ai) => ai.text)).toEqual(['A', 'X', 'C']);
    });

    it('sets a destination on that item alone', async () => {
        const { api } = edits(legacy());
        await api.handleSetActionDestination('legacy-index:0', { kind: 'automation', ref: 'a-1', label: 'L' });
        const sent = H.patchTranscription.mock.calls[0][1].actionItems;
        expect(sent.map((ai) => !!ai.destination)).toEqual([true, false, false]);
    });

    it('changes nothing for an undefined handle', async () => {
        const { api } = edits(legacy());
        await api.handleToggleActionItem(undefined);
        const sent = H.patchTranscription.mock.calls[0][1].actionItems;
        expect(sent.map((ai) => ai.done)).toEqual([false, false, false]);
    });
});

describe('useMeetingEdits — tags take the server’s cleaned list (MN-130)', () => {
    it('shows and reports the stored tag, not the typed one', async () => {
        const long = 'x'.repeat(120);
        H.patchTranscription.mockImplementation(async (_id, patch) => ({
            success: true, tags: patch.tags.map((t) => t.slice(0, 80)),
        }));
        const { api, onChanged, onTagsSaved, local } = edits({ id: 'm1', tags: ['a'] });
        await api.handleAddTag(long);
        expect(local().tags).toEqual(['a', 'x'.repeat(80)]);
        expect(onChanged).toHaveBeenLastCalledWith('m1', { tags: ['a', 'x'.repeat(80)] });
        // What picks the meeting up is derived from its tags (MN-118).
        expect(onTagsSaved).toHaveBeenCalledTimes(1);
    });

    it('keeps its own list when the answer carries none', async () => {
        H.patchTranscription.mockResolvedValue({ success: true });
        const { api, local } = edits({ id: 'm1', tags: ['a'] });
        await api.handleAddTag('b');
        expect(local().tags).toEqual(['a', 'b']);
    });
});
