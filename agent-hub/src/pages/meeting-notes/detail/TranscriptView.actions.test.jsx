/**
 * The transcript tab and its per-line popover (plan M4, artboard 1b).
 *
 * ── WHAT THIS FILE IS GUARDING ──────────────────────────────────────
 * Two things, and everything else here is shape.
 *
 *  1. THE LINE NUMBER IS THE UNFILTERED ONE. Every artifact a person makes
 *     here stores a `segmentIndex`, and the transcript's third column reads it
 *     back. The rendered list is filtered by a search box and a speaker chip,
 *     so writing the rendered position would silently anchor the sentence to a
 *     different line the moment anybody typed in the box — and the chip would
 *     then appear on somebody else's words.
 *  2. WHAT A PERSON MAKES HERE IS THEIRS. The item goes over the wire marked
 *     `source: 'user'`, which is what keeps the next "Opnieuw" from deleting
 *     it (the server half of that rule is pinned in
 *     server/core/meetingNotes/actionItems.test.js and
 *     server/routes/transcriptions.regenerate.test.js).
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const listAutomations = vi.fn();
const runAutomation = vi.fn();
vi.mock('../../../hooks/useAutomationApi', () => ({
    default: () => ({ listAutomations: (...a) => listAutomations(...a), run: (...a) => runAutomation(...a) }),
}));

const tableList = vi.fn();
const getSchema = vi.fn();
const addRow = vi.fn();
vi.mock('../../../components/admin/Studio/Datatables/datatablesApi', () => ({
    datatablesApi: {
        list: (...a) => tableList(...a),
        getSchema: (...a) => getSchema(...a),
        addRow: (...a) => addRow(...a),
    },
}));

const kbList = vi.fn();
const createSource = vi.fn();
vi.mock('../../../components/admin/Studio/KnowledgeStudio/knowledgeApi', () => {
    const api = { list: (...a) => kbList(...a), createSource: (...a) => createSource(...a) };
    return { default: api, knowledgeApi: api };
});

import TranscriptView from './TranscriptView';
import { appendArtifact } from '../lib/transcriptLines';

const segments = [
    { start: 0, speaker: 'Tom', text: 'Goedemorgen allemaal.' },
    { start: 61, speaker: 'Sandra', text: 'De offerte van leverancier A is te duur.' },
    { start: 754.2, speaker: 'Sandra', text: 'We gaan met leverancier B verder.' },
    { start: 900, speaker: 'Tom', text: 'Ik stuur de opzegging deze week.' },
];
const speakers = [{ id: 'Tom' }, { id: 'Sandra' }];
const meeting = { id: 't-1', title: 'Leveranciersoverleg', createdAt: '2026-09-07T09:00:00.000Z' };

const rowFor = (text) => screen.getByText(text).closest('li');
const writeText = vi.fn();

function open(props = {}) {
    const handlers = {
        onAddLineAction: vi.fn().mockResolvedValue(true),
        onAddLineDecision: vi.fn().mockResolvedValue(true),
        ...props,
    };
    render(<TranscriptView segments={segments} speakers={speakers} meeting={meeting} {...handlers} />);
    return handlers;
}

const openMenuOn = (text) => fireEvent.click(within(rowFor(text)).getByTestId('transcript-line-menu-trigger'));

beforeEach(() => {
    for (const fn of [listAutomations, runAutomation, tableList, getSchema, addRow, kbList, createSource, writeText]) fn.mockReset();
    tableList.mockResolvedValue({ datatables: [{ id: 't-9', name: 'Backlog', grade: 'editor' }] });
    getSchema.mockResolvedValue({
        fields: [
            { key: 'title', type: 'text', label: 'Title' },
            { key: 'who', type: 'text', label: 'Who' },
            { key: 'amount', type: 'number', label: 'Amount' },
        ],
    });
    addRow.mockResolvedValue({ id: 'row-1' });
    kbList.mockResolvedValue([{ id: 'kb-1', name: 'Inkoop' }]);
    createSource.mockResolvedValue({ source: { id: 'src-1' } });
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

describe('TranscriptView — the three columns', () => {
    it('lays the line out as 110px | 1fr | 150px', () => {
        open();
        // The artboard's contract. A row that loses its third column loses the
        // classification chips and the popover with them.
        expect(rowFor('Goedemorgen allemaal.').className).toContain('grid-cols-[110px_1fr_150px]');
    });

    it('chips a line with what was pulled out of it', () => {
        open({
            meeting: {
                ...meeting,
                actionItems: [{ id: 'u-1', text: 'Opzegging sturen', segmentIndex: 3, source: 'user' }],
                decisions: [{ id: 'ud-1', text: 'Leverancier B', segmentIndex: 2, source: 'user' }],
                questions: [{ id: 'uq-1', text: 'Te duur?', segmentIndex: 1, open: false }],
            },
        });
        expect(within(rowFor('Ik stuur de opzegging deze week.')).getByTestId('line-mark-action')).toBeTruthy();
        expect(within(rowFor('We gaan met leverancier B verder.')).getByTestId('line-mark-decision')).toBeTruthy();
        // An answered question is a different LABEL, not a suffix bolted onto
        // one — the ternary sits around the key, never inside the sentence.
        expect(within(rowFor('De offerte van leverancier A is te duur.')).getByText('Answered')).toBeTruthy();
        expect(within(rowFor('Goedemorgen allemaal.')).queryByTestId('line-mark-action')).toBeNull();
    });

    it('never chips the first line for the items that predate anchors', () => {
        // Every artifact written before M4 has no segmentIndex at all, and
        // Number(undefined) must not become line 0 — that would decorate the
        // opening sentence of every older meeting with marks nobody put there.
        open({
            meeting: {
                ...meeting,
                actionItems: [{ id: 'ai-0', text: 'Oud punt' }],
                decisions: [{ id: 'd-0', text: 'Oud besluit', segmentIndex: null }],
            },
        });
        expect(screen.queryAllByTestId('line-mark-action')).toHaveLength(0);
        expect(screen.queryAllByTestId('line-mark-decision')).toHaveLength(0);
    });

    it('outlines the selected line with the shared pulse, and only that line', () => {
        open();
        fireEvent.click(rowFor('We gaan met leverancier B verder.'));
        const picked = rowFor('We gaan met leverancier B verder.');
        expect(picked.style.outline).toContain('var(--accent-primary)');
        // The keyframe animates outline-color ONLY, so selecting a line cannot
        // shift the lines under the cursor.
        expect(picked.style.animation).toContain('bf-node-pulse');
        expect(rowFor('Goedemorgen allemaal.').style.animation).toBe('');
    });
});

describe('TranscriptView — what one line can become', () => {
    it('offers the five entries of the artboard to the owner', () => {
        open();
        openMenuOn('We gaan met leverancier B verder.');
        for (const label of ['Action', 'Decision', 'To a knowledge base', 'Row in a table', 'Copy quote']) {
            expect(screen.getByText(label)).toBeTruthy();
        }
    });

    /**
     * "Actie" and "Besluit" write on the NOTE, which only its owner may do.
     * The other three write into the viewer's OWN workspace — their knowledge
     * base, their table, their clipboard — and are gated by those routes, so a
     * colleague reading a shared note keeps them.
     */
    it('withholds the two note writes from a reader, and keeps the other three', () => {
        render(<TranscriptView segments={segments} speakers={speakers} meeting={meeting} />);
        openMenuOn('We gaan met leverancier B verder.');
        expect(screen.queryByText('Action')).toBeNull();
        expect(screen.queryByText('Decision')).toBeNull();
        expect(screen.getByText('Copy quote')).toBeTruthy();
        expect(screen.getByText('To a knowledge base')).toBeTruthy();
    });

    it('writes an action marked as the person\'s, anchored to that line', async () => {
        const { onAddLineAction } = open();
        openMenuOn('We gaan met leverancier B verder.');
        fireEvent.click(screen.getByText('Action'));
        await waitFor(() => expect(onAddLineAction).toHaveBeenCalled());

        const item = onAddLineAction.mock.calls[0][0];
        // THE BITE. Without this field the next "Opnieuw" deletes the line the
        // person just picked, with no undo and nothing on screen to say so.
        expect(item.source).toBe('user');
        expect(item.segmentIndex).toBe(2);
        expect(item.text).toBe('We gaan met leverancier B verder.');
        expect(item.timestamp).toBe('12:34');
    });

    it('writes a decision the same way', async () => {
        const { onAddLineDecision } = open();
        openMenuOn('Ik stuur de opzegging deze week.');
        fireEvent.click(screen.getByText('Decision'));
        await waitFor(() => expect(onAddLineDecision).toHaveBeenCalled());
        const decision = onAddLineDecision.mock.calls[0][0];
        expect(decision.source).toBe('user');
        expect(decision.segmentIndex).toBe(3);
    });

    /**
     * THE BITE, second half. The list on screen is filtered; the anchor is
     * not. Storing the rendered position would point the chip — and, one stage
     * later, the seek — at whatever sentence happens to sit at that position
     * once the search box is cleared.
     */
    it('stores the line\'s real number even when the list is filtered', async () => {
        const { onAddLineAction } = open();
        fireEvent.change(screen.getByPlaceholderText('Search transcript…'), { target: { value: 'opzegging' } });
        // One row left, so what is written next is being written from the
        // FIRST rendered row — which is the fourth line of the meeting.
        const rows = screen.getAllByTestId('transcript-row');
        expect(rows).toHaveLength(1);

        fireEvent.click(within(rows[0]).getByTestId('transcript-line-menu-trigger'));
        fireEvent.click(screen.getByText('Action'));
        await waitFor(() => expect(onAddLineAction).toHaveBeenCalled());
        expect(onAddLineAction.mock.calls[0][0].segmentIndex).toBe(3);
        expect(onAddLineAction.mock.calls[0][0].timestamp).toBe('15:00');
    });

    /**
     * ── DE TWEEDE KLIK OP DEZELFDE REGEL ────────────────────────────
     * `buildLineActionItem` is deterministisch, `appendArtifact` plakt blind
     * achter, en `collect()` (server) ontdubbelt alleen op id — dat elk item
     * vers gemunt krijgt. Een tweede bezoek maakte dus een byte-identiek
     * tweede item, en dat is niet terug te draaien: er is geen verwijderknop
     * voor een los item en `source:'user'` is juist wat elke "Opnieuw" laat
     * staan. Het menu moet zelf zeggen wat de regel al heeft opgeleverd.
     */
    it('biedt geen tweede actie aan op een regel die er al een heeft', () => {
        open({
            meeting: {
                ...meeting,
                actionItems: [{ id: 'u-1', text: 'We gaan met leverancier B verder.', segmentIndex: 2, source: 'user' }],
            },
        });
        openMenuOn('We gaan met leverancier B verder.');
        expect(screen.getByTestId('line-already-action')).toBeTruthy();
        // Er valt niets te kiezen: geen knop, dus ook geen menuitem.
        expect(screen.getByTestId('line-already-action').closest('button')).toBeNull();
        // En het is de ANDERE soort niet: een besluit kan deze regel nog worden.
        expect(screen.getByText('Decision')).toBeTruthy();
        expect(screen.queryByTestId('line-already-decision')).toBeNull();
    });

    it('remt per soort, niet per regel', () => {
        open({
            meeting: {
                ...meeting,
                decisions: [{ id: 'ud-1', text: 'Leverancier B', segmentIndex: 2, source: 'user' }],
            },
        });
        openMenuOn('We gaan met leverancier B verder.');
        expect(screen.getByTestId('line-already-decision')).toBeTruthy();
        expect(screen.getByText('Action')).toBeTruthy();
    });

    /**
     * Dezelfde val als in de derde kolom: een item van vóór M4 heeft geen
     * anker, en `Number(undefined)` mag geen 0 worden — anders is de eerste
     * zin van elke oudere meeting "al een actie" en kan niemand hem meer
     * markeren.
     */
    it('remt niets op een item zonder anker', () => {
        open({ meeting: { ...meeting, actionItems: [{ id: 'ai-0', text: 'Oud punt' }] } });
        openMenuOn('Goedemorgen allemaal.');
        expect(screen.getByText('Action')).toBeTruthy();
        expect(screen.queryByTestId('line-already-action')).toBeNull();
    });

    /**
     * En hetzelfde over een ECHTE ronde: schrijven, menu dicht, menu weer
     * open. Dit is de weg waarlangs de dubbel ontstond — de chip die het al
     * zei staat 150px verderop in dezelfde rij, en wie na een scroll twijfelt
     * of de eerste klik landde, klikt gewoon nog eens.
     */
    it('laat een tweede bezoek na een geslaagde schrijfactie niets meer schrijven', async () => {
        const onWrite = vi.fn();
        function Harness() {
            const [note, setNote] = React.useState({ ...meeting, actionItems: [] });
            const add = async (item) => {
                const next = appendArtifact(note.actionItems || [], item);
                onWrite(next);
                // Zoals de server teruggeeft: elk item krijgt een vers id.
                setNote((p) => ({ ...p, actionItems: next.map((i, n) => ({ ...i, id: i.id || `u-${n}` })) }));
                return true;
            };
            return <TranscriptView segments={segments} speakers={speakers} meeting={note} onAddLineAction={add} />;
        }
        render(<Harness />);

        openMenuOn('We gaan met leverancier B verder.');
        fireEvent.click(screen.getByText('Action'));
        await waitFor(() => expect(onWrite).toHaveBeenCalledTimes(1));

        openMenuOn('We gaan met leverancier B verder.');
        expect(await screen.findByTestId('line-already-action')).toBeTruthy();
        expect(onWrite).toHaveBeenCalledTimes(1);
        // Eén chip, één rij op de kaart.
        expect(within(rowFor('We gaan met leverancier B verder.')).queryAllByTestId('line-mark-action')).toHaveLength(1);
    });

    it('copies the quote with who said it and when', async () => {
        open();
        openMenuOn('We gaan met leverancier B verder.');
        fireEvent.click(screen.getByText('Copy quote'));
        await waitFor(() => expect(writeText).toHaveBeenCalledWith('[12:34] Sandra: We gaan met leverancier B verder.'));
    });

    it('says so when the browser refused the clipboard', async () => {
        // "Copied" with an empty clipboard is the worst of both.
        writeText.mockRejectedValue(new Error('denied'));
        open();
        openMenuOn('We gaan met leverancier B verder.');
        fireEvent.click(screen.getByText('Copy quote'));
        expect(await screen.findByRole('alert')).toBeTruthy();
    });
});

describe('TranscriptView — a line into a knowledge base or a table', () => {
    it('files a text source that says which transcript line it is', async () => {
        open();
        openMenuOn('We gaan met leverancier B verder.');
        fireEvent.click(screen.getByText('To a knowledge base'));
        fireEvent.click(await screen.findByText('Inkoop'));
        await waitFor(() => expect(createSource).toHaveBeenCalled());

        const [kbId, body] = createSource.mock.calls[0];
        expect(kbId).toBe('kb-1');
        expect(body.kind).toBe('text');
        expect(body.config.metadata).toEqual({ transcriptionId: 't-1', segmentIndex: 2 });
        expect(body.config.text).toContain('We gaan met leverancier B verder.');
    });

    it('adds a row through the same allow-list the action card uses', async () => {
        open();
        openMenuOn('We gaan met leverancier B verder.');
        fireEvent.click(screen.getByText('Row in a table'));
        fireEvent.click(await screen.findByText('Backlog'));
        // A `number` column cannot hold a sentence, so it is not offered.
        expect(await screen.findByLabelText('Title')).toBeTruthy();
        expect(screen.queryByLabelText('Amount')).toBeNull();
        // The quote lands in the first text column by default; name the
        // speaker into the second by hand.
        fireEvent.change(screen.getByLabelText('Who'), { target: { value: 'assignee' } });
        fireEvent.click(screen.getByText('Add the row'));
        await waitFor(() => expect(addRow).toHaveBeenCalled());

        const [tableId, values] = addRow.mock.calls[0];
        expect(tableId).toBe('t-9');
        expect(values).toEqual({ title: 'We gaan met leverancier B verder.', who: 'Sandra' });
    });

    it('shows the route\'s own refusal and leaves the menu open', async () => {
        createSource.mockRejectedValue(new Error('This plan allows 3 knowledge sources per knowledge base.'));
        open();
        openMenuOn('We gaan met leverancier B verder.');
        fireEvent.click(screen.getByText('To a knowledge base'));
        fireEvent.click(await screen.findByText('Inkoop'));
        expect((await screen.findByRole('alert')).textContent).toContain('This plan allows 3 knowledge sources');
    });

    it('says so when the note itself refused the write', async () => {
        // The popover closing on a PATCH that failed looks exactly like one
        // that worked, and the action would be gone on the next refresh.
        const { onAddLineAction } = open({ onAddLineAction: vi.fn().mockResolvedValue(false) });
        openMenuOn('We gaan met leverancier B verder.');
        fireEvent.click(screen.getByText('Action'));
        await waitFor(() => expect(onAddLineAction).toHaveBeenCalled());
        expect((await screen.findByRole('alert')).textContent).toContain('could not be updated');
    });
});
