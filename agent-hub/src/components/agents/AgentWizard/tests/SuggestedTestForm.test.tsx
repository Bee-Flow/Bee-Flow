/**
 * The form in which a PROPOSAL becomes a test (A4 part D).
 *
 * Three promises, and all three are there to prevent a test from standing there later that
 * guards something other than what someone thought:
 *
 *   • every proposed field is editable before saving, and what is saved is what STANDS,
 *     not what the model wrote;
 *   • the screen says, per field, that an AI wrote it, and stops saying so as soon as you
 *     touch that field;
 *   • if nothing was proposed, there is no AI flag above an empty form either.
 *
 * Run: cd agent-hub && ./node_modules/.bin/vitest run src/components/agents/AgentWizard/tests/SuggestedTestForm.test.jsx
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';

import SuggestedTestForm from './SuggestedTestForm';
import { refusalFor } from './testSetFacts';
import type { TranslateParams } from '@/hooks/useTranslation';
import type { ComponentProps } from 'react';
import { stub } from '@/test/mocks';

const t = (key: string, fallback: string, params: TranslateParams) => {
    let s = typeof fallback === 'string' ? fallback : key;
    for (const [k, v] of Object.entries(params || {})) s = s.split(`{${k}}`).join(String(v));
    return s;
};

const TURN = { question: 'When are you open?', answer: 'We are open until six.', toolsUsed: ['kb_search'] };

const SUGGESTION = {
    expect: {
        mustMention: ['open until six'],
        mustNotMention: [],
        toolsExpected: ['kb_search'],
        rulesExpected: [],
        notes: 'Stay friendly.',
    },
    wrote: {
        mustMention: 'ai', notes: 'ai', toolsExpected: 'observed',
        mustNotMention: 'empty', rulesExpected: 'empty',
    },
    suggestedBy: 'ai',
};

afterEach(() => cleanup());

describe('SuggestedTestForm — wie schreef dit', () => {
    it('zegt dat een AI het voorstel schreef, en dat je het moet nalezen', () => {
        render(<SuggestedTestForm t={t} turn={TURN} suggestion={SUGGESTION} />);
        const banner = screen.getByTestId('agent-tests-suggest-source');
        expect(banner).toHaveAttribute('data-source', 'ai');
        expect(banner.textContent).toMatch(/An AI read that answer/i);
        expect(banner.textContent).toMatch(/before you save/i);
    });

    it('merkt de velden apart: geschreven door een AI, of gezien in de beurt', () => {
        render(<SuggestedTestForm t={t} turn={TURN} suggestion={SUGGESTION} />);
        expect(screen.getByTestId('agent-tests-field-source-mustMention')).toHaveAttribute('data-source', 'ai');
        expect(screen.getByTestId('agent-tests-field-source-toolsExpected')).toHaveAttribute('data-source', 'observed');
        // A prohibition proposes nobody, so no marker hangs there.
        expect(screen.queryByTestId('agent-tests-field-source-mustNotMention')).toBeNull();
    });

    it('BIJT — zodra jij een veld aanraakt, staat er niet meer dat een AI het schreef', () => {
        render(<SuggestedTestForm t={t} turn={TURN} suggestion={SUGGESTION} />);
        fireEvent.change(screen.getByTestId('agent-tests-field-mustMention'), { target: { value: 'open until six\nfree parking' } });
        expect(screen.queryByTestId('agent-tests-field-source-mustMention')).toBeNull();
        // En de merkjes van de velden die je NIET aanraakte blijven staan.
        expect(screen.getByTestId('agent-tests-field-source-notes')).toBeInTheDocument();
    });

    it('BIJT — zonder voorstel staat er geen AI-vlag boven een leeg formulier', () => {
        render(<SuggestedTestForm t={t} turn={TURN} suggestion={null} state="refused"
            refusal={refusalFor({ status: 503, body: { code: 'no_suggestion_model' } })} />);
        const banner = screen.getByTestId('agent-tests-suggest-source');
        expect(banner).toHaveAttribute('data-source', 'none');
        expect(banner.textContent).toMatch(/write them yourself/i);
        expect(screen.getByTestId('agent-tests-field-mustMention')).toHaveValue('');
    });

    it('een leeg voorstel is geen AI-tekst', () => {
        const emptySuggestion = {
            expect: { mustMention: [], mustNotMention: [], toolsExpected: [], rulesExpected: [], notes: '' },
            wrote: { mustMention: 'empty', notes: 'empty', toolsExpected: 'empty', mustNotMention: 'empty', rulesExpected: 'empty' },
            suggestedBy: 'ai',
        };
        render(<SuggestedTestForm t={t} turn={TURN} suggestion={emptySuggestion} />);
        expect(screen.getByTestId('agent-tests-suggest-source')).toHaveAttribute('data-source', 'none');
    });

    it('terwijl het voorstel geschreven wordt staat er nog geen formulier', () => {
        render(<SuggestedTestForm t={t} turn={TURN} state="loading" />);
        expect(screen.getByTestId('agent-tests-suggest-form')).toHaveAttribute('data-state', 'loading');
        expect(screen.queryByTestId('agent-tests-field-mustMention')).toBeNull();
    });
});

describe('SuggestedTestForm — bewerken en opslaan', () => {
    it('vult de vraag uit de beurt in en laat hem bewerken', async () => {
        const user = userEvent.setup();
        const onSave = vi.fn();
        render(<SuggestedTestForm t={t} turn={TURN} suggestion={SUGGESTION} onSave={onSave} />);
        const question = screen.getByTestId('agent-tests-field-question');
        expect(question).toHaveValue('When are you open?');
        await user.clear(question);
        await user.type(question, 'What are your opening hours?');
        await user.click(screen.getByTestId('agent-tests-suggest-save'));
        expect(onSave.mock.calls[0][0].question).toBe('What are your opening hours?');
    });

    it('BIJT — opgeslagen wordt wat er STAAT, niet wat het model schreef', async () => {
        const user = userEvent.setup();
        const onSave = vi.fn();
        render(<SuggestedTestForm t={t} turn={TURN} suggestion={SUGGESTION} onSave={onSave} />);
        fireEvent.change(screen.getByTestId('agent-tests-field-mustMention'), { target: { value: 'open until six on weekdays\n  \nfree parking' } });
        await user.clear(screen.getByTestId('agent-tests-field-mustNotMention'));
        await user.type(screen.getByTestId('agent-tests-field-mustNotMention'), 'discount');
        await user.clear(screen.getByTestId('agent-tests-field-toolsExpected'));
        await user.clear(screen.getByTestId('agent-tests-field-notes'));
        await user.click(screen.getByTestId('agent-tests-suggest-save'));

        expect(onSave).toHaveBeenCalledTimes(1);
        expect(onSave.mock.calls[0][0].expect).toEqual({
            mustMention: ['open until six on weekdays', 'free parking'],
            mustNotMention: ['discount'],
            toolsExpected: [],
            rulesExpected: [],
            notes: '',
        });
    });

    it('slaat het voorstel ongewijzigd op als je niets verandert', async () => {
        const user = userEvent.setup();
        const onSave = vi.fn();
        render(<SuggestedTestForm t={t} turn={TURN} suggestion={SUGGESTION} onSave={onSave} />);
        await user.click(screen.getByTestId('agent-tests-suggest-save'));
        expect(onSave.mock.calls[0][0].expect.mustMention).toEqual(['open until six']);
        expect(onSave.mock.calls[0][0].expect.toolsExpected).toEqual(['kb_search']);
        expect(onSave.mock.calls[0][0].name).toBe('');
    });

    it('zonder vraag valt er niets op te slaan', async () => {
        const user = userEvent.setup();
        const onSave = vi.fn();
        render(<SuggestedTestForm t={t} turn={stub<ComponentProps<typeof SuggestedTestForm>['turn']>({ question: '', answer: 'x' })} suggestion={SUGGESTION} onSave={onSave} />);
        expect(screen.getByTestId('agent-tests-suggest-save')).toBeDisabled();
        await user.click(screen.getByTestId('agent-tests-suggest-save'));
        expect(onSave).not.toHaveBeenCalled();
    });

    it('tijdens het opslaan kan er niet nog een keer gedrukt worden', () => {
        const onSave = vi.fn();
        render(<SuggestedTestForm t={t} turn={TURN} suggestion={SUGGESTION} onSave={onSave} saving />);
        expect(screen.getByTestId('agent-tests-suggest-save')).toBeDisabled();
    });

    it('een mislukte opslag komt op het scherm', () => {
        render(<SuggestedTestForm t={t} turn={TURN} suggestion={SUGGESTION} saveError="This agent already has 100 tests." />);
        expect(screen.getByTestId('agent-tests-suggest-error').textContent).toMatch(/already has 100 tests/);
    });

    it('annuleren gaat naar de aanroeper', async () => {
        const user = userEvent.setup();
        const onCancel = vi.fn();
        render(<SuggestedTestForm t={t} turn={TURN} suggestion={SUGGESTION} onCancel={onCancel} />);
        await user.click(screen.getByTestId('agent-tests-suggest-cancel'));
        expect(onCancel).toHaveBeenCalled();
    });
});
