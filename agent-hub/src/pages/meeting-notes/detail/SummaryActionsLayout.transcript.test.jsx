/**
 * De transcript-tab en het paneel ernaast (plan M4 stap 2, artboard 1b).
 *
 * ── WAAROM DIT BESTAND BESTAAT ──────────────────────────────────────
 * ExtractedPanel wordt in zijn eigen test op alles losgelaten wat het kan
 * zeggen. Wat dáár niet te zien is, is of het paneel op het scherm dezelfde
 * gegevens krijgt: `usageUnchecked` loopt van `useUsage` via MeetingDetail en
 * deze layout naar het paneel, en dat is precies het soort doorgeefluik dat
 * bij de eerste refactor sneuvelt zonder dat er iets rood wordt. Valt het weg,
 * dan zegt het paneel "nog geen regel gefileerd" over een scan die niet heeft
 * kunnen kijken — de fail-open die de rest van dit scherm nergens toestaat.
 *
 * Draaien: cd agent-hub && npx vitest run src/pages/meeting-notes/detail/SummaryActionsLayout.transcript.test.jsx
 */
import { render, screen } from '@testing-library/react';
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

// De popover-takken worden hier niet geopend; de modules worden wel geladen.
vi.mock('../../../hooks/useAutomationApi', () => ({ default: () => ({ listAutomations: vi.fn(), run: vi.fn() }) }));
vi.mock('../../../components/admin/Studio/Datatables/datatablesApi', () => ({
    datatablesApi: { list: vi.fn(), getSchema: vi.fn(), addRow: vi.fn() },
}));
vi.mock('../../../components/admin/Studio/KnowledgeStudio/knowledgeApi', () => {
    const api = { list: vi.fn(), createSource: vi.fn() };
    return { default: api, knowledgeApi: api };
});

import { TABS } from './MeetingHeader';
import SummaryActionsLayout from './SummaryActionsLayout';

const meeting = {
    id: 't-1',
    title: 'Leveranciersoverleg',
    durationSeconds: 300,
    segments: [
        { start: 0, end: 40, speaker: 'Tom', text: 'Goedemorgen allemaal.' },
        { start: 41, end: 200, speaker: 'Sandra', text: 'De offerte is te duur.' },
    ],
    speakers: [{ id: 'Tom', speakingSeconds: 40 }, { id: 'Sandra', speakingSeconds: 159 }],
    attendees: ['Tom', 'Sandra'],
    actionItems: [], decisions: [], questions: [], chapters: [], tags: [],
};

describe('the transcript tab', () => {
    it('puts the "pulled from this transcript" panel beside the transcript', () => {
        render(<SummaryActionsLayout meeting={meeting} tab={TABS.TRANSCRIPT} usage={[]} />);
        expect(screen.getAllByTestId('transcript-row').length).toBe(2);
        expect(screen.getByTestId('extracted-panel')).toBeInTheDocument();
    });

    it('hands the panel the kinds the server could NOT check', () => {
        render(<SummaryActionsLayout meeting={meeting} tab={TABS.TRANSCRIPT} usage={[]} usageUnchecked={['kb']} />);
        // Dropped anywhere along the way, this becomes "no line has been
        // filed yet" — a claim nobody verified.
        expect(screen.getByTestId('extracted-knowledge-unknown')).toBeInTheDocument();
        expect(screen.queryByTestId('extracted-knowledge-none')).toBeNull();
    });

    it('keeps the panel off the summary tab — it belongs to the transcript', () => {
        render(<SummaryActionsLayout meeting={meeting} tab={TABS.SUMMARY} usage={[]} />);
        expect(screen.queryByTestId('extracted-panel')).toBeNull();
    });
});
