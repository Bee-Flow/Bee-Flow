/**
 * "Uit dit transcript gehaald" — het zijpaneel naast de transcriptregels
 * (plan M4 stap 2, artboard 1b).
 *
 * ── WAT DIT BESTAND BEWAAKT ─────────────────────────────────────────
 * Drie dingen, en de rest is opmaak.
 *
 *  1. ER WORDT NIETS OPNIEUW GETELD. De aantallen komen uit
 *     `buildFollowUpStats` — de functie die de Inzichten-tab voedt. Een
 *     paneel met een eigen telling loopt vroeg of laat uit de pas met de tab
 *     ernaast, en dan hebben twee schermen gelijk over dezelfde vergadering.
 *  2. ONBEKEND IS GEEN NUL. Een kb-scan die niet kon draaien moet dat zéggen;
 *     "nog geen regel gefileerd" is een ander antwoord en mag daar nooit voor
 *     in de plaats komen. Hetzelfde geldt voor de sprekersvraag: minder
 *     sprekers dan aanwezigen is pas een vraag als beide lijsten er zijn.
 *  3. DE PER-PERSOONS-GATE HEEFT GEEN ACHTERDEUR. Met de gate dicht mag hier
 *     geen sprekersnaam en geen per-persoonsregel staan — ook niet in de
 *     vraag over een niet-herkende spreker.
 *
 * Draaien: cd agent-hub && npx vitest run src/pages/meeting-notes/detail/ExtractedPanel.test.jsx
 */
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

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

import ExtractedPanel, { speakerGapText } from './ExtractedPanel';
import { SPEAKER_CHECK } from '../lib/transcriptOutputs';

const segments = [
    { start: 0, end: 40, speaker: 'Tom', text: 'Goedemorgen allemaal.' },
    { start: 41, end: 200, speaker: 'Sandra', text: 'De offerte van leverancier A is te duur.' },
    { start: 210, end: 260, speaker: 'Tom', text: 'Ik stuur de opzegging deze week.' },
];

const meeting = {
    id: 't-1',
    title: 'Leveranciersoverleg',
    durationSeconds: 300,
    segments,
    speakers: [{ id: 'Tom', speakingSeconds: 90 }, { id: 'Sandra', speakingSeconds: 159 }],
    attendees: ['Tom', 'Sandra'],
    actionItems: [
        { id: 'ai-1', text: 'Opzegging sturen', assignee: 'Tom', done: false },
        { id: 'ai-2', text: 'Offerte opvragen', assignee: 'Sandra', done: true },
        { id: 'u-1', text: 'Leverancier B bellen', source: 'user', done: false },
    ],
    decisions: [{ id: 'd-1', text: 'We gaan met leverancier B verder.' }],
    questions: [
        { id: 'q-1', text: 'Wanneer loopt het contract af?', open: true },
        { id: 'q-2', text: 'Wie tekent?', open: false },
    ],
};

const kbRow = (over = {}) => ({
    kind: 'kb', id: 'kb-1', title: 'Sales knowledge', role: 'contains', lineCount: 2, ownerId: 'me', ...over,
});

function draw(props = {}) {
    const handlers = { onNavigate: vi.fn(), onEditSpeakers: vi.fn(), ...props };
    render(<ExtractedPanel meeting={meeting} currentUserId="me" {...handlers} />);
    return handlers;
}

describe('the counts', () => {
    it('reports open/total, decisions and OPEN questions from the shared derivation', () => {
        draw({ usage: [] });
        const counts = screen.getByTestId('extracted-counts');
        // 3 action items, one of them done ⇒ "2 / 3". Not "3", and not a
        // second count that forgets the one a person typed themselves.
        expect(counts.textContent).toContain('2 / 3');
        // One decision, and one of the two questions is answered.
        expect(counts).toHaveTextContent(/Decisions\s*1/);
        expect(counts).toHaveTextContent(/Open questions\s*1/);
    });

    it('survives a note with no artifact lists at all', () => {
        render(<ExtractedPanel meeting={{ id: 't-2' }} usage={[]} />);
        expect(screen.getByTestId('extracted-counts').textContent).toContain('0 / 0');
    });
});

describe('filed knowledge lines', () => {
    it('names the knowledge base and how many lines went into it', () => {
        draw({ usage: [kbRow()] });
        const row = screen.getByTestId('extracted-knowledge-row');
        expect(row).toHaveTextContent('2 knowledge lines');
        expect(row).toHaveTextContent('Sales knowledge');
    });

    it('uses the singular sentence for one line, not a bolted-on "s"', () => {
        draw({ usage: [kbRow({ lineCount: 1 })] });
        expect(screen.getByTestId('extracted-knowledge-row')).toHaveTextContent('1 knowledge line');
    });

    it('navigates in-app to a base of your own', () => {
        const { onNavigate } = draw({ usage: [kbRow()] });
        fireEvent.click(screen.getByRole('button', { name: /Sales knowledge/ }));
        expect(onNavigate).toHaveBeenCalledWith('studio/knowledge/kb-1');
    });

    it('a colleague’s base is plain text, never a link this account cannot open', () => {
        draw({ usage: [kbRow({ ownerId: 'someone-else', title: null })] });
        expect(screen.queryByRole('button', { name: /knowledge base/ })).toBeNull();
        expect(screen.getByTestId('extracted-knowledge-row')).toHaveTextContent('Someone else’s knowledge base');
    });

    it('a base that only COLLECTS the tag is not a line anybody filed', () => {
        draw({ usage: [{ kind: 'kb', id: 'kb-9', title: 'Tagged', role: 'contains', siteLabel: 'sales', ownerId: 'me' }] });
        expect(screen.queryByTestId('extracted-knowledge-row')).toBeNull();
        expect(screen.getByTestId('extracted-knowledge-none')).toBeInTheDocument();
    });

    it('says it is still checking while the usage fetch runs', () => {
        draw({ usage: null });
        expect(screen.queryByTestId('extracted-knowledge-none')).toBeNull();
        expect(screen.queryByTestId('extracted-knowledge-unknown')).toBeNull();
        expect(screen.getByTestId('extracted-knowledge')).toHaveTextContent(/Checking/);
    });

    it('A SCAN THAT COULD NOT RUN NEVER READS AS "nothing was filed"', () => {
        draw({ usage: [], usageUnchecked: ['kb'] });
        expect(screen.getByTestId('extracted-knowledge-unknown')).toBeInTheDocument();
        expect(screen.queryByTestId('extracted-knowledge-none')).toBeNull();
    });

    it('a failed usage read is the same unknown, not an empty list', () => {
        draw({ usage: [], usageError: new Error('500') });
        expect(screen.getByTestId('extracted-knowledge-unknown')).toBeInTheDocument();
    });

    it('shows what it did find when only part of the scan failed', () => {
        draw({ usage: [kbRow()], usageUnchecked: ['kb'] });
        expect(screen.getByTestId('extracted-knowledge-row')).toHaveTextContent('Sales knowledge');
        expect(screen.getByTestId('extracted-knowledge')).toHaveTextContent('This list may be incomplete.');
    });
});

describe('speakers and the per-person gate', () => {
    it('lists the speakers from the insights model', () => {
        draw({ usage: [] });
        const panel = screen.getByTestId('extracted-speakers');
        expect(panel).toHaveTextContent('Tom');
        expect(panel).toHaveTextContent('Sandra');
    });

    it('BUILDS NO PER-PERSON ROW when the org disabled per-person statistics', () => {
        render(<ExtractedPanel meeting={meeting} usage={[]} perPersonEnabled={false} onEditSpeakers={vi.fn()} />);
        const panel = screen.getByTestId('extracted-speakers');
        expect(screen.getByTestId('extracted-speakers-off')).toBeInTheDocument();
        expect(panel).not.toHaveTextContent('Tom');
        expect(panel).not.toHaveTextContent('Sandra');
    });
});

describe('the "was X there?" question', () => {
    const withGap = { ...meeting, attendees: ['Tom', 'Sandra', 'Marijke'] };

    it('names the attendee nobody was matched to, and opens the speaker editor', () => {
        const onEditSpeakers = vi.fn();
        render(<ExtractedPanel meeting={withGap} usage={[]} onEditSpeakers={onEditSpeakers} />);
        expect(screen.getByTestId('extracted-speaker-gap')).toHaveTextContent('was Marijke in this meeting?');
        fireEvent.click(screen.getByRole('button', { name: /Check the speakers/ }));
        expect(onEditSpeakers).toHaveBeenCalledTimes(1);
    });

    it('NAMES NOBODY with the gate closed — two counts, no attribution', () => {
        render(<ExtractedPanel meeting={withGap} usage={[]} perPersonEnabled={false} onEditSpeakers={vi.fn()} />);
        const gap = screen.getByTestId('extracted-speaker-gap');
        expect(gap).not.toHaveTextContent('Marijke');
        expect(gap).toHaveTextContent('(2)');
        expect(gap).toHaveTextContent('(3)');
    });

    it('is not asked at all of somebody who cannot answer it', () => {
        // Same gap, no handler: a colleague reading a shared note cannot edit
        // the speakers, and an unanswerable question is noise, not information.
        render(<ExtractedPanel meeting={withGap} usage={[]} />);
        expect(screen.queryByTestId('extracted-speaker-gap')).toBeNull();
    });

    it('asks NOTHING about a transcript whose diarisation could not be read', () => {
        // No segments ⇒ buildInsightsModel answers null. Three attendees and
        // zero speakers is not a shortage; it is a hole in what we know, and
        // "was Marijke there?" would be a name pulled out of that hole.
        render(<ExtractedPanel meeting={{ ...withGap, segments: [], durationSeconds: 0 }} usage={[]} onEditSpeakers={vi.fn()} />);
        expect(screen.queryByTestId('extracted-speaker-gap')).toBeNull();
        expect(screen.getByTestId('extracted-speakers-unknown')).toBeInTheDocument();
    });

    it('never leaves a bare "Speakers" heading with nothing under it', () => {
        render(<ExtractedPanel meeting={{ id: 't-4', attendees: [] }} usage={[]} onEditSpeakers={vi.fn()} />);
        expect(screen.getByTestId('extracted-speakers')).toHaveTextContent('No speaker was recognised in this recording.');
    });

    it('stays quiet about a meeting that never had an attendee list', () => {
        render(<ExtractedPanel meeting={{ id: 't-3', attendees: [] }} usage={[]} onEditSpeakers={vi.fn()} />);
        expect(screen.queryByTestId('extracted-speaker-gap')).toBeNull();
        // Nothing was ever going to be compared, so there is nothing to warn about.
        expect(screen.queryByTestId('extracted-speakers-unknown')).toBeNull();
    });

    it('says nothing when everybody was recognised', () => {
        render(<ExtractedPanel meeting={meeting} usage={[]} onEditSpeakers={vi.fn()} />);
        expect(screen.queryByTestId('extracted-speaker-gap')).toBeNull();
        expect(screen.queryByTestId('extracted-speakers-unknown')).toBeNull();
    });
});

describe('speakerGapText', () => {
    const t = (key, fallback, vars) => {
        let out = fallback;
        for (const [k, v] of Object.entries(vars || {})) out = out.split(`{${k}}`).join(String(v));
        return out;
    };

    it('picks the KEY by how many names there are, never a suffix', () => {
        const one = { state: SPEAKER_CHECK.GAP, names: ['Marijke'], speakerCount: 2, attendeeCount: 3 };
        expect(speakerGapText(one, t)).toBe('One speaker was not recognised — was Marijke in this meeting?');

        const many = { state: SPEAKER_CHECK.GAP, names: ['Marijke', 'René'], speakerCount: 1, attendeeCount: 3 };
        expect(speakerGapText(many, t)).toBe('Not everyone was recognised — Marijke, René were not matched to a speaker.');
    });

    it('NEVER claims a number of unrecognised speakers it cannot know', () => {
        // Three attendees, two "Guest-…" labels: one speaker is missing, but
        // no attendee matches a label, so all three come back as unmatched.
        // Turning that into "3 speakers were not recognised" would be false
        // about a recording in which two people demonstrably spoke.
        const guests = { state: SPEAKER_CHECK.GAP, names: ['Tom', 'Sandra', 'Marijke'], speakerCount: 2, attendeeCount: 3 };
        expect(speakerGapText(guests, t)).not.toMatch(/3 speakers/);
        expect(speakerGapText(guests, t)).toContain('Tom, Sandra, Marijke');
    });

    it('falls back to the two counts when there is no name to use', () => {
        expect(speakerGapText({ state: SPEAKER_CHECK.GAP, names: null, speakerCount: 2, attendeeCount: 3 }, t))
            .toBe('Fewer speakers were recognised (2) than there were attendees (3).');
        expect(speakerGapText({ state: SPEAKER_CHECK.GAP, names: [], speakerCount: 2, attendeeCount: 3 }, t))
            .toContain('(2)');
    });
});
