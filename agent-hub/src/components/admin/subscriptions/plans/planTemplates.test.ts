import { describe, expect, it } from 'vitest';
import { PLAN_TEMPLATES } from './planTemplates';

// `plan.*` is seeded into the editor and, once saved, shown to customers (plan
// cards, the consumer plan picker). Economics belong in display.operatorNote.
const INTERNAL_ECONOMICS = /margin|markup|raw model cost|undercut/i;
const COMPETITOR_OR_VENDOR = /chatgpt|openai|claude|gemini|anthropic|mistral|copilot/i;

describe('PLAN_TEMPLATES', () => {
    it.each(PLAN_TEMPLATES.map(tpl => [tpl.id, tpl] as const))(
        '%s has a customer-safe plan description, name and tagline',
        (_id, tpl) => {
            for (const text of [tpl.plan.description, tpl.plan.name, tpl.plan.tagline]) {
                const value = String(text ?? '');
                expect(value).not.toMatch(/margin|chatgpt|openai|claude|gemini/i);
                expect(value).not.toMatch(INTERNAL_ECONOMICS);
                expect(value).not.toMatch(COMPETITOR_OR_VENDOR);
            }
        },
    );

    it.each(PLAN_TEMPLATES.map(tpl => [tpl.id, tpl] as const))(
        '%s names no competitor in its gallery texts',
        (_id, tpl) => {
            const { title, subtitle, priceLabel, highlights = [], operatorNote = '' } = tpl.display;
            for (const text of [title, subtitle, priceLabel, ...highlights, operatorNote]) {
                expect(text).not.toMatch(COMPETITOR_OR_VENDOR);
            }
        },
    );

    it('keeps the operator note out of the seeded plan', () => {
        for (const tpl of PLAN_TEMPLATES) {
            expect(tpl.plan).not.toHaveProperty('operatorNote');
        }
        expect(PLAN_TEMPLATES.some(tpl => tpl.display.operatorNote)).toBe(true);
    });
});
