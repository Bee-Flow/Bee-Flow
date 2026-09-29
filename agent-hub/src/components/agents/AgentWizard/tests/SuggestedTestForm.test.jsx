/**
 * Het formulier waarin een VOORSTEL een test wordt (A4 deel D).
 *
 * Drie beloftes, en alle drie zijn ze er om te voorkomen dat er straks een
 * test staat die iets anders bewaakt dan iemand dacht:
 *
 *   • elk voorgesteld veld is te bewerken vóór opslag, en wat wordt opgeslagen
 *     is wat er STAAT — niet wat het model schreef;
 *   • het scherm zegt dat een AI het schreef, per veld, en houdt daarmee op
 *     zodra jij het veld aanraakt;
 *   • is er niets voorgesteld, dan staat er ook geen AI-vlag boven een leeg
 *     formulier.
 *
 * Run: cd agent-hub && ./node_modules/.bin/vitest run src/components/agents/AgentWizard/tests/SuggestedTestForm.test.jsx
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';

import SuggestedTestForm from './SuggestedTestForm';
import { refusalFor } from './testSetFacts';

const t = (key, fallback, params) => {
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
        // Een verbod stelt niemand voor, dus daar hangt geen merkje.
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
    it('vult de vraag uit de beurt in en laat hem bewerken', () => {
        const onSave = vi.fn();
        render(<SuggestedTestForm t={t} turn={TURN} suggestion={SUGGESTION} onSave={onSave} />);
        const question = screen.getByTestId('agent-tests-field-question');
        expect(question).toHaveValue('When are you open?');
        fireEvent.change(question, { target: { value: 'What are your opening hours?' } });
        fireEvent.click(screen.getByTestId('agent-tests-suggest-save'));
        expect(onSave.mock.calls[0][0].question).toBe('What are your opening hours?');
    });

    it('BIJT — opgeslagen wordt wat er STAAT, niet wat het model schreef', () => {
        const onSave = vi.fn();
        render(<SuggestedTestForm t={t} turn={TURN} suggestion={SUGGESTION} onSave={onSave} />);
        fireEvent.change(screen.getByTestId('agent-tests-field-mustMention'), { target: { value: 'open until six on weekdays\n  \nfree parking' } });
        fireEvent.change(screen.getByTestId('agent-tests-field-mustNotMention'), { target: { value: 'discount' } });
        fireEvent.change(screen.getByTestId('agent-tests-field-toolsExpected'), { target: { value: '' } });
        fireEvent.change(screen.getByTestId('agent-tests-field-notes'), { target: { value: '' } });
        fireEvent.click(screen.getByTestId('agent-tests-suggest-save'));

        expect(onSave).toHaveBeenCalledTimes(1);
        expect(onSave.mock.calls[0][0].expect).toEqual({
            mustMention: ['open until six on weekdays', 'free parking'],
            mustNotMention: ['discount'],
            toolsExpected: [],
            rulesExpected: [],
            notes: '',
        });
    });

    it('slaat het voorstel ongewijzigd op als je niets verandert', () => {
        const onSave = vi.fn();
        render(<SuggestedTestForm t={t} turn={TURN} suggestion={SUGGESTION} onSave={onSave} />);
        fireEvent.click(screen.getByTestId('agent-tests-suggest-save'));
        expect(onSave.mock.calls[0][0].expect.mustMention).toEqual(['open until six']);
        expect(onSave.mock.calls[0][0].expect.toolsExpected).toEqual(['kb_search']);
        expect(onSave.mock.calls[0][0].name).toBe('');
    });

    it('zonder vraag valt er niets op te slaan', () => {
        const onSave = vi.fn();
        render(<SuggestedTestForm t={t} turn={{ question: '', answer: 'x' }} suggestion={SUGGESTION} onSave={onSave} />);
        expect(screen.getByTestId('agent-tests-suggest-save')).toBeDisabled();
        fireEvent.click(screen.getByTestId('agent-tests-suggest-save'));
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

    it('annuleren gaat naar de aanroeper', () => {
        const onCancel = vi.fn();
        render(<SuggestedTestForm t={t} turn={TURN} suggestion={SUGGESTION} onCancel={onCancel} />);
        fireEvent.click(screen.getByTestId('agent-tests-suggest-cancel'));
        expect(onCancel).toHaveBeenCalled();
    });
});
