// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { readStyleAssistAnswer, styleAssistFor } from './formStyleAssist';

describe('styleAssistFor', () => {
    it('is null without a saved automation', () => {
        expect(styleAssistFor(null)).toBeNull();
        expect(styleAssistFor('')).toBeNull();
    });

    it('posts the prompt and only the parts that are set, to the automation\'s style-assist route', async () => {
        const post = vi.fn(async () => ({ css: '.bf-form__title { color: #111111; }', notes: ['Darker title'], removed: [] }));
        const ask = styleAssistFor('a/1', 'trig_2', post);
        const answer = await ask!({ prompt: 'warm bakery', style: { font: 'serif' }, theme: null, customCss: '' });
        expect(post).toHaveBeenCalledWith('/api/automation/a%2F1/forms/style-assist', { prompt: 'warm bakery', triggerStepId: 'trig_2', style: { font: 'serif' } });
        expect(answer).toEqual({ css: '.bf-form__title { color: #111111; }', notes: ['Darker title'], removed: [] });
    });

    it('leaves triggerStepId out for the main trigger', async () => {
        const post = vi.fn(async () => ({}));
        await styleAssistFor('a1', null, post)!({ prompt: 'x', customCss: '.a{}' });
        expect(post).toHaveBeenCalledWith('/api/automation/a1/forms/style-assist', { prompt: 'x', customCss: '.a{}' });
    });
});

describe('readStyleAssistAnswer', () => {
    it('reads a partial or odd answer as empty parts, never throws', () => {
        expect(readStyleAssistAnswer(null)).toEqual({ css: '', notes: [], removed: [] });
        expect(readStyleAssistAnswer({ css: 5, notes: ['ok', 3, ' '], removed: 'url()' })).toEqual({ css: '', notes: ['ok'], removed: [] });
    });
});
