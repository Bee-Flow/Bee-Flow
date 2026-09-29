// @vitest-environment node
//
// Unit tests — docked/modal layout resolution for the LessonPlayer (v2).
// The pure rules only: mobile always modal; explicit preference wins;
// otherwise action/tour lessons dock, quiz/slide lessons stay modal.

import { describe, it, expect } from 'vitest';
import { defaultLayoutForSteps, resolveInitialLayout, LAYOUTS } from './playerLayout';

const slide = { type: 'slide', id: 's' };
const quizStep = { type: 'quiz', id: 'q', choices: [] };
const action = { type: 'action', id: 'a', checkId: 'x' };
const tour = { id: 't', target: '[data-tour="x"]' }; // no type ⇒ tour

describe('defaultLayoutForSteps', () => {
    it('docks lessons with action or tour steps', () => {
        expect(defaultLayoutForSteps([slide, action])).toBe(LAYOUTS.DOCKED);
        expect(defaultLayoutForSteps([slide, tour, quizStep])).toBe(LAYOUTS.DOCKED);
    });
    it('keeps pure inline lessons modal', () => {
        expect(defaultLayoutForSteps([slide, quizStep])).toBe(LAYOUTS.MODAL);
        expect(defaultLayoutForSteps([])).toBe(LAYOUTS.MODAL);
    });
});

describe('resolveInitialLayout', () => {
    it('mobile always forces modal, even over a docked preference', () => {
        expect(resolveInitialLayout([action], LAYOUTS.DOCKED, true)).toBe(LAYOUTS.MODAL);
    });
    it('a stored preference beats the step-mix default', () => {
        expect(resolveInitialLayout([slide, quizStep], LAYOUTS.DOCKED, false)).toBe(LAYOUTS.DOCKED);
        expect(resolveInitialLayout([action], LAYOUTS.MODAL, false)).toBe(LAYOUTS.MODAL);
    });
    it('no preference falls back to the step-mix default', () => {
        expect(resolveInitialLayout([action], null, false)).toBe(LAYOUTS.DOCKED);
        expect(resolveInitialLayout([slide, quizStep], null, false)).toBe(LAYOUTS.MODAL);
        expect(resolveInitialLayout([slide], 'garbage', false)).toBe(LAYOUTS.MODAL);
    });
});
