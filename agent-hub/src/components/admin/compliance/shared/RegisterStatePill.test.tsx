import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';
import RegisterStatePill from './RegisterStatePill';
import { REGISTER_STATE_CLASS, REGISTER_STATE_TONES, toneOfRegisterState } from './statusVocabulary';

/**
 * One look per lifecycle state, on every register. Pinned: the four groups
 * from the plan, never dashed (dashed is self-attested), a Check glyph on a
 * done state, and an unknown state that falls back to neutral.
 */

describe('statusVocabulary', () => {
    it.each([
        ['neutral', ['new', 'open', 'pending', 'received']],
        ['warning', ['in_progress', 'treating', 'assessing', 'corrective_action', 'effectiveness_review', 'early_warning_sent']],
        ['success', ['fulfilled', 'closed', 'approved', 'published', 'achieved', 'done']],
        ['muted', ['rejected', 'dropped', 'excluded', 'not_applicable']],
    ])('%s: %j', (tone, states) => {
        for (const state of states as string[]) expect(toneOfRegisterState(state)).toBe(tone);
    });

    it('an unknown, empty or differently cased state is read sensibly', () => {
        expect(toneOfRegisterState('whatever')).toBe('neutral');
        expect(toneOfRegisterState(null)).toBe('neutral');
        expect(toneOfRegisterState(undefined)).toBe('neutral');
        expect(toneOfRegisterState('Closed')).toBe('success');
        // A prototype key is not a state.
        expect(toneOfRegisterState('constructor')).toBe('neutral');
    });

    it('no tone is dashed and none is an alarm colour', () => {
        for (const cls of Object.values(REGISTER_STATE_CLASS)) {
            expect(cls).not.toMatch(/dashed/);
            expect(cls).not.toMatch(/--error/);
        }
        expect(new Set(Object.values(REGISTER_STATE_TONES))).toEqual(new Set(['neutral', 'warning', 'success', 'muted']));
    });
});

describe('RegisterStatePill', () => {
    it('open: a neutral solid hairline with primary text, no glyph', () => {
        render(<RegisterStatePill state="open">Open</RegisterStatePill>);
        const pill = screen.getByTestId('register-state-pill');
        expect(pill).toHaveTextContent('Open');
        expect(pill).toHaveAttribute('data-tone', 'neutral');
        expect(pill).toHaveAttribute('data-state', 'open');
        expect(pill.className).toContain('border-solid');
        expect(pill.className).toContain(REGISTER_STATE_CLASS.neutral);
        expect(pill.querySelector('svg')).toBeNull();
    });

    it('in progress: warning hairline and ink', () => {
        render(<RegisterStatePill state="corrective_action">Corrective action</RegisterStatePill>);
        const pill = screen.getByTestId('register-state-pill');
        expect(pill).toHaveAttribute('data-tone', 'warning');
        expect(pill.className).toContain('border-[var(--warning)] text-[var(--warning-ink)]');
    });

    it('done: success ink with a Check glyph before the word', () => {
        render(<RegisterStatePill state="fulfilled">Fulfilled</RegisterStatePill>);
        const pill = screen.getByTestId('register-state-pill');
        expect(pill).toHaveAttribute('data-tone', 'success');
        expect(pill.className).toContain('text-[var(--success-ink)]');
        const glyph = pill.firstElementChild;
        expect(glyph?.tagName.toLowerCase()).toBe('svg');
        expect(glyph?.getAttribute('aria-hidden')).toBe('true');
        expect(pill).toHaveTextContent('Fulfilled');
    });

    it('rejected: muted, tertiary text', () => {
        render(<RegisterStatePill state="rejected" title="Rejected on 3 Sep" testId="p">Rejected</RegisterStatePill>);
        const pill = screen.getByTestId('p');
        expect(pill).toHaveAttribute('data-tone', 'muted');
        expect(pill.className).toContain('text-[var(--text-tertiary)]');
        expect(pill).toHaveAttribute('title', 'Rejected on 3 Sep');
    });
});
