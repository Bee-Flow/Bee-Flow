/**
 * The AI Act ladder on the phone, over a mocked HTTP client: one step at a
 * time (Art. 5 → Art. 50 → Annex III), the outcome before anything is
 * recorded, Record PUTs the answers and hands the stored row to the cache;
 * Record waits for steps 1 and 3, Back goes back, a failed save says why,
 * and re-assessing starts from the saved declaration.
 */

import { fireEvent, screen, userEvent, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api, ApiError } from '@/core/api/client';
import { flowKeys, type AiActAssessment } from '@/features/flow-editor/api';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { AiActLadderSheet } from './AiActLadderSheet';
import { ANNEX_III_CATEGORIES } from './ladderOutcome';
import { ART5_CHIPS } from './ladderWords';

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const ALL_NO: Record<string, 'no'> = Object.fromEntries(ANNEX_III_CATEGORIES.map((id) => [id, 'no' as const]));

const assessment = (patch: Partial<AiActAssessment> = {}): AiActAssessment => ({
    outcome: null,
    attestedAt: null,
    expiresAt: null,
    current: false,
    signals: {
        containsAi: true, customerFacing: true, generatesContent: false, disclosurePresent: false, markingEnabled: null,
        aiSteps: 1, aiStepLabels: ['Classify'], annexHints: ['employment'],
    },
    answers: null,
    ...patch,
});

const onClose = jest.fn();
const mount = (a: AiActAssessment = assessment()) => renderScreen(<AiActLadderSheet automationId="a1" assessment={a} onClose={onClose} />);
const next = () => fireEvent.press(screen.getByTestId('ladder-next'));

beforeEach(() => jest.clearAllMocks());

it('asks the three steps one at a time, shows the outcome, and records it', async () => {
    (api.put as jest.Mock).mockResolvedValue({ outcome: 'transparency', attested_at: '2026-09-27T10:00:00Z', expires_at: '2027-09-27T10:00:00Z', current: true, signals: {}, answers: {} });
    const { queryClient } = await mount();

    expect(screen.getByText('Does the AI Act apply to this automation?')).toBeTruthy();
    expect(screen.getByText('1 AI steps')).toBeTruthy();
    expect(screen.getByText(/yes — step "Classify" is an AI step\./)).toBeTruthy();
    expect(screen.getByText('Art. 5 — prohibited practice?')).toBeTruthy();
    expect(screen.queryByTestId('ladder-step-1-verdict')).toBeNull();
    for (const chip of ART5_CHIPS) await fireEvent.press(screen.getByLabelText(chip.en));
    expect(screen.getByTestId('ladder-step-1-verdict')).toHaveTextContent('No');

    await next();
    expect(screen.getByText('Art. 50 — transparency')).toBeTruthy();
    expect(screen.getByText('Talks to people: yes → AI notice missing')).toBeTruthy();
    expect(screen.getByText('Generates content: no')).toBeTruthy();
    expect(screen.getByTestId('ladder-step-2-verdict')).toHaveTextContent('0 of 1 in order');

    await next();
    expect(screen.getByText('Annex III — high-risk?')).toBeTruthy();
    const rows = screen.getAllByTestId(/^ladder-annex-[a-z_]+$/).map((r) => r.props.testID);
    expect(rows[0]).toBe('ladder-annex-employment');
    expect(screen.getByText(/this automation’s wording mentions it/)).toBeTruthy();
    expect(screen.getByTestId('ladder-step-3-verdict')).toHaveTextContent('0 of 10 answered');
    for (const id of ANNEX_III_CATEGORIES) await fireEvent.press(screen.getByTestId(`ladder-annex-${id}-no`));
    expect(screen.getByTestId('ladder-step-3-verdict')).toHaveTextContent('No');

    await next();
    expect(screen.getByTestId('ladder-outcome-transparency')).toBeTruthy();
    expect(screen.getByText('Outcome: the AI Act applies — Art. 4 (literacy) and Art. 50 (transparency). Not high-risk.')).toBeTruthy();
    expect(screen.getByText('Art. 50 still open: AI notice.')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('ladder-record'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.put).toHaveBeenCalledWith(
        '/api/compliance/ai-act/assessments/automation/a1',
        {
            answers: {
                art5: { answer: 'no', practices: [] },
                art50: { interacts: true, disclosure: false, generates: false, marking: null },
                annex_iii: { answer: 'no', category: null, domains: ALL_NO },
            },
        },
        { retry: false },
    );
    expect(queryClient.getQueryData<AiActAssessment>(flowKeys.aiAct('a1'))?.outcome).toBe('transparency');
    expect(await screen.findByText('Recorded as self-declared — stamped with who and when, valid for 12 months.')).toBeTruthy();
});

it('keeps Record shut while steps 1 and 3 are open, and Back goes back', async () => {
    await mount();
    expect(screen.getByTestId('ladder-later')).toBeTruthy();
    await next();
    await next();
    await next();
    expect(screen.getByTestId('ladder-outcome-pending')).toBeTruthy();
    expect(screen.getByText('Outcome: pending — tick the chips of steps 1 and 3 to declare.')).toBeTruthy();
    expect(screen.getByTestId('ladder-record')).toBeDisabled();
    await fireEvent.press(screen.getByTestId('ladder-record'));
    expect(api.put).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('ladder-back'));
    await fireEvent.press(screen.getByTestId('ladder-annex-credit-yes'));
    expect(screen.getByTestId('ladder-step-3-verdict')).toHaveTextContent('Yes');
    expect(screen.getByTestId('ladder-annex-articles')).toHaveTextContent('High risk under Annex III(5)(b).');
    await fireEvent.press(screen.getByTestId('ladder-annex-credit-yes'));
    expect(screen.getByTestId('ladder-step-3-verdict')).toHaveTextContent('0 of 10 answered');

    await fireEvent.press(screen.getByTestId('ladder-back'));
    await fireEvent.press(screen.getByTestId('ladder-back'));
    await fireEvent.press(screen.getByTestId('ladder-later'));
    expect(onClose).toHaveBeenCalled();
});

it('says why a save did not go through, and stays open', async () => {
    (api.put as jest.Mock).mockRejectedValue(new ApiError('The server said no', { status: 400 }));
    await mount(assessment({ signals: { ...assessment().signals, containsAi: false, aiStepLabels: [] } }));
    expect(screen.getByText(/no — none of the steps calls a model\./)).toBeTruthy();
    await next();
    await next();
    await next();
    expect(screen.getByText('Outcome: the AI Act does not apply — no step calls a model. Only the GDPR applies.')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('ladder-record'));
    expect(await screen.findByText(/^That did not save — /)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
});

it('starts from the saved declaration', async () => {
    await mount(assessment({
        outcome: 'transparency',
        attestedAt: '2026-09-01T10:00:00Z',
        expiresAt: '2027-09-01T10:00:00Z',
        current: true,
        answers: { art5: 'no', annexIii: 'no', annexCategory: null, annexDomains: ALL_NO },
    }));
    for (const chip of ART5_CHIPS) expect(screen.getByLabelText(chip.en)).toBeChecked();
    await next();
    await next();
    expect(screen.getByTestId('ladder-annex-justice-no')).toBeSelected();
    await next();
    expect(screen.getByTestId('ladder-outcome-transparency')).toBeTruthy();
    expect(screen.getByTestId('ladder-saved-stamp')).toHaveTextContent(/^Last declared .+, valid until .+\.$/);
    expect(screen.getByTestId('ladder-record')).toBeEnabled();
});

it('a "yes" saved before the ten questions ticks only the area it named, and asks to pick the rest', async () => {
    const user = userEvent.setup();
    await mount(assessment({
        outcome: 'high_risk',
        answers: { art5: 'no', annexIii: 'yes', annexCategory: 'insurance', annexDomains: {} },
    }));
    await user.press(screen.getByTestId('ladder-next'));
    await user.press(screen.getByTestId('ladder-next'));
    expect(screen.getByTestId('ladder-legacy-yes-note')).toHaveTextContent('Declared high-risk earlier — pick the area(s) to confirm');
    expect(screen.getByTestId('ladder-annex-insurance-yes')).toBeSelected();
    // Never all ten: biometrics stays open, neither yes nor no.
    expect(screen.getByTestId('ladder-annex-biometrics-yes')).not.toBeSelected();
    expect(screen.getByTestId('ladder-annex-biometrics-no')).not.toBeSelected();
});

it('says nothing about an earlier declaration when the ten were answered', async () => {
    const user = userEvent.setup();
    await mount(assessment({ answers: { art5: 'no', annexIii: 'yes', annexCategory: null, annexDomains: { ...ALL_NO, credit: 'yes' } } }));
    await user.press(screen.getByTestId('ladder-next'));
    await user.press(screen.getByTestId('ladder-next'));
    expect(screen.getByTestId('ladder-annex-credit-yes')).toBeSelected();
    expect(screen.queryByTestId('ladder-legacy-yes-note')).toBeNull();
});
