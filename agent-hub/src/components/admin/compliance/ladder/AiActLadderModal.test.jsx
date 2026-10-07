import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../utils/helpers', () => ({ authFetch: vi.fn() }));
vi.mock('../../../shared/Toast', () => {
    const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() };
    return { default: toast, toast };
});

import AiActLadderModal from './AiActLadderModal';
import { legacyAnnexAnswers } from './ladderOutcome';
import { authFetch } from '../../../../utils/helpers';
import toast from '../../../shared/Toast';
import { API } from '../data/api';

// The artboard's day: 14 Sep 2026 → 79 days to 2 Dec 2026.
const NOW = new Date(2026, 8, 14, 15, 30).getTime();

const quote = {
    id: 'a1',
    name: 'Offerte berekenen',
    definition: {
        trigger: { kind: 'form' },
        steps: [
            { id: 's1', type: 'form_page', label: 'Nieuwe aanvraag' },
            { id: 's2', type: 'set' },
            { id: 's3', type: 'ai_step', label: "Foto's beoordelen" },
            { id: 's4', type: 'summarize' },
            { id: 's5', type: 'set' },
            { id: 's6', type: 'set' },
            { id: 's7', type: 'generate_document', label: 'Offerte-PDF' },
        ],
    },
};

/** The artboard's signals: talks to people with a notice, generates without marking. */
const ARTBOARD_SIGNALS = {
    contains_ai: true,
    customer_facing: true,
    generates_content: true,
    disclosure_present: true,
    marking_enabled: false,
    steps: { ai: [{ id: 's3', label: "Foto's beoordelen" }], generating: [{ id: 's7', label: 'Offerte-PDF' }] },
    step_count: 7,
    surface: 'form',
    source: 'server',
};

function hookData(over = {}) {
    return {
        loading: false,
        error: null,
        absent: false,
        assessment: null,
        signals: ARTBOARD_SIGNALS,
        signalsSource: 'server',
        reload: vi.fn(),
        refetchSignals: vi.fn(),
        save: vi.fn().mockResolvedValue({ outcome: 'transparency', attested_at: '2026-09-14T10:00:00Z' }),
        enableMarking: vi.fn().mockResolvedValue(undefined),
        ...over,
    };
}

const clickAll = (testId) => screen.getAllByTestId(testId).forEach(b => fireEvent.click(b));
/** Answer every one of the ten Annex III questions the same way. */
const answerAllAnnex = (value) => screen.getAllByTestId(`ladder-annex-${value}`).forEach(b => fireEvent.click(b));
const ANNEX_DOMAINS = [
    'biometrics', 'critical_infrastructure', 'education', 'employment', 'essential_services',
    'credit', 'insurance', 'law_enforcement', 'migration', 'justice',
];
const ALL_NO = Object.fromEntries(ANNEX_DOMAINS.map(id => [id, 'no']));

beforeEach(() => {
    authFetch.mockReset();
    toast.success.mockReset();
});

describe('AiActLadderModal — step verdicts from the signals (artboard 1f)', () => {
    it('header, subtitle and "Contains AI" banner read the signals; steps 1 and 3 start unanswered', () => {
        render(<AiActLadderModal open onClose={() => {}} kind="automation" target={quote} data={hookData()} now={NOW} />);
        expect(screen.getByText('Does the AI Act apply to this automation?')).toBeTruthy();
        expect(screen.getByText('Offerte berekenen · 7 steps · 1 AI step · customer-facing via a form')).toBeTruthy();
        const banner = screen.getByTestId('ladder-contains-ai');
        expect(banner.getAttribute('data-contains-ai')).toBe('true');
        expect(banner.textContent).toContain('yes — step "Foto\'s beoordelen" is an AI step.');
        expect(screen.getByTestId('ladder-step-1').getAttribute('data-state')).toBe('open');
        expect(screen.getByTestId('ladder-step-3').getAttribute('data-state')).toBe('open');
        expect(screen.queryByTestId('ladder-step-1-verdict')).toBeNull();
        expect(screen.getByTestId('ladder-outcome').getAttribute('data-outcome')).toBe('pending');
        expect(screen.getByTestId('ladder-record').hasAttribute('disabled')).toBe(true);
    });

    it('step 2 paints the two sub-cards from the signals: notice shown (success), marking missing (error) with the fixed deadline', () => {
        render(<AiActLadderModal open onClose={() => {}} kind="automation" target={quote} data={hookData()} now={NOW} />);
        const step2 = screen.getByTestId('ladder-step-2');
        expect(step2.getAttribute('data-state')).toBe('failing');
        expect(screen.getByTestId('ladder-step-2-verdict').textContent).toBe('1 of 2 in order');
        const disclosure = screen.getByTestId('ladder-card-disclosure');
        expect(disclosure.getAttribute('data-tone')).toBe('success');
        expect(disclosure.textContent).toContain('Talks to people: yes → AI notice shown');
        const marking = screen.getByTestId('ladder-card-marking');
        expect(marking.getAttribute('data-tone')).toBe('error');
        expect(marking.textContent).toContain('Generates content: yes → marking missing');
        expect(marking.textContent).toContain('2 Dec 2026 (in 79 days)');
        expect(within(marking).getByTestId('ladder-enable-marking')).toBeTruthy();
    });

    it('an unknown signal (client fallback, disclosure null) is a neutral card, not a failure', () => {
        const signals = { ...ARTBOARD_SIGNALS, disclosure_present: null, marking_enabled: null, source: 'client' };
        render(<AiActLadderModal open onClose={() => {}} kind="automation" target={quote} data={hookData({ signals })} now={NOW} />);
        expect(screen.getByTestId('ladder-card-disclosure').getAttribute('data-tone')).toBe('neutral');
        expect(screen.getByTestId('ladder-card-marking').getAttribute('data-tone')).toBe('neutral');
        expect(screen.getByTestId('ladder-step-2').getAttribute('data-state')).toBe('open');
        expect(screen.queryByTestId('ladder-step-2-verdict')).toBeNull();
    });

    it('all EIGHT Art. 5 chips ticked → "No"; all TEN Annex III questions answered "No" → "No"; the outcome becomes transparency', () => {
        render(<AiActLadderModal open onClose={() => {}} kind="automation" target={quote} data={hookData()} now={NOW} />);
        // These counts were 3 and 4 while the server's lists were 8 and 10, so
        // ticking everything on screen recorded a declaration about things
        // nobody had been asked. Both are now the whole list.
        expect(screen.getAllByTestId('ladder-art5-chip')).toHaveLength(8);
        expect(screen.getAllByTestId('ladder-annex-question')).toHaveLength(10);

        fireEvent.click(screen.getAllByTestId('ladder-art5-chip')[0]);
        expect(screen.getByTestId('ladder-step-1').getAttribute('data-state')).toBe('open');
        clickAll('ladder-art5-chip'); // toggles the first OFF and the other seven ON
        expect(screen.getByTestId('ladder-step-1').getAttribute('data-state')).toBe('open');
        fireEvent.click(screen.getAllByTestId('ladder-art5-chip')[0]);
        expect(screen.getByTestId('ladder-step-1').getAttribute('data-state')).toBe('done');
        expect(screen.getByTestId('ladder-step-1-verdict').textContent).toBe('No');

        // Nine of ten is not a declaration — and the step says which it is.
        screen.getAllByTestId('ladder-annex-no').slice(0, 9).forEach(b => fireEvent.click(b));
        expect(screen.getByTestId('ladder-step-3').getAttribute('data-state')).toBe('open');
        expect(screen.getByTestId('ladder-step-3-verdict').textContent).toBe('9 of 10 answered');

        fireEvent.click(screen.getAllByTestId('ladder-annex-no')[9]);
        expect(screen.getByTestId('ladder-step-3').getAttribute('data-state')).toBe('done');
        expect(screen.getByTestId('ladder-step-3-verdict').textContent).toBe('No');

        // Pressing the answer you gave takes it back — a legal declaration
        // needs a way out of a mis-click, and the step drops back to counting.
        fireEvent.click(screen.getAllByTestId('ladder-annex-no')[9]);
        expect(screen.getByTestId('ladder-step-3').getAttribute('data-state')).toBe('open');
        expect(screen.getByTestId('ladder-step-3-verdict').textContent).toBe('9 of 10 answered');
        fireEvent.click(screen.getAllByTestId('ladder-annex-no')[9]);

        const box = screen.getByTestId('ladder-outcome');
        expect(box.getAttribute('data-outcome')).toBe('transparency');
        expect(box.textContent).toContain('Outcome: the AI Act applies — Art. 4 (literacy) and Art. 50 (transparency). Not high-risk.');
        expect(box.textContent).toContain('Art. 50 still open: content marking.');
        expect(box.textContent).toContain('Recorded with the model inventory');
        expect(screen.getByTestId('ladder-record').hasAttribute('disabled')).toBe(false);
    });

    it('without AI the banner says so with the GDPR note, the outcome is not_applicable and recording needs no chips', () => {
        const signals = { contains_ai: false, customer_facing: true, generates_content: false, disclosure_present: null, marking_enabled: null, steps: { ai: [], generating: [] }, step_count: 3, surface: 'form', source: 'client' };
        render(<AiActLadderModal open onClose={() => {}} kind="automation" target={quote} data={hookData({ signals })} now={NOW} />);
        const banner = screen.getByTestId('ladder-contains-ai');
        expect(banner.getAttribute('data-contains-ai')).toBe('false');
        expect(banner.textContent).toContain('Without AI only the GDPR applies: Art. 22 for decisions with legal effect, WOR Art. 27 for employee monitoring.');
        expect(screen.getByTestId('ladder-outcome').getAttribute('data-outcome')).toBe('not_applicable');
        expect(screen.getByTestId('ladder-record').hasAttribute('disabled')).toBe(false);
    });

    it('kind="agent" changes the title', () => {
        const signals = { contains_ai: true, customer_facing: true, generates_content: true, disclosure_present: false, marking_enabled: true, steps: { ai: [], generating: [] }, step_count: null, surface: 'published_agent', source: 'server' };
        render(<AiActLadderModal open onClose={() => {}} kind="agent" target={{ id: 'g1', name: 'Helpdesk' }} data={hookData({ signals })} now={NOW} />);
        expect(screen.getByText('Does the AI Act apply to this agent?')).toBeTruthy();
        expect(screen.getByText('Helpdesk · 0 AI steps · customer-facing via a published agent')).toBeTruthy();
        expect(screen.getByTestId('ladder-card-disclosure').getAttribute('data-tone')).toBe('error');
        expect(screen.getByTestId('ladder-card-marking').getAttribute('data-tone')).toBe('success');
    });
});

describe('AiActLadderModal — actions', () => {
    it('"Enable marking" calls the hook\'s enableMarking (PUT settings + refetch) and toasts', async () => {
        const data = hookData();
        render(<AiActLadderModal open onClose={() => {}} kind="automation" target={quote} data={data} now={NOW} />);
        fireEvent.click(screen.getByTestId('ladder-enable-marking'));
        await waitFor(() => expect(data.enableMarking).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Content marking enabled for this organisation.'));
    });

    it('"Record as self-declared" PUTs the answers (art50 from signals), toasts, reports and closes', async () => {
        const data = hookData();
        const onClose = vi.fn();
        const onRecorded = vi.fn();
        render(<AiActLadderModal open onClose={onClose} onRecorded={onRecorded} kind="automation" target={quote} data={data} now={NOW} />);
        clickAll('ladder-art5-chip');
        answerAllAnnex('no');
        fireEvent.click(screen.getByTestId('ladder-record'));
        await waitFor(() => expect(data.save).toHaveBeenCalledTimes(1));
        expect(data.save).toHaveBeenCalledWith({
            art5: { answer: 'no', practices: [] },
            art50: { interacts: true, disclosure: true, generates: true, marking: false },
            // The ten answers themselves go up, not only the 'no' they add to.
            annex_iii: { answer: 'no', category: null, domains: ALL_NO },
        });
        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(onRecorded).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'transparency' }));
        expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('Recorded as self-declared'));
    });

    it('a failed record is its own state: the error line shows, the modal stays open', async () => {
        const data = hookData({ save: vi.fn().mockRejectedValue(new Error('500 Internal Server Error')) });
        const onClose = vi.fn();
        render(<AiActLadderModal open onClose={onClose} kind="automation" target={quote} data={data} now={NOW} />);
        clickAll('ladder-art5-chip');
        answerAllAnnex('no');
        fireEvent.click(screen.getByTestId('ladder-record'));
        await waitFor(() => expect(screen.getByTestId('ladder-action-error').textContent).toContain('500 Internal Server Error'));
        expect(onClose).not.toHaveBeenCalled();
    });

    it('answering ONE domain "Yes" makes it high-risk and names the point of the annex', () => {
        // The four-chip ladder had no way to say yes at all: a genuinely
        // high-risk system could not be recorded as one through this screen.
        render(<AiActLadderModal open onClose={() => {}} kind="automation" target={quote} data={hookData()} now={NOW} />);
        clickAll('ladder-art5-chip');
        const credit = screen.getAllByTestId('ladder-annex-yes').find(b => b.getAttribute('data-domain') === 'credit');
        fireEvent.click(credit);

        expect(screen.getByTestId('ladder-step-3-verdict').textContent).toBe('Yes');
        expect(screen.getByTestId('ladder-annex-articles').textContent).toBe('High risk under Annex III(5)(b).');
        expect(screen.getByTestId('ladder-outcome').getAttribute('data-outcome')).toBe('high_risk');
        // …without waiting for the other nine: one yes settles it.
        expect(screen.getByTestId('ladder-record').hasAttribute('disabled')).toBe(false);
    });

    it('a domain the wording mentions is sorted first and marked — never answered', () => {
        // This is the old keyword regex with its authority taken away. It
        // decided "this may be a high-risk use of AI" from a word match; it
        // now puts a question at the top and says why it is there.
        const data = hookData();
        data.signals = {
            ...data.signals,
            annex_iii_questions: [
                { id: 'law_enforcement', hint: true, article: 'Annex III(6)' },
                { id: 'biometrics', hint: false, article: 'Annex III(1)' },
            ],
        };
        render(<AiActLadderModal open onClose={() => {}} kind="automation" target={quote} data={data} now={NOW} />);
        const rows = screen.getAllByTestId('ladder-annex-question');
        expect(rows[0].getAttribute('data-domain')).toBe('law_enforcement');
        expect(rows[0].getAttribute('data-answer')).toBe('open');
        expect(screen.getAllByTestId('ladder-annex-hint')).toHaveLength(1);
        // Nothing is pressed, and the step is nowhere near answered.
        expect(rows.every(r => r.getAttribute('data-answer') === 'open')).toBe(true);
        expect(screen.getByTestId('ladder-step-3-verdict').textContent).toBe('0 of 10 answered');
    });

    it('a saved declaration pre-ticks the chips and prints the stamp', () => {
        const data = hookData({
            assessment: {
                outcome: 'transparency', attested_by: 'u1', attested_at: '2026-09-01T09:00:00Z', expires_at: '2027-09-01T09:00:00Z', current: true,
                answers: { art5: { answer: 'no', practices: [] }, annex_iii: { answer: 'no', category: null } },
            },
        });
        render(<AiActLadderModal open onClose={() => {}} kind="automation" target={quote} data={data} now={NOW} />);
        expect(screen.getByTestId('ladder-step-1').getAttribute('data-state')).toBe('done');
        // A row stored before the ten questions existed carries one answer for
        // all of them. It must still read back as a declaration — dropping it
        // would silently un-declare every assessment already on file.
        expect(screen.getByTestId('ladder-step-3').getAttribute('data-state')).toBe('done');
        expect(screen.getAllByTestId('ladder-annex-question').every(r => r.getAttribute('data-answer') === 'no')).toBe(true);
        expect(screen.queryByTestId('ladder-legacy-yes-note')).toBeNull();
        expect(screen.getByTestId('ladder-saved-stamp').textContent).toBe('Last declared 1 Sep 2026, valid until 1 Sep 2027.');
    });

    it('a legacy "yes" with a known category pre-ticks only that area, with a note to pick the rest', () => {
        const data = hookData({
            assessment: {
                outcome: 'high_risk', attested_by: 'u1', attested_at: '2026-01-10T09:00:00Z', expires_at: '2027-01-10T09:00:00Z', current: true,
                answers: { art5: { answer: 'no', practices: [] }, annex_iii: { answer: 'yes', category: 'insurance' } },
            },
        });
        render(<AiActLadderModal open onClose={() => {}} kind="automation" target={quote} data={data} now={NOW} />);
        const byDomain = Object.fromEntries(screen.getAllByTestId('ladder-annex-question')
            .map(r => [r.getAttribute('data-domain'), r.getAttribute('data-answer')]));
        expect(byDomain.insurance).toBe('yes');
        // Never biometrics, law enforcement or migration on the strength of one old "yes".
        expect(Object.entries(byDomain).filter(([id]) => id !== 'insurance').every(([, v]) => v === 'open')).toBe(true);
        expect(screen.getByTestId('ladder-legacy-yes-note').textContent).toBe('Declared high-risk earlier — pick the area(s) to confirm');
        expect(screen.getByTestId('ladder-step-3-verdict').textContent).toBe('Yes');
    });

    it('a legacy "yes" without a known category leaves all ten open, still with the note', () => {
        const data = hookData({
            assessment: {
                outcome: 'high_risk', attested_at: '2026-01-10T09:00:00Z', expires_at: '2027-01-10T09:00:00Z', current: true,
                answers: { art5: { answer: 'no', practices: [] }, annex_iii: { answer: 'yes', category: 'astrology' } },
            },
        });
        render(<AiActLadderModal open onClose={() => {}} kind="automation" target={quote} data={data} now={NOW} />);
        expect(screen.getAllByTestId('ladder-annex-question').every(r => r.getAttribute('data-answer') === 'open')).toBe(true);
        expect(screen.getByTestId('ladder-legacy-yes-note')).toBeTruthy();
        expect(screen.getByTestId('ladder-step-3-verdict').textContent).toBe('0 of 10 answered');
    });

    it('legacyAnnexAnswers: no → ten noes, yes + known area → that one, anything else → none', () => {
        expect(Object.values(legacyAnnexAnswers({ answer: 'no', category: null }))).toEqual(Array(10).fill('no'));
        expect(legacyAnnexAnswers({ answer: 'yes', category: 'insurance' })).toEqual({ insurance: 'yes' });
        expect(legacyAnnexAnswers({ answer: 'yes', category: null })).toEqual({});
        expect(legacyAnnexAnswers({ answer: 'yes', category: 'toString' })).toEqual({});
        expect(legacyAnnexAnswers(undefined)).toEqual({});
    });

    it('a saved declaration with per-domain answers reads them back one by one', () => {
        const data = hookData({
            assessment: {
                outcome: 'high_risk', attested_by: 'u1', attested_at: '2026-09-01T09:00:00Z', expires_at: '2027-09-01T09:00:00Z', current: true,
                answers: {
                    art5: { answer: 'no', practices: [] },
                    annex_iii: { answer: 'yes', category: null, domains: { ...ALL_NO, employment: 'yes' } },
                },
            },
        });
        render(<AiActLadderModal open onClose={() => {}} kind="automation" target={quote} data={data} now={NOW} />);
        const byDomain = Object.fromEntries(screen.getAllByTestId('ladder-annex-question')
            .map(r => [r.getAttribute('data-domain'), r.getAttribute('data-answer')]));
        expect(byDomain.employment).toBe('yes');
        expect(byDomain.biometrics).toBe('no');
        expect(screen.getByTestId('ladder-annex-articles').textContent).toBe('High risk under Annex III(4).');
    });

    it('closed → renders nothing', () => {
        render(<AiActLadderModal open={false} onClose={() => {}} kind="automation" target={quote} data={hookData()} />);
        expect(screen.queryByTestId('ai-act-ladder')).toBeNull();
    });
});

describe('AiActLadderModal — standalone (owns the hook) and the 404 fallback', () => {
    it('with no `data` prop it reads the assessment route; a 404 falls back to the definition\'s own signals', async () => {
        authFetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) });
        render(<AiActLadderModal open onClose={() => {}} kind="automation" target={quote} now={NOW} />);
        await waitFor(() => expect(authFetch).toHaveBeenCalledWith(`${API}/ai-act/assessments/automation/a1`, expect.objectContaining({ credentials: 'include' })));
        await waitFor(() => expect(screen.getByTestId('ladder-contains-ai').getAttribute('data-contains-ai')).toBe('true'));
        // summarize (s4) is not counted: one AI step, seven steps, via the form.
        expect(screen.getByText('Offerte berekenen · 7 steps · 1 AI step · customer-facing via a form')).toBeTruthy();
        // Client-side the disclosure is unknown → neutral, and marking unknown → neutral with the Enable button still offered.
        expect(screen.getByTestId('ladder-card-disclosure').getAttribute('data-tone')).toBe('neutral');
        expect(screen.getByTestId('ladder-card-marking').getAttribute('data-tone')).toBe('neutral');
    });

    it('"Enable marking" in standalone mode PUTs /settings {ai_content_marking_enabled:true} then refetches the signals', async () => {
        authFetch.mockImplementation(async (url, init) => {
            if (url.endsWith('/settings') && init?.method === 'PUT') return { ok: true, json: async () => ({ ok: true }) };
            if (url.endsWith('/signals')) return { ok: true, json: async () => ({ ...ARTBOARD_SIGNALS, marking_enabled: true }) };
            return { ok: true, json: async () => ({ signals: ARTBOARD_SIGNALS, answers: null, outcome: null, current: false }) };
        });
        render(<AiActLadderModal open onClose={() => {}} kind="automation" target={quote} now={NOW} />);
        await waitFor(() => expect(screen.getByTestId('ladder-card-marking').getAttribute('data-tone')).toBe('error'));
        fireEvent.click(screen.getByTestId('ladder-enable-marking'));
        await waitFor(() => expect(authFetch).toHaveBeenCalledWith(
            `${API}/settings`,
            expect.objectContaining({ method: 'PUT', body: JSON.stringify({ ai_content_marking_enabled: true }) }),
        ));
        await waitFor(() => expect(authFetch).toHaveBeenCalledWith(`${API}/ai-act/assessments/automation/a1/signals`, expect.anything()));
        await waitFor(() => expect(screen.getByTestId('ladder-card-marking').getAttribute('data-tone')).toBe('success'));
        expect(screen.getByTestId('ladder-step-2-verdict').textContent).toBe('2 of 2 in order');
    });

    it('a failed read (500) is its own state, shown inside the modal', async () => {
        authFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error', json: async () => ({}) });
        render(<AiActLadderModal open onClose={() => {}} kind="automation" target={quote} now={NOW} />);
        await waitFor(() => expect(screen.getByTestId('ladder-load-error')).toBeTruthy());
        // …and the definition's signals still drive the ladder.
        expect(screen.getByTestId('ladder-contains-ai').getAttribute('data-contains-ai')).toBe('true');
    });
});
