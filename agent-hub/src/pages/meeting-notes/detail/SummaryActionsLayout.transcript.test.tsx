/**
 * The transcript tab and the panel beside it (plan M4 step 2, artboard 1b).
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────
 * ExtractedPanel is put through its own test on everything it can say. What is not
 * visible there is whether the panel on the screen gets the same data. `usageUnchecked`
 * runs from `useUsage` via MeetingDetail and this layout to the panel, and that is
 * precisely the kind of pass-through that vanishes at the first refactor without
 * anything turning red. If it drops away, the panel says "no rule filed yet" about a
 * scan that could not look: the fail-open that the rest of this screen nowhere allows.
 *
 * Running: cd agent-hub && npx vitest run src/pages/meeting-notes/detail/SummaryActionsLayout.transcript.test.jsx
 */
import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../hooks/useTranslation', () => import('@/test/useTranslationParamsMock'));

// The popover branches are not opened here. The modules are loaded, however.
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
import { omitted } from '@/test/mocks';
import { type ComponentProps } from 'react';

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
        render(<SummaryActionsLayout {...omitted<ComponentProps<typeof SummaryActionsLayout>>()} meeting={meeting} tab={TABS.TRANSCRIPT} usage={[]} />);
        expect(screen.getAllByTestId('transcript-row').length).toBe(2);
        expect(screen.getByTestId('extracted-panel')).toBeInTheDocument();
    });

    it('hands the panel the kinds the server could NOT check', () => {
        render(<SummaryActionsLayout {...omitted<ComponentProps<typeof SummaryActionsLayout>>()} meeting={meeting} tab={TABS.TRANSCRIPT} usage={[]} usageUnchecked={['kb']} />);
        // Dropped anywhere along the way, this becomes "no line has been
        // filed yet" — a claim nobody verified.
        expect(screen.getByTestId('extracted-knowledge-unknown')).toBeInTheDocument();
        expect(screen.queryByTestId('extracted-knowledge-none')).toBeNull();
    });

    it('keeps the panel off the summary tab — it belongs to the transcript', () => {
        render(<SummaryActionsLayout {...omitted<ComponentProps<typeof SummaryActionsLayout>>()} meeting={meeting} tab={TABS.SUMMARY} usage={[]} />);
        expect(screen.queryByTestId('extracted-panel')).toBeNull();
    });
});
