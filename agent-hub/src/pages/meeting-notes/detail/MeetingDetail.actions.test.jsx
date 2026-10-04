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
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
    patchTranscription: vi.fn(),
    regenerateSummary: vi.fn(),
    refresh: vi.fn(),
    state: { meeting: null },
}));

vi.mock('../../../hooks/useTranslation', () => {
    const translator = () => ({
        t: (key, fallback, vars) => {
            let out = fallback || key;
            for (const [k, v] of Object.entries(vars || {})) out = out.split(`{${k}}`).join(String(v));
            return out;
        },
        language: 'en', locale: 'en',
    });
    return { default: translator, useTranslation: translator };
});

vi.mock('../../../hooks/useUsage', () => ({
    default: () => ({ usage: [], unchecked: [], error: null, loading: false, refetch: () => {}, setUsage: () => {} }),
    USAGE_KIND_PATH: {},
}));

// A real local copy of the note, so an optimistic write and the server's echo
// can actually be told apart on screen.
vi.mock('../hooks/useTranscription', async () => {
    const React2 = await import('react');
    function useTranscriptionStub() {
        const [data, setData] = React2.useState(() => H.state.meeting);
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

vi.mock('../lib/transcriptionsApi', () => ({
    patchTranscription: (...a) => H.patchTranscription(...a),
    regenerateSummary: (...a) => H.regenerateSummary(...a),
    deleteTranscription: vi.fn(async () => ({ success: true })),
    reprocessTranscription: vi.fn(async () => ({})),
    exportTranscription: vi.fn(async () => new Blob()),
    listSummaryTemplates: vi.fn(async () => []),
    getSeriesPrevious: vi.fn(async () => null),
    audioUrl: () => '', audioDownloadUrl: () => '',
}));

vi.mock('./WaveformPlayer', () => ({ default: () => <div data-testid="player" /> }));
vi.mock('./AssistantSidebar', () => ({ default: () => null }));
vi.mock('./SpeakerEditor', () => ({ default: () => null }));
vi.mock('./TemplateEditor', () => ({ default: () => null }));
vi.mock('./MeetingVisibility', () => ({ default: () => null }));
vi.mock('../../../components/shared/Toast', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

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
            <button type="button" onClick={() => onToggleActionItem?.('ai-0')}>harness-toggle</button>
        </div>
    ),
}));

import MeetingDetail from './MeetingDetail';

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
        H.regenerateSummary.mockResolvedValue({
            summary: 'Fresh',
            actionItems: [
                USER_ITEM,
                { id: 'ai-0', text: 'Opnieuw geëxtraheerd', done: false, source: 'ai' },
            ],
        });
        render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" />);
        expect(texts()).toEqual(['Filter inbouwen', 'Morgen contact opnemen → Backlog']);

        fireEvent.click(screen.getByText('harness-regenerate'));
        await waitFor(() => expect(texts()).toContain('Opnieuw geëxtraheerd'));
        // Survived, with the chip that says where it went.
        expect(texts()).toContain('Morgen contact opnemen → Backlog');
        // And the stale AI item is gone — the answer was taken whole.
        expect(texts()).not.toContain('Filter inbouwen');
    });

    /**
     * ── EEN MISLUKTE ARTEFACTPASS MOET HET ZEGGEN ───────────────────
     * De server bewaart bij een omgevallen extractie de bestaande
     * actiepunten, besluiten en vragen en antwoordt `artifactsRegenerated:
     * false`. Dat veld las niemand. Voor de persoon die net op "Opnieuw"
     * drukte is het resultaat dan niet te onderscheiden van "de vergadering
     * leverde niets nieuws op": de samenvatting is vernieuwd, de lijsten
     * staan er nog, en niets zegt dat de helft van de knop niet gedraaid
     * heeft. Dan drukt niemand nog eens.
     */
    it('says so when the server reports the artifact pass did not run', async () => {
        const { toast } = await import('../../../components/shared/Toast');
        toast.info.mockClear();
        H.regenerateSummary.mockResolvedValue({
            summary: 'Fresh',
            actionItems: [AI_ITEM, USER_ITEM],
            artifactsRegenerated: false,
        });
        render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" />);
        fireEvent.click(screen.getByText('harness-regenerate'));
        await waitFor(() => expect(screen.getByTestId('summary').textContent).toBe('Fresh'));

        expect(toast.info).toHaveBeenCalled();
        expect(String(toast.info.mock.calls.at(-1)[0])).toMatch(/action items/i);
        // En de lijst staat er nog: bewaren is de helft, zeggen dat je
        // bewaard hebt is de andere helft.
        expect(texts()).toContain('Filter inbouwen');
    });

    it('stays quiet when the artifact pass DID run', async () => {
        const { toast } = await import('../../../components/shared/Toast');
        toast.info.mockClear();
        H.regenerateSummary.mockResolvedValue({
            summary: 'Fresh', actionItems: [AI_ITEM], artifactsRegenerated: true,
        });
        render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" />);
        fireEvent.click(screen.getByText('harness-regenerate'));
        await waitFor(() => expect(screen.getByTestId('summary').textContent).toBe('Fresh'));
        expect(toast.info).not.toHaveBeenCalled();
    });

    it('leaves the list alone when the answer is not a list, rather than emptying the card', async () => {
        H.regenerateSummary.mockResolvedValue({ summary: 'Fresh' });
        render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" />);
        fireEvent.click(screen.getByText('harness-regenerate'));
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
        render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" />);
        fireEvent.click(screen.getByText('harness-set-destination'));
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
        H.patchTranscription.mockResolvedValue({
            success: true,
            actionItems: [
                AI_ITEM,
                { ...USER_ITEM, text: 'Morgen contact opnemen', destination: { kind: 'automation', ref: 'a-1', label: 'Weging (server)', at: '2026-07-27T10:00:00.000Z' } },
            ],
        });
        render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" />);
        fireEvent.click(screen.getByText('harness-set-destination'));
        await waitFor(() => expect(texts()).toContain('Morgen contact opnemen → Weging (server)'));
    });

    it('keeps the rail’s open-action count in step with a checkbox', async () => {
        const onChanged = vi.fn();
        render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" onChanged={onChanged} />);
        fireEvent.click(screen.getByText('harness-toggle'));
        await waitFor(() => expect(H.patchTranscription).toHaveBeenCalled());
        expect(onChanged).toHaveBeenCalledWith('m-1', { actionsTotal: 2, actionsOpen: 1 });
    });

    it('says so when the note could not be saved after the automation already ran', async () => {
        const { toast } = await import('../../../components/shared/Toast');
        H.patchTranscription.mockRejectedValue(new Error('offline'));
        render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" />);
        fireEvent.click(screen.getByText('harness-set-destination'));
        await waitFor(() => expect(toast.error).toHaveBeenCalled());
        expect(String(toast.error.mock.calls.at(-1)[0])).toMatch(/could not be updated/i);
        expect(H.refresh).toHaveBeenCalled();
    });
});


// ── DE SJABLOONSTEMPEL NA "OPNIEUW" (M4 stap 3) ─────────────────────
//
// De stempel zegt met welk sjabloon de tekst die er NU staat geschreven is.
// Na een regenerate hoort het scherm dus de stempel van het ANTWOORD te
// dragen — ook als dat antwoord "geen sjabloon" is.

describe('MeetingDetail — de sjabloonstempel volgt de nieuwe tekst', () => {
    it('neemt de stempel van het antwoord over', async () => {
        H.state.meeting = { ...note([AI_ITEM]), summaryTemplateId: 'builtin:general', summaryTemplateVersion: null };
        H.regenerateSummary.mockResolvedValue({
            summary: 'Fresh', actionItems: [AI_ITEM],
            summaryTemplateId: 'tpl-9', summaryTemplateVersion: 4,
        });
        render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" />);
        fireEvent.click(screen.getByText('harness-regenerate'));
        await waitFor(() => expect(screen.getByTestId('stamp').textContent).toBe('tpl-9|4'));
    });

    it('WIST de stempel als het antwoord er geen draagt (eenmalige prompt)', async () => {
        // Het vorige sjabloon laten staan zou een sjabloonnaam plakken op
        // tekst die dat sjabloon nooit geschreven heeft.
        H.state.meeting = { ...note([AI_ITEM]), summaryTemplateId: 'tpl-9', summaryTemplateVersion: 4 };
        H.regenerateSummary.mockResolvedValue({ summary: 'Fresh', actionItems: [AI_ITEM], summaryTemplateId: null, summaryTemplateVersion: null });
        render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" />);
        expect(screen.getByTestId('stamp').textContent).toBe('tpl-9|4');
        fireEvent.click(screen.getByText('harness-regenerate'));
        await waitFor(() => expect(screen.getByTestId('summary').textContent).toBe('Fresh'));
        expect(screen.getByTestId('stamp').textContent).toBe('null|null');
    });
});


// ── EEN BEWAARD PUNT MOET HET ZEGGEN (M4) ───────────────────────────
//
// De server bewaart een AI-punt dat een mens had afgevinkt of overgetypt, óók
// wanneer de nieuwe extractie het niet meer oplevert — weggooien-en-opnieuw-
// aanmaken zou die invoer alsnog wissen. Zo'n punt komt terug met
// `orphaned: true`. Dat stilzwijgend doorlaten laat de kaart beweren dat de
// AI het zojuist heeft opgeleverd, dus wordt het benoemd op het moment dat het
// gebeurt (de blijvende markering staat op de kaart zelf, ActionItemsList).

describe('MeetingDetail — bewaarde actiepunten worden benoemd', () => {
    it('zegt hoeveel punten bewaard zijn die de nieuwe pass niet meer opleverde', async () => {
        const { toast } = await import('../../../components/shared/Toast');
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
        fireEvent.click(screen.getByText('harness-regenerate'));
        await waitFor(() => expect(screen.getByTestId('summary').textContent).toBe('Fresh'));

        expect(toast.info).toHaveBeenCalled();
        const said = String(toast.info.mock.calls.at(-1)[0]);
        // EEN punt zegt "one", niet "1": de vormkeuze ligt op de SLEUTEL
        // (basis + `_plural`), niet op een "(s)" in de zin. Pinnen op het
        // cijfer zou juist de Engelse-grammatica-in-code terugvragen.
        expect(said).toMatch(/\bone\b/i);
        expect(said).not.toMatch(/\d/);
        expect(said).toMatch(/kept/i);
        // En het punt staat er nog: benoemen mag nooit in plaats van bewaren.
        expect(texts()).toContain('Contract tekenen');
    });

    it('...en telt ze wél zodra het er meer dan een zijn', async () => {
        const { toast } = await import('../../../components/shared/Toast');
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
        fireEvent.click(screen.getByText('harness-regenerate'));
        await waitFor(() => expect(screen.getByTestId('summary').textContent).toBe('Fresh'));

        const said = String(toast.info.mock.calls.at(-1)[0]);
        expect(said).toMatch(/\b2\b/);
        expect(said).toMatch(/kept/i);
        expect(texts()).toContain('Contract tekenen');
        expect(texts()).toContain('Offerte nakijken');
    });

    it('zwijgt wanneer elk punt gewoon herkend werd', async () => {
        const { toast } = await import('../../../components/shared/Toast');
        toast.info.mockClear();
        H.regenerateSummary.mockResolvedValue({
            summary: 'Fresh', actionItems: [AI_ITEM], artifactsRegenerated: true,
        });
        render(<MeetingDetail id="m-1" currentUserId="me" currentUserName="Me" />);
        fireEvent.click(screen.getByText('harness-regenerate'));
        await waitFor(() => expect(screen.getByTestId('summary').textContent).toBe('Fresh'));
        expect(toast.info).not.toHaveBeenCalled();
    });
});
